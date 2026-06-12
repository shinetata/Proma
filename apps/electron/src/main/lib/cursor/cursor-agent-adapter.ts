/**
 * Cursor Agent 适配器
 *
 * 实现 AgentProviderAdapter 接口：通过本地 cursor-agent CLI 的 headless 模式
 * （-p + --output-format stream-json）运行 Agent，并把 CLI 的 NDJSON 事件流
 * 翻译为 Proma 统一的 SDKMessage 流，复用现有编排层（持久化、事件、重试、渲染）。
 *
 * 与 ClaudeAgentAdapter 的差异：
 * - cursor-agent headless 为单轮单进程（一个 prompt → 一个 result），不支持
 *   流式追加消息 / 软中断 / 动态权限模式（这些方法不实现，由 Router 兜底报错）。
 * - 权限：headless 下用 --force 自动放行（plan 模式映射为 --mode plan 只读规划）。
 * - 工具事件结构与 Claude 不同，需做工具名归一化与 tool_use/tool_result 配对翻译。
 *
 * CLI 契约参考：https://cursor.com/docs/cli/reference/output-format
 */

import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type {
  AgentQueryInput,
  AgentProviderAdapter,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@proma/shared'
import { materializeCursorMcpConfig } from './cursor-mcp-bridge'

// ============================================================================
// 查询选项
// ============================================================================

/**
 * Cursor 适配器查询选项
 *
 * 由 RouterAgentAdapter 在编排层 ClaudeAgentQueryOptions 基础上注入
 * cursorApiKey / cursorCliPath 后传入。其余字段从编排层选项透传。
 */
export interface CursorAgentQueryOptions extends AgentQueryInput {
  /** cursor-agent 可执行文件绝对路径（由 Router 注入） */
  cursorCliPath: string
  /** Cursor API Key（由 Router 解密注入，通过 CURSOR_API_KEY 传给子进程） */
  cursorApiKey: string
  /** 子进程环境变量（复用编排层 sdkEnv，含 Proma 增强的 PATH/HOME 等） */
  env?: Record<string, string | undefined>
  /** 系统提示词（claude_code preset 的 append 作为上下文前缀注入 prompt） */
  systemPrompt?: string | { type: 'preset'; preset: string; append?: string }
  /** 上一轮 cursor chat id，用于 --resume 衔接上下文 */
  resumeSessionId?: string
  /** Proma 权限模式（plan → cursor --mode plan，其它 → --force） */
  sdkPermissionMode?: string
  /** stderr 回调 */
  onStderr?: (data: string) => void
  /** cursor chat id 捕获回调（持久化为 sdkSessionId，供下一轮 resume） */
  onSessionId?: (sessionId: string) => void
  /** 模型确认回调（从 system/init 读取） */
  onModelResolved?: (model: string) => void
  /**
   * 编排层构建的 MCP 服务器配置（含外部 stdio/http/sse 与内置 sdk 工具）。
   * Cursor headless 仅能用外部 MCP，query 前会把其中外部项物化为会话 cwd 的 .cursor/mcp.json。
   */
  mcpServers?: Record<string, Record<string, unknown>>
}

// ============================================================================
// 工具名归一化
// ============================================================================

/** cursor 工具 key（去除 ToolCall 后缀后）→ Proma/Claude 风格工具名 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'Edit',
  search_replace: 'Edit',
  delete: 'Delete',
  ls: 'LS',
  list: 'LS',
  list_dir: 'LS',
  glob: 'Glob',
  grep: 'Grep',
  search: 'Grep',
  codebase_search: 'Grep',
  shell: 'Bash',
  terminal: 'Bash',
  run_terminal_cmd: 'Bash',
  run: 'Bash',
  bash: 'Bash',
  command: 'Bash',
  web: 'WebFetch',
  fetch: 'WebFetch',
  web_search: 'WebSearch',
  todo: 'TodoWrite',
  todo_write: 'TodoWrite',
  switchmode: 'SwitchMode',
  switch_mode: 'SwitchMode',
  createplan: 'CreatePlan',
  create_plan: 'CreatePlan',
}

/** 将 cursor 工具 key（如 readToolCall / writeToolCall / function）归一化为展示名 */
function normalizeToolName(rawKey: string): string {
  const base = rawKey.replace(/ToolCall$/, '').replace(/Tool$/, '')
  const lower = base.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  if (TOOL_NAME_MAP[lower]) return TOOL_NAME_MAP[lower]
  // 兜底：驼峰转 PascalCase 展示名
  return base.charAt(0).toUpperCase() + base.slice(1)
}

interface CursorToolCall {
  name: string
  input: Record<string, unknown>
  result?: unknown
}

/** 从 cursor tool_call.tool_call 对象提取工具名 / 参数 / 结果 */
function parseToolCall(toolCall: Record<string, unknown> | undefined): CursorToolCall | null {
  if (!toolCall || typeof toolCall !== 'object') return null

  const keys = Object.keys(toolCall)
  if (keys.length === 0) return null
  const key = keys[0]!
  const body = toolCall[key] as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') return null

  // 通用 function 结构：{ function: { name, arguments } }
  if (key === 'function') {
    const name = typeof body.name === 'string' ? body.name : 'function'
    let input: Record<string, unknown> = {}
    if (typeof body.arguments === 'string') {
      try {
        input = JSON.parse(body.arguments) as Record<string, unknown>
      } catch {
        input = { arguments: body.arguments }
      }
    } else if (body.arguments && typeof body.arguments === 'object') {
      input = body.arguments as Record<string, unknown>
    }
    return { name: normalizeToolName(name), input, result: body.result }
  }

  // 具名工具结构：{ readToolCall: { args, result } }
  const input = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>
  return { name: normalizeToolName(key), input, result: body.result }
}

/** 将 cursor 工具结果转为 tool_result 内容 + 错误标记 */
function stringifyToolResult(result: unknown): { content: string; isError: boolean } {
  if (result == null) return { content: '', isError: false }
  if (typeof result === 'string') return { content: result, isError: false }
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (obj.error != null || obj.failure != null) {
      const errObj = obj.error ?? obj.failure
      return { content: typeof errObj === 'string' ? errObj : JSON.stringify(errObj), isError: true }
    }
    const success = (obj.success ?? obj) as Record<string, unknown> | string
    if (typeof success === 'string') return { content: success, isError: false }
    if (typeof success.content === 'string') return { content: success.content, isError: false }
    try {
      return { content: JSON.stringify(success), isError: false }
    } catch {
      return { content: String(success), isError: false }
    }
  }
  return { content: String(result), isError: false }
}

// ============================================================================
// NDJSON → SDKMessage 翻译
// ============================================================================

/**
 * 将单条 cursor NDJSON 事件翻译为零或多条 SDKMessage。
 *
 * - system/init → SDKSystemMessage（并触发 onSessionId / onModelResolved）
 * - user → 跳过（编排层已持久化用户输入，避免重复）
 * - assistant → SDKAssistantMessage（文本）
 * - tool_call/started → SDKAssistantMessage（tool_use 块）
 * - tool_call/completed → SDKUserMessage（tool_result 块）
 * - result → SDKResultMessage（补充合成 usage）
 */
function translateEvent(
  event: Record<string, unknown>,
  options: CursorAgentQueryOptions,
): SDKMessage[] {
  const type = event.type
  const sessionId = typeof event.session_id === 'string' ? event.session_id : options.sessionId

  if (type === 'system') {
    if (event.subtype === 'init') {
      if (typeof event.session_id === 'string' && event.session_id) {
        options.onSessionId?.(event.session_id)
      }
      if (typeof event.model === 'string' && event.model) {
        options.onModelResolved?.(event.model)
      }
    }
    const sys: SDKSystemMessage = {
      type: 'system',
      subtype: typeof event.subtype === 'string' ? event.subtype : undefined,
      session_id: sessionId,
      model: typeof event.model === 'string' ? event.model : undefined,
    }
    return [sys]
  }

  // 用户输入回显：编排层已记录，跳过避免重复
  if (type === 'user') return []

  if (type === 'assistant') {
    const message = event.message as { content?: Array<Record<string, unknown>>; role?: string } | undefined
    const text = (message?.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    if (!text) return []
    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text }],
        model: typeof options.model === 'string' ? options.model : undefined,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    }
    return [assistant]
  }

  if (type === 'tool_call') {
    const callId = typeof event.call_id === 'string' ? event.call_id : `cursor_tool_${Date.now()}`
    const parsed = parseToolCall(event.tool_call as Record<string, unknown> | undefined)
    if (!parsed) return []

    if (event.subtype === 'started') {
      const assistant: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: callId, name: parsed.name, input: parsed.input }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      return [assistant]
    }

    if (event.subtype === 'completed') {
      const { content, isError } = stringifyToolResult(parsed.result)
      const user: SDKUserMessage = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      return [user]
    }
    return []
  }

  if (type === 'result') {
    if (typeof event.session_id === 'string' && event.session_id) {
      options.onSessionId?.(event.session_id)
    }
    const isError = event.is_error === true || event.subtype === 'error'
    const result: SDKResultMessage = {
      type: 'result',
      subtype: isError ? 'error' : 'success',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
      session_id: sessionId,
    }
    return [result]
  }

  // 未知事件：忽略（向前兼容）
  return []
}

// ============================================================================
// 进程管理
// ============================================================================

/** 平台差异化强杀进程树 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
      // 宽限后兜底 SIGKILL
      setTimeout(() => {
        try {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }, 2000).unref?.()
    }
  } catch {
    /* 进程可能已退出 */
  }
}

// ============================================================================
// CursorAgentAdapter
// ============================================================================

export class CursorAgentAdapter implements AgentProviderAdapter {
  /** 活跃子进程（sessionId → child） */
  private readonly activeProcs = new Map<string, ChildProcess>()

  abort(sessionId: string): void {
    const child = this.activeProcs.get(sessionId)
    if (child) {
      killProcessTree(child)
      this.activeProcs.delete(sessionId)
    }
  }

  dispose(): void {
    for (const child of this.activeProcs.values()) {
      killProcessTree(child)
    }
    this.activeProcs.clear()
  }

  /** 构建 cursor-agent headless 启动参数 */
  private buildArgs(options: CursorAgentQueryOptions, prompt: string, approveMcps: boolean): string[] {
    const args: string[] = ['-p', '--output-format', 'stream-json']

    // 权限：plan → 只读规划；其它 → 自动放行（headless 无交互式逐工具授权）
    const isPlan = typeof options.sdkPermissionMode === 'string' && options.sdkPermissionMode.toLowerCase().includes('plan')
    if (isPlan) {
      args.push('--mode', 'plan')
    } else {
      args.push('--force')
    }

    // headless 信任工作区，避免交互式确认
    args.push('--trust')

    // 物化了外部 MCP 时自动放行其工具审批（headless 无交互式 MCP 审批）
    if (approveMcps) args.push('--approve-mcps')

    if (options.cwd) args.push(`--workspace=${options.cwd}`)
    if (options.model) args.push('--model', options.model)
    // 用 = 形式避免可选值参数吞掉后续位置参数
    if (options.resumeSessionId) args.push(`--resume=${options.resumeSessionId}`)

    // 位置参数 prompt 放最后
    args.push(prompt)
    return args
  }

  /** 构建子进程环境变量：复用编排层 env（含增强 PATH），注入 CURSOR_API_KEY，剥离 ANTHROPIC_* */
  private buildEnv(options: CursorAgentQueryOptions): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = { ...(options.env ?? process.env) }
    for (const key of Object.keys(base)) {
      if (key.startsWith('ANTHROPIC_')) delete base[key]
    }
    base.CURSOR_API_KEY = options.cursorApiKey
    return base
  }

  /** 提取系统提示词 append 作为 prompt 上下文前缀 */
  private buildPrompt(options: CursorAgentQueryOptions): string {
    const sp = options.systemPrompt
    const append = typeof sp === 'string' ? sp : sp?.append
    if (append && append.trim()) {
      return `${append.trim()}\n\n---\n\n${options.prompt}`
    }
    return options.prompt
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as CursorAgentQueryOptions
    const { sessionId } = options

    const prompt = this.buildPrompt(options)
    // 物化外部 MCP 到会话 cwd 的 .cursor/mcp.json（仅 stdio/http/sse，内置 sdk 工具跳过）
    const mcpResult = materializeCursorMcpConfig(options.cwd, options.mcpServers)
    const args = this.buildArgs(options, prompt, mcpResult.wrote)
    const env = this.buildEnv(options)

    console.log(`[Cursor 适配器] 启动 cursor-agent: sessionId=${sessionId}, model=${options.model || '默认'}, resume=${options.resumeSessionId || '无'}, mcp=${mcpResult.wrote ? mcpResult.names.join('/') : '无'}`)

    const child = spawn(options.cursorCliPath, args, {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.activeProcs.set(sessionId, child)

    // 事件队列：桥接 child 的 data 事件到 async generator
    const queue: SDKMessage[] = []
    let done = false
    let resolveWaiter: (() => void) | null = null
    const wake = (): void => {
      if (resolveWaiter) {
        const r = resolveWaiter
        resolveWaiter = null
        r()
      }
    }
    const pushMessages = (msgs: SDKMessage[]): void => {
      if (msgs.length === 0) return
      queue.push(...msgs)
      wake()
    }

    // NDJSON 行缓冲解析
    let stdoutBuffer = ''
    const stderrChunks: string[] = []
    let sawResult = false

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // 非 JSON 噪声（极少），忽略
        return
      }
      if (event.type === 'result') sawResult = true
      try {
        pushMessages(translateEvent(event, options))
      } catch (err) {
        console.error('[Cursor 适配器] 事件翻译失败:', err)
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      let idx: number
      while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx)
        stdoutBuffer = stdoutBuffer.slice(idx + 1)
        handleLine(line)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString()
      stderrChunks.push(s)
      try {
        options.onStderr?.(s)
      } catch {
        /* 用户回调异常不影响流 */
      }
    })

    const closePromise = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        stderrChunks.push(String(err))
        resolve()
      })
      child.on('close', () => {
        // 处理缓冲区中最后一段无换行的内容
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer)
        stdoutBuffer = ''
        resolve()
      })
    })

    // 子进程关闭后：若未产出 result，则合成一个错误 result，避免编排层挂起
    void closePromise.then(() => {
      if (!sawResult) {
        const stderr = stderrChunks.join('').trim()
        const errResult: SDKResultMessage = {
          type: 'result',
          subtype: 'error',
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: sessionId,
          errors: stderr ? [stderr.slice(0, 2000)] : ['cursor-agent 进程异常退出'],
        }
        pushMessages([errResult])
      }
      done = true
      wake()
    })

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (done) break
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve
        })
      }
    } finally {
      this.activeProcs.delete(sessionId)
      if (!child.killed) killProcessTree(child)
    }
  }
}
