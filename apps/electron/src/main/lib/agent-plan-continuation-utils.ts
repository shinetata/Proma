import type { ExitPlanModeAction, ExitPlanModeRequestSource } from '@proma/shared'

export function buildPlanExecutionUserMessage(planPath?: string): string {
  const trimmed = planPath?.trim()
  if (trimmed) {
    return `请执行该计划\n\n计划文件：${trimmed}`
  }
  return '请执行该计划'
}

export function shouldAutoContinuePlanExecution(
  source: ExitPlanModeRequestSource | undefined,
  action: ExitPlanModeAction,
): boolean {
  if (source !== 'cursor_synthetic') return false
  return action === 'approve_auto' || action === 'approve_edit'
}
