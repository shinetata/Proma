/**
 * 全局画像（跨项目共享）的读写入口。
 *
 * 界面「关于你」直接编辑画像时也走 `MemoryUpdate`，因此仍受版本校验、预算与锁约束。
 */

import type { GlobalProfileSnapshot } from '@proma/shared'
import {
  inspectLegacyProfileLocations,
  memoryPaths,
  pendingMemoryMigrations,
  readMemoryFile,
  readMemoryReview,
  updateMemory,
  MAX_MEMORY_BYTES,
  type AgentMemoryContext,
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
