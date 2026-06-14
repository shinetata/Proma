/**
 * Cursor CLI 定位器
 *
 * 在用户系统中查找 cursor-agent 可执行文件。查找优先级：
 * 1. 环境变量 PROMA_CURSOR_AGENT_PATH 显式指定
 * 2. 官方默认安装目录 ~/.local/bin/cursor-agent（curl https://cursor.com/install）
 * 3. 版本目录 ~/.local/share/cursor-agent/versions/<ver>/cursor-agent（取最新）
 * 4. PATH 中的 cursor-agent / agent
 *
 * Windows 对应 .exe 后缀及用户目录下安装位置。
 */

import { existsSync, statSync, readdirSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'
const BIN_NAME = IS_WINDOWS ? 'cursor-agent.exe' : 'cursor-agent'
const ALT_BIN_NAME = IS_WINDOWS ? 'agent.exe' : 'agent'

/** Cursor CLI 定位信息 */
export interface CursorCliInfo {
  /** 可执行文件绝对路径 */
  path: string
  /** 版本号（解析失败为 undefined） */
  version?: string
}

/** 判断路径是否为可执行文件 */
function isExecutable(p: string): boolean {
  try {
    if (!p || !existsSync(p)) return false
    if (!statSync(p).isFile()) return false
    if (!IS_WINDOWS) accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 候选安装路径（不含 PATH 查找） */
function candidatePaths(): string[] {
  const home = homedir()
  const out: string[] = []

  const override = process.env.PROMA_CURSOR_AGENT_PATH
  if (override) out.push(override)

  // 官方默认安装目录
  out.push(join(home, '.local', 'bin', BIN_NAME))
  out.push(join(home, '.local', 'bin', ALT_BIN_NAME))

  // 版本目录（目录名倒序，通常最新版本在前）
  const versionsDir = join(home, '.local', 'share', 'cursor-agent', 'versions')
  try {
    if (existsSync(versionsDir)) {
      for (const d of readdirSync(versionsDir).sort().reverse()) {
        out.push(join(versionsDir, d, BIN_NAME))
      }
    }
  } catch {
    /* 忽略读取失败 */
  }

  return out
}

/** 通过 PATH 查找（which / where） */
function findOnPath(): string | null {
  const finder = IS_WINDOWS ? 'where' : 'which'
  for (const name of ['cursor-agent', 'agent']) {
    try {
      const out = execFileSync(finder, [name], { encoding: 'utf8', timeout: 5000 })
        .split(/\r?\n/)[0]
        ?.trim()
      if (out && isExecutable(out)) return out
    } catch {
      /* 未找到 */
    }
  }
  return null
}

/** 查询 CLI 版本（失败返回 undefined） */
function queryVersion(p: string): string | undefined {
  try {
    const out = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

let cached: CursorCliInfo | null = null

/**
 * 查找 cursor-agent CLI；返回 null 表示未安装
 *
 * @param useCache 是否使用缓存（安装/更新后应传 false 强制重新查找）
 */
export function findCursorCli(useCache = true): CursorCliInfo | null {
  if (useCache && cached && isExecutable(cached.path)) return cached

  for (const p of candidatePaths()) {
    if (isExecutable(p)) {
      cached = { path: p, version: queryVersion(p) }
      return cached
    }
  }

  const onPath = findOnPath()
  if (onPath) {
    cached = { path: onPath, version: queryVersion(onPath) }
    return cached
  }

  cached = null
  return null
}

/** 清除定位缓存 */
export function clearCursorCliCache(): void {
  cached = null
}
