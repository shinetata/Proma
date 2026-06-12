/**
 * Cursor 模型列表 / 连通性测试
 *
 * 通过 cursor-agent CLI 的 --list-models 获取可用模型并验证 API Key 有效性。
 * CLI 缺失时自动安装（托管）。
 */

import { spawn } from 'node:child_process'
import type { ChannelModel, ChannelTestResult, FetchModelsResult } from '@proma/shared'
import { ensureCursorCli } from './cursor-cli-installer'

/** 运行 cursor-agent 并收集输出 */
function runCursorCli(
  cliPath: string,
  args: string[],
  apiKey: string,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
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
  return /unauthor|invalid.*(key|token)|forbidden|401|403|not logged in|please run .*login/i.test(stderr)
}

/** 拉取 Cursor 可用模型列表 */
export async function fetchCursorModels(apiKey: string): Promise<FetchModelsResult> {
  if (!apiKey.trim()) {
    return { success: false, message: '请先填写 Cursor API Key', models: [] }
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
