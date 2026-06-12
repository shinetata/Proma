/**
 * Cursor Plan 批准后自动续跑
 *
 * Cursor 渠道的规划回合在合成审批前已结束，用户批准后需主动发起新一轮执行。
 */

import type { WebContents } from 'electron'
import type { AgentSendInput, AgentStreamEvent, AgentStreamPayload, PromaPermissionMode, SDKMessage } from '@proma/shared'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import {
  isAgentSessionActive,
  registerAgentWebContents,
  runAgent,
  updateAgentPermissionMode,
} from './agent-service'
import { getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import { getSettings } from './settings-service'
import { buildPlanExecutionUserMessage } from './agent-plan-continuation-utils'

export { buildPlanExecutionUserMessage, shouldAutoContinuePlanExecution } from './agent-plan-continuation-utils'

const SESSION_IDLE_MAX_ATTEMPTS = 20
const SESSION_IDLE_DELAY_MS = 50

async function waitForSessionIdle(sessionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < SESSION_IDLE_MAX_ATTEMPTS; attempt++) {
    if (!isAgentSessionActive(sessionId)) return true
    await new Promise((resolve) => setTimeout(resolve, SESSION_IDLE_DELAY_MS))
  }
  return !isAgentSessionActive(sessionId)
}

function sendStreamEvent(
  webContents: WebContents,
  sessionId: string,
  payload: AgentStreamPayload,
): void {
  if (webContents.isDestroyed()) return
  try {
    webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
  } catch (err) {
    console.error(`[PlanContinuation] 直发流式事件失败: sessionId=${sessionId}`, err)
  }
}

function resolveContinuationModelId(sessionId: string): string | undefined {
  const settings = getSettings()
  if (settings.agentModelId) return settings.agentModelId

  const messages = getAgentSessionSDKMessages(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const modelId = (messages[i] as Record<string, unknown>)._channelModelId
    if (typeof modelId === 'string' && modelId.length > 0) return modelId
  }
  return undefined
}

function resolveAdditionalDirectories(meta: NonNullable<ReturnType<typeof getAgentSessionMeta>>): string[] | undefined {
  const dirs = new Set<string>()
  for (const dir of meta.attachedDirectories ?? []) {
    if (dir.trim()) dirs.add(dir)
  }
  for (const file of meta.attachedFiles ?? []) {
    const parent = file.replace(/[/\\][^/\\]+$/, '')
    if (parent.trim()) dirs.add(parent)
  }
  return dirs.size > 0 ? Array.from(dirs) : undefined
}

export async function continuePlanAfterApproval(input: {
  sessionId: string
  targetMode: PromaPermissionMode
  planPath?: string
  webContents: WebContents
}): Promise<void> {
  const { sessionId, targetMode, planPath, webContents } = input

  registerAgentWebContents(sessionId, webContents)

  const emitFailure = (reason: string): void => {
    sendStreamEvent(webContents, sessionId, {
      kind: 'proma_event',
      event: { type: 'plan_execution_auto_start_failed', sessionId, reason },
    })
  }

  const idle = await waitForSessionIdle(sessionId)
  if (!idle) {
    console.warn(`[PlanContinuation] 会话 ${sessionId} 仍在运行，无法自动执行计划`)
    emitFailure('session_still_active')
    return
  }

  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.channelId) {
    console.warn(`[PlanContinuation] 会话 ${sessionId} 缺少 channelId，无法自动执行`)
    emitFailure('missing_channel')
    return
  }

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

  sendStreamEvent(webContents, sessionId, { kind: 'sdk_message', message: userSDKMsg })
  sendStreamEvent(webContents, sessionId, {
    kind: 'proma_event',
    event: {
      type: 'plan_execution_auto_start',
      sessionId,
      startedAt,
      targetMode,
    },
  })

  // 记录 Cursor 下轮 CLI flags（会话空闲时 updateSessionPermissionMode 会 no-op，靠 override 生效）
  try {
    await updateAgentPermissionMode(sessionId, targetMode)
  } catch (err) {
    console.warn(`[PlanContinuation] 权限模式预同步失败（将由 override 兜底）:`, err)
  }

  const additionalDirectories = resolveAdditionalDirectories(meta)
  const sendInput: AgentSendInput = {
    sessionId,
    userMessage,
    channelId: meta.channelId,
    modelId: resolveContinuationModelId(sessionId),
    workspaceId: meta.workspaceId,
    permissionModeOverride: targetMode,
    startedAt,
    ...(additionalDirectories ? { additionalDirectories } : {}),
  }

  console.log(`[PlanContinuation] 自动发起计划执行: sessionId=${sessionId}, mode=${targetMode}`)
  await runAgent(sendInput, webContents)
}
