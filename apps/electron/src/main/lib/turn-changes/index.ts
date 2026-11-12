/**
 * 轮次文件改动对外入口
 *
 * 按 sessionId 持有录制器实例，供 Agent 编排（开始/工具前/工具结果/结算/删除）
 * 与 IPC（查询摘要与单文件 diff）调用。录制器自身处理串行化与生命周期，
 * 这里只做会话级路由。
 */

import type { TurnChangesSummary, TurnFileDiff } from '@proma/shared'
import { TurnRecorder } from './recorder'

const recorders = new Map<string, TurnRecorder>()

function recorderFor(sessionId: string): TurnRecorder {
  let recorder = recorders.get(sessionId)
  if (recorder === undefined) {
    recorder = new TurnRecorder()
    recorders.set(sessionId, recorder)
  }
  return recorder
}

/** 开启一轮录制：为该轮用户消息记录基线快照。 */
export function beginTurnChanges(sessionId: string, key: string, cwd: string): void {
  recorderFor(sessionId).start(key, cwd)
}

/** 文件工具放行前调用：捕获写前内容副本。 */
export async function preExecuteTurnTool(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  fallbackCwd: string,
): Promise<void> {
  const recorder = recorders.get(sessionId)
  if (recorder === undefined) return
  await recorder.preExecuteTool(toolName, input, fallbackCwd)
}

/** 收到含 tool_result 的 user 消息时调用。 */
export function observeTurnToolResult(sessionId: string): void {
  recorders.get(sessionId)?.observeToolResult()
}

/** 结算本轮并返回摘要；没有录制器时返回 null。 */
export async function finishTurnChanges(sessionId: string, expectedKey?: string): Promise<TurnChangesSummary | null> {
  const recorder = recorders.get(sessionId)
  if (recorder === undefined) return null
  return recorder.finish(expectedKey)
}

/** 读取内存中已结算轮次的摘要，供渲染层在持久化字段缺失时兜底。 */
export function getTurnChanges(sessionId: string, key: string): TurnChangesSummary | null {
  return recorders.get(sessionId)?.getSummary(key) ?? null
}

/** 按需计算某轮某文件的 hunks。 */
export async function getTurnFileDiff(
  sessionId: string,
  key: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<TurnFileDiff | null> {
  const recorder = recorders.get(sessionId)
  if (recorder === undefined) return null
  return recorder.getFileDiff(key, filePath, signal)
}

/** 会话删除时调用：释放录制器并清理 scratch。 */
export async function disposeTurnChanges(sessionId: string): Promise<void> {
  const recorder = recorders.get(sessionId)
  if (recorder === undefined) return
  recorders.delete(sessionId)
  await recorder.dispose()
}
