import { describe, expect, test } from 'bun:test'
import { AgentExitPlanService } from './agent-exit-plan-service'

describe('ExitPlanMode 合成审批', () => {
  test('Given requestPlanApproval 后 clearSessionPending When 用户批准 Then respondToExitPlanMode 返回 null（回归）', () => {
    const service = new AgentExitPlanService()
    const sessionId = 'session-regression'

    const request = service.requestPlanApproval(
      sessionId,
      { planPath: '/tmp/plan.md', planSummary: 'test plan' },
      () => { /* noop */ },
    )

    service.clearSessionPending(sessionId)

    const result = service.respondToExitPlanMode({
      requestId: request.requestId,
      action: 'approve_auto',
    })

    expect(result).toBeNull()
  })

  test('Given requestPlanApproval 后未清理 When 用户批准 Then 应自动续跑', () => {
    const service = new AgentExitPlanService()
    const sessionId = 'session-happy-path'

    const request = service.requestPlanApproval(
      sessionId,
      { planPath: '/tmp/plan.md', planSummary: 'test plan' },
      () => { /* noop */ },
    )

    const result = service.respondToExitPlanMode({
      requestId: request.requestId,
      action: 'approve_auto',
    })

    expect(result).not.toBeNull()
    expect(result?.sessionId).toBe(sessionId)
    expect(result?.targetMode).toBe('bypassPermissions')
    expect(result?.shouldAutoContinue).toBe(true)
    expect(result?.source).toBe('cursor_synthetic')
    expect(result?.planPath).toBe('/tmp/plan.md')
  })
})
