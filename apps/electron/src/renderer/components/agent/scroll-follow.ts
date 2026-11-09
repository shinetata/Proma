/**
 * scroll-follow — 最终回复出现后停止跟随滚动的纯逻辑
 *
 * 对应商业版 0.22.0 的 z8t / mhe：
 * - hasLiveFinalOutput：判断当前 run 的实时消息里是否已出现最终回复；
 * - computeFollowLocked：滚动跟随锁的状态机——运行中且没有最终回复时跟随，
 *   一旦出现最终回复（或停止运行）即锁定，不再自动滚到底。
 */

import type { SDKMessage } from '@proma/shared'

type LooseLiveAssistantMessage = {
  type: 'assistant'
  parent_tool_use_id?: string | null
  isReplay?: boolean
  _promaLiveRunStartedAt?: unknown
  error?: unknown
  _partial?: unknown
  message: {
    content: Array<{ type: string; text?: string; phase?: string }>
    stop_reason?: string
  }
}

/**
 * 判断实时消息中是否已出现最终回复（对应商业版 z8t）。
 *
 * 取最后一条主线（无 parent_tool_use_id）、非重放、属于当前 run 的 assistant 消息：
 * - 有 phase === 'final_answer' 的非空文本 → 已出现；
 * - 带 error、_partial 或含 tool_use → 视为尚未收尾；
 * - 否则要求 stop_reason 为 stop / end_turn 且存在非 commentary 的非空文本。
 */
export function hasLiveFinalOutput(liveMessages: readonly SDKMessage[], runStartedAt?: number): boolean {
  const last = liveMessages.findLast((message): message is LooseLiveAssistantMessage => {
    const record = message as LooseLiveAssistantMessage
    return record.type === 'assistant'
      && !record.parent_tool_use_id
      && !record.isReplay
      && (runStartedAt == null || record._promaLiveRunStartedAt === runStartedAt)
  })
  if (!last) return false
  const texts = last.message.content.filter((block) => block.type === 'text' && typeof block.text === 'string' && !!block.text.trim())
  if (texts.some((block) => block.type === 'text' && block.phase === 'final_answer')) return true
  if (last.error || last._partial || last.message.content.some((block) => block.type === 'tool_use')) return false
  return ['stop', 'end_turn'].includes(last.message.stop_reason ?? '')
    && texts.some((block) => block.type === 'text' && block.phase !== 'commentary')
}

/** 滚动跟随锁的输入状态 */
export interface FollowState {
  sessionId: string
  streaming: boolean
  runStartedAt?: number
  hasFinalOutput: boolean
}

/**
 * 计算滚动跟随锁（对应商业版 mhe）：
 *
 * - 非运行中、或已出现最终回复 → 锁定（不跟随）；
 * - 上一状态不存在 / 切换了会话 / 上一状态非运行 / 换了新一轮（runStartedAt 变化）→ 解锁；
 * - 其余沿用上一次的锁定状态。
 */
export function computeFollowLocked(previous: FollowState | undefined, next: FollowState, previousLocked: boolean): boolean {
  if (!next.streaming || next.hasFinalOutput) return true
  if (!previous || previous.sessionId !== next.sessionId || !previous.streaming || previous.runStartedAt !== next.runStartedAt) {
    return false
  }
  return previousLocked
}
