/**
 * Cursor CLI 安装器（托管自动安装）
 *
 * 使用 Cursor 官方安装脚本自动安装 cursor-agent 到 ~/.local/bin，
 * 不随应用分发二进制（遵守 Cursor CLI 许可，不再分发）。
 * - macOS / Linux: curl https://cursor.com/install -fsS | bash
 * - Windows: powershell irm 'https://cursor.com/install?win32=true' | iex
 *
 * 更新走 cursor-agent 自带的 `update` 子命令。
 */

import { spawn } from 'node:child_process'
import { findCursorCli, clearCursorCliCache } from './cursor-cli-finder'
import type { CursorCliInfo } from './cursor-cli-finder'

const IS_WINDOWS = process.platform === 'win32'

/** 安装/更新结果 */
export interface CursorInstallResult {
  success: boolean
  message: string
  path?: string
}

/** 安装进行中的去重 Promise（避免并发触发多次下载） */
let installInFlight: Promise<CursorInstallResult> | null = null

/** 运行官方安装脚本 */
function runInstallScript(onLog?: (line: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = IS_WINDOWS
      ? spawn('powershell', ['-NoProfile', '-Command', "irm 'https://cursor.com/install?win32=true' | iex"], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('bash', ['-c', 'curl https://cursor.com/install -fsS | bash'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => onLog?.(c.toString()))
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString()
      stderr += s
      onLog?.(s)
    })
    child.on('error', (err) => resolve({ code: -1, stderr: String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

/**
 * 安装 Cursor CLI（若已安装则直接返回）
 *
 * 并发调用共享同一安装过程。
 */
export async function installCursorCli(onLog?: (line: string) => void): Promise<CursorInstallResult> {
  const existing = findCursorCli(false)
  if (existing) return { success: true, message: '已安装', path: existing.path }

  if (installInFlight) return installInFlight

  installInFlight = (async (): Promise<CursorInstallResult> => {
    try {
      console.log('[Cursor 安装] 开始安装 cursor-agent CLI...')
      const { code, stderr } = await runInstallScript(onLog)
      clearCursorCliCache()
      const found = findCursorCli(false)
      if (found) {
        console.log(`[Cursor 安装] 安装成功: ${found.path}`)
        return { success: true, message: '安装成功', path: found.path }
      }
      return {
        success: false,
        message: `安装失败 (exit ${code})${stderr ? `: ${stderr.slice(0, 300)}` : '，请检查网络连接'}`,
      }
    } catch (err) {
      return { success: false, message: `安装失败: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      installInFlight = null
    }
  })()

  return installInFlight
}

/**
 * 确保 Cursor CLI 可用：已安装则返回路径，否则自动安装
 *
 * @throws 安装失败时抛出错误
 */
export async function ensureCursorCli(onLog?: (line: string) => void): Promise<CursorCliInfo> {
  const existing = findCursorCli()
  if (existing) return existing

  const result = await installCursorCli(onLog)
  if (!result.success || !result.path) {
    throw new Error(result.message || 'Cursor CLI 安装失败')
  }
  return findCursorCli(false) ?? { path: result.path }
}

/** 更新 Cursor CLI（调用 cursor-agent update；未安装则改为安装） */
export async function updateCursorCli(onLog?: (line: string) => void): Promise<CursorInstallResult> {
  const cli = findCursorCli()
  if (!cli) return installCursorCli(onLog)

  return new Promise<CursorInstallResult>((resolve) => {
    const child = spawn(cli.path, ['update'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => onLog?.(c.toString()))
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString()
      stderr += s
      onLog?.(s)
    })
    child.on('error', (err) => resolve({ success: false, message: String(err) }))
    child.on('close', (code) => {
      clearCursorCliCache()
      resolve(
        code === 0
          ? { success: true, message: '更新完成', path: cli.path }
          : { success: false, message: `更新失败 (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}` },
      )
    })
  })
}
