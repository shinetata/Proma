import { describe, expect, test } from 'bun:test'
import {
  applyThinkingReplayPolicy,
  createThinkingReplayState,
  MAX_THINKING_SIGNATURE_RECOVERIES,
  prepareThinkingSignatureRecovery,
} from './pi-thinking-replay'

interface TestMessage {
  role: string
  content: unknown
  timestamp?: number
}

function assistant(timestamp: number, signature?: string): TestMessage {
  return {
    role: 'assistant',
    timestamp,
    content: [
      { type: 'thinking', thinking: `思考 ${timestamp}`, ...(signature ? { thinkingSignature: signature } : {}) },
      { type: 'toolCall', id: `call-${timestamp}`, name: 'bash', arguments: {} },
    ],
  }
}

function toolResult(timestamp: number): TestMessage {
  return { role: 'toolResult', timestamp, content: [{ type: 'text', text: 'ok' }] }
}

function thinkingCount(message: TestMessage | undefined): number {
  const content = message?.content
  return Array.isArray(content) ? content.filter((block) => block.type === 'thinking').length : 0
}

describe('prepareThinkingSignatureRecovery', () => {
  test('Given 同一条失败消息被多次询问 Then 只计一次并保持可重试', () => {
    const state = createThinkingReplayState()
    const failed = { stopReason: 'error' }

    expect(prepareThinkingSignatureRecovery(state, failed, { supported: true, now: 100 })).toBe('started')
    expect(prepareThinkingSignatureRecovery(state, failed, { supported: true, now: 200 })).toBe('pending')
    expect(state.signatureRecovery.attempts).toBe(1)
    expect(state.signatureRecovery.stripSignedBefore).toBe(100)
  })

  test('Given 原地恢复次数用尽 Then 交给编排层', () => {
    const state = createThinkingReplayState()
    for (let attempt = 1; attempt <= MAX_THINKING_SIGNATURE_RECOVERIES; attempt += 1) {
      expect(prepareThinkingSignatureRecovery(state, {}, { supported: true, now: attempt })).toBe('started')
    }
    expect(prepareThinkingSignatureRecovery(state, {}, { supported: true })).toBe('exhausted')
    expect(state.signatureRecovery.stripSignedBefore).toBe(MAX_THINKING_SIGNATURE_RECOVERIES)
  })

  test('Given 协议不校验签名或处于 legacy 排查模式 Then 不做原地恢复', () => {
    expect(prepareThinkingSignatureRecovery(createThinkingReplayState(), {}, { supported: false })).toBe('unsupported')
    expect(prepareThinkingSignatureRecovery(createThinkingReplayState('legacy'), {}, { supported: true })).toBe('unsupported')
  })
})

describe('applyThinkingReplayPolicy', () => {
  const messages: TestMessage[] = [
    { role: 'user', timestamp: 1, content: '上一轮' },
    assistant(2, 'sig-previous-turn'),
    toolResult(3),
    { role: 'user', timestamp: 10, content: '当前轮' },
    assistant(11, 'sig-before-error'),
    toolResult(12),
    assistant(20, 'sig-after-retry'),
    toolResult(21),
  ]

  test('Given 未发生签名错误 Then 只剥离之前轮次的思考块', () => {
    const result = applyThinkingReplayPolicy(messages, createThinkingReplayState(), { supported: true })

    expect(thinkingCount(result[1])).toBe(0)
    expect(thinkingCount(result[4])).toBe(1)
    expect(thinkingCount(result[6])).toBe(1)
  })

  test('Given 签名错误已记录剥离时点 Then 剥离当前轮中此前生成的思考块，保留重试后生成的', () => {
    const state = createThinkingReplayState()
    prepareThinkingSignatureRecovery(state, {}, { supported: true, now: 15 })
    const result = applyThinkingReplayPolicy(messages, state, { supported: true })

    expect(thinkingCount(result[1])).toBe(0)
    expect(thinkingCount(result[4])).toBe(0)
    expect(thinkingCount(result[6])).toBe(1)
    // 工具调用与工具结果不受影响，同一 transcript 可以原地继续。
    expect((result[4]?.content as Array<{ type: string }>).map((block) => block.type)).toEqual(['toolCall'])
    expect(result[5]).toBe(messages[5])
  })

  test('Given 无签名思考块 Then 剥离时点不改动它们', () => {
    const state = createThinkingReplayState()
    prepareThinkingSignatureRecovery(state, {}, { supported: true, now: 100 })
    const unsigned = [{ role: 'user', timestamp: 1, content: 'q' }, assistant(2)]

    expect(applyThinkingReplayPolicy(unsigned, state, { supported: true })).toBe(unsigned)
  })

  test('Given 协议不校验签名 Then 原样返回', () => {
    const state = createThinkingReplayState()
    prepareThinkingSignatureRecovery(state, {}, { supported: true, now: 100 })

    expect(applyThinkingReplayPolicy(messages, state, { supported: false })).toBe(messages)
  })
})
