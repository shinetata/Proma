/**
 * Cursor ACP 适配器
 *
 * 通过 `cursor-agent acp`（Agent Client Protocol，JSON-RPC 2.0 over stdio NDJSON）运行 Agent，
 * 是 Cursor 渠道的唯一后端，对齐 Claude 直连渠道的交互能力：
 * - 持久会话 + 多轮 prompt（session/prompt 顺序注入）→ 支持流式追加消息
 * - 逐工具权限审批（session/request_permission → canUseTool → allow/reject）
 * - 运行中软中断（session/cancel）
 * - 运行中切换权限模式（session/set_mode，即时生效，无需下轮）
 * - thinking 推理流（agent_thought_chunk）
 * - 自动标题（session_info_update）
 *
 * 上游硬限制：ACP 流不含 token 用量（result 仅 stopReason），与 headless 一致，usage 合成为 0。
 *
 * 协议契约（实测自 cursor-agent 2026.06）：
 * - initialize → { agentCapabilities, authMethods }（authMethods=cursor_login，复用本机 `cursor login`）
 * - session/new { cwd, mcpServers } → { sessionId, modes, models }
 * - session/load { sessionId, cwd, mcpServers } → 恢复既有会话（agentCapabilities.loadSession=true）
 * - session/set_mode { sessionId, modeId: 'agent'|'plan'|'ask' }
 * - session/prompt { sessionId, prompt:[{type:'text',text}] } → { stopReason }
 * - session/cancel { sessionId }（通知，无响应）
 * - 通知 session/update：agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update /
 *   session_info_update / current_mode_update / available_commands_update / plan
 * - 服务端→客户端请求：session/request_permission（options: allow_once/allow_always/reject_once）、fs/*
 */

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { resolveToolName } from './cursor-tool-names'
import type {
  AgentQueryInput,
  AgentProviderAdapter,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'

// ============================================================================
// 查询选项
// ============================================================================

/**
 * Cursor ACP 适配器查询选项
 *
 * 由 RouterAgentAdapter 在编排层 ClaudeAgentQueryOptions 基础上注入 cursorApiKey / cursorCliPath，
 * 其余字段（canUseTool / mcpServers / systemPrompt 等）从编排层选项透传（运行时同一对象引用）。
 */
export interface CursorAcpQueryOptions extends AgentQueryInput {
  /** cursor-agent 可执行文件绝对路径（由 Router 注入） */
  cursorCliPath: string
  /** Cursor API Key（由 Router 解密注入，通过 CURSOR_API_KEY 传给子进程） */
  cursorApiKey: string
  /** 子进程环境变量（复用编排层 sdkEnv，含 Proma 增强的 PATH/HOME 等） */
  env?: Record<string, string | undefined>
  /** 系统提示词（仅在新建 ACP 会话的首轮注入，后续轮次依赖 ACP 会话上下文留存，避免历史污染） */
  systemPrompt?: string | { type: 'preset'; preset: string; append?: string }
  /** 上一轮 ACP sessionId，用于 session/load 衔接上下文（进程重建场景） */
  resumeSessionId?: string
  /** SDK 权限模式（plan → ACP plan；其它 → ACP agent，按 canUseTool 逐工具审批） */
  sdkPermissionMode?: string
  /** 编排层构建的 MCP 服务器配置（外部 stdio/http/sse 注入 session/new；内置 sdk 工具跳过） */
  mcpServers?: Record<string, Record<string, unknown>>
  /** 权限决策回调（来自编排层 canUseTool，桥接 session/request_permission） */
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  /** stderr 回调 */
  onStderr?: (data: string) => void
  /** ACP sessionId 捕获回调（持久化为 sdkSessionId，供下一轮 session/load） */
  onSessionId?: (sessionId: string) => void
  /** 模型确认回调（从 session/new 的 models.currentModelId 解析） */
  onModelResolved?: (model: string) => void
  /** 上下文窗口缓存回调（从 currentModelId 的 context=XXXk 解析） */
  onContextWindow?: (contextWindow: number) => void
}

// ============================================================================
// 协议映射辅助
// ============================================================================

/**
 * 基于字符数估算 token 用量。
 * Cursor ACP 协议不返回 token 统计，使用启发式估算：
 * - 纯英文/代码：约 4 字符 = 1 token
 * - CJK 混合文本：约 1.8 字符 = 1 token（CJK 字符 token 密度更高）
 * 混合文本按 CJK 字符占比动态计算。
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkChars = (text.match(/[一-鿿㐀-䶿豈-﫿]/g) ?? []).length
  const cjkRatio = cjkChars / text.length
  const charsPerToken = cjkRatio > 0.15 ? 1.8 + (3.5 - 1.8) * (1 - cjkRatio) : 3.5
  return Math.max(1, Math.round(text.length / charsPerToken))
}

/** Cursor CLI 错误分类 */
type CursorErrorCategory = 'network' | 'rate_limit' | 'crash' | 'auth' | 'unknown'

interface CategorizedCursorError {
  category: CursorErrorCategory
  message: string
}

/** 将 CLI stderr/error 文本分类为结构化错误 */
function classifyCursorError(stderrText: string, exitCode?: number): CategorizedCursorError {
  const text = stderrText.toLowerCase()
  if (/econnrefused|etimedout|enotfound|socket hang up|network.*unreachable|dns|proxy/i.test(text)) {
    return { category: 'network', message: `网络连接失败：${stderrText.slice(0, 200)}` }
  }
  if (/429|rate.?limit|too many requests/i.test(text)) {
    return { category: 'rate_limit', message: '请求频率过高，请稍后重试' }
  }
  if (/segmentation fault|out of memory|killed|signal|exit.*13/i.test(text) || (exitCode === -1 && !text.includes('unauthor'))) {
    return { category: 'crash', message: `cursor-agent 进程异常退出${exitCode ? ` (exit ${exitCode})` : ''}` }
  }
  if (/unauthor|invalid.*(key|token)|forbidden|401|403|not logged in|login expired|token revoked/i.test(text)) {
    return { category: 'auth', message: 'API Key 无效或未授权，请检查 Cursor API Key' }
  }
  return { category: 'unknown', message: stderrText.slice(0, 300) || `cursor-agent 异常退出 (exit ${exitCode ?? '未知'})` }
}

/** Proma/SDK 权限模式 → ACP modeId */
function toAcpMode(sdkPermissionMode: string | undefined): 'agent' | 'plan' {
  if (typeof sdkPermissionMode === 'string' && sdkPermissionMode.toLowerCase().includes('plan')) return 'plan'
  return 'agent'
}

/** ACP toolCall.kind → Proma 标准工具名（委托 cursor-tool-names 共享模块） */
const getAcpToolName = (acpKind: string, title?: string): string => resolveToolName(acpKind, title)

/** 从 ACP currentModelId（如 "claude-opus-4-8[thinking=true,context=300k,...]"）解析展示名 */
function parseAcpModelName(modelId: string): string {
  const idx = modelId.indexOf('[')
  return idx >= 0 ? modelId.slice(0, idx) : modelId
}

/** 从 ACP currentModelId 的 context=300k 解析上下文窗口 token 数 */
function parseAcpContextWindow(modelId: string): number | undefined {
  const m = modelId.match(/context=(\d+)k/i)
  if (m && m[1]) return parseInt(m[1], 10) * 1000
  return undefined
}

/**
 * 把 Proma 选定模型（来自 --list-models，可能是 name 或 modelId 形式）解析为 ACP 规范 modelId。
 *
 * 依次按：精确 modelId → 精确 name → modelId 前缀（去 [params]）→ name 前缀 匹配 availableModels。
 * 无法匹配时返回 undefined（沿用 cursor 默认模型，不强行 set_model 以免报错）。
 */
function resolveAcpModelId(
  optionModel: string | undefined,
  available: Array<{ modelId: string; name: string }>,
): string | undefined {
  if (!optionModel || available.length === 0) return undefined
  const want = optionModel.trim()
  const wantBase = parseAcpModelName(want)

  const exactId = available.find((m) => m.modelId === want)
  if (exactId) return exactId.modelId
  const exactName = available.find((m) => m.name === want)
  if (exactName) return exactName.modelId
  const byIdBase = available.find((m) => parseAcpModelName(m.modelId) === wantBase)
  if (byIdBase) return byIdBase.modelId
  const byName = available.find((m) => m.name === wantBase)
  if (byName) return byName.modelId
  return undefined
}

/** ACP session/new 的 mcpServers 单条目（stdio 用 command，远端用 url） */
interface AcpMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  type?: 'http' | 'sse'
  url?: string
  headers?: Array<{ name: string; value: string }>
}

/** 把编排层 mcpServers（含内置 sdk 工具）转为 ACP session/new 所需的外部 MCP 数组（跳过 type:'sdk'） */
function toAcpMcpServers(
  mcpServers: Record<string, Record<string, unknown>> | undefined,
): AcpMcpServer[] {
  if (!mcpServers) return []
  const out: AcpMcpServer[] = []
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== 'object') continue
    const type = entry.type
    if (type === 'stdio' && typeof entry.command === 'string') {
      const envObj = (entry.env && typeof entry.env === 'object' ? entry.env : {}) as Record<string, string>
      const server: AcpMcpServer = { name, command: entry.command }
      if (Array.isArray(entry.args) && entry.args.length > 0) server.args = entry.args as string[]
      if (Object.keys(envObj).length > 0) {
        server.env = Object.entries(envObj).map(([k, v]) => ({ name: k, value: String(v) }))
      }
      out.push(server)
    } else if ((type === 'http' || type === 'sse') && typeof entry.url === 'string') {
      const headersObj = (entry.headers && typeof entry.headers === 'object' ? entry.headers : {}) as Record<string, string>
      const server: AcpMcpServer = { name, type, url: entry.url }
      if (Object.keys(headersObj).length > 0) {
        server.headers = Object.entries(headersObj).map(([k, v]) => ({ name: k, value: String(v) }))
      }
      out.push(server)
    }
    // type === 'sdk'（automation/mem/nano-banana 等进程内工具）跳过
  }
  return out
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
// ACP 连接（JSON-RPC over NDJSON）
// ============================================================================

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  method: string
}

/** 单个 cursor-agent acp 子进程的 JSON-RPC 连接 */
class AcpConnection {
  readonly child: ChildProcess
  acpSessionId?: string
  /** 是否已为该会话注入过系统提示词（仅新建会话首轮注入，避免历史污染） */
  systemPromptInjected = false
  /** session/new 返回的可用模型表（modelId+name），用于把 Proma 选定模型解析为 ACP modelId */
  availableModels: Array<{ modelId: string; name: string }> = []
  /** 已通过 session/set_model 应用的 modelId（避免每轮重复设置；支持中途换模型） */
  appliedModelId?: string
  alive = true

  /** 收到服务端通知（method 无 id） */
  onNotification?: (method: string, params: Record<string, unknown>) => void
  /** 收到服务端→客户端请求（method 带 id，需回响应） */
  onServerRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>

  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private buf = ''

  constructor(cliPath: string, env: Record<string, string | undefined>, cwd: string | undefined, onStderr?: (s: string) => void) {
    this.child = spawn(cliPath, ['acp'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString()
      let idx: number
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 1)
        this.handleLine(line)
      }
    })

    this.child.stderr?.on('data', (chunk: Buffer) => {
      try {
        onStderr?.(chunk.toString())
      } catch {
        /* 用户回调异常不影响连接 */
      }
    })

    const onExit = (): void => {
      this.alive = false
      // 唤醒所有未决请求，避免上层永久挂起
      for (const [, p] of this.pending) {
        p.reject(new Error('[Cursor ACP] 连接已关闭'))
      }
      this.pending.clear()
    }
    this.child.on('close', onExit)
    this.child.on('error', (err) => {
      try {
        onStderr?.(String(err))
      } catch {
        /* 忽略 */
      }
      onExit()
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return // 非 JSON 噪声
    }

    const id = msg.id
    const method = msg.method

    // 1) 对我方请求的响应（有 id，无 method）
    if (id !== undefined && typeof method !== 'string' && (('result' in msg) || ('error' in msg))) {
      const p = this.pending.get(id as number)
      if (!p) return
      this.pending.delete(id as number)
      if ('error' in msg && msg.error) {
        const e = msg.error as { message?: string; code?: number }
        p.reject(new Error(`[Cursor ACP] ${p.method} 失败: ${e.message ?? JSON.stringify(msg.error)}`))
      } else {
        p.resolve((msg.result ?? {}) as Record<string, unknown>)
      }
      return
    }

    // 2) 服务端→客户端请求（有 id，有 method）→ 需回响应
    if (id !== undefined && typeof method === 'string') {
      const params = (msg.params ?? {}) as Record<string, unknown>
      void this.dispatchServerRequest(id as number, method, params)
      return
    }

    // 3) 通知（有 method，无 id）
    if (typeof method === 'string') {
      const params = (msg.params ?? {}) as Record<string, unknown>
      try {
        this.onNotification?.(method, params)
      } catch (err) {
        console.error('[Cursor ACP] 通知处理失败:', err)
      }
    }
  }

  private async dispatchServerRequest(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const handler = this.onServerRequest
      const result = handler ? await handler(method, params) : {}
      this.writeRaw({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (err) {
      this.writeRaw({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } })
    }
  }

  private writeRaw(obj: Record<string, unknown>): void {
    if (!this.alive || !this.child.stdin?.writable) return
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n')
    } catch (err) {
      console.error('[Cursor ACP] 写入 stdin 失败:', err)
    }
  }

  /** 发起 JSON-RPC 请求并等待响应 */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new Error('[Cursor ACP] 连接已关闭'))
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.writeRaw({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发送 JSON-RPC 通知（无需响应，如 session/cancel） */
  notify(method: string, params: Record<string, unknown>): void {
    this.writeRaw({ jsonrpc: '2.0', method, params })
  }

  close(): void {
    this.alive = false
    if (!this.child.killed) killProcessTree(this.child)
  }
}

// ============================================================================
// CursorAcpAdapter
// ============================================================================

/** 空闲连接释放上限（无活跃 query 且超时未复用则杀进程，防泄漏） */
const IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000

export class CursorAcpAdapter implements AgentProviderAdapter {
  /** Proma sessionId → ACP 连接（跨轮复用，保留会话上下文） */
  private readonly connections = new Map<string, AcpConnection>()
  /** Proma sessionId → 待发送 prompt 队列（sendQueuedMessage 注入，prompt 驱动循环消费） */
  private readonly promptQueues = new Map<string, string[]>()
  /** Proma sessionId → 当前 query 的 AbortController（abort 时触发，唤醒等待中的 canUseTool） */
  private readonly controllers = new Map<string, AbortController>()
  /** Proma sessionId → 空闲释放计时器 */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  /** Proma sessionId → 唤醒 prompt 驱动循环检查队列的回调（用于无中断追加时立即续轮） */
  private readonly queueWakers = new Map<string, () => void>()

  abort(sessionId: string): void {
    this.clearIdleTimer(sessionId)
    this.controllers.get(sessionId)?.abort()
    this.controllers.delete(sessionId)
    const conn = this.connections.get(sessionId)
    if (conn) {
      conn.close()
      this.connections.delete(sessionId)
    }
    this.promptQueues.delete(sessionId)
    this.queueWakers.delete(sessionId)
  }

  dispose(): void {
    for (const t of this.idleTimers.values()) clearTimeout(t)
    this.idleTimers.clear()
    for (const c of this.controllers.values()) c.abort()
    this.controllers.clear()
    for (const conn of this.connections.values()) conn.close()
    this.connections.clear()
    this.promptQueues.clear()
    this.queueWakers.clear()
  }

  /** 软中断当前 turn：发送 session/cancel，使在飞的 session/prompt 以 stopReason=cancelled 收尾 */
  async interruptQuery(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId)
    if (!conn?.alive || !conn.acpSessionId) return
    conn.notify('session/cancel', { sessionId: conn.acpSessionId })
    console.log(`[Cursor ACP] 已发送 session/cancel: sessionId=${sessionId}`)
  }

  /** 注入追加消息：压入 prompt 队列，由 prompt 驱动循环在本轮（或软中断后）续跑 */
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const conn = this.connections.get(sessionId)
    if (!conn?.alive) {
      throw new Error(`[Cursor ACP] 无活跃 ACP 连接可追加消息: ${sessionId}`)
    }
    const text = typeof message.message?.content === 'string' ? message.message.content : ''
    const queue = this.promptQueues.get(sessionId) ?? []
    queue.push(text)
    this.promptQueues.set(sessionId, queue)
    // 唤醒驱动循环：若当前无 in-flight prompt（未中断的追加），立即开始下一轮
    this.queueWakers.get(sessionId)?.()
    console.log(`[Cursor ACP] 追加消息已入队: sessionId=${sessionId}, uuid=${message.uuid}`)
  }

  /** 运行中切换权限模式：session/set_mode 即时生效（无需等下一轮 spawn） */
  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const conn = this.connections.get(sessionId)
    if (!conn?.alive || !conn.acpSessionId) {
      console.warn(`[Cursor ACP] 无活跃连接，跳过权限模式切换: ${sessionId}`)
      return
    }
    try {
      await conn.request('session/set_mode', { sessionId: conn.acpSessionId, modeId: toAcpMode(mode) })
      console.log(`[Cursor ACP] 权限模式已切换: sessionId=${sessionId}, mode=${toAcpMode(mode)}`)
    } catch (err) {
      console.warn(`[Cursor ACP] 权限模式切换失败: ${sessionId}`, err)
    }
  }

  private clearIdleTimer(sessionId: string): void {
    const t = this.idleTimers.get(sessionId)
    if (t) {
      clearTimeout(t)
      this.idleTimers.delete(sessionId)
    }
  }

  private armIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId)
    const t = setTimeout(() => {
      console.warn(`[Cursor ACP] 连接空闲超时，释放子进程: ${sessionId}`)
      const conn = this.connections.get(sessionId)
      conn?.close()
      this.connections.delete(sessionId)
      this.promptQueues.delete(sessionId)
    }, IDLE_CONNECTION_TIMEOUT_MS)
    t.unref?.()
    this.idleTimers.set(sessionId, t)
  }

  /** 构建子进程环境变量：复用编排层 env（含增强 PATH），注入 CURSOR_API_KEY，剥离 ANTHROPIC_* */
  private buildEnv(options: CursorAcpQueryOptions): Record<string, string | undefined> {
    const base: Record<string, string | undefined> = { ...(options.env ?? process.env) }
    for (const key of Object.keys(base)) {
      if (key.startsWith('ANTHROPIC_')) delete base[key]
    }
    base.CURSOR_API_KEY = options.cursorApiKey
    return base
  }

  /** 提取系统提示词 append（仅新建会话首轮注入） */
  private extractSystemPrompt(options: CursorAcpQueryOptions): string {
    const sp = options.systemPrompt
    const append = typeof sp === 'string' ? sp : sp?.append
    return append && append.trim() ? append.trim() : ''
  }

  /** 确保连接就绪：复用存活连接，否则 spawn + initialize + session/load|new */
  private async ensureConnection(options: CursorAcpQueryOptions): Promise<{ conn: AcpConnection; isNewSession: boolean }> {
    const existing = this.connections.get(options.sessionId)
    if (existing?.alive) {
      return { conn: existing, isNewSession: false }
    }

    const env = this.buildEnv(options)
    const conn = new AcpConnection(options.cursorCliPath, env, options.cwd, options.onStderr)

    await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })

    const acpMcp = toAcpMcpServers(options.mcpServers)
    let isNewSession = true

    // 进程重建场景：尝试 session/load 恢复既有会话上下文
    if (options.resumeSessionId) {
      try {
        await conn.request('session/load', {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: acpMcp,
        })
        conn.acpSessionId = options.resumeSessionId
        conn.systemPromptInjected = true // 既有会话已含系统提示词
        isNewSession = false
        console.log(`[Cursor ACP] 已恢复会话: ${options.resumeSessionId}`)
      } catch (err) {
        console.warn(`[Cursor ACP] session/load 失败，改为新建会话:`, err)
      }
    }

    if (!conn.acpSessionId) {
      const res = await conn.request('session/new', {
        cwd: options.cwd,
        mcpServers: acpMcp,
      })
      const sid = typeof res.sessionId === 'string' ? res.sessionId : undefined
      if (!sid) throw new Error('[Cursor ACP] session/new 未返回 sessionId')
      conn.acpSessionId = sid
      options.onSessionId?.(sid)

      // 缓存可用模型表 + 记录 cursor 默认 currentModelId 为已应用基线
      const models = res.models as
        | { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> }
        | undefined
      if (Array.isArray(models?.availableModels)) {
        conn.availableModels = models.availableModels.filter(
          (m): m is { modelId: string; name: string } => typeof m?.modelId === 'string' && typeof m?.name === 'string',
        )
      }
      if (models?.currentModelId) {
        conn.appliedModelId = models.currentModelId
        const cw = parseAcpContextWindow(models.currentModelId)
        if (cw) options.onContextWindow?.(cw)
      }
    }

    this.connections.set(options.sessionId, conn)
    return { conn, isNewSession }
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const options = input as CursorAcpQueryOptions
    const { sessionId } = options

    this.clearIdleTimer(sessionId)

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)

    let conn: AcpConnection
    let isNewSession: boolean
    try {
      const ready = await this.ensureConnection(options)
      conn = ready.conn
      isNewSession = ready.isNewSession
    } catch (err) {
      this.controllers.delete(sessionId)
      const errText = err instanceof Error ? err.message : String(err)
      const classified = classifyCursorError(errText)
      const errResult: SDKResultMessage = {
        type: 'result',
        subtype: 'error',
        usage: { input_tokens: 0, output_tokens: 0 },
        session_id: sessionId,
        errors: [classified.message],
      }
      yield errResult
      return
    }

    const acpSessionId = conn.acpSessionId!

    // 设置权限模式（即时）
    try {
      await conn.request('session/set_mode', { sessionId: acpSessionId, modeId: toAcpMode(options.sdkPermissionMode) })
    } catch (err) {
      console.warn('[Cursor ACP] 初始 set_mode 失败（忽略）:', err)
    }

    // 应用 Proma 选定模型（每轮检查，支持中途换模型）：解析为 ACP modelId 并 set_model
    const targetModelId = resolveAcpModelId(typeof options.model === 'string' ? options.model : undefined, conn.availableModels)
    if (targetModelId && targetModelId !== conn.appliedModelId) {
      try {
        await conn.request('session/set_model', { sessionId: acpSessionId, modelId: targetModelId })
        conn.appliedModelId = targetModelId
        const cw = parseAcpContextWindow(targetModelId)
        if (cw) options.onContextWindow?.(cw)
        console.log(`[Cursor ACP] 已设置模型: ${parseAcpModelName(targetModelId)}`)
      } catch (err) {
        console.warn('[Cursor ACP] session/set_model 失败（沿用默认模型）:', err)
      }
    }
    // 回报实际生效模型（展示名）
    if (conn.appliedModelId) options.onModelResolved?.(parseAcpModelName(conn.appliedModelId))

    // ── 事件队列桥接（push 通知 → pull 异步生成器） ──
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
    const pushMsg = (m: SDKMessage): void => {
      queue.push(m)
      wake()
    }

    // ── 流式累积器：thinking / text 分别累积，遇 tool_call 或回合末 flush ──
    let textBuf = ''
    let thinkingBuf = ''
    let roundTextChars = 0
    let roundThinkingChars = 0
    const flushThinking = (): void => {
      if (!thinkingBuf) return
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: thinkingBuf }],
          model: typeof options.model === 'string' ? options.model : undefined,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      thinkingBuf = ''
      pushMsg(msg)
    }
    const flushText = (): void => {
      if (!textBuf) return
      const msg: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: textBuf }],
          model: typeof options.model === 'string' ? options.model : undefined,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      textBuf = ''
      pushMsg(msg)
    }

    // toolCallId → rawInput（tool_call 通知缓存，供 request_permission 查 input） / 工具名
    const rawInputByToolCall = new Map<string, Record<string, unknown>>()
    const toolNameByToolCall = new Map<string, string>()

    // ── 通知处理：ACP session/update → SDKMessage ──
    conn.onNotification = (method, params) => {
      if (method !== 'session/update') return
      const u = (params.update ?? {}) as Record<string, unknown>
      const kind = u.sessionUpdate as string

      switch (kind) {
        case 'agent_thought_chunk': {
          const text = ((u.content as { text?: string } | undefined)?.text) ?? ''
          if (text) {
            if (textBuf) flushText() // text 在前则先收口（极少见）
            thinkingBuf += text
            roundThinkingChars += text.length
          }
          break
        }
        case 'agent_message_chunk': {
          const text = ((u.content as { text?: string } | undefined)?.text) ?? ''
          if (text) {
            if (thinkingBuf) flushThinking()
            textBuf += text
            roundTextChars += text.length
          }
          break
        }
        case 'tool_call': {
          flushThinking()
          flushText()
          const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : `acp_tool_${Date.now()}`
          const acpKind = typeof u.kind === 'string' ? u.kind : 'other'
          const title = typeof u.title === 'string' ? u.title : acpKind
          const rawInput = (u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}) as Record<string, unknown>
          const toolName = getAcpToolName(acpKind, title)
          rawInputByToolCall.set(toolCallId, rawInput)
          toolNameByToolCall.set(toolCallId, toolName)
          const assistant: SDKAssistantMessage = {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: toolCallId, name: toolName, input: { ...rawInput, _displayName: title } }],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          }
          pushMsg(assistant)
          break
        }
        case 'tool_call_update': {
          const status = u.status as string
          if (status !== 'completed' && status !== 'failed') break
          const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : ''
          if (!toolCallId) break
          const isError = status === 'failed'
          const content = extractToolResultText(u)
          const user: SDKUserMessage = {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content, is_error: isError }],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          }
          pushMsg(user)
          break
        }
        // session_info_update（自动标题）/ current_mode_update / available_commands_update / plan 等：
        // 暂不映射（标题沿用 Proma 既有 generateCursorTitle；其余向前兼容忽略）
        default:
          break
      }
    }

    // ── 服务端→客户端请求处理：权限审批 + fs ──
    conn.onServerRequest = async (method, params) => {
      if (method === 'session/request_permission') {
        return this.handlePermissionRequest(params, options, controller.signal, rawInputByToolCall, toolNameByToolCall)
      }
      if (method === 'fs/read_text_file') {
        return this.handleFsRead(params)
      }
      if (method === 'fs/write_text_file') {
        return this.handleFsWrite(params)
      }
      return {}
    }

    // 用户主动停止（abort()）：唤醒 yield 循环尽快退出，避免悬挂
    const onAbort = (): void => {
      done = true
      wake()
    }
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener('abort', onAbort, { once: true })

    // ── prompt 驱动循环（IIFE）：初始 prompt + 队列续轮 ──
    void (async () => {
      let promptText = ''
      /** 基于本轮累积字符 + 输入 prompt 长度估算 token 用量 */
      const makeEstimatedUsage = (outputOverride?: number): { input_tokens: number; output_tokens: number } => {
        const outputChars = roundTextChars + roundThinkingChars
        return {
          input_tokens: estimateTokens(promptText),
          output_tokens: outputOverride ?? Math.max(1, Math.round(outputChars / 3.5)),
        }
      }

      try {
        promptText = options.prompt
        // 仅新建会话首轮注入系统提示词（后续轮依赖 ACP 会话上下文留存）
        if (isNewSession && !conn.systemPromptInjected) {
          const sp = this.extractSystemPrompt(options)
          if (sp) promptText = `${sp}\n\n---\n\n${promptText}`
          conn.systemPromptInjected = true
        }

        while (true) {
          roundTextChars = 0
          roundThinkingChars = 0
          let result: Record<string, unknown>
          try {
            result = await conn.request('session/prompt', {
              sessionId: acpSessionId,
              prompt: [{ type: 'text', text: promptText }],
            })
          } catch (err) {
            // 用户主动停止（session/cancel 后 abort 杀进程使请求 reject）：静默收尾，不报错
            if (controller.signal.aborted) break
            flushThinking()
            flushText()
            const errText = err instanceof Error ? err.message : String(err)
            const classified = classifyCursorError(errText)
            pushMsg({
              type: 'result',
              subtype: 'error',
              usage: makeEstimatedUsage(),
              session_id: sessionId,
              errors: [classified.message],
            } as SDKResultMessage)
            break
          }

          // 回合末收口残留 thinking/text
          flushThinking()
          flushText()

          const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
          const isErr = stopReason === 'refusal' || stopReason === 'error'
          // 仅软中断（cancelled）需短宽限期覆盖"cancel 使 prompt resolve"与"追加消息入队"的竞态；
          // 自然结束无竞态，立即收口避免给每轮平添延迟。
          const wasCancelled = stopReason === 'cancelled'

          // 等待可能的追加消息：若队列已有 → 立即续轮；否则结束本 query
          const nextText = await this.waitForQueuedPrompt(sessionId, wasCancelled)
          if (nextText != null) {
            // 续轮：发 continuable result 让编排层保持事件循环（不 completeRun）
            pushMsg({
              type: 'result',
              subtype: isErr ? 'error' : 'success',
              usage: makeEstimatedUsage(),
              total_cost_usd: 0,
              session_id: sessionId,
              terminal_reason: 'aborted_streaming',
            } as unknown as SDKResultMessage)
            promptText = nextText
            continue
          }

          // 本轮真正结束
          pushMsg({
            type: 'result',
            subtype: isErr ? 'error' : 'success',
            usage: makeEstimatedUsage(),
            total_cost_usd: 0,
            session_id: sessionId,
          } as SDKResultMessage)
          break
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('[Cursor ACP] prompt 驱动循环异常:', err)
          pushMsg({
            type: 'result',
            subtype: 'error',
            usage: makeEstimatedUsage(),
            session_id: sessionId,
            errors: [err instanceof Error ? err.message : String(err)],
          } as SDKResultMessage)
        }
      } finally {
        done = true
        wake()
      }
    })()

    // ── yield 循环 ──
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
      // 清理本轮处理器与控制器；连接保活以供下一轮复用，挂空闲计时器防泄漏
      conn.onNotification = undefined
      conn.onServerRequest = undefined
      this.controllers.delete(sessionId)
      this.queueWakers.delete(sessionId)
      if (conn.alive) this.armIdleTimer(sessionId)
    }
  }

  /**
   * 等待追加 prompt：队列非空立即返回队首；否则按是否软中断决定收口策略。
   *
   * 设计：本轮 session/prompt 已结束时调用。
   * - 队列已有消息（非中断追加：prompt 跑完时消息早已入队）→ 立即续轮。
   * - 自然结束（graceForRace=false）→ 无竞态，立即返回 null 收口（不给每轮平添延迟）。
   * - 软中断结束（graceForRace=true）→ 给极短宽限期，覆盖"session/cancel 使 prompt 提前 resolve"
   *   与"sendQueuedMessage 入队"之间的竞态；期满仍无消息则 null 收口。
   */
  private waitForQueuedPrompt(sessionId: string, graceForRace: boolean): Promise<string | null> {
    const queue = this.promptQueues.get(sessionId)
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift()!)
    }
    if (!graceForRace) return Promise.resolve(null)
    // 极短宽限期：覆盖"session/cancel 使 prompt resolve"与"sendQueuedMessage 入队"之间的竞态
    return new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (val: string | null): void => {
        if (settled) return
        settled = true
        this.queueWakers.delete(sessionId)
        resolve(val)
      }
      this.queueWakers.set(sessionId, () => {
        const q = this.promptQueues.get(sessionId)
        finish(q && q.length > 0 ? q.shift()! : null)
      })
      setTimeout(() => finish(null), 150).unref?.()
    })
  }

  /** 桥接 session/request_permission → canUseTool → ACP option */
  private async handlePermissionRequest(
    params: Record<string, unknown>,
    options: CursorAcpQueryOptions,
    signal: AbortSignal,
    rawInputByToolCall: Map<string, Record<string, unknown>>,
    toolNameByToolCall: Map<string, string>,
  ): Promise<Record<string, unknown>> {
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>
    const optionsList = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId?: string; kind?: string }>
    const allowOnce = optionsList.find((o) => o.kind === 'allow_once') ?? optionsList[0]
    const rejectOnce = optionsList.find((o) => o.kind === 'reject_once') ?? optionsList[optionsList.length - 1]
    const selectId = (o?: { optionId?: string }): Record<string, unknown> => ({
      outcome: { outcome: 'selected', optionId: o?.optionId },
    })

    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : ''
    const acpKind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
    const toolName = toolNameByToolCall.get(toolCallId) ?? getAcpToolName(acpKind) ?? 'Tool'
    const toolInput = rawInputByToolCall.get(toolCallId) ?? {}

    // 无 canUseTool（理论上不该发生）：默认放行
    if (!options.canUseTool) return selectId(allowOnce)

    try {
      const result = await options.canUseTool(toolName, toolInput, {
        signal,
        toolUseID: toolCallId || `acp_${Date.now()}`,
      })
      if (result.behavior === 'allow') {
        return selectId(allowOnce)
      }
      return selectId(rejectOnce)
    } catch (err) {
      // canUseTool 异常或被中止：保守拒绝
      console.warn('[Cursor ACP] 权限决策异常，拒绝工具:', err)
      return selectId(rejectOnce)
    }
  }

  /** fs/read_text_file：从磁盘读取（agent 一般自行 IO，此为客户端能力声明的兜底实现） */
  private handleFsRead(params: Record<string, unknown>): Record<string, unknown> {
    const path = typeof params.path === 'string' ? params.path : ''
    try {
      const content = readFileSync(path, 'utf8')
      const line = typeof params.line === 'number' ? params.line : undefined
      const limit = typeof params.limit === 'number' ? params.limit : undefined
      if (line != null) {
        const lines = content.split('\n')
        const start = Math.max(0, line - 1)
        const slice = limit != null ? lines.slice(start, start + limit) : lines.slice(start)
        return { content: slice.join('\n') }
      }
      return { content }
    } catch (err) {
      throw new Error(`读取文件失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** fs/write_text_file：写入磁盘（兜底实现） */
  private handleFsWrite(params: Record<string, unknown>): Record<string, unknown> {
    const path = typeof params.path === 'string' ? params.path : ''
    const content = typeof params.content === 'string' ? params.content : ''
    try {
      writeFileSync(path, content, 'utf8')
      return {}
    } catch (err) {
      throw new Error(`写入文件失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 从 tool_call_update 提取工具结果文本（content[].content.text 或 rawOutput） */
function extractToolResultText(update: Record<string, unknown>): string {
  const content = update.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = block as { content?: { text?: string }; text?: string }
      if (b?.content?.text) parts.push(b.content.text)
      else if (typeof b?.text === 'string') parts.push(b.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  const rawOutput = update.rawOutput
  if (rawOutput != null) {
    if (typeof rawOutput === 'string') return rawOutput
    try {
      return JSON.stringify(rawOutput)
    } catch {
      return String(rawOutput)
    }
  }
  return ''
}
