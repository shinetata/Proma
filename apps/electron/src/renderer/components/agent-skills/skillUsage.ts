/**
 * skillUsage — Skill 使用统计的展示口径
 *
 * 主进程按工作区汇总出每个 Skill 的使用情况（会话数 + 最近一次时间），这里决定：
 * - 卡片上的相对时间短语与 tooltip 文案；
 * - 「30 天未用」的闲置判定。
 * 纯函数，便于单测；不依赖 React 或 IPC。
 */

import type { SkillUsageEntry } from '@proma/shared'

/** 超过这个天数没有加载过的非内置 Skill 视为闲置。 */
export const SKILL_IDLE_DAYS = 30

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 卡片右下角的使用时间短语。
 *
 * 约定：未使用过显示「未使用」；时间差先按小时/天分档，再按周、月粗化，
 * 超过一年统一显示「很久前用过」，避免出现「13 个月前用过」这类无信息量的精度。
 */
export function formatSkillUsageAge(usage: SkillUsageEntry | undefined, now: number = Date.now()): string {
  if (!usage) return '未使用'
  const elapsed = Math.max(0, now - usage.lastUsedAt)
  if (elapsed < HOUR_MS) return '刚刚用过'
  if (elapsed < DAY_MS) return '今天用过'
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} 天前用过`
  if (elapsed < SKILL_IDLE_DAYS * DAY_MS) return `${Math.floor(elapsed / (7 * DAY_MS))} 周前用过`
  if (elapsed < 365 * DAY_MS) return `${Math.floor(elapsed / (SKILL_IDLE_DAYS * DAY_MS))} 个月前用过`
  return '很久前用过'
}

/** 悬停卡片使用时间时的完整说明。 */
export function describeSkillUsage(usage: SkillUsageEntry | undefined): string {
  if (!usage) return '还没有在会话中触发过这个 Skill'
  return `${usage.count} 个会话使用过，最近一次 ${new Date(usage.lastUsedAt).toLocaleString('zh-CN')}`
}

/**
 * 判断一个 Skill 是否闲置。
 *
 * 内置 Skill（Proma 的默认能力）永不闲置；工作区 Skill 没有使用记录，
 * 或最近一次使用距 now 已满 30 天时视为闲置。
 */
export function isIdleSkill(input: {
  usage: SkillUsageEntry | undefined
  isBuiltin: boolean
  now?: number
}): boolean {
  if (input.isBuiltin) return false
  if (!input.usage) return true
  const now = input.now ?? Date.now()
  return now - input.usage.lastUsedAt >= SKILL_IDLE_DAYS * DAY_MS
}
