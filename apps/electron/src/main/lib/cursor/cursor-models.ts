/**
 * Cursor 模型列表 / 连通性测试
 *
 * 通过 cursor-agent CLI 的 --list-models 获取可用模型并验证 API Key 有效性。
 * CLI 缺失时自动安装（托管）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { ChannelModel, ChannelTestResult, FetchModelsResult } from '@proma/shared'
import { ensureCursorCli } from './cursor-cli-installer'

/** 模型列表缓存（key = hash(apiKey)，5 分钟 TTL） */
interface ModelCacheEntry {
  models: ChannelModel[]
  ts: number
}
const modelCache = new Map<string, ModelCacheEntry>()
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000  // 5 分钟
const MODEL_LIST_TIMEOUT_MS = 15_000       // 从 30s 缩短至 15s

/** 运行 cursor-agent 并收集输出 */
function runCursorCli(
  cliPath: string,
  args: string[],
  apiKey: string,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      cwd,
      env: { ...process.env, CURSOR_API_KEY: apiKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 从 --list-models 输出解析模型 ID 列表 */
function parseModelList(stdout: string): string[] {
  const ids = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    // 去除列表标记 / 当前选中标记
    const line = rawLine.replace(/^[\s*\-•>]+/, '').trim()
    if (!line) continue
    // 取首个 token 作为模型 ID
    const token = line.split(/\s+/)[0]!
    // 过滤明显的标题行 / 提示语
    if (!/^[A-Za-z0-9][\w.\-:/]*$/.test(token)) continue
    ids.add(token)
  }
  return [...ids]
}

/** 判断 stderr 是否为认证失败 */
function isAuthError(stderr: string): boolean {
  return /unauthor|invalid.*(key|token)|forbidden|401|403|not logged in|please run .*login|login expired|token revoked|subscription.*expired|key.*revoked|auth.*failed/i.test(stderr)
}

/** 拉取 Cursor 可用模型列表 */
export async function fetchCursorModels(apiKey: string): Promise<FetchModelsResult> {
  if (!apiKey.trim()) {
    return { success: false, message: '请先填写 Cursor API Key', models: [] }
  }

  // 检查缓存
  const cacheKey = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  const cached = modelCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < MODEL_CACHE_TTL_MS) {
    return { success: true, message: `成功获取 ${cached.models.length} 个模型（缓存）`, models: cached.models }
  }

  let cliPath: string
  try {
    cliPath = (await ensureCursorCli()).path
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Cursor CLI 安装失败', models: [] }
  }

  const { code, stdout, stderr } = await runCursorCli(cliPath, ['--list-models'], apiKey)
  if (isAuthError(stderr)) {
    return { success: false, message: 'API Key 无效或未授权', models: [] }
  }
  if (code !== 0) {
    return { success: false, message: `获取模型失败 (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`, models: [] }
  }

  const modelIds = parseModelList(stdout)
  if (modelIds.length === 0) {
    return { success: false, message: '未解析到可用模型，请确认 CLI 版本与登录状态', models: [] }
  }

  const models: ChannelModel[] = modelIds.map((id) => ({ id, name: id, enabled: true }))

  // 写入缓存
  modelCache.set(cacheKey, { models, ts: Date.now() })

  return { success: true, message: `成功获取 ${models.length} 个模型`, models }
}

/** 测试 Cursor 渠道连通性（验证 CLI + API Key） */
export async function testCursorConnection(apiKey: string): Promise<ChannelTestResult> {
  if (!apiKey.trim()) {
    return { success: false, message: '请先填写 Cursor API Key' }
  }
  let cliPath: string
  try {
    cliPath = (await ensureCursorCli()).path
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Cursor CLI 安装失败' }
  }

  const { code, stdout, stderr } = await runCursorCli(cliPath, ['--list-models'], apiKey)
  if (isAuthError(stderr)) {
    return { success: false, message: 'API Key 无效或未授权' }
  }
  if (code === 0 && parseModelList(stdout).length > 0) {
    return { success: true, message: '连接成功' }
  }
  return { success: false, message: `连接失败 (exit ${code})${stderr ? `: ${stderr.slice(0, 150)}` : ''}` }
}

/**
 * 用 cursor-agent CLI 生成会话标题（一次性 LLM 摘要）
 *
 * Cursor 无 HTTP 标题端点，改用 headless 一次性调用（-p + text 输出）做摘要，
 * 让 Cursor 会话与其他渠道一样获得 LLM 总结的标题。
 *
 * 关键点（对齐 CursorAgentAdapter.buildArgs，否则 headless 无输出）：
 * - `-p/--print` 为布尔 flag，prompt 是位置参数，必须放在所有 flag 之后。
 * - headless 下用 `--force --trust` 自动放行，避免权限/信任提示导致停顿至超时。
 * - 在临时目录运行（不传 --workspace），避免 agent 探查工作区文件。
 * - 任何失败 / 超时 / 空输出返回 null，由调用方回退到本地启发式。
 */
export async function generateCursorTitle(
  apiKey: string,
  modelId: string | undefined,
  prompt: string,
): Promise<string | null> {
  if (!apiKey.trim()) return null

  let cliPath: string
  try {
    cliPath = (await ensureCursorCli()).path
  } catch {
    return null
  }

  const args = ['-p', '--output-format', 'text', '--force', '--trust']
  if (modelId) args.push('--model', modelId)
  // 位置参数 prompt 放最后，避免被前置 flag 解析吞掉
  args.push(prompt)

  const { code, stdout, stderr } = await runCursorCli(cliPath, args, apiKey, 20_000, tmpdir())
  if (code !== 0) {
    console.warn(`[Cursor 标题] CLI 退出码非零 (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
    return null
  }

  const text = stdout.trim()
  if (!text) {
    console.warn(`[Cursor 标题] CLI 输出为空${stderr ? `，stderr: ${stderr.slice(0, 200)}` : ''}`)
    return null
  }
  return text
}
