/**
 * 会话检出历史
 *
 * 会话会在「主仓库项目目录」「linked worktree」「会话工作台」之间切换，历史记录这条
 * 轨迹，供主进程解析可用 cwd、重建被删的 worktree、把失效绝对路径重定位到新检出根。
 *
 * 这里的函数都是纯逻辑，目录是否存在的判断由调用方注入，便于单测。
 */

import type { AgentActiveWorktree, AgentCwdMode, SessionCheckoutEntry } from '@proma/shared'

/** 会话检出历史的最大条数；超出时丢弃最早的条目。 */
export const MAX_CHECKOUT_HISTORY = 20

/** 解析结果：命中的历史条目，附带是否发生了回退。 */
export interface SessionCheckoutResolution extends SessionCheckoutEntry {
  /**
   * 命中的不是历史最后一条（或历史为空、退到了默认目录）。
   * 调用方据此把回退目标写回历史，并清理失效的 activeWorktree。
   */
  fellBack: boolean
}

/** 把旧的 activeWorktree 字段转成一条检出记录，兼容未写历史的存量会话。 */
export function checkoutFromActiveWorktree(
  activeWorktree: AgentActiveWorktree,
  baseCommit?: string,
): SessionCheckoutEntry {
  return {
    kind: 'worktree',
    path: activeWorktree.path,
    mainRepoRoot: activeWorktree.mainRepoRoot,
    branch: activeWorktree.branch,
    ...(baseCommit ? { baseCommit } : {}),
    since: activeWorktree.selectedAt,
  }
}

/** agentCwdMode 对应的默认检出目录；项目根或工作台缺失时返回 null。 */
export function defaultCheckout(
  agentCwdMode: AgentCwdMode,
  projectPath: string | undefined,
  workbenchPath: string | undefined,
): SessionCheckoutEntry | null {
  if (agentCwdMode === 'project') {
    return projectPath ? { kind: 'project', path: projectPath, since: 0 } : null
  }
  return workbenchPath ? { kind: 'workbench', path: workbenchPath, since: 0 } : null
}

/**
 * 解析会话当前可用的检出目录。
 *
 * 约定：
 * - 从历史末尾往前找第一个仍存在的目录；命中非末尾条目时标记 fellBack。
 * - 历史为空时尝试 activeWorktree（旧会话只有这个字段）。
 * - 都不可用时退到默认目录（agentCwdMode 决定项目目录或会话工作台），并标记 fellBack。
 * - 没有任何可用目录时返回 null，由调用方兜底到系统默认目录。
 */
export function resolveSessionCheckout(input: {
  history?: SessionCheckoutEntry[]
  activeWorktree?: AgentActiveWorktree
  agentCwdMode: AgentCwdMode
  projectPath?: string
  workbenchPath?: string
  isDirectory: (path: string) => boolean
}): SessionCheckoutResolution | null {
  const history = input.history ?? []
  const lastIndex = history.length - 1

  for (let index = lastIndex; index >= 0; index -= 1) {
    const entry = history[index]
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue
    if (!input.isDirectory(entry.path)) continue
    return { ...entry, fellBack: index !== lastIndex }
  }

  if (history.length === 0 && input.activeWorktree?.path && input.isDirectory(input.activeWorktree.path)) {
    return { ...checkoutFromActiveWorktree(input.activeWorktree), fellBack: false }
  }

  const fallback = defaultCheckout(input.agentCwdMode, input.projectPath, input.workbenchPath)
  if (!fallback) return null
  return { ...fallback, fellBack: history.length > 0 || Boolean(input.activeWorktree?.path) }
}

/**
 * 把一条记录追加到历史末尾。
 *
 * 同一路径只保留最后一次出现（先删除旧条目再追加），并裁剪到 MAX_CHECKOUT_HISTORY，
 * 避免会话在两个目录之间反复切换时历史被同一路径占满。
 */
export function appendCheckoutEntry(
  history: SessionCheckoutEntry[] | undefined,
  entry: SessionCheckoutEntry,
): SessionCheckoutEntry[] {
  const kept = (history ?? []).filter((item) => item.path !== entry.path)
  kept.push(entry)
  return kept.slice(-MAX_CHECKOUT_HISTORY)
}

/** 该路径是否就是历史中的当前检出（最后一条）。 */
export function isCurrentCheckout(history: SessionCheckoutEntry[] | undefined, path: string): boolean {
  const last = history?.[(history?.length ?? 0) - 1]
  return last?.path === path
}