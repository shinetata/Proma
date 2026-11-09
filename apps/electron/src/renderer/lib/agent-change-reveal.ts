/**
 * 右侧改动区自动展开判定。
 *
 * 任务结束时（流式真正结束，不是软空闲态），如果本轮产生过文件改动、而用户还没看过这一轮的
 * 改动，就把右侧工作区切到「文件改动」。判定沿用 revealChangedWorkspaceComponentAtom 的克制
 * 策略：右侧已经打开且用户正在阅读 Skills / 记忆时只留圆点提示，不抢焦点。
 *
 * 这里只放纯函数，atom 读写留在调用方，便于单测。
 */

import type { SessionFileChange } from '@/lib/session-file-changes'

export interface AgentRunChangesInput {
  /** 会话当前 run 的 ID（agentFileChangesCurrentRunAtom）；没有 run 说明本轮还没建立改动归属 */
  currentRunId?: string
  /** 用户已经查看过改动的 run ID（agentViewedChangeRunAtom） */
  viewedRunId?: string
  /** Git 侧是否还有未查看改动（agentDiffUnseenChangesAtom） */
  gitChangesUnseen?: boolean
  /** 非 Git 目录里本会话的写入记录（agentNonGitFileChangesAtom） */
  nonGitChanges?: readonly SessionFileChange[]
}

/**
 * 本轮是否真的产生了文件改动。
 *
 * Git 工作树改动由会话级布尔标记，非 Git 目录只能靠该 run 的写入记录判断，
 * 两者任一成立都算；仅有 run ID 而没有改动记录时不视为改动。
 */
export function hasFileChangesForRun({
  currentRunId,
  gitChangesUnseen,
  nonGitChanges,
}: AgentRunChangesInput): boolean {
  if (gitChangesUnseen === true) return true
  if (!currentRunId) return false
  return (nonGitChanges ?? []).some((change) => change.runId === currentRunId)
}

/** 是否存在用户尚未查看的本轮改动：本轮有改动，且用户看过的不是这一轮。 */
export function hasUnviewedRunChanges(input: AgentRunChangesInput): boolean {
  if (!hasFileChangesForRun(input)) return false
  return input.viewedRunId !== input.currentRunId
}

export interface ShouldAutoRevealChangesInput {
  /** 是否存在未查看的本轮改动 */
  hasUnviewedChanges: boolean
  /** 右侧工作区当前是否打开（agentSidePanelOpenAtomFamily） */
  sidePanelOpen: boolean
  /** 右侧当前页签是否属于用户显式选择的阅读焦点（skills / memory） */
  preservesUserFocus: boolean
}

/**
 * 任务结束时是否应把右侧切到改动区。
 *
 * - 右侧关着：直接打开改动区，让用户第一时间看到改了什么。
 * - 右侧开着且用户正在读 Skills / 记忆：保留焦点，只在标题栏留圆点。
 * - 右侧开着且停在文件、预览等页签：切到改动区，改动是这一轮的主要产出。
 */
export function shouldAutoRevealChanges({
  hasUnviewedChanges,
  sidePanelOpen,
  preservesUserFocus,
}: ShouldAutoRevealChangesInput): boolean {
  if (!hasUnviewedChanges) return false
  if (!sidePanelOpen) return true
  return !preservesUserFocus
}