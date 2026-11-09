import { describe, expect, test } from 'bun:test'
import { classifyPiRetryReason, installPromaRetryClassifier, mapPiNativeRetryEvent } from './pi-retry-control'

/** 模拟 Pi AgentSession 上的私有重试判定：默认一律可重试 */
function createClassifierHost(initial: boolean, hasMethod = true): {
  session: Record<string, unknown>
  calls: () => number
  isRetryable: (message: unknown) => boolean
} {
  let callCount = 0
  const host: Record<string, unknown> = {}
  if (hasMethod) {
    host._isRetryableError = (): boolean => {
      callCount += 1
      return initial
    }
  }
  return {
    session: host,
    calls: () => callCount,
    isRetryable: (message) => (host._isRetryableError as (m: unknown) => boolean).call(host, message),
  }
}

describe('installPromaRetryClassifier', () => {
  test('Given session 没有 _isRetryableError Then 返回 false', () => {
    expect(installPromaRetryClassifier({})).toBe(false)
    expect(installPromaRetryClassifier(undefined)).toBe(false)
    expect(installPromaRetryClassifier(null)).toBe(false)
  })

  test('Given session 带 _isRetryableError Then 安装成功且仍调用原判定', () => {
    const host = createClassifierHost(true)
    expect(installPromaRetryClassifier(host.session)).toBe(true)
    expect(host.isRetryable({ stopReason: 'stop' })).toBe(true)
    expect(host.calls()).toBe(1)
  })

  test('Given 额度不足错误 Then Proma 分类覆盖 Pi 的可重试判定', () => {
    const host = createClassifierHost(true)
    installPromaRetryClassifier(host.session)
    expect(host.isRetryable({ stopReason: 'error', errorMessage: 'insufficient_quota: quota exceeded' })).toBe(false)
  })

  test('Given 代理不可达错误 Then 保持可重试', () => {
    const host = createClassifierHost(true)
    installPromaRetryClassifier(host.session)
    expect(host.isRetryable({ stopReason: 'error', errorMessage: 'net::ERR_PROXY_CONNECTION_FAILED' })).toBe(true)
  })

  test('Given 非 error 结束或缺少 errorMessage Then 沿用 Pi 判定', () => {
    const host = createClassifierHost(true)
    installPromaRetryClassifier(host.session)
    expect(host.isRetryable({ stopReason: 'stop', errorMessage: 'insufficient_quota' })).toBe(true)
    expect(host.isRetryable({ stopReason: 'error' })).toBe(true)
    expect(host.isRetryable('不是对象')).toBe(true)
  })

  test('Given Pi 原本判定不可重试但 Proma 归类为连接失败 Then 放开重试', () => {
    const host = createClassifierHost(false)
    installPromaRetryClassifier(host.session)
    expect(host.isRetryable({ stopReason: 'error', errorMessage: 'net::ERR_NAME_NOT_RESOLVED' })).toBe(true)
  })

  const signatureError = '400 {"error":{"message":"***.***.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}'

  test('Given 思考块签名错误且调用方已安排剥离 Then 原地重试', () => {
    const host = createClassifierHost(false)
    const seen: unknown[] = []
    installPromaRetryClassifier(host.session, {
      recoverThinkingSignature: (message) => {
        seen.push(message)
        return true
      },
    })
    const failed = { stopReason: 'error', errorMessage: signatureError }

    expect(host.isRetryable(failed)).toBe(true)
    expect(seen).toEqual([failed])
  })

  test('Given 思考块签名错误但原地恢复已用尽 Then 按 400 不重试', () => {
    const host = createClassifierHost(false)
    installPromaRetryClassifier(host.session, { recoverThinkingSignature: () => false })

    expect(host.isRetryable({ stopReason: 'error', errorMessage: signatureError })).toBe(false)
  })

  test('Given 未传恢复回调或非签名错误 Then 不触发恢复', () => {
    const plain = createClassifierHost(false)
    installPromaRetryClassifier(plain.session)
    expect(plain.isRetryable({ stopReason: 'error', errorMessage: signatureError })).toBe(false)

    let called = false
    const host = createClassifierHost(false)
    installPromaRetryClassifier(host.session, {
      recoverThinkingSignature: () => {
        called = true
        return true
      },
    })
    expect(host.isRetryable({ stopReason: 'error', errorMessage: '400 Bad Request: invalid tool schema' })).toBe(false)
    expect(called).toBe(false)
  })
})

describe('classifyPiRetryReason', () => {
  test.each([
    ['HTTP 429 rate limit', 'rate_limited'],
    ['incomplete chunked read', 'stream_interrupted'],
    ['Unexpected end of JSON input', 'response_malformed'],
    ['read ECONNRESET', 'connection'],
    ['完全未知的报错', 'unknown'],
  ] as const)('Given "%s" Then 归类为 %s', (message, expected) => {
    expect(classifyPiRetryReason(message)).toBe(expected)
  })
})

describe('mapPiNativeRetryEvent', () => {
  test('Given 首次重试 Then 立即向 UI 上报并带上 reasonKind', () => {
    const updates = mapPiNativeRetryEvent(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2500, errorMessage: 'net::ERR_NAME_NOT_RESOLVED' },
      { runStartedAt: 1 },
      1000,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      status: 'starting',
      attempt: 1,
      maxAttempts: 3,
      delaySeconds: 2.5,
      scheduledAt: 1000,
      reason: 'net::ERR_NAME_NOT_RESOLVED',
      reasonKind: 'connection',
    })
  })

  test('Given 重试成功 Then 上报 cleared', () => {
    const updates = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: true, attempt: 2 } as never,
      { runStartedAt: 1 },
      1000,
    )
    expect(updates[0]).toMatchObject({ status: 'cleared', attempt: 2 })
  })

  test('Given 用户取消重试 Then 上报 cancelled 而不是 failed', () => {
    const updates = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'Retry cancelled' },
      { runStartedAt: 1 },
      1000,
    )
    expect(updates[0]).toMatchObject({ status: 'cancelled', attempt: 2, maxAttempts: 2, reason: 'Retry cancelled' })
  })

  test('Given 重试耗尽 Then 上报 failed 且 attemptData 带 reasonKind', () => {
    const updates = mapPiNativeRetryEvent(
      { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'read ECONNRESET' },
      { runStartedAt: 1 },
      1000,
    )
    expect(updates[0]).toMatchObject({
      status: 'failed',
      attemptData: { attempt: 2, reason: 'read ECONNRESET', reasonKind: 'connection', errorMessage: 'read ECONNRESET' },
    })
  })
})