import { describe, expect, test } from 'bun:test'
import { AgentExitPlanService } from './agent-exit-plan-service'

describe('ExitPlanMode 审批', () => {
  test('Given handleExitPlanMode 后 clearSessionPending When 中止 Then respondToExitPlanMode 返回 null', () => {
    const service = new AgentExitPlanService()
    const sessionId = 'session-regression'
    const abortController = new AbortController()

    const promise = service.handleExitPlanMode(
      sessionId,
      { planPath: '/tmp/plan.md', planSummary: 'test plan' },
      abortController.signal,
      () => { /* noop */ },
    )

    service.clearSessionPending(sessionId)

    // After clearSessionPending, the promise should resolve with 'deny'
    promise.then((result) => {
      expect(result.behavior).toBe('deny')
    })
  })

  test('Given handleExitPlanMode 未清理 When 用户批准 Then 返回 allow', async () => {
    const service = new AgentExitPlanService()
    const sessionId = 'session-happy-path'
    const abortController = new AbortController()

    let capturedRequest: unknown = null
    const promise = service.handleExitPlanMode(
      sessionId,
      { planPath: '/tmp/plan.md', planSummary: 'test plan' },
      abortController.signal,
      (request) => { capturedRequest = request },
    )

    // Verify the request was sent
    expect(capturedRequest).not.toBeNull()
    const req = capturedRequest as { requestId: string }
    expect(req.requestId).toBeDefined()

    // Respond with approve_auto
    const result = service.respondToExitPlanMode({
      requestId: req.requestId,
      action: 'approve_auto',
    })

    expect(result).not.toBeNull()
    expect(result?.sessionId).toBe(sessionId)
    expect(result?.targetMode).toBe('bypassPermissions')
    expect(result?.shouldAutoContinue).toBe(false)

    // The promise should resolve with allow
    const permResult = await promise
    expect(permResult.behavior).toBe('allow')
  })
})
