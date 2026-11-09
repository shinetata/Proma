import type { AgentSendInput } from '@proma/shared'

const PLANNING_DELETION_TOOLS = new Set([
  'mcp__planning__delete_todo',
  'mcp__planning__delete_calendar_event',
  'mcp__planning__delete_group',
  'mcp__planning__delete_tag',
  'mcp__planning__delete_reminder',
])

export type PlanningDeletionPermissionDecision =
  | 'not-planning-deletion'
  | 'allow'
  | 'deny-unattended'

/**
 * 将 Planning 删除操作映射为编排层可执行的权限决策。
 *
 * 权限模式与逐次确认已下线：用户主会话的删除直接放行，
 * 自动任务与协作子会话始终不能删除本地规划数据。
 */
export function resolvePlanningDeletionPermission(
  toolName: string,
  triggeredBy: AgentSendInput['triggeredBy'],
): PlanningDeletionPermissionDecision {
  if (!PLANNING_DELETION_TOOLS.has(toolName)) return 'not-planning-deletion'

  if (triggeredBy === 'automation' || triggeredBy === 'delegation') {
    return 'deny-unattended'
  }

  return 'allow'
}