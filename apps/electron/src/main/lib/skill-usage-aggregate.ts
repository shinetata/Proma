/**
 * Skill 使用统计 — 聚合（纯函数）
 *
 * 与文件系统、IPC 无关，只负责「归属判断 + 按会话数求和」，
 * 便于在单测里直接验证统计口径。
 */

import type { SkillUsageSummary } from '@proma/shared'
import type { SkillUsageActivationRef } from './skill-usage-parse'

/** 单个会话的统计输入。 */
export interface SessionSkillUsageRecord {
  /** 会话最后活动时间，作为该会话里 Skill 的使用时间 */
  lastUsedAt: number
  activations: readonly SkillUsageActivationRef[]
}

/** 任意工作区 Skills 目录的路径特征：/agent-workspaces/{slug}/skills/ */
const WORKSPACE_SKILLS_SEGMENT = /\/agent-workspaces\/[^/]+\/skills\//

/**
 * 判断一次激活是否属于指定工作区。
 *
 * 约定（与商业版一致）：
 * - 有 filePath 且指向本工作区的 skills/ 目录时算作本工作区；
 * - 有 filePath 但指向其他工作区的 skills/ 目录时不算，避免导入/引用记录串项目；
 * - 其余情况（内置 Skill 或未记录路径）按激活时记录的 workspaceSlug 判断。
 */
export function belongsToWorkspace(
  activation: SkillUsageActivationRef,
  workspaceSlug: string,
): boolean {
  if (activation.filePath) {
    const normalized = activation.filePath.replace(/\\/g, '/')
    if (normalized.includes(`/agent-workspaces/${workspaceSlug}/skills/`)) return true
    if (WORKSPACE_SKILLS_SEGMENT.test(normalized)) return false
  }
  return activation.workspaceSlug === workspaceSlug
}

/**
 * 汇总一个工作区内每个 Skill 的使用情况。
 *
 * count 为使用过该 Skill 的会话数，同一会话内即使出现多条激活也只算一次；
 * lastUsedAt 取这些会话里最晚的活动时间。
 */
export function summarizeSkillUsage(
  records: readonly SessionSkillUsageRecord[],
  workspaceSlug: string,
): SkillUsageSummary {
  const usage: SkillUsageSummary = {}

  for (const record of records) {
    const countedSlugs = new Set<string>()
    for (const activation of record.activations) {
      if (countedSlugs.has(activation.slug)) continue
      if (!belongsToWorkspace(activation, workspaceSlug)) continue
      countedSlugs.add(activation.slug)

      const entry = usage[activation.slug]
      if (!entry) {
        usage[activation.slug] = { count: 1, lastUsedAt: record.lastUsedAt }
        continue
      }
      entry.count += 1
      if (record.lastUsedAt > entry.lastUsedAt) entry.lastUsedAt = record.lastUsedAt
    }
  }

  return usage
}
