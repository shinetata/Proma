import type { AgentPlanModeChangeSource } from '@proma/shared'

export interface PlanModeChange {
  active: boolean
  source: AgentPlanModeChangeSource
}

/** 解析 SwitchMode 工具输入是否进入计划态 */
export function parseSwitchModePlanActive(input: Record<string, unknown> | undefined): boolean | null {
  if (!input) return null
  const target = typeof input.target_mode_id === 'string' ? input.target_mode_id : ''
  if (!target) return null
  return target.toLowerCase().includes('plan')
}

/** 从 SDK 工具名解析计划阶段变化。 */
export function getPlanModeChangeFromToolName(
  toolName: string,
  toolInput?: Record<string, unknown>,
): PlanModeChange | null {
  if (toolName === 'EnterPlanMode') {
    return { active: true, source: 'tool' }
  }
  if (toolName === 'SwitchMode') {
    const active = parseSwitchModePlanActive(toolInput)
    if (active == null) return null
    return { active, source: 'tool' }
  }
  // ExitPlanMode 只是发起退出计划的审批请求，不能在工具开始时视为已退出。
  // 真正退出由后端在用户批准后发送 plan_mode_changed(active=false)。
  return null
}

/** 更新计划阶段会话集合；无变化时复用原 Set，减少 Jotai 下游刷新。 */
export function updatePlanModeSessionSet(
  prev: Set<string>,
  sessionId: string,
  active: boolean,
): Set<string> {
  if (active) {
    if (prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.add(sessionId)
    return next
  }

  if (!prev.has(sessionId)) return prev
  const next = new Set(prev)
  next.delete(sessionId)
  return next
}
