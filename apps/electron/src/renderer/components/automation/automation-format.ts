/**
 * 定时任务展示层工具函数（对齐商业版 0.21.88 产物 25734-25876 行）
 *
 * - formatAutomationSchedule：调度文案（Kke）
 * - formatAutomationWeekdays：运行日文案（nst）
 * - formatAutomationNextRun：下次运行 / 已完成 / 已暂停（Xke）
 * - groupAutomations：搜索过滤 + 启用中 / 已暂停 / 已完成分组（Zit）
 * - listAutomationRuns：任务的运行会话列表（Jit）
 * - collectUnreadRunCounts / collectAutomationsWithUnread：待查看计数（tst / est）
 */

import { getAgentSessionActivityAt, type AgentSessionMeta, type Automation, type AutomationRun } from '@proma/shared'
import type { AutomationSessionSort } from '@/atoms/automation-atoms'

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 运行日文案（商业版 nst） */
export function formatAutomationWeekdays(days?: number[]): string {
  const normalized = [...new Set(days ?? [])].sort((a, b) => a - b)
  if (normalized.length === 0) return '每天'
  if (normalized.join(',') === '1,2,3,4,5') return '工作日'
  if (normalized.join(',') === '0,6') return '周末'
  return normalized.map((day) => WEEKDAY_NAMES[day] ?? '').filter(Boolean).join('、')
}

/** 调度配置的可读文案（商业版 Kke） */
export function formatAutomationSchedule(a: Automation): string {
  if (a.scheduleType === 'once') {
    const when = a.scheduledAt
      ? new Date(a.scheduledAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '指定时间'
    return `仅一次 ${when}`
  }
  if (a.scheduleType === 'daily') return `每天 ${a.timeOfDay ?? '09:00'}`
  if (a.scheduleType === 'weekly') return `每${WEEKDAY_NAMES[a.dayOfWeek ?? 1]} ${a.timeOfDay ?? '09:00'}`
  if (a.scheduleType === 'monthly') {
    const dom = a.dayOfMonth ?? 1
    const suffix = dom >= 29 ? '（短月落在最后一天）' : ''
    return `每月 ${dom} 号 ${a.timeOfDay ?? '09:00'}${suffix}`
  }
  const min = a.intervalMinutes
  let label: string
  if (min < 60) label = `每 ${min} 分钟`
  else if (min < 1440) label = `每 ${min / 60} 小时`
  else label = `每 ${min / 1440} 天`
  const weekdayLabel = a.activeWeekdays && a.activeWeekdays.length > 0 ? ` · ${formatAutomationWeekdays(a.activeWeekdays)}` : ''
  const windowLabel = a.activeWindowStart && a.activeWindowEnd ? ` · ${a.activeWindowStart}–${a.activeWindowEnd}` : ''
  const maxRunsLabel = a.maxRuns !== undefined ? ` · 限 ${a.maxRuns} 次` : ''
  return `${label}${weekdayLabel}${windowLabel}${maxRunsLabel}`
}

/** 下次运行 / 已完成 / 已暂停（商业版 Xke） */
export function formatAutomationNextRun(a: Automation): string {
  if (a.active) {
    return `下次 ${new Date(a.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`
  }
  return a.completedAt ? '已完成' : '已暂停'
}

/** 运行会话时间（商业版 O5） */
export function formatRunTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 单次运行结果文案（商业版 bD） */
export function formatRunResult(run: AutomationRun): string {
  if (run.status === 'success') {
    return run.durationMs === undefined
      ? '已完成'
      : `已完成 · ${Math.max(1, Math.round(run.durationMs / 1000))} 秒`
  }
  if (run.status === 'skipped') return run.skipReason || '本次跳过'
  return run.error || '执行失败'
}

/** 运行记录的稳定 key（商业版 i2e） */
export function getRunKey(run: AutomationRun): string {
  return `${run.sessionId}:${run.runAt}`
}

/** 会话活动时间（商业版 xd）：取 lastActivityAt，旧数据回退 updatedAt */
export function getSessionActivityTime(session: AgentSessionMeta): number {
  return getAgentSessionActivityAt(session)
}

function getAutomationRecency(a: Automation): number {
  return a.completedAt ?? a.updatedAt ?? a.lastRunAt ?? a.createdAt
}

function compareByRecency(a: Automation, b: Automation): number {
  return getAutomationRecency(b) - getAutomationRecency(a) || a.name.localeCompare(b.name, 'zh-CN')
}

function compareByNextRun(a: Automation, b: Automation): number {
  return a.nextRunAt - b.nextRunAt || a.name.localeCompare(b.name, 'zh-CN')
}

export interface AutomationGroups {
  active: Automation[]
  paused: Automation[]
  completed: Automation[]
}

/** 搜索过滤 + 分组（商业版 Kit / Xit / Zit） */
export function groupAutomations(automations: Automation[], query: string): AutomationGroups {
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = automations.filter((a) => (
    normalized ? `${a.name}\n${a.prompt}`.toLocaleLowerCase().includes(normalized) : true
  ))
  return {
    active: filtered.filter((a) => a.active).sort(compareByNextRun),
    paused: filtered.filter((a) => !a.active && !a.completedAt).sort(compareByRecency),
    completed: filtered.filter((a) => !a.active && !!a.completedAt).sort(compareByRecency),
  }
}

/**
 * 任务的运行会话列表（商业版 Jit）
 * - 运行历史按会话去重；未读会话优先，跳过记录排在最后
 * - 补充 runHistory 已截断但仍标记 sourceAutomationId 的会话
 */
export function listAutomationRuns(
  automation: Automation,
  sessions: AgentSessionMeta[],
  unviewedSessionIds: Set<string> = new Set(),
  sort: AutomationSessionSort = 'activity',
): AutomationRun[] {
  const seen = new Set<string>()
  const rank = (run: AutomationRun): number => (
    run.status !== 'skipped' && unviewedSessionIds.has(run.sessionId) ? 0 : run.status !== 'skipped' ? 1 : 2
  )
  const history = [...automation.runHistory]
    .sort((a, b) => rank(a) - rank(b) || b.runAt - a.runAt)
    .filter((run) => {
      if (!run.sessionId) return true
      if (seen.has(run.sessionId)) return false
      seen.add(run.sessionId)
      return true
    })
  const extra: AutomationRun[] = sessions
    .filter((session) => session.sourceAutomationId === automation.id && !seen.has(session.id))
    .map((session) => ({ sessionId: session.id, runAt: getAgentSessionActivityAt(session) || session.createdAt, status: 'success' }))
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const sortTime = (run: AutomationRun): number => {
    const session = sessionById.get(run.sessionId)
    if (!session) return run.runAt
    return sort === 'activity' ? getSessionActivityTime(session) : session.createdAt
  }
  return [...history, ...extra].sort((a, b) => (
    (sort === 'activity' ? rank(a) - rank(b) : 0)
    || (sort === 'created-asc' ? 1 : -1) * (sortTime(a) - sortTime(b))
    || a.sessionId.localeCompare(b.sessionId)
    || b.runAt - a.runAt
  ))
}

/** 含未读运行会话的任务 ID（商业版 est） */
export function collectAutomationsWithUnread(
  automations: Automation[],
  sessions: AgentSessionMeta[],
  unviewedSessionIds: Set<string>,
): Set<string> {
  const ids = new Set<string>()
  for (const a of automations) {
    if (a.runHistory.some((run) => run.status !== 'skipped' && unviewedSessionIds.has(run.sessionId))) ids.add(a.id)
  }
  for (const session of sessions) {
    if (session.sourceAutomationId && unviewedSessionIds.has(session.id)) ids.add(session.sourceAutomationId)
  }
  return ids
}

/** 每个任务的待查看会话数（商业版 tst） */
export function collectUnreadRunCounts(
  automations: Automation[],
  unviewedSessionIds: Set<string>,
  sessions: AgentSessionMeta[] = [],
): Map<string, number> {
  const map = new Map<string, Set<string>>()
  for (const a of automations) {
    const ids = new Set(
      a.runHistory
        .filter((run) => run.status !== 'skipped' && unviewedSessionIds.has(run.sessionId))
        .map((run) => run.sessionId),
    )
    if (ids.size > 0) map.set(a.id, ids)
  }
  for (const session of sessions) {
    if (!session.sourceAutomationId || !unviewedSessionIds.has(session.id)) continue
    const ids = map.get(session.sourceAutomationId) ?? new Set<string>()
    ids.add(session.id)
    map.set(session.sourceAutomationId, ids)
  }
  return new Map([...map].map(([id, ids]) => [id, ids.size]))
}
