/**
 * Cursor Plan 批准后自动续跑
 *
 * Cursor 渠道的规划回合在合成审批前已结束，用户批准后需主动发起新一轮执行。
 */

import type { WebContents } from 'electron'
import type { AgentSendInput, PromaPermissionMode, SDKMessage } from '@proma/shared'
import { agentEventBus, isAgentSessionActive, runAgent } from './agent-service'
import { getAgentSessionMeta } from './agent-session-manager'
import { getSettings } from './settings-service'
import { buildPlanExecutionUserMessage } from './agent-plan-continuation-utils'

export { buildPlanExecutionUserMessage, shouldAutoContinuePlanExecution } from './agent-plan-continuation-utils'

export async function continuePlanAfterApproval(input: {
  sessionId: string
  targetMode: PromaPermissionMode
  planPath?: string
  webContents: WebContents
}): Promise<void> {
  const { sessionId, targetMode, planPath, webContents } = input

  if (isAgentSessionActive(sessionId)) {
    console.warn(`[PlanContinuation] 会话 ${sessionId} 仍在运行，跳过自动执行`)
    return
  }

  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.channelId) {
    console.warn(`[PlanContinuation] 会话 ${sessionId} 缺少 channelId，无法自动执行`)
    return
  }

  const settings = getSettings()
  const userMessage = buildPlanExecutionUserMessage(planPath)
  const startedAt = Date.now()

  const userSDKMsg: SDKMessage = {
    type: 'user',
    message: {
      content: [{ type: 'text', text: userMessage }],
    },
    parent_tool_use_id: null,
    _createdAt: startedAt,
  } as unknown as SDKMessage

  agentEventBus.emit(sessionId, { kind: 'sdk_message', message: userSDKMsg })

  const sendInput: AgentSendInput = {
    sessionId,
    userMessage,
    channelId: meta.channelId,
    modelId: settings.agentModelId,
    workspaceId: meta.workspaceId,
    permissionModeOverride: targetMode,
    startedAt,
  }

  console.log(`[PlanContinuation] 自动发起计划执行: sessionId=${sessionId}, mode=${targetMode}`)
  await runAgent(sendInput, webContents)
}
