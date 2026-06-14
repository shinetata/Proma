import type { ExitPlanModeAction } from '@proma/shared'

export function buildPlanExecutionUserMessage(planPath?: string): string {
  const trimmed = planPath?.trim()
  if (trimmed) {
    return `请执行该计划\n\n计划文件：${trimmed}`
  }
  return '请执行该计划'
}

export function shouldAutoContinuePlanExecution(
  _source: string | undefined,
  _action: ExitPlanModeAction,
): boolean {
  // ExitPlanMode 统一由 tool_callback 路径处理，不再有 cursor_synthetic。
  // 保留此函数供未来需要时扩展。
  return false
}
