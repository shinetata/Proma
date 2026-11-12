/**
 * AgentOrchestrator — Agent 编排层
 *
 * 从 agent-service.ts 提取的核心业务逻辑，负责：
 * - 并发守卫（同一会话不允许并行请求）
 * - 渠道查找 + API Key 解密
 * - 环境变量构建 + SDK 路径解析
 * - 用户/助手消息持久化
 * - 事件流遍历 + 文本累积 + 事件持久化
 * - 错误处理 + 部分内容保存
 * - 自动标题生成
 *
 * 通过 EventBus 分发 AgentEvent，通过 SessionCallbacks 发送控制信号，
 * 完全解耦 Electron IPC，可独立测试（mock Adapter + EventBus）。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { app } from 'electron'
import type { AgentSendInput, AgentMessage, AgentGenerateTitleInput, AgentProviderAdapter, AgentSessionMeta, AgentActiveSessionSnapshot, CodexOAuthCredentials, GithubCopilotOAuthCredentials, XaiOAuthCredentials, TypedError, SDKMessage, SDKAssistantMessage, AgentStreamPayload, AgentAssistantDeltaPayload, RewindSessionResult, SkillActivation } from '@proma/shared'
import {
  PROMA_DEFAULT_PERMISSION_MODE,
  migrateNarrationMode,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isPersistableSDKSystemMessage,
  normalizePathForCompare,
  normalizeMcpTransportType,
  inferContextWindow,
  inferReasoningTransport,
  resolveReasoningProfile,
  collectSkillActivations,
  mergeSkillActivations,
} from '@proma/shared'
import type { PromaPermissionMode, AskUserRequest, SDKSystemMessage } from '@proma/shared'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import { getMainRepoRoot } from './git-diff-service'
import { getPiAssistantErrorDetails, hasPiAssistantTextContent, stripPiAssistantError } from './adapters/pi-message-adapter'
import { friendlyErrorMessage, isPromptTooLongError, isThinkingSignatureError, mapAgentErrorToTypedError } from './agent-error-utils'
import { getActiveRunRejectionMessage, shouldPersistInitialUserMessage } from './agent-send-message-policy'
import { isSessionNotFoundError } from './error-patterns'
import { AgentEventBus } from './agent-event-bus'
import { isStaleActiveQueueError } from './agent-queue-routing'
import { decryptApiKey, getChannelById, listChannels, persistCodexOAuthCredentials, persistGithubCopilotOAuthCredentials, persistXaiOAuthCredentials, resolveChannelRuntimeApiKey, resolveCodexOAuthCredentials, resolveGithubCopilotOAuthCredentials, resolveXaiOAuthCredentials } from './channel-manager'
import { getAdapter, fetchTitle } from '@proma/core'
import pkg from '../../../package.json' with { type: 'json' }
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendSDKMessages, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages, removeSDKErrorMessage, updateSDKUserMessageSkillActivations, updateSDKUserMessageTurnChanges, rewindPiAgentSession, resolveAgentCwd, resolveSessionCheckoutCwd, defaultCheckoutEntry, getActiveWorktreePath, getAgentCwdMode, getSessionWorkbenchLayout, isAgentSessionDeleting } from './agent-session-manager'
import { appendCheckoutEntry, checkoutFromActiveWorktree } from './session-checkout'
import { beginTurnChanges, finishTurnChanges, observeTurnToolResult, preExecuteTurnTool } from './turn-changes'
import { getAgentWorkspace, getProjectFilesPath, getWorkspaceMcpConfig, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from './agent-workspace-manager'
import { getLocalProjectRootStatus } from './project-root-health'
import { getMcpApiKeyEnvironment, getMcpOAuthHeaders } from './mcp-oauth-service'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath, getSdkConfigDir, getWorkspaceSkillsDir } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { buildSystemPrompt, buildDynamicContext } from './agent-prompt-builder'
import { resolveProjectInstructions } from './project-instruction-resolver'
import { broadcastKnowledgeChanges } from './knowledge-change-events'
import { getAgentMemoryContext } from './agent-workspace-manager'
import { MAX_CONTEXT_MESSAGES, buildContextPrompt, buildRecoveryPrompt, buildReferencedSessionsPrompt } from './agent-session-context-prompt'
import { buildReferencedPlanningPrompt } from './planning-reference-context'
import { permissionService } from './agent-permission-service'
import type { PermissionResult, CanUseToolOptions } from './agent-permission-service'
import { resolvePlanningDeletionPermission } from './planning-permission-policy'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { validateToolInput } from './agent-tool-input-validator'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator'
import { buildPiBuiltinTools } from './adapters/pi-builtin-tools'
import { getAgentVaultRoots, getVaultUserContext } from './vault-service'
import { buildPiMcpTools } from './adapters/pi-mcp-tools'
import { buildAgentRuntimeEnv, type AgentRuntimeEnv } from './agent-runtime-env'
import { isVisibleRunMessage } from './agent-run-message-visibility'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { resolvePiApi, resolvePiReasoningCapability } from './adapters/pi-model-registry'
import {
  isClaudeFamilyModelId,
  isOpaqueUpstream400,
} from './adapters/pi-thinking-replay'
import { generateCodexTitle } from './adapters/pi-codex-title-generator'
import { createFallbackTitle, sanitizeGeneratedTitle, TITLE_PROMPT } from './title-generation'
import { browserController } from './browser-controller'
import { resolveRuntimeAdditionalDirectories } from './agent-orchestrator-vault-access'

// ===== 类型定义 =====

/**
 * 会话控制信号回调
 *
 * 解耦 Electron webContents，使 Orchestrator 可独立测试。
 * agent-service.ts 负责将这些回调绑定到 webContents.send()。
 */
type AgentRunInput = AgentSendInput & { runGeneration?: number }

export interface SessionCallbacks {
  /** 发送流式错误 */
  onError: (error: string, opts?: { runGeneration?: number }) => void
  /** 发送流式完成（携带已持久化的消息列表） */
  onComplete: (messages?: AgentMessage[], opts?: { stoppedByUser?: boolean; startedAt?: number; runGeneration?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean }) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number; runGeneration: number; userMessage?: string; userMessageUuid?: string }) => void
}

type RecoverableAgentQueryOptions = {
  prompt: string
  resumeSessionId?: string
  resumeSessionAt?: string
}

// ===== 工具函数 =====

const EMPTY_RESPONSE_RESULT_SUBTYPE = 'empty_response'

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingActiveQueueChannelError(error: unknown): boolean {
  return isStaleActiveQueueError(error)
}

function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function isAssistantDeltaSDKMessage(message: SDKMessage): message is SDKMessage & {
  type: 'assistant_delta'
  uuid: string
  delta: AgentAssistantDeltaPayload['deltas'][number]
  session_id?: string
  _channelModelId?: string
} {
  const record = message as Record<string, unknown>
  return record.type === 'assistant_delta'
    && typeof record.uuid === 'string'
    && !!record.delta
}

/** 默认会话标题（用于判断是否需要自动生成） */
const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/** 默认模型 ID */
const DEFAULT_MODEL_ID = 'claude-sonnet-5'

/**
 * 聚合一次 SDK 调用涉及的所有附加目录（去重，保持插入顺序）。
 *
 * 来源：
 *   1. extraDirs：调用方传入的临时附加目录（例如 sendMessage 时用户当次提交的目录）
 *   2. 当前会话的私有工作目录，以及会话级 attachedDirectories + attachedFiles 的父目录
 *   3. 工作区级 attachedDirectories + attachedFiles 的父目录
 *   4. 项目文件根目录（本地项目为用户目录，空白项目为 workspace-files/）
 */
function collectAttachedDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const { sessionMeta, workspaceSlug, extraDirs } = params
  const result: string[] = []
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  for (const d of extraDirs ?? []) push(d)
  if (sessionMeta?.activeWorktree?.path) push(sessionMeta.activeWorktree.path)
  if (workspaceSlug && sessionMeta) push(getAgentSessionWorkspacePath(workspaceSlug, sessionMeta.id))
  for (const d of sessionMeta?.attachedDirectories ?? []) push(d)
  for (const file of sessionMeta?.attachedFiles ?? []) push(dirname(file))

  if (workspaceSlug) {
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getProjectFilesPath(workspaceSlug))
  }

  return result
}

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildPiAdditionalDirectoriesPrompt(directories: string[]): string {
  if (directories.length === 0) return ''
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  return `

<attached_directories>
这些目录已由 Proma 授权给当前会话，和当前工作目录同属于用户允许访问的范围。
如需读取或修改这些目录中的内容，请直接使用绝对路径，不要先复制到当前工作目录。
${directoryLines}
</attached_directories>`
}

const LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE = 'local_project_root_unavailable'

function createLocalProjectRootUnavailableError(projectRootPath: string, status?: string): Error {
  const error = new Error(
    `本地项目根目录不可用: 本地项目根目录不存在或无法访问：${projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
  ) as Error & { code?: string; details?: string[] }
  error.code = LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE
  error.details = status ? [`目录状态: ${status}`] : undefined
  return error
}

// ===== AgentOrchestrator =====

export class AgentOrchestrator {
  private adapter: AgentProviderAdapter
  private eventBus: AgentEventBus
  private activeSessions = new Map<string, number>()
  private activeSessionStartedAt = new Map<string, number>()
  private nextRunGenerationBySession = new Map<string, number>()

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()
  /** Skill callback may precede queue-message JSONL persistence by one event loop. */
  private pendingUserSkillActivations = new Map<string, Map<string, SkillActivation[]>>()

  /** 被用户手动中止的运行代际（在 stop 中标记，在对应运行的终态路径消费）。 */
  private stoppedBySessions = new Map<string, number>()
  /** 队列启动投影已显示、但运行槽尚未占用时的停止请求。 */
  private stoppedBeforeRunSessions = new Set<string>()

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus) {
    this.adapter = adapter
    this.eventBus = eventBus
  }

  /**
   * 消费一次用户手动停止标记。
   *
   * SDK 在 query.close() 后不一定走异常路径：某些版本会先正常 yield result 再结束迭代。
   * 因此停止标记必须在所有终态路径统一消费，而不能只依赖 catch 块。
   */
  private consumeStoppedByUser(sessionId: string, runGeneration: number): boolean {
    if (this.stoppedBySessions.get(sessionId) !== runGeneration) return false
    this.stoppedBySessions.delete(sessionId)
    return true
  }

  /**
   * 构建工作区 MCP 服务器配置
   */
  private async buildMcpServers(workspaceSlug: string | undefined, proxyUrl?: string): Promise<Record<string, Record<string, unknown>>> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      const type = normalizeMcpTransportType((entry as { type?: unknown }).type)

      if (type === 'stdio' && entry.command) {
        const credentialEnv = getMcpApiKeyEnvironment(workspaceSlug, name, entry)
        const mergedEnv: Record<string, string> = {
          ...(process.env.PATH && { PATH: process.env.PATH }),
          ...entry.env,
          ...credentialEnv,
        }
        mcpServers[name] = {
          type: 'stdio',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 && { args: entry.args }),
          ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
          required: true,
          startup_timeout_sec: entry.timeout ?? 30,
        }
      } else if ((type === 'http' || type === 'sse') && entry.url) {
        let oauthHeaders: Record<string, string> | undefined
        try {
          oauthHeaders = await getMcpOAuthHeaders(workspaceSlug, name, entry.url)
        } catch (error) {
          console.warn(`[Agent 编排] MCP OAuth 凭据不可用：${name}`, error instanceof Error ? error.message : error)
          continue
        }
        const headers = { ...entry.headers, ...oauthHeaders }
        mcpServers[name] = {
          type,
          url: entry.url,
          ...(Object.keys(headers).length > 0 && { headers }),
          ...(proxyUrl && { proxyUrl }),
          startup_timeout_sec: entry.timeout ?? 30,
          required: true,
        }
      } else {
        console.warn(`[Agent 编排] MCP 服务器 "${name}" 配置不完整，已跳过（type=${entry.type}, command=${entry.command ?? '无'}, url=${entry.url ?? '无'}）`)
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      console.log(`[Agent 编排] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
    }

    return mcpServers
  }

  /**
   * 生成 Agent 会话标题
   *
   * 使用 Provider 适配器系统，支持所有渠道。任何错误返回 null。
   */
  async generateTitle(input: AgentGenerateTitleInput, signal?: AbortSignal): Promise<string | null> {
    const { userMessage, channelId, modelId } = input
    if (signal?.aborted) return null
    console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

    // 渠道信息在异常路径也要用于判断是否应用自定义渠道本地兜底，因此提前解析；
    // 同时保留 listChannels 自身的错误边界：解析失败时按“无渠道”处理并返回 null。
    let channel: import('@proma/shared').Channel | undefined
    try {
      channel = listChannels().find((c) => c.id === channelId)
    } catch (error) {
      console.warn('[Agent 标题生成] 渠道解析失败:', error)
      return null
    }
    if (!channel) {
      console.warn('[Agent 标题生成] 渠道不存在:', channelId)
      return null
    }

    if (channel.provider === 'xai' || channel.provider === 'github-copilot') {
      // Subscription providers use Pi's provider-specific OAuth transport; title generation's
      // generic channel adapter only understands API keys, so retain a local deterministic title.
      return createFallbackTitle(userMessage)
    }

    if (channel.provider === 'openai-codex') {
      const fallbackTitle = createFallbackTitle(userMessage)
      try {
        const [credentials, proxyUrl] = await Promise.all([
          resolveCodexOAuthCredentials(channelId),
          getEffectiveProxyUrl(),
        ])
        if (signal?.aborted) return null
        const generatedTitle = await generateCodexTitle({
          modelId,
          prompt: TITLE_PROMPT + userMessage,
          credentials,
          proxyUrl,
          signal,
          onCredentialsRefreshed: (refreshed) => persistCodexOAuthCredentials(channelId, refreshed),
        })
        if (signal?.aborted) return null
        const title = generatedTitle ? sanitizeGeneratedTitle(generatedTitle) : null
        if (title) {
          console.log(`[Agent 标题生成] ChatGPT OAuth 语义标题生成成功: "${title}"`)
          return title
        }
        console.warn('[Agent 标题生成] ChatGPT OAuth 返回空标题，使用本地兜底')
      } catch (error) {
        if (signal?.aborted) return null
        console.warn('[Agent 标题生成] ChatGPT OAuth 语义标题生成失败，使用本地兜底:', error)
      }
      return fallbackTitle
    }

    try {
      const apiKey = await resolveChannelRuntimeApiKey(channelId)
      const providerAdapter = getAdapter(channel.provider)
      const request = providerAdapter.buildTitleRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        prompt: TITLE_PROMPT + userMessage,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitle(request, providerAdapter, fetchFn)
      const result = title ? sanitizeGeneratedTitle(title) : null
      if (!result) {
        console.warn('[Agent 标题生成] API 未返回可用标题')
        // 自定义渠道（custom）可能返回空/异常；任何取不到可用标题的情况
        // 都回退到首行兜底，保证会话一定被重命名。
        return (channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
      }

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      console.warn('[Agent 标题生成] 生成失败:', error)
      // 自定义渠道的服务端偶发返回空标题/异常响应/超时，异常路径同样要完成重命名。
      return (channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
    }
  }

  /**
   * 流开始后自动生成标题。
   *
   * 默认会话沿用首条消息自动命名；Pi `/tree` 探索分支则在首条**新增**用户消息时
   * 重命名一次，摆脱「原标题 (fork)」，之后不再覆盖用户或分支自己的语义标题。
   */
  private async autoGenerateTitle(
    sessionId: string,
    userMessage: string,
    channelId: string,
    modelId: string,
    callbacks: SessionCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    try {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return
      const isDefaultSessionTitle = meta.title === DEFAULT_SESSION_TITLE
      const isFirstExplorationMessage = Boolean(
        meta.explorationParentSessionId
        && !meta.explorationTitleInitializedAt,
      )
      if (!isDefaultSessionTitle && !isFirstExplorationMessage) return

      // 分支的历史被 Pi fork 复制，不能按「第一条历史消息」命名；以首次继续发送的消息
      // 作为唯一的命名信号。先持久化守卫，避免用户连发时启动多个竞争标题请求。
      const explorationTitleInitializedAt = isFirstExplorationMessage ? Date.now() : undefined
      if (explorationTitleInitializedAt) {
        updateAgentSessionMeta(sessionId, { explorationTitleInitializedAt })
      }

      const title = await this.generateTitle({ userMessage, channelId, modelId }, signal)
        ?? (isFirstExplorationMessage ? createFallbackTitle(userMessage) : null)
      if (!title || signal?.aborted) return

      // 标题请求是异步的；请求期间用户可能已手动重命名，不能用旧结果覆盖。
      const latestMeta = getAgentSessionMeta(sessionId)
      const canApplyDefaultTitle = isDefaultSessionTitle && latestMeta?.title === DEFAULT_SESSION_TITLE
      const canApplyExplorationTitle = Boolean(
        isFirstExplorationMessage
        && latestMeta?.title === meta.title
        && latestMeta.explorationTitleInitializedAt === explorationTitleInitializedAt,
      )
      if (!latestMeta || (!canApplyDefaultTitle && !canApplyExplorationTitle)) return

      updateAgentSessionMeta(sessionId, { title })
      callbacks.onTitleUpdated(title)
      console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
    } catch (error) {
      if (signal?.aborted) return
      console.warn('[Agent 编排] 自动标题生成失败:', error)
    }
  }

  /**
   * Session-not-found 恢复：保留磁盘 sdkSessionId，本轮切换到上下文回填模式
   *
   * 当 resume 的目标 session 报 "No conversation found" 时触发。注意该错误可能是
   * listSessions 路径哈希不匹配导致的误检（见步骤 9.6 注释），不代表会话真正失效，
   * 因此不清除磁盘 meta：本轮以非 resume 模式恢复，若失败下一轮仍可尝试 resume（#903）。
   * 调用方负责设置本地 existingSdkSessionId = undefined 和流程控制（break/continue）。
   *
   */
  private prepareSessionNotFoundRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
  ): void {
    this.prepareResumeFallbackRecovery(
      sessionId,
      queryOptions,
      contextualMessage,
      agentCwd,
      workspaceSlug,
      accumulatedMessages,
      queryStartedAt,
      '检测到 session-not-found（可能为误检），保留 sdkSessionId 并切换到上下文回填模式',
    )
  }

  /**
   * Resume 失败恢复：本轮切到「非 resume + 历史回填恢复」模式，注入 session 自引用让 Agent
   * 优先通过 session-cleaner 读取干净历史继续工作。使用 <session_recovery> 标签指向当前会话，
   * 比 buildContextPrompt（仅注入 20 条摘要）提供完整得多的上下文连续性。
   *
   * 关于磁盘 meta 的 sdkSessionId（由 clearPersistedSession 控制，默认 false 即保留）：
   * - 默认保留：本轮恢复只改本地 queryOptions，不动磁盘；若本轮成功，SDK 新会话的 ID 会经
   *   onSessionId 回调自动覆盖 meta；若本轮失败到终止，下一轮仍可尝试 resume 旧 ID（#903）。
   *   这是「迷了就别删」的安全默认，适用于 session-not-found（可能为误检）等不确定场景。
   * - 仅 thinking-signature 跨模型不兼容时传 true：旧 ID 指向的 JSONL 焊死了旧模型思考块，
   *   当前模型 resume 必然再次失败，此时主动清除可避免下一轮无谓的失败往返。
   */
  private prepareResumeFallbackRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
    logMessage: string,
    clearPersistedSession = false,
  ): void {
    console.log(`[Agent 编排] ${logMessage}`)
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 仅在确定旧会话永久无效时（thinking-signature）才清除磁盘 meta；
    // 其余场景保留，新 SDK 会话产生的 sdkSessionId 会通过 onSessionId 回调自动覆盖。
    if (clearPersistedSession) {
      try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.resumeSessionAt = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息。
   */
  private persistSDKMessages(
    sessionId: string,
    accumulatedMessages: SDKMessage[],
    durationMs?: number,
  ): void {
    if (accumulatedMessages.length === 0) return

    const hasCompactBoundary = accumulatedMessages.some((m) => {
      return m.type === 'system' && (m as SDKSystemMessage).subtype === 'compact_boundary'
    })

    const toPersist = accumulatedMessages.filter(
      (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result'
        || (m.type === 'system' && isPersistableSDKSystemMessage(m as SDKSystemMessage))
    ).filter((m) => {
      if (isPartialSDKMessage(m)) return false
      if (m.type === 'system') {
        const sysMsg = m as SDKSystemMessage
        if (hasCompactBoundary && sysMsg.subtype === 'status' && sysMsg.compact_result === 'success') {
          return false
        }
      }
      // 过滤 SDK 内部生成的 user 文本消息（如 Skill 展开 prompt），与实时流过滤逻辑一致
      if (m.type === 'user') {
        const content = (m as { message?: { content?: Array<{ type: string }> } }).message?.content
        const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) return false
      }
      return true
    })

    if (toPersist.length === 0) return

    // 为没有 _createdAt 的消息补上时间戳（assistant 消息来自 SDK 原始输出，不含时间）
    const now = Date.now()
    const withTimestamps = toPersist.map((m) => {
      const msg = m as Record<string, unknown>
      if (typeof msg._createdAt === 'number') return m
      // 为 result 消息附加 _durationMs
      if (m.type === 'result' && durationMs != null) {
        return { ...m, _createdAt: now, _durationMs: durationMs } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    appendSDKMessages(sessionId, withTimestamps)
  }

  private persistUserMessage(
    sessionId: string,
    userMessage: string,
    createdAt = Date.now(),
    uuid?: string,
    vaultFocus?: import('@proma/shared').VaultFocusAttribution,
  ): string {
    const persistedUuid = uuid ?? randomUUID()
    const userSDKMsg: SDKMessage = {
      type: 'user',
      uuid: persistedUuid,
      message: {
        content: [{ type: 'text', text: userMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: createdAt,
      ...(vaultFocus ? { _vaultFocus: vaultFocus } : {}),
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [userSDKMsg])
    return persistedUuid
  }

  private recordUserSkillActivations(
    sessionId: string,
    userMessageUuid: string,
    activations: SkillActivation[],
  ): void {
    try {
      if (updateSDKUserMessageSkillActivations(sessionId, userMessageUuid, activations)) return
    } catch (error) {
      console.warn(`[Agent 编排] 写入用户 Skill metadata 失败，将等待消息落盘后重试:`, error)
    }

    const byMessage = this.pendingUserSkillActivations.get(sessionId) ?? new Map<string, SkillActivation[]>()
    byMessage.set(
      userMessageUuid,
      mergeSkillActivations(byMessage.get(userMessageUuid) ?? [], activations),
    )
    this.pendingUserSkillActivations.set(sessionId, byMessage)
  }

  private flushPendingUserSkillActivations(sessionId: string, userMessageUuid: string): void {
    const byMessage = this.pendingUserSkillActivations.get(sessionId)
    const activations = byMessage?.get(userMessageUuid)
    if (!activations?.length) return
    try {
      if (!updateSDKUserMessageSkillActivations(sessionId, userMessageUuid, activations)) return
      byMessage?.delete(userMessageUuid)
      if (byMessage?.size === 0) this.pendingUserSkillActivations.delete(sessionId)
    } catch (error) {
      console.warn(`[Agent 编排] 补写用户 Skill metadata 失败:`, error)
    }
  }

  private clearPendingUserSkillActivations(sessionId: string, userMessageUuid?: string): void {
    if (!userMessageUuid) {
      this.pendingUserSkillActivations.delete(sessionId)
      return
    }
    const byMessage = this.pendingUserSkillActivations.get(sessionId)
    if (!byMessage) return
    byMessage.delete(userMessageUuid)
    if (byMessage.size === 0) this.pendingUserSkillActivations.delete(sessionId)
  }

  private persistEmptyResponseError(
    sessionId: string,
    resultSubtype: string | undefined,
    resultErrors: string[] | undefined,
  ): string {
    const detail = resultErrors?.find((error) => error.trim().length > 0)?.trim()
    const subtype = resultSubtype ?? 'unknown'
    const errorContent = detail
      ? `Agent 本轮结束了，但没有返回任何可展示内容。错误详情：${detail}`
      : resultSubtype === 'success'
        ? 'Agent 本轮结束了，但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。'
        : `Agent 本轮异常结束（${subtype}），但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。`
    const errorSDKMsg: SDKMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: errorContent }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      error: { message: errorContent, errorType: EMPTY_RESPONSE_RESULT_SUBTYPE },
      _createdAt: Date.now(),
      _errorCode: 'unknown_error',
      _errorTitle: '没有收到模型回复',
      _errorCanRetry: true,
      _errorActions: [
        { key: 'r', label: '重试', action: 'retry' },
        { key: 'm', label: '重新选择模型', action: 'select_model' },
      ],
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [errorSDKMsg])
    console.warn(`[Agent 编排] 本轮没有收到可展示内容: sessionId=${sessionId}, resultSubtype=${subtype}`)
    return errorContent
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(
    input: AgentRunInput,
    callbacks: SessionCallbacks,
    extensions: { piCustomTools?: ToolDefinition[] } = {},
  ): Promise<void> {
    const { sessionId, userMessage, rawUserMessage, userMessageUuid, channelId, modelId, workspaceId: requestedWorkspaceId, additionalDirectories, mentionedSkills, mentionedMcpServers, mentionedSessionIds, mentionedTodoIds, mentionedCalendarEventIds, automationContext, retryOfErrorUuid } = input
    // Capture the focus once per turn. Later UI focus changes must not rewrite this reply's attribution.
    const initialVaultFocus = getVaultUserContext(sessionId)
    const streamStartedAt = input.startedAt ?? Date.now()
    let userMessagePersisted = false
    let initialUserMessageUuid: string | undefined
    let sessionMeta = getAgentSessionMeta(sessionId)

    const completeBeforeRun = (options: {
      stoppedByUser?: boolean
      startedAt?: number
    } = {}): void => {
      const stoppedByUser = this.stoppedBeforeRunSessions.delete(sessionId)
      callbacks.onComplete([], {
        ...options,
        startedAt: options.startedAt ?? streamStartedAt,
        ...(input.runGeneration != null ? { runGeneration: input.runGeneration } : {}),
        stoppedByUser: options.stoppedByUser === true || stoppedByUser,
      })
    }

    const persistInitialUserMessage = (): void => {
      if (userMessagePersisted) return
      // rawUserMessage 保留展示/持久化用的原始文本（@file 编码原文，remarkMentions 解码显示）；
      // userMessage 是传给 Agent 的 SDK 文本（@file 路径已解码为真实路径）。
      initialUserMessageUuid = this.persistUserMessage(
        sessionId,
        rawUserMessage ?? userMessage,
        Date.now(),
        userMessageUuid,
        initialVaultFocus ? {
          displayName: initialVaultFocus.displayName,
          rootPath: initialVaultFocus.rootPath,
          focus: initialVaultFocus.focus,
        } : undefined,
      )
      userMessagePersisted = true
    }

    // 删除墓碑必须先于并发/预检检查：headless run 可能已进入异步预检，
    // 但还没有占用 active/start 槽位。此时绝不能再持久化或启动 runtime。
    if (isAgentSessionDeleting(sessionId)) {
      callbacks.onComplete([], {
        stoppedByUser: true,
        startedAt: streamStartedAt,
        ...(input.runGeneration != null ? { runGeneration: input.runGeneration } : {}),
      })
      return
    }

    // 0. 并发保护
    const hasActiveRun = this.activeSessions.has(sessionId)
    const shouldPersistUserMessage = shouldPersistInitialUserMessage({ hasActiveRun, retryOfErrorUuid })
    if (hasActiveRun) {
      // 并发请求没有真正启动新的 Agent run，绝不能把它当作新用户输入写入 JSONL。
      // 尤其在用户点击停止后、底层 query 尚未完全退出的短暂窗口内，否则同一条
      // 后续消息会随每次点击重复落盘。
      console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求且不保存用户消息`)
      callbacks.onError(getActiveRunRejectionMessage())
      callbacks.onComplete([], { startedAt: streamStartedAt, ...(input.runGeneration != null ? { runGeneration: input.runGeneration } : {}) })
      return
    }

    // 手动重试直接删除原错误，避免它在下一轮完成后仍被历史回放。
    // 删除失败不阻断重试（例如旧版本遗留的无 UUID 错误）。
    if (retryOfErrorUuid) {
      try {
        removeSDKErrorMessage(sessionId, retryOfErrorUuid)
      } catch (error) {
        console.warn(`[Agent 编排] 删除重试前错误失败: ${retryOfErrorUuid}`, error)
      }
    }

    if (shouldPersistUserMessage) {
      try {
        persistInitialUserMessage()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Agent 编排] 持久化用户消息失败:', error)
        callbacks.onError(`消息保存失败：${message}`)
        completeBeforeRun()
        return
      }
    }

    // 0.5 清除上一轮中断标记
    try { updateAgentSessionMeta(sessionId, { stoppedByUser: false }) } catch { /* 会话可能已删除 */ }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
      // 凭据预检可能跨越 await；失败出口也必须遵守主动停止与删除墓碑语义。
      if (isAgentSessionDeleting(sessionId) || this.stoppedBeforeRunSessions.has(sessionId)) {
        completeBeforeRun({ stoppedByUser: true })
        return
      }
      const errorContent = typedError.title
        ? `${typedError.title}: ${typedError.message}`
        : typedError.message
      const errorSDKMsg: SDKMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: errorContent }],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        error: { message: typedError.message, errorType: typedError.code },
        _createdAt: Date.now(),
        _errorCode: typedError.code,
        _errorTitle: typedError.title,
        _errorDetails: typedError.details,
        _errorCanRetry: typedError.canRetry,
        _errorActions: typedError.actions,
      } as unknown as SDKMessage
      try { appendSDKMessages(sessionId, [errorSDKMsg]) } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      callbacks.onError(errorContent)
      completeBeforeRun()
    }

    // 已有会话的项目归属由持久化元数据决定；渲染端当前项目只是导航状态。
    const workspaceId = sessionMeta?.workspaceId ?? requestedWorkspaceId

    // 本地项目根由用户管理。根目录被删除、替换为文件或无法访问时，绝不能
    // 进入 SDK/Agent 初始化链路，以免后续文件工具通过 mkdir 间接重建该目录。
    if (workspaceId) {
      const workspace = getAgentWorkspace(workspaceId)
      if (!workspace) {
        reportPreflightError({
          code: 'workspace_not_found',
          title: '项目不存在',
          message: `指定的 Agent 项目不存在或已删除: ${workspaceId}`,
          actions: [],
          canRetry: false,
        })
        return
      }

      const projectRootStatus = await getLocalProjectRootStatus(workspace.projectRootPath)
      if (projectRootStatus && projectRootStatus !== 'available') {
        reportPreflightError({
          code: 'local_project_root_unavailable',
          title: '本地项目根目录不可用',
          message: `本地项目根目录不存在或无法访问：${workspace.projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
          details: [`目录状态: ${projectRootStatus}`],
          actions: [],
          canRetry: false,
        })
        return
      }
    }

    // Windows 缺少 Git Bash / WSL 时仍允许启动 Pi Agent。
    // Pi adapter 会移除 Bash 工具并注入基础模式说明；文件工具、对话和本地 Proma 工具不受影响。

    // 1. 获取渠道信息并解密 API Key
    const channel = getChannelById(channelId)
    if (!channel) {
      reportPreflightError({
        code: 'channel_not_found',
        title: '渠道不存在',
        message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    let apiKey: string
    let codexOAuthCredentials: CodexOAuthCredentials | undefined
    let githubCopilotOAuthCredentials: GithubCopilotOAuthCredentials | undefined
    let xaiOAuthCredentials: XaiOAuthCredentials | undefined
    try {
      // 订阅 OAuth 渠道必须保留完整凭据给 Pi runtime，才能在执行中按真实 expires
      // 自动刷新；其余渠道只需解密 API Key。
      if (channel.provider === 'openai-codex') {
        codexOAuthCredentials = await resolveCodexOAuthCredentials(channelId)
        apiKey = codexOAuthCredentials.access
      } else if (channel.provider === 'github-copilot') {
        githubCopilotOAuthCredentials = await resolveGithubCopilotOAuthCredentials(channelId)
        apiKey = githubCopilotOAuthCredentials.access
      } else if (channel.provider === 'xai') {
        xaiOAuthCredentials = await resolveXaiOAuthCredentials(channelId)
        apiKey = xaiOAuthCredentials.access
      } else {
        apiKey = decryptApiKey(channelId)
      }
    } catch (err) {
      if (channel.provider === 'openai-codex' || channel.provider === 'github-copilot' || channel.provider === 'xai') {
        const isXai = channel.provider === 'xai'
        const isGithubCopilot = channel.provider === 'github-copilot'
        reportPreflightError({
          code: 'expired_oauth_token',
          title: isXai ? 'xAI 登录已失效' : isGithubCopilot ? 'GitHub Copilot 登录已失效' : 'ChatGPT 登录已失效',
          message: isXai
            ? '无法刷新 xAI 登录凭据，登录可能已过期或被撤销。请在设置中重新登录 xAI。'
            : isGithubCopilot
              ? '无法刷新 GitHub Copilot 登录凭据，登录可能已过期、被撤销或不再拥有 Copilot 订阅。请在设置中重新登录。'
              : '无法刷新 ChatGPT 登录凭据，登录可能已过期或被撤销。请在设置中重新登录 ChatGPT。',
          actions: [
            { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
          ],
          canRetry: false,
        })
        return
      }
      reportPreflightError({
        code: 'api_key_decrypt_failed',
        title: 'API Key 解密失败',
        message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    const appSettings = getSettings()

    if (sessionMeta?.legacyTranscript?.continuationRequired) {
      reportPreflightError({
        code: 'agent_runtime_not_found',
        title: '历史会话需要迁移',
        message: '这是已退役 Claude runtime 的只读历史会话。请新建 Pi Agent 会话，并通过会话引用带入此历史。',
        actions: [],
        canRetry: false,
      })
      return
    }

    // 2.1 立即抢占会话槽位（在所有同步检查通过后、第一个 await 之前）
    // 防止 buildSdkEnv 等 await 期间并发调用绕过上方的检查，导致多条重复消息写入 JSONL
    // finally 块会通过 generation 匹配来安全清理，不影响正常流程
    if (isAgentSessionDeleting(sessionId) || this.stoppedBeforeRunSessions.has(sessionId)) {
      completeBeforeRun({ stoppedByUser: true })
      return
    }
    const runGeneration = input.runGeneration ?? this.reserveRunGeneration(sessionId)
    this.activeSessions.set(sessionId, runGeneration)
    this.activeSessionStartedAt.set(sessionId, streamStartedAt)
    callbacks.onRunStarted?.({
      startedAt: streamStartedAt,
      runGeneration,
      ...(initialUserMessageUuid ? {
        userMessage: rawUserMessage ?? userMessage,
        userMessageUuid: initialUserMessageUuid,
      } : {}),
    })

    const releaseActiveRun = (): void => {
      // 在发送 STREAM_COMPLETE 前释放 active slot，避免渲染进程已进入空闲态、
      // 主进程仍在 finally 前短暂拒绝下一条消息。
      const ownsActiveRun = this.activeSessions.get(sessionId) === runGeneration
      if (ownsActiveRun) {
        this.activeSessions.delete(sessionId)
        this.activeSessionStartedAt.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
      }
    }
    const completeRun = (
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onComplete(messages, { ...opts, runGeneration })
    }
    const failRun = (
      error: string,
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onError(error, { runGeneration })
      callbacks.onComplete(messages, { ...opts, runGeneration })
    }

    // 3. 构建 Pi runtime 环境（代理与 Windows shell 配置）。
    const proxyUrl = await getEffectiveProxyUrl()
    const runtimeEnv = buildAgentRuntimeEnv({
      proxyUrl,
      runtimeStatus: getRuntimeStatus(),
      windowsShellPreference: appSettings.windowsShellPreference,
    })

    // 4. 读取已有的 SDK session ID（用于 resume）
    let existingSdkSessionId = sessionMeta?.sdkSessionId

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, proma sessionId=${sessionId}`)

    // 5. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    let pendingSkillActivations: SkillActivation[] = []
    const recordSkillActivation = (
      activations: SkillActivation[],
      userMessageUuid: string,
    ): void => {
      pendingSkillActivations = mergeSkillActivations(pendingSkillActivations, activations)
      this.recordUserSkillActivations(sessionId, userMessageUuid, activations)
    }
    // 委派子会话必须继承当前实际运行的模型；未显式传入时与 runtime 的默认值保持一致。
    const selectedModelId = modelId || DEFAULT_MODEL_ID
    let resolvedModel = selectedModelId
    let titleGenerationStarted = false
    /** 捕获到的 SDK session ID（用于 resume / recovery） */
    let capturedSdkSessionId = existingSdkSessionId
    let agentCwd: string | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@proma/shared').AgentWorkspace | undefined

    try {
      console.log(`[Agent 编排] 启动 Pi runtime — 模型: ${modelId || DEFAULT_MODEL_ID}, resume: ${existingSdkSessionId ?? '无'}`)

      // 确定 Agent 工作目录
      agentCwd = homedir()
      workspaceSlug = undefined
      workspace = undefined
      if (workspaceId) {
        const ws = getAgentWorkspace(workspaceId)
        if (!ws) {
          throw new Error(`指定的 Agent 项目不存在或已删除: ${workspaceId}`)
        }
        let activeWorktree = sessionMeta?.activeWorktree
        // 检出目录可能被手动删除或移走：按历史平滑回退到仍存在的目录，
        // 并把回退目标写回历史，避免每轮都重新探测、也保留当时的 worktree 记录供恢复。
        const checkout = sessionMeta ? resolveSessionCheckoutCwd(ws, sessionMeta) : null
        if (checkout?.fellBack) {
          const fallbackEntry = checkout.kind === 'worktree'
            ? { kind: checkout.kind, path: checkout.path, mainRepoRoot: checkout.mainRepoRoot, branch: checkout.branch, baseCommit: checkout.baseCommit, since: Date.now() }
            : defaultCheckoutEntry(ws, sessionId, sessionMeta?.agentCwdMode)
              ?? { kind: checkout.kind, path: checkout.path, since: Date.now() }
          console.warn(`[Agent 编排] 检出目录已失效，平滑回退到 ${fallbackEntry.kind}: ${fallbackEntry.path}`)
          sessionMeta = updateAgentSessionMeta(sessionId, {
            activeWorktree: fallbackEntry.kind === 'worktree' ? activeWorktree : undefined,
            checkoutHistory: appendCheckoutEntry(sessionMeta?.checkoutHistory, fallbackEntry),
          })
          if (fallbackEntry.kind !== 'worktree') {
            activeWorktree = undefined
          }
        } else if (activeWorktree) {
          const activeWorktreePath = getActiveWorktreePath(sessionMeta)
          const currentMainRepoRoot = activeWorktreePath ? await getMainRepoRoot(activeWorktreePath) : null
          // 存量会话只有 activeWorktree、没有历史：校验仍有效后补一条初始历史，
          // 让后续解析统一走历史路径。
          if (activeWorktreePath && currentMainRepoRoot && normalizePathForCompare(currentMainRepoRoot) === normalizePathForCompare(activeWorktree.mainRepoRoot) && !sessionMeta?.checkoutHistory?.length) {
            sessionMeta = updateAgentSessionMeta(sessionId, {
              checkoutHistory: [checkoutFromActiveWorktree(activeWorktree)],
            })
          }
          if (!activeWorktreePath || !currentMainRepoRoot || normalizePathForCompare(currentMainRepoRoot) !== normalizePathForCompare(activeWorktree.mainRepoRoot)) {
            console.warn(`[Agent 编排] 活动 worktree 已失效，回退默认 cwd: ${activeWorktree.path}`)
            const fallback = defaultCheckoutEntry(ws, sessionId, sessionMeta?.agentCwdMode)
            sessionMeta = updateAgentSessionMeta(sessionId, {
              activeWorktree: undefined,
              ...(fallback ? { checkoutHistory: appendCheckoutEntry(sessionMeta?.checkoutHistory, fallback) } : {}),
            })
            activeWorktree = undefined
          }
        }
        agentCwd = resolveAgentCwd(ws, sessionId, sessionMeta?.agentCwdMode, activeWorktree) ?? homedir()
        workspaceSlug = ws.slug
        workspace = ws
        runtimeEnv.env.PROMA_WORKSPACE_DIR = getAgentWorkspacePath(ws.slug)
        runtimeEnv.env.PROMA_WORKSPACE_SLUG = ws.slug
        const cwdKind = activeWorktree ? `worktree ${activeWorktree.branch}` : getAgentCwdMode(sessionMeta)
        console.log(`[Agent 编排] 使用 ${cwdKind} cwd: ${agentCwd} (${ws.name}/${sessionId})`)


        if (existingSdkSessionId) {
          console.log(`[Agent 编排] 将尝试 resume: ${existingSdkSessionId}`)
        } else {
          console.log(`[Agent 编排] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
        }
      }

      // 9.4.1 Fork session JSONL 迁移已在 forkAgentSession 中完成；fork 的 cwd 语义
      // 从源会话继承并持久化，避免历史相对路径在恢复时切换到另一文件根。

      // 必须与 runtime 接收的附加目录保持一致；读取本机图片与文件的工具据此限制可访问路径。
      const productivityTools = appSettings.productivityTools
      const vaultUserContext = productivityTools.obsidianEnabled ? getVaultUserContext(sessionId) : null
      const attachedDirectories = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const allAdditionalDirectories = resolveRuntimeAdditionalDirectories(
        attachedDirectories,
        productivityTools.obsidianEnabled ? getAgentVaultRoots() : [],
      )
      const browserAllowedRoots = [...new Set([
        workspaceId ? agentCwd : undefined,
        workspaceSlug ? getProjectFilesPath(workspaceSlug) : undefined,
        ...allAdditionalDirectories,
      ].filter((root): root is string => typeof root === 'string' && root.length > 0))]
      // 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
      // （如 ~/.proma/agent-workspaces/workspace-xxx/sessionId）与 SDK 内部存储的路径哈希可能不匹配，
      // 导致 listSessions 始终返回 0 个会话，误杀有效的 resume。
      // SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume: ${existingSdkSessionId}`)
      }

      // 10. 构建工作区 MCP 配置与 Pi 基础运行时工具
      // worktree 会话的项目根跟随当前 checkout，记忆、项目规则与项目地图保持一致。
      const projectKnowledgeRoot = getActiveWorktreePath(sessionMeta) ?? (workspaceSlug ? getProjectFilesPath(workspaceSlug) : undefined)
      const memoryMaintenanceSince = Date.now()
      const memoryContext = workspaceSlug
        ? (() => {
            const context = getAgentMemoryContext(workspaceSlug, projectKnowledgeRoot)
            // 计划模式已下线，不再根据历史 permissionMode 关闭指令维护。
            if (input.triggeredBy === 'automation' || input.triggeredBy === 'delegation') {
              context.allowProfileMigration = false
              context.workspaces = []
            }
            return context
          })()
        : undefined
      const mcpServers = await this.buildMcpServers(workspaceSlug, proxyUrl)
      let piBuiltinTools: unknown[] = []
      let piMcpTools: unknown[] = []
      const piSdk = await import('@earendil-works/pi-coding-agent')
      const builtinMcpResult = await buildPiBuiltinTools(piSdk, {
        sessionId,
        channelId,
        modelId: selectedModelId,
        workspaceId,
        workspaceSlug,
        agentCwd,
        allowedRoots: browserAllowedRoots,
        // 权限模式不再参与运行时判定，传默认值保持字段管线完整。
        permissionMode: PROMA_DEFAULT_PERMISSION_MODE,
        triggeredBy: input.triggeredBy,
        windowsShellAvailable: process.platform !== 'win32' || runtimeEnv.shellKind != null,
        lastWindowsTerminalProfile: appSettings.lastWindowsTerminalProfile,
        productivityTools,
        projectKnowledgeRoot,
        onKnowledgeChanges: (changes) => {
          if (workspaceSlug) broadcastKnowledgeChanges(workspaceSlug, changes)
        },
      })
      piBuiltinTools = builtinMcpResult.tools
      const collaborationAvailable = builtinMcpResult.collaborationAvailable

      // 合并外部注入的自定义 MCP 服务器（如飞书群聊工具）

      // Proma 主进程连接用户 MCP server，并转换为 Pi custom tools。
      if (Object.keys(mcpServers).length > 0) {
        try {
          piMcpTools = await buildPiMcpTools(mcpServers)
        } catch (error) {
          console.warn('[Agent 编排] Pi MCP 工具桥接失败，已跳过用户 MCP:', error)
        }
      }

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd,
        narrationMode: migrateNarrationMode(sessionMeta?.narrationMode),
        userBrowserContext: browserController.getUserContext(sessionId),
        userVaultContext: vaultUserContext,
      })
      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅影响 prompt，不影响持久化
      let enrichedMessage = userMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      if (mentionedSkills?.length || mentionedMcpServers?.length) {
        const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
        for (const slug of mentionedSkills ?? []) {
          const qualifiedName = workspaceSlug
            ? `proma-workspace-${workspaceSlug}:${slug}`
            : slug
          toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
        }
        for (const name of mentionedMcpServers ?? []) {
          toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
        }
        enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${mentionedSkills?.length ?? 0} skills, ${mentionedMcpServers?.length ?? 0} MCP`)
      }
      const referencedPlanningBlock = buildReferencedPlanningPrompt(
        productivityTools.todosEnabled ? mentionedTodoIds : undefined,
        productivityTools.calendarEnabled ? mentionedCalendarEventIds : undefined,
        { requireToolRead: true },
      )
      if (referencedPlanningBlock) {
        enrichedMessage = `${referencedPlanningBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_planning: ${mentionedTodoIds?.length ?? 0} todos, ${mentionedCalendarEventIds?.length ?? 0} calendar events`)
      }

      const contextualMessage = [dynamicCtx, enrichedMessage].filter(Boolean).join('\n\n')

      const isCompactCommand = userMessage.trim() === '/compact'
      const finalPrompt = isCompactCommand
        ? '/compact'
        : existingSdkSessionId
          ? contextualMessage
          : buildContextPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })

      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
      } else if (finalPrompt !== contextualMessage) {
        console.log(`[Agent 编排] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
      }

      // 12. 权限模式与计划模式已下线
      // 产品决策：不再向用户暴露权限模式选择，也不再逐次确认工具调用，工具直接执行。
      // 保留权限模式字段与 canUseTool 管道：底层拦截能力（agent-permission-service、
      // agent-exit-plan-service、agent-plan-file-policy）完整保留，便于日后恢复确认入口；
      // 老会话索引里的 permissionMode 仍会被读取，但不再参与运行期判定。
      const initialPermissionMode: PromaPermissionMode = PROMA_DEFAULT_PERMISSION_MODE
      const runTriggeredBy = input.triggeredBy

      // ── 本轮文件改动录制 ──
      // 轮首给工作树做 Git 快照，文件工具执行前保存写前副本，轮末比较快照与副本，
      // 结果写回该轮用户消息的 turn_changes（渲染层底部的改动卡据此渲染）。
      // key 用触发本轮的用户消息 uuid：本轮由前端发起时已知（initialUserMessageUuid），
      // 否则（自动化、直接重试等）回退到历史里最后一条真实用户输入。
      // 注：JSONL 实际落盘的是 SDK 消息结构，getAgentSessionMessages 的返回类型只是宽松声明，
      // 所以这里按运行时字段扫描。
      const activeTurnUserMessageUuid: string | undefined = initialUserMessageUuid ?? (() => {
        const history = getAgentSessionMessages(sessionId) as unknown[]
        for (let index = history.length - 1; index >= 0; index -= 1) {
          const item = history[index] as {
            type?: string
            uuid?: string
            isSynthetic?: boolean
            message?: { content?: unknown }
          } | undefined
          if (item?.type !== 'user' || item.isSynthetic) continue
          const blocks = item.message?.content
          if (Array.isArray(blocks) && blocks.some((block) => (block as { type?: string } | null)?.type === 'tool_result')) continue
          if (typeof item.uuid === 'string' && item.uuid.length > 0) return item.uuid
        }
        return undefined
      })()

      if (activeTurnUserMessageUuid && agentCwd) {
        beginTurnChanges(sessionId, activeTurnUserMessageUuid, agentCwd)
      }

      /** 结算本轮文件改动并写回用户消息；失败只告警，不影响本轮收尾。 */
      const settleActiveTurnChanges = async (): Promise<void> => {
        if (!activeTurnUserMessageUuid) return
        const turnKey = activeTurnUserMessageUuid
        try {
          const summary = await finishTurnChanges(sessionId, turnKey)
          if (summary !== null) {
            updateSDKUserMessageTurnChanges(sessionId, turnKey, summary)
          }
        } catch (error) {
          console.warn('[Agent 编排] 结算本轮文件改动失败:', error)
        }
      }

      /**
       * 工具调用拦截管道
       *
       * wrapToolWithPermission 会把每个工具调用交给这里。管道保留，但不再向用户发起逐次确认：
       * 除参数校验、AskUser 交互与无人值守删除边界外，其余调用一律放行。
       */
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: CanUseToolOptions,
      ): Promise<PermissionResult> => {
        // ── 参数校验守卫（先于任何放行判断） ──
        const validationFailure = validateToolInput(toolName, input)
        if (validationFailure) {
          console.warn(`[Agent 工具验证] 参数缺失: tool=${toolName}`)
          return validationFailure
        }

        // ── Write 大文件 token 截断防护 ──
        // 这不是用户确认，而是「写入必然被截断」的前置判断，权限模式下线后仍然保留。
        if (toolName === 'Write' && typeof input.content === 'string') {
          const estimatedTokens = estimateTokenCount(input.content)
          if (estimatedTokens > WRITE_CONTENT_TOKEN_THRESHOLD) {
            console.warn(
              `[Agent 工具验证] Write 内容过大: tokens≈${estimatedTokens}, chars=${input.content.length}, file=${String(input.file_path)}`,
            )
            return {
              behavior: 'deny' as const,
              message:
                `The content for Write tool (~${estimatedTokens} estimated tokens, ${input.content.length} chars) is too large and may be truncated. ` +
                `Please split the write into smaller sequential steps: write the first portion of the file now, then use Edit tool to append remaining sections incrementally.`,
            }
          }
        }

        // AskUserQuestion：交互式问答与权限无关，始终走问答流程。
        if (toolName === 'AskUserQuestion') {
          return askUserService.handleAskUserQuestion(
            sessionId, input, options.signal,
            (request: AskUserRequest) => {
              this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'ask_user_request', request } })
            },
          )
        }

        // 定时任务与协作子 Agent 不能删除本地规划数据，必须由用户主会话发起。
        if (resolvePlanningDeletionPermission(toolName, runTriggeredBy) === 'deny-unattended') {
          return { behavior: 'deny' as const, message: '定时任务和协作子 Agent 不能删除本地规划数据，请由用户主会话发起并确认。' }
        }

        // 保留管道，当前产品决策为直接执行（对齐商业版 0.22.0）。
        // 放行前捕获文件修改工具的写前副本，轮末据此统计真实改动。
        await preExecuteTurnTool(sessionId, toolName, input, agentCwd ?? process.cwd())
        return { behavior: 'allow' as const, updatedInput: input }
      }

      // 13. 构建 Adapter 查询选项
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0
        ? appSettings.agentMaxTurns
        : undefined
      const piReasoningCapability = await resolvePiReasoningCapability(channel.provider, selectedModelId)
      const piThinkingLevel = resolvePiThinkingLevel(appSettings, sessionMeta, channel.provider, selectedModelId, piReasoningCapability)
      const projectInstructions = workspaceSlug
        ? (() => {
            try {
              const manifest = resolveProjectInstructions({ projectRoot: getProjectFilesPath(workspaceSlug) })
              for (const diagnostic of manifest.diagnostics) {
                console.warn(`[项目指令] ${diagnostic.path}: ${diagnostic.message}`)
              }
              return manifest
            } catch (error) {
              console.warn('[项目指令] 解析失败，已跳过本轮项目指令注入:', error)
              return undefined
            }
          })()
        : undefined
      // 与商业版一致：工作区级 AGENTS.md 不再作为项目地图注入，只作为待迁移的外层规则。
      const instructionFiles = projectInstructions?.sources.map(({ path, content }) => ({ path, content })) ?? []
      const systemPromptAppend = buildSystemPrompt({
        workspaceName: workspace?.name,
        workspaceSlug,
        sessionId,
        agentCwd,
        sessionWorkbenchLayout: getSessionWorkbenchLayout(sessionMeta),
        permissionMode: initialPermissionMode,
        narrationMode: migrateNarrationMode(sessionMeta?.narrationMode),
        collaborationAvailable,
        currentModelId: selectedModelId,
        projectKnowledgeRoot,
        productivityTools,
      }) + (automationContext ? `\n\n## 定时任务执行上下文\n\n${automationContext}` : '')
      const startAutoTitleGeneration = (): void => {
        if (titleGenerationStarted) return
        titleGenerationStarted = true

        // 标题请求与前台 Agent run 使用独立的 Codex Responses 请求，可并发执行。
        // 自动标题只会写入仍为默认名称的会话，因此不会覆盖用户的手动重命名。
        // 标题优先基于用户原文；Bridge 追加的来源标记等 Agent 运行上下文不应出现在标题中。
        this.autoGenerateTitle(sessionId, rawUserMessage ?? userMessage, channelId, resolvedModel, callbacks)
          .catch((err) => console.error('[Agent 编排] 标题生成未捕获异常:', err))
      }
      const handleSessionId = (sdkSessionId: string, piSessionFile?: string): void => {
        // 仅在 session_id 真正变化时才持久化。Pi 在同一 artifact 的每条消息都可能回调，
        // capturedSdkSessionId 已初始化为 existingSdkSessionId，并在 recovery 时同步重置。
        const isNewSessionId = sdkSessionId !== capturedSdkSessionId
        const latestSessionMeta = getAgentSessionMeta(sessionId)
        // recovery 新建 artifact 后，旧 entry bindings 属于另一棵 Pi tree，必须原子替换而非合并。
        const artifactReplaced = !!piSessionFile && latestSessionMeta?.piSessionFile !== piSessionFile
        capturedSdkSessionId = sdkSessionId
        if (isNewSessionId || artifactReplaced) {
          try {
            // 用户可在本轮运行中改选下一轮内核；不能让旧 runtime 回填不兼容的 session artifact。
            if (latestSessionMeta?.legacyTranscript?.continuationRequired) {
              console.log(`[Agent 编排] 忽略只读历史会话的 session artifact: ${sdkSessionId}`)
            } else {
              updateAgentSessionMeta(sessionId, {
                sdkSessionId,
                ...(piSessionFile ? { piSessionFile } : {}),
                ...(artifactReplaced ? { piEntryBindings: {} } : {}),
              })
              console.log(`[Agent 编排] 已保存 Pi session_id: ${sdkSessionId}`)
            }
          } catch (err) {
            console.error(`[Agent 编排] 保存 Pi session_id 失败:`, err)
          }
        }

      }
      const handleModelResolved = (model: string): void => {
        // `[1m]` 是 SDK 内部上下文变体，不应泄漏到标题生成或用户可见的模型名。
        resolvedModel = model.replace(/\[1m\]$/i, '')
        console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
        this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'model_resolved', model: resolvedModel } })
      }
      const handleContextWindow = (cw: number): void => {
        const inferredWindow = inferContextWindow(modelId)
        const contextWindow = Math.max(cw, inferredWindow ?? 0) || cw
        console.log(`[Agent 编排] 缓存 contextWindow: ${contextWindow}`)
        // result 消息里的真实 contextWindow 透传到 renderer，
        // 覆盖流式过程中按模型名推断的 fallback 值（智谱等端点会把 [1m] 等后缀剥掉，导致 fallback 不准）
        this.eventBus.emit(sessionId, {
          kind: 'proma_event',
          event: { type: 'context_window', contextWindow },
        })
      }
      const piCustomTools = [...piBuiltinTools, ...piMcpTools, ...(extensions.piCustomTools ?? [])]
      let githubCopilotCredentialsSnapshot = githubCopilotOAuthCredentials
      const queryOptions: PiAgentQueryOptions = {
        sessionId,
        prompt: finalPrompt,
        // 旧持久化模型 ID 可能带 `[1m]` 上下文后缀；Pi runtime 不支持该变体：
        // 智谱等端点不识别 glm-5.2[1m] 这类后缀，会返回 1211「模型不存在」。
        // 因此 pi 分支直接使用用户配置的原始模型 ID，不追加任何 `[1m]`。
        model: selectedModelId,
        cwd: agentCwd,
        apiKey,
        baseUrl: channel.baseUrl,
        provider: channel.provider,
        channelId,
        channelName: channel.name,
        proxyUrl,
        runtimeEnv,
        ...(maxTurns != null && { maxTurns }),
        permissionMode: initialPermissionMode,
        canUseTool,
        systemPrompt: systemPromptAppend + buildPiAdditionalDirectoriesPrompt(allAdditionalDirectories),
        ...(instructionFiles.length > 0 && { projectInstructionFiles: instructionFiles }),
        // 只传字符串路径：query 选项会被结构化克隆到 runtime 进程，函数无法序列化。
        ...(memoryContext && {
          memoryContext,
          memoryMaintenanceSince,
          ...(workspaceSlug ? { projectInstructionRoot: projectKnowledgeRoot ?? getProjectFilesPath(workspaceSlug) } : {}),
        }),
        ...(projectInstructions && {
          projectInstructionScope: {
            projectRoot: projectInstructions.projectRoot,
            initialSources: projectInstructions.sources,
          },
        }),
        resumeSessionId: existingSdkSessionId,
        initialUserMessageUuid,
        piAgentDir: getSdkConfigDir(),
        piSessionDir: join(getSdkConfigDir(), 'sessions'),
        ...(allAdditionalDirectories.length > 0 && { additionalDirectories: allAdditionalDirectories }),
        ...(workspaceSlug ? {
          additionalSkillPaths: [getWorkspaceSkillsDir(workspaceSlug)],
          skillWorkspaceSlug: workspaceSlug,
        } : {}),
        ...(mentionedSkills?.length ? { skillMentions: mentionedSkills } : {}),
        onSkillActivated: recordSkillActivation,
        ...(isCompactCommand ? { compactRequest: true } : {}),
        ...(sessionMeta?.codexFastMode && channel.provider === 'openai-codex' ? { codexFastMode: true } : {}),
        ...(codexOAuthCredentials && {
          codexOAuthCredentials,
          onCodexOAuthCredentialsRefreshed: (credentials: CodexOAuthCredentials) => {
            persistCodexOAuthCredentials(channelId, credentials)
          },
        }),
        ...(githubCopilotOAuthCredentials && {
          githubCopilotOAuthCredentials,
          onGithubCopilotOAuthCredentialsRefreshed: (credentials: GithubCopilotOAuthCredentials) => {
            const expectedCredentials = githubCopilotCredentialsSnapshot
            if (expectedCredentials && persistGithubCopilotOAuthCredentials(channelId, credentials, expectedCredentials)) {
              githubCopilotCredentialsSnapshot = credentials
            }
          },
        }),
        ...(xaiOAuthCredentials && {
          xaiOAuthCredentials,
          onXaiOAuthCredentialsRefreshed: (credentials: XaiOAuthCredentials) => {
            persistXaiOAuthCredentials(channelId, credentials)
          },
        }),
        ...((channel.provider === 'openai-codex' || channel.provider === 'xai' || channel.provider === 'openai-responses' || channel.provider === 'openai' || channel.provider === 'custom')
          && resolveReasoningProfile({
            modelId: selectedModelId,
            transport: inferReasoningTransport(channel.provider),
          })?.id.startsWith('openai-reasoning-') && {
            openAIThinkingLevel: piThinkingLevel!,
          }),
        thinkingLevel: piThinkingLevel!,
        ...(appSettings.agentMaxBudgetUsd != null && appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        ...(piCustomTools.length > 0 && { customTools: piCustomTools as PiAgentQueryOptions['customTools'] }),
        onSessionId: handleSessionId,
        onPiEntryBindings: (bindings) => {
          const latest = getAgentSessionMeta(sessionId)
          // 运行中切到其他内核后，保留旧 turn 展示但不再写入 Pi 专用恢复 artifact。
          if (latest?.legacyTranscript?.continuationRequired) return
          updateAgentSessionMeta(sessionId, {
            piEntryBindings: { ...(latest?.piEntryBindings ?? {}), ...bindings },
          })
        },
        onModelResolved: handleModelResolved,
        onContextWindow: handleContextWindow,
        retryRunStartedAt: streamStartedAt,
        onRetry: (retry) => {
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'retry', ...retry } })
        },
      }

      // 首条用户消息已持久化且运行参数已就绪，立刻启动自动命名。
      // 不依赖 Pi onSessionId：部分第三方渠道在该回调延迟或缺失时仍必须完成重命名。
      startAutoTitleGeneration()

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 事件流。Pi adapter 自行处理传输层重试；此处仅允许一次 resume artifact 回退。
      const MAX_QUERY_ATTEMPTS = 2
      // 历史思考块的 signature 只在 Anthropic Messages 协议下校验，其余协议剥离会白丢推理内容。
      const piModelApiProtocol = resolvePiApi(channel.provider)
      // 整次 run 只允许一次「剥离历史思考块」兜底重试，避免与网关反复对抗、把重试预算耗光。
      let thinkingStripRetryUsed = false
      const queryStartedAt = Date.now()
      // 运行期标记只随 EventBus 的浅拷贝发送到 renderer，绝不污染待持久化的 SDKMessage。
      // renderer 据此拒绝旧 run 的迟到消息，避免其覆盖当前任务进度。
      const emitLiveSdkMessage = (message: SDKMessage): void => {
        this.eventBus.emit(sessionId, {
          kind: 'sdk_message',
          message: {
            ...(message as Record<string, unknown>),
            _promaLiveRunStartedAt: streamStartedAt,
            _promaLiveRunGeneration: runGeneration,
          } as unknown as SDKMessage,
        })
      }

      for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
        // stop() releases the active slot before aborting the adapter. It can win
        // the race against async preflight or a recoverable-error retry, when no
        // adapter query exists yet to cancel. Never start that later query.
        if (isAgentSessionDeleting(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) {
          const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
          try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
          await settleActiveTurnChanges()
          completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
          return
        }

        // A recovery query starts a fresh turn; activations from a failed attempt must not leak.
        pendingSkillActivations = []
        // 回退会清除 queryOptions.resumeSessionId；新建 Pi artifact 不应再触发 prompt replay。
        const wasResuming = !!queryOptions.resumeSessionId
        let shouldRetryFromError = false

        try {
          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = this.adapter.query(queryOptions)
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // 手动事件循环：Promise.race（SDKMessage vs result drain timeout）
          let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // result 收到后的安全超时：正常情况下 adapter 收到 terminal result 后会主动 break 自己的
          // for-await 循环（触发 SDK iterator.return → cleanup），让此处的 next() 立即拿到 done。
          // 此 timeout 仅作真正的兜底安全网，防止极端情况（SDK 行为再次变化等）下 iterator 不关闭、
          // 事件循环无限挂起。正常运行下不应触发——若日志频繁出现 drain timeout，说明 adapter 主动
          // 终止路径失效，需排查。
          let drainTimeoutPromise: Promise<'drain_timeout'> | null = null
          const RESULT_DRAIN_TIMEOUT_MS = 2_000
          let visibleRunMessageCount = 0

          while (true) {
            if (!pendingNext) {
              pendingNext = queryIterator.next()
            }

            const racePromises: Array<Promise<{ kind: string; result: IteratorResult<SDKMessage> | null }>> = [
              pendingNext.then((r) => ({ kind: 'event' as const, result: r })),
            ]
            if (drainTimeoutPromise) {
              racePromises.push(drainTimeoutPromise.then(() => ({ kind: 'drain_timeout' as const, result: null })))
            }

            const raceResult = await Promise.race(racePromises)

            if (raceResult.kind === 'drain_timeout') {
              // 安全网：channel.close() 后 SDK 仍未在超时内关闭 iterator，强制退出
              console.warn(`[Agent 编排] drain timeout: SDK iterator 在 result 后 ${RESULT_DRAIN_TIMEOUT_MS}ms 内未关闭，强制退出`)
              pendingNext?.catch(() => {})
              pendingNext = null
              queryIterator.return?.(undefined as never).catch(() => {})
              break
            }

            const iterResult = raceResult.result
            if (!iterResult || iterResult.done) break

            pendingNext = null
            let msg = iterResult.value
            if (isAssistantDeltaSDKMessage(msg)) {
              this.eventBus.emit(sessionId, {
                kind: 'sdk_delta',
                delta: {
                  uuid: msg.uuid,
                  deltas: [msg.delta],
                  session_id: msg.session_id,
                  runStartedAt: streamStartedAt,
                  runGeneration,
                  _channelModelId: msg._channelModelId,
                },
              })
              continue
            }
            const isPartialMessage = isPartialSDKMessage(msg)
            if (msg.type === 'result') {
              const skillActivations = mergeSkillActivations(
                pendingSkillActivations,
                collectSkillActivations(
                  [...accumulatedMessages, msg],
                  workspaceSlug
                    ? { workspaceSlug, workspaceSkillsRoot: getWorkspaceSkillsDir(workspaceSlug) }
                    : undefined,
                ),
              )
              if (skillActivations.length > 0) {
                msg = {
                  ...(msg as Record<string, unknown>),
                  skill_activations: skillActivations,
                } as unknown as SDKMessage
              }
              pendingSkillActivations = []
            }
            // isVisibleRunMessage 已抽到独立模块，不含 partial 判断；
            // pi runtime 的流式 partial 消息不应计入可见消息数，故在此显式排除。
            if (!isPartialMessage && isVisibleRunMessage(msg)) {
              visibleRunMessageCount += 1
            }

            // 检测 assistant 消息中的 SDK 错误
            if (msg.type === 'assistant' && !isPartialMessage) {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                // Pi keeps generated text and the transport failure in separate fields. Claude's
                // content-first extractor would otherwise promote the text to error details.
                const { detailedMessage, originalError } = getPiAssistantErrorDetails(assistantMsg)
                let errorCode = assistantMsg.error.errorType || 'unknown_error'
                if (isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                // 开源版没有 Proma Cloud 渠道，402 一律按第三方渠道账单错误处理；
                // 商业版由 channel.provider === 'proma' 传入 isPromaChannel 区分额度不足。
                const typedError = mapAgentErrorToTypedError(errorCode, friendlyErrorMessage(detailedMessage), originalError, {
                  isPromaChannel: false,
                })

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && wasResuming) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Proma 已持久化上下文重跑一次；再失败才展示用户提示。
                if (
                  typedError.code === THINKING_SIGNATURE_ERROR_CODE &&
                  wasResuming
                ) {
                  // 回填重跑仍会带着带 signature 的历史思考块，一并开启强制剥离。
                  queryOptions.forceThinkingStrip = true
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
                    true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
                  )
                  shouldRetryFromError = true
                  break
                }

                // 上下文过长：旧 SDK session 已经处于不可继续的超限状态。
                // 自动清除 resume 指针，改用 Proma 最近历史回填重跑一次；用于飞书/自动任务等无人值守入口自恢复。
                if (
                  typedError.code === 'prompt_too_long' &&
                  wasResuming
                ) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
                    true,
                  )
                  shouldRetryFromError = true
                  break
                }

                // 上游 400 的诊断文本可能被网关隐去（new-api 类中转会把错误压成
                // 「upstream http 400」），此时无法按具体错误码分流。按「Claude 家族 +
                // Anthropic Messages 协议」识别这类隐去诊断的 400，先剥离历史思考块再重试一次，
                // 而不是直接把 400 抛给用户。
                if (
                  !thinkingStripRetryUsed &&
                  isClaudeFamilyModelId(selectedModelId) &&
                  piModelApiProtocol === 'anthropic-messages' &&
                  isOpaqueUpstream400(detailedMessage, originalError) &&
                  attempt < MAX_QUERY_ATTEMPTS
                ) {
                  thinkingStripRetryUsed = true
                  queryOptions.forceThinkingStrip = true
                  shouldRetryFromError = true
                  console.warn(`[Agent 编排] 上游 400 诊断被网关隐去，剥离历史思考块后重试: ${sessionId}`)
                  break
                }

                // 不可重试 → 终止
                const hasPiPartialOutput = hasPiAssistantTextContent(assistantMsg)
                if (hasPiPartialOutput) {
                  const partialOutput = stripPiAssistantError(assistantMsg)
                  if (modelId) partialOutput._channelModelId = modelId
                  partialOutput._channelProvider = channel.provider
                  const partialRecord = partialOutput as SDKAssistantMessage & { _createdAt?: number }
                  if (typeof partialRecord._createdAt !== 'number') {
                    partialRecord._createdAt = streamStartedAt
                  }
                  accumulatedMessages.push(partialOutput)
                  // Reuse the Pi UUID to replace the latest partial frame with normal markdown output.
                  emitLiveSdkMessage(partialOutput)
                }
                this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                accumulatedMessages.length = 0
                if (typedError.code === 'prompt_too_long') {
                  try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
                }

                const errorContent = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  uuid: randomUUID(),
                  _channelModelId: modelId,
                  _channelProvider: channel.provider,
                  error: { message: typedError.message, errorType: typedError.code },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                appendSDKMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                emitLiveSdkMessage(errorSDKMsg)
                try { updateAgentSessionMeta(sessionId, {}) } catch { /* 忽略 */ }
                await settleActiveTurnChanges()
                completeRun(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
                return
              }
            }

            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积需要长期可见的状态（压缩 / 权限拒绝）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              const msgRecord = msg as Record<string, unknown>
              if (!msgRecord.isReplay && !isPartialMessage) {
                if (msg.type === 'user') {
                  // 仅累积包含 tool_result 的 user 消息（跳过 SDK 重新发出的初始用户消息）
                  const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
                  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
                  if (hasToolResult) {
                    observeTurnToolResult(sessionId)
                    accumulatedMessages.push(msg)
                  }
                } else {
                  // 为结果消息注入渠道信息，确保持久化后能按模型上下文窗口计算压缩阈值
                  if (msg.type === 'result') {
                    if (modelId) {
                      (msg as Record<string, unknown>)._channelModelId = modelId
                    }
                    ;(msg as Record<string, unknown>)._channelProvider = channel.provider
                  }
                  // 为 assistant 消息注入渠道信息，确保持久化后能正确匹配模型显示名与上下文窗口
                  if (msg.type === 'assistant') {
                    const assistantRecord = msg as Record<string, unknown>
                    if (typeof assistantRecord._createdAt !== 'number') {
                      assistantRecord._createdAt = streamStartedAt
                    }
                    if (modelId) {
                      assistantRecord._channelModelId = modelId
                    }
                    assistantRecord._channelProvider = channel.provider
                  }
                  accumulatedMessages.push(msg)
                }
              }
            } else if (msg.type === 'system') {
              const sysMsg = msg as SDKSystemMessage
              if (isPersistableSDKSystemMessage(sysMsg)) {
                accumulatedMessages.push(msg)
              }
            }

            // Turn 结束时：持久化累积消息
            if (msg.type === 'result') {
              capturedResultSubtype = (msg as { subtype?: string }).subtype
              // Pi result 的 errors[] 携带真实错误原因，透传到前端展示具体错误。
              const rawResultErrors = (msg as { errors?: unknown }).errors
              capturedResultErrors = Array.isArray(rawResultErrors)
                ? rawResultErrors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                : undefined
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
              console.log(
                `[Agent 编排] result 到达: sessionId=${sessionId}, subtype=${capturedResultSubtype ?? 'unknown'}` +
                (capturedResultErrors?.length ? `, errors=${JSON.stringify(capturedResultErrors)}` : ''),
              )
              // Pi 也可能在 result 中报告失效的 resume artifact；仅回退本轮实际 resume 的请求。
              const resultErrorText = capturedResultErrors?.join('\n')
              if (resultErrorText && wasResuming) {
                if (isSessionNotFoundError(resultErrorText)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  shouldRetryFromError = true
                  break
                }
                if (isPromptTooLongError(resultErrorText)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式', true,
                  )
                  shouldRetryFromError = true
                  break
                }
                if (isThinkingSignatureError(resultErrorText)) {
                  queryOptions.forceThinkingStrip = true
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式', true,
                  )
                  shouldRetryFromError = true
                  break
                }
              }
              if (!drainTimeoutPromise) {
                // Pi adapter 收到终态 result 后会结束 iterator；超时仅保护异常运行时行为。
                drainTimeoutPromise = new Promise((resolve) =>
                  setTimeout(() => resolve('drain_timeout'), RESULT_DRAIN_TIMEOUT_MS),
                )
              }
            }

            // 过滤 SDK 内部生成的 user 消息（如 Skill 展开文本），避免在前端渲染为用户消息
            // 仅允许含 tool_result 的 user 消息通过（这些是工具调用的响应，需要展示）
            // 初始用户消息已通过前端乐观注入显示，无需 SDK 重复推送
            let shouldEmit = true
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
              const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
              if (!hasToolResult) {
                shouldEmit = false
              }
            }

            if (!shouldEmit) {
              // 跳过 SDK 内部 user 消息的前端推送
            } else {
              emitLiveSdkMessage(msg)
            }
          }

          // 需要恢复时，前一次 adapter iterator 尚未自然结束。显式 return 才会
          // 执行 PiUtilityAdapter 的 finally，释放旧 runtime 与 pending query；否则
          // 同一 session 会残留多个运行时，后续 stop 只能取消其中一个。
          if (shouldRetryFromError) {
            await queryIterator.return?.(undefined as never).catch(() => {})
            continue
          }

          const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          try { updateAgentSessionMeta(sessionId, wasStoppedByUser ? { stoppedByUser: true } : {}) } catch { /* 忽略 */ }

          if (!wasStoppedByUser && visibleRunMessageCount === 0) {
            const errorContent = this.persistEmptyResponseError(sessionId, capturedResultSubtype, capturedResultErrors)
            await settleActiveTurnChanges()
            failRun(errorContent, getAgentSessionMessages(sessionId), {
              startedAt: streamStartedAt,
              resultSubtype: EMPTY_RESPONSE_RESULT_SUBTYPE,
              resultErrors: [errorContent],
            })
            return
          }

          // 发送完成信号；先把本轮文件改动写回用户消息，completeRun 携带的消息才会带上 turn_changes
          await settleActiveTurnChanges()
          completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })

          return

        } catch (error) {
          // 同一 session 的新 run 可能已在旧 run 的迟到错误之前开始；只要
          // 本代际不再拥有 active slot，就只能收束自己，不能向新 run 泄漏终态。
          if (isAgentSessionDeleting(sessionId) || this.activeSessions.get(sessionId) !== runGeneration) {
            const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
            await settleActiveTurnChanges()
            completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
            return
          }

          const rawErrorMessage = errorMessageOf(error)
          const catchLooksPromptTooLong = isPromptTooLongError(rawErrorMessage)

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage) && wasResuming) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
            continue  // 进入下一次 retry 循环
          }

          // 上下文过长：清除超限 resume 指针，用 Proma 历史回填自动恢复一次。
          if (catchLooksPromptTooLong && wasResuming) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
              true,
            )
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (
            isThinkingSignatureError(rawErrorMessage) &&
            wasResuming
          ) {
            // 回填重跑仍会带着带 signature 的历史思考块，一并开启强制剥离。
            queryOptions.forceThinkingStrip = true
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
              true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
            )
            continue  // 进入下一次 retry 循环
          }

          // 上游 400 诊断被网关隐去时同样兜底：按协议特征剥离历史思考块后重试一次。
          // 与上面 assistant 错误分支共用同一个一次性标记，整次 run 不会重复剥离。
          if (
            !thinkingStripRetryUsed &&
            isClaudeFamilyModelId(selectedModelId) &&
            piModelApiProtocol === 'anthropic-messages' &&
            isOpaqueUpstream400(rawErrorMessage) &&
            attempt < MAX_QUERY_ATTEMPTS
          ) {
            thinkingStripRetryUsed = true
            queryOptions.forceThinkingStrip = true
            console.warn(`[Agent 编排] 上游 400 诊断被网关隐去，剥离历史思考块后重试一次: ${sessionId}`)
            continue
          }

          // 不可重试 — 走原有终止逻辑
          const errorMessage = rawErrorMessage || '未知错误'
          console.error(`[Agent 编排] 执行失败:`, error)

          // 保存已累积的部分内容
          if (accumulatedMessages.length > 0) {
            try {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              console.log(`[Agent 编排] 已保存部分执行结果 (${accumulatedMessages.length} 条消息)`)
            } catch (saveError) {
              console.error('[Agent 编排] 保存部分内容失败:', saveError)
            }
          }

          let userFacingError = friendlyErrorMessage(errorMessage)

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const errorStack = error instanceof Error ? (error.stack ?? error.message) : String(error)
            const isPromptTooLong = isPromptTooLongError(userFacingError, errorStack)
            const isThinkingSignature = isThinkingSignatureError(userFacingError, rawErrorMessage, errorStack)
            const errorCode = isPromptTooLong
              ? 'prompt_too_long'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_CODE
                : 'unknown_error'
            const errorTitle = isPromptTooLong
              ? '上下文过长'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_TITLE
                : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
                  { key: 'r', label: '重试', action: 'retry' },
                ]
              : undefined
            userFacingError = errorContent
            if (isPromptTooLong) {
              try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
            }

            const errMsg: SDKMessage = {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: errorContent }],
              },
              parent_tool_use_id: null,
              uuid: randomUUID(),
              error: { message: errorContent, errorType: errorCode },
              _createdAt: Date.now(),
              _errorCode: errorCode,
              _errorTitle: errorTitle,
              _errorActions: errorActions,
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          await settleActiveTurnChanges()
          failRun(userFacingError, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

          // 保留 Pi session ID，确保网络或上游临时失败后的下一轮可继续 resume。
          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 保留 sdkSessionId 以便下一轮 resume（错误未表明会话失效）`)
          }

          return
        }
      }

      const recoveryFailure = '会话恢复失败，请新建会话继续'
      const recoveryError: SDKMessage = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: recoveryFailure }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        error: { message: recoveryFailure, errorType: 'unknown_error' },
        _createdAt: Date.now(),
        _errorCode: 'unknown_error',
        _errorTitle: '会话恢复失败',
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [recoveryError])
      await settleActiveTurnChanges()
      failRun(recoveryFailure, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

    } finally {
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      releaseActiveRun()
      permissionService.clearSessionPending(sessionId)
      // askUserService 不在 turn 结束时清理——AskUserQuestion 的生命周期由用户交互决定，
      // 仅在会话真正删除时（DELETE_SESSION IPC）才清理。
      exitPlanService.clearSessionPending(sessionId)
    }
  }

  /**
   * 中止指定会话的 Agent 执行
   *
   * 先从 activeSessions 移除（供 sendMessage catch 块检测用户中止），
   * 再调用 adapter.abort() 中止底层 SDK 进程。
   */
  stop(sessionId: string, stopBeforeRun = false): void | Promise<void> {
    const runGeneration = this.activeSessions.get(sessionId)
    this.activeSessions.delete(sessionId)
    this.activeSessionStartedAt.delete(sessionId)
    browserController.cancelSession(sessionId)
    if (runGeneration != null) {
      this.stoppedBySessions.set(sessionId, runGeneration)
    } else if (stopBeforeRun) {
      // 队列启动状态已投影给 renderer 后，run 仍可能卡在预检阶段。
      // 记录这次停止，防止预检完成后错误地创建一个无法终止的新 query。
      this.stoppedBeforeRunSessions.add(sessionId)
    }
    this.queuedMessageUuids.delete(sessionId)
    const abort = this.adapter.abort(sessionId)
    console.log(`[Agent 编排] 已中止会话: ${sessionId}`)
    return abort
  }

  /** 删除会话专用：等待已发出的底层中止请求完成，再移除持久化文件。 */
  async stopAndDrain(sessionId: string): Promise<void> {
    await this.stop(sessionId, true)
  }

  /** 为一个会话预留下一次运行身份。所有 run lifecycle 事件都必须复用该值。 */
  reserveRunGeneration(sessionId: string): number {
    const runGeneration = (this.nextRunGenerationBySession.get(sessionId) ?? 0) + 1
    this.nextRunGenerationBySession.set(sessionId, runGeneration)
    return runGeneration
  }

  /** 检查指定会话是否正在处理中 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /** 返回主进程当前仍在执行的 Agent，会话重载时供 renderer 恢复运行指示。 */
  listActiveSessionSnapshots(): AgentActiveSessionSnapshot[] {
    return [...this.activeSessions.keys()].map((sessionId) => ({
      sessionId,
      startedAt: this.activeSessionStartedAt.get(sessionId) ?? Date.now(),
      runGeneration: this.activeSessions.get(sessionId),
    }))
  }

  /** 是否存在任意运行中 Agent（含后台运行与外部触发的会话）。 */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0
  }

  /**
   * 切换会话权限模式（保留方法签名）
   *
   * 权限模式已下线：不再影响运行期判定，也不再广播 plan_mode_changed。
   * 保留空实现以便 IPC / 自动化 / 未来恢复确认入口时可以直接接回。
   */
  async updateSessionPermissionMode(_sessionId: string, _mode: PromaPermissionMode): Promise<void> {
    // 无操作：当前产品决策为工具调用直接执行，见 canUseTool。
  }

  // ===== 快照回退 =====

  /**
   * 回退 Pi 会话到指定消息点。
   *
   * Pi 可安全回退其对话树；文件快照不属于 Pi runtime，当前不会修改工作区文件。
   * 未提供文件回退能力是正常状态，不作为回退错误返回。
   * 退役 Claude 会话仅可查看，不允许回退或继续。
   */
  async rewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionResult> {
    if (this.activeSessions.has(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = getAgentSessionMeta(sessionId)
    if (sessionMeta?.legacyTranscript?.continuationRequired) {
      throw new Error('这是已退役 Claude runtime 的只读历史会话，不能回退；请以 Pi 新会话继续。')
    }
    if (!sessionMeta?.sdkSessionId) {
      throw new Error('会话没有 Pi session ID，无法回退')
    }

    // rewindPiAgentSession 以单一一致性流程处理 Pi branch、JSONL 截断和 metadata 提交。
    const remainingMessages = await rewindPiAgentSession(sessionId, assistantMessageUuid)
    return {
      remainingMessages,
      fileRewind: {
        canRewind: false,
      },
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    if (this.activeSessions.size > 0) {
      console.log(`[Agent 编排] 正在中止所有活跃会话 (${this.activeSessions.size} 个)...`)
    }
    // 即便 activeSessions 为空，也要调 dispose 清理可能残留的 pidMap / 子进程
    this.adapter.dispose()
    this.activeSessions.clear()
    this.activeSessionStartedAt.clear()
    this.stoppedBeforeRunSessions.clear()
    this.queuedMessageUuids.clear()
    this.pendingUserSkillActivations.clear()
  }

  // ===== 队列消息管理 =====

  /**
   * 流式追加消息
   *
   * 在 Agent 运行中注入用户消息到 SDK，使用 'now' 优先级立即处理。
   * 消息立即持久化到 JSONL。
   *
   * @returns 消息 UUID
   */
  async queueMessage(
    sessionId: string,
    text: string,
    rawText?: string,
    _priority?: string,
    presetUuid?: string,
    opts?: { interrupt?: boolean },
    mentionedSkills?: string[],
    mentionedMcpServers?: string[],
    mentionedSessionIds?: string[],
    mentionedTodoIds?: string[],
    mentionedCalendarEventIds?: string[],
  ): Promise<string> {
    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`)
    }

    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    // 注入 mention 引用指令（Skill/MCP/会话）— 与 sendMessage 路径保持一致的 prompt 加工
    const meta = getAgentSessionMeta(sessionId)
    const workspaceSlug = meta?.workspaceId
      ? getAgentWorkspace(meta.workspaceId)?.slug
      : undefined

    const userBrowserContext = browserController.getUserContext(sessionId)
    const userVaultContext = getVaultUserContext(sessionId)
    const narrationMode = migrateNarrationMode(meta?.narrationMode)
    // 运行中的 Agent 收到队列消息时也必须看到用户刚刚主动打开的页面，
    // 以及当前会话的过程表述模式（explain 需要每轮重申阶段说明）。
    const needsDynamicContext = Boolean(userBrowserContext || userVaultContext) || narrationMode === 'explain'
    let enrichedText = needsDynamicContext
      ? `${buildDynamicContext({ narrationMode, userBrowserContext, userVaultContext })}\n\n${text}`
      : text
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
    if (referencedSessionsBlock) {
      enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    }
    if (mentionedSkills?.length || mentionedMcpServers?.length) {
      const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
      for (const slug of mentionedSkills ?? []) {
        const qualifiedName = workspaceSlug
          ? `proma-workspace-${workspaceSlug}:${slug}`
          : slug
        toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
      }
      for (const name of mentionedMcpServers ?? []) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      enrichedText = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedText}`
    }
    // Planning read tools are Pi-native. Do not direct Claude sessions to unavailable tools.
    const referencedPlanningBlock = buildReferencedPlanningPrompt(
      mentionedTodoIds,
      mentionedCalendarEventIds,
      { requireToolRead: true },
    )
    if (referencedPlanningBlock) {
      enrichedText = `${referencedPlanningBlock}\n\n${enrichedText}`
    }

    const uuid = presetUuid || randomUUID()

    // 防重记录
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    uuids.add(uuid)
    this.queuedMessageUuids.set(sessionId, uuids)

    // 构造 SDKUserMessage 并注入（强制 'now' 优先级）
    const sdkMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: enrichedText },
      parent_tool_use_id: null,
      priority: 'now' as const,
      uuid,
      session_id: sessionId,
    }

    try {
      await this.adapter.sendQueuedMessage(sessionId, sdkMessage, {
        ...(opts?.interrupt ? { interrupt: true } : {}),
        ...(mentionedSkills?.length ? { skillMentions: mentionedSkills } : {}),
      })
      console.log(`[Agent 编排] 追加消息已注入: sessionId=${sessionId}, uuid=${uuid}, interrupt=${!!opts?.interrupt}`)

      // 立即持久化到 JSONL — 仅存原始文本，不含 prompt 工程块（与 sendMessage 路径一致）
      const persistMsg: SDKMessage = {
        type: 'user',
        uuid,
        message: {
          content: [{ type: 'text', text: rawText ?? text }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
        // 插队打断：渲染层据此把紧挨在本消息前面的助手轮次视为「已停止」
        ...(opts?.interrupt ? { _promaInterruptedPrevious: true } : {}),
        ...(userVaultContext ? {
          _vaultFocus: {
            displayName: userVaultContext.displayName,
            rootPath: userVaultContext.rootPath,
            focus: userVaultContext.focus,
          },
        } : {}),
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [persistMsg])
      this.flushPendingUserSkillActivations(sessionId, uuid)
    } catch (error) {
      uuids.delete(uuid)
      this.clearPendingUserSkillActivations(sessionId, uuid)
      if (isMissingActiveQueueChannelError(error)) {
        console.warn(`[Agent 编排] 队列注入失败且消息通道已失效，释放陈旧运行状态: sessionId=${sessionId}`)
        this.activeSessions.delete(sessionId)
        this.activeSessionStartedAt.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
      }
      throw error
    }

    return uuid
  }
}
