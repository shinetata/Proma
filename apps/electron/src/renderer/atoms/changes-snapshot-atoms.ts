/**
 * 连续改动视图的数据快照
 *
 * 一次性读改动列表 + 每个仓库的 patch，缓存下来供「改动」Tab 切走再切回时立即渲染（SWR），
 * 避免每次都重新拉取并解析整仓库 diff。
 */

import { atom } from 'jotai'
import type { SessionFileChange } from '@/lib/session-file-changes'
import type { ChangesFile } from '@/components/diff/continuous-diff-rows'

/** 单个 Git 仓库的改动快照 */
export interface ChangesRepoSnapshot {
  /** 仓库根目录（绝对路径） */
  gitRoot: string
  /** 展示名：仓库根目录的最后一段 */
  name: string
  /** 该仓库内的改动文件，已按路径排序 */
  files: ChangesFile[]
  additions: number
  deletions: number
  /** patch 因体积超限被截断，文件可能不完整 */
  truncated: boolean
  /** patch 读取失败 */
  failed: boolean
}

/** 一次改动快照 */
export interface ChangesSnapshot {
  /** 是否处于 Git 仓库中 */
  isGit: boolean
  /** 按仓库名排序的 Git 改动 */
  repos: ChangesRepoSnapshot[]
  /** 非 Git 目录中由 Agent 写入的文件（无基线可比较） */
  nonGit: SessionFileChange[]
  /** 文件路径 → 所属仓库根，还原与读取完整内容时使用 */
  gitRootByPath: Map<string, string>
  totals: { files: number; additions: number; deletions: number }
}

/** 空快照：加载中或非 Git 目录的初值 */
export const EMPTY_CHANGES_SNAPSHOT: ChangesSnapshot = {
  isGit: false,
  repos: [],
  nonGit: [],
  gitRootByPath: new Map(),
  totals: { files: 0, additions: 0, deletions: 0 },
}

/** sessionId → 最近一次改动快照（含 worktree 维度，见 getChangesSnapshotCacheKey） */
export const changesSnapshotMapAtom = atom<Map<string, ChangesSnapshot>>(new Map())

/** 快照缓存 key：会话模式与 worktree 模式互不复用。 */
export function getChangesSnapshotCacheKey(sessionId: string, worktreePath?: string | null): string {
  return worktreePath ? `${sessionId}:worktree:${worktreePath}` : `${sessionId}:session`
}
