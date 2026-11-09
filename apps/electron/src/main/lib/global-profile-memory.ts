/**
 * 全局画像（跨项目共享）的读写入口。
 *
 * 界面「关于你」直接编辑画像时也走 `MemoryUpdate`，因此仍受版本校验、预算与锁约束。
 */

import type { GlobalProfileHistoryVersion, GlobalProfileSnapshot } from '@proma/shared'
import {
  inspectLegacyProfileLocations,
  listMemoryHistory,
  memoryPaths,
  pendingMemoryMigrations,
  readMemoryFile,
  readMemoryHistoryVersion,
  readMemoryReview,
  restoreMemoryVersion,
  updateMemory,
  MAX_MEMORY_BYTES,
  type AgentMemoryContext,
  type MemoryHistoryEntry,
} from './agent-memory'

export function readGlobalProfile(ctx: AgentMemoryContext): GlobalProfileSnapshot {
  const file = readMemoryFile(memoryPaths(ctx).profile)
  const { sources, issues } = inspectLegacyProfileLocations(ctx)
  let pendingCount = 0
  try {
    pendingCount = pendingMemoryMigrations(ctx).length
  } catch (error) {
    issues.push({ path: ctx.globalDir, message: `迁移记录检查失败：${String(error)}` })
  }
  return {
    ...file,
    checkedAt: readMemoryReview(ctx, file).checkedAt,
    legacyCount: sources.length,
    pendingCount,
    migrationIssues: issues,
  }
}

export function writeGlobalProfile(
  ctx: AgentMemoryContext,
  revision: string,
  content: string,
): GlobalProfileSnapshot {
  if (
    typeof revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(revision) ||
    typeof content !== 'string' ||
    !content.trim() ||
    Buffer.byteLength(content) > MAX_MEMORY_BYTES
  ) {
    throw new Error('请输入有效画像内容（不超过 512 KiB），并先读取当前版本。')
  }
  updateMemory(ctx, 'global-profile', revision, content, '用户在「关于你」中直接编辑并保存。')
  return readGlobalProfile(ctx)
}

/** 历史版本列表：面板里的「历史版本」区块直接展示这些条目。 */
export function readGlobalProfileHistory(ctx: AgentMemoryContext, limit?: number): MemoryHistoryEntry[] {
  return listMemoryHistory(ctx, 'global-profile', limit)
}

/** 读取某一历史版本的正文，供恢复前预览。 */
export function readGlobalProfileHistoryVersion(
  ctx: AgentMemoryContext,
  revision: string,
): GlobalProfileHistoryVersion {
  const file = readMemoryHistoryVersion(ctx, 'global-profile', revision)
  if (file.content === null) throw new Error('该历史版本不存在或已被清理。')
  return { revision, content: file.content }
}

/** 恢复历史版本；恢复本身也生成新版本，原内容继续保留在历史中。 */
export function restoreGlobalProfileHistory(
  ctx: AgentMemoryContext,
  revision: string,
  expectedRevision: string,
): GlobalProfileSnapshot {
  if (!/^[a-f0-9]{64}$/.test(revision) || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new Error('请先刷新画像，再选择要恢复的历史版本。')
  }
  restoreMemoryVersion(ctx, 'global-profile', revision, expectedRevision, '用户在「关于你」中从历史版本恢复。')
  return readGlobalProfile(ctx)
}
