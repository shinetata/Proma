/**
 * SDKMessageRenderer — 渲染 SDKMessage 对象
 *
 * 支持两种渲染模式：
 * 1. 单条消息：SDKMessageRenderer（用于实时流式消息）
 * 2. Turn 分组：AssistantTurnRenderer（用于持久化消息，一个 turn 一个 header）
 *
 * Turn 分组规则：
 * - 用户消息后到下一条用户消息之间的所有 assistant 消息组成一个 turn
 * - user(tool_result) 消息属于当前 turn（不中断分组）
 * - system 消息独立渲染
 */

import * as React from 'react'
import { Bot, Loader2, AlertTriangle, FileText, FileImage, Download, Split, Undo2, RotateCw, Plus, Minimize2, Wrench, Settings, Cpu, ExternalLink, Clock, FolderInput, FolderPlus, ListTodo } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox'
import { ContentBlock } from './ContentBlock'
import { AskUserAnswerCard } from './AskUserAnswerCard'
import { collectAnsweredQuestionToolIds } from './ask-user-answers'
import { TurnFileChangesSummary, buildTurnFileNameMap } from './TurnFileChangesSummary'
import { TurnSkillUsageSummary } from './TurnSkillUsageSummary'
import { buildAssistantTurnSections, findTrailingResult, formatTurnDuration, getTurnInterruptedDurationMs, getTurnLiveStartedAt, groupConsecutiveQuestions, needsTrailingRunningPlaceholder, splitTurnBodyAndProcess, type AssistantTurnListEntry, type AssistantTurnSection, type AssistantTurnSectionItem } from './assistant-turn-sections'
import { ProcessMotion, ProcessStepGroup, TurnLayoutTransition, TurnProcessSummary, type TurnOutcome } from './ProcessTimeline'
import { extractToolResultText, TASK_TOOL_NAMES } from './task-progress'
import { normalizeThinkTagsInContentBlocks } from './thinking-tag-parser'
import { getTurnForkTargetUuid } from '@/lib/turn-fork-target'
// 会话转录的纯逻辑(Turn 分组 / 快照去重 / 预览)已下沉到 @proma/session-core 作为唯一真源。
// 这里 import 供本文件内部使用，并 re-export 以保持既有 `from './SDKMessageRenderer'` 导入方零改动。
import {
  groupIntoTurns,
  getGroupPreview,
  extractUserText,
  extractMeta,
  isUserInputMessage,
  stripScheduledRunMarker,
  type MessageGroup,
  type AssistantTurn,
} from '@proma/session-core'
export { groupIntoTurns, getGroupPreview, extractUserText } from '@proma/session-core'
export type { MessageGroup, AssistantTurn } from '@proma/session-core'
import { buildUsageTooltip } from './AgentMessages'
import {
  Message,
  MessageHeader,
  MessageContent,
  MessageActions,
  MessageAction,
  MessageResponse,
  UserMessageContent,
  TurnFileMapProvider,
} from '@/components/ai-elements/message'
import { UserAvatar } from '@/components/common/UserAvatar'
import { CopyButton } from '@/components/common/CopyButton'
import { Button } from '@/components/ui/button'
import { formatMessageTime } from '@/lib/message-time'
import { getModelLogo, resolveModelDisplayName, resolveModelProvider } from '@/lib/model-logo'
import { userProfileAtom } from '@/atoms/user-profile'
import { channelsAtom } from '@/atoms/channel-atoms'
import { modelSelectorOpenAtom } from '@/atoms/model-selector-atoms'
import { agentSessionPendingFilesAtom, agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { activeSessionIdAtom } from '@/atoms/tab-atoms'
import { automationsAtom, automationFormAtom, automationToDraft } from '@/atoms/automation-atoms'
import { openWorkspaceComponentAtom } from '@/atoms/agent-atoms'
import { environmentCheckDialogOpenAtom } from '@/atoms/environment'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { getFileParentPath } from '@/lib/file-utils'
import { parseQuotedSelectionRefs, replaceAgentHistoryQuoteMentionsWithLabels } from '@/lib/quoted-selection'
import type { QuotedSelection } from '@/atoms/preview-atoms'
import type { ParsedQuotedSelectionRef, ParseQuotedSelectionRefsOptions } from '@/lib/quoted-selection'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKContentBlock,
  SDKResultMessage,
  AgentEventUsage,
  SDKToolUseBlock,
  SDKToolResultBlock,
  RecoveryAction,
} from '@proma/shared'
import type { AgentPendingFile } from '@proma/shared'
import {
  getSDKCompactStatus,
  inferContextWindow,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
} from '@proma/shared'
import type { ToolActivity } from '@/atoms/agent-atoms'

// ===== SDKMessageRenderer Props =====

export interface SDKMessageRendererProps {
  /** 要渲染的消息 */
  message: SDKMessage
  /** 所有消息（用于 ContentBlock 内查找工具结果） */
  allMessages: SDKMessage[]
  /** 相对路径解析基准 */
  basePath?: string
  /** 是否显示消息头部（模型 icon + 名称），默认 true */
  showHeader?: boolean
  /** 用户在前端选择的模型 ID（优先用于显示名称） */
  sessionModelId?: string
}

// ===== system 消息：上下文压缩分割线 =====

function CompactBoundaryDivider(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 my-4 px-1">
      <div className="flex-1 h-px bg-border/40" />
      <span className="shrink-0 text-[11px] text-muted-foreground/60 px-2 py-0.5 rounded-full border border-border/30 bg-muted/20">
        上下文已压缩
      </span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  )
}

function formatSystemToolName(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1]} / ${parts.slice(2).join('__')}`
  }
  return toolName
}

function PermissionDeniedNotice({ message }: { message: SDKSystemMessage }): React.ReactElement {
  const toolName = typeof message.tool_name === 'string' ? formatSystemToolName(message.tool_name) : undefined
  const denialMessage = typeof message.message === 'string' ? message.message : undefined
  const reason = typeof message.decision_reason === 'string' ? message.decision_reason : undefined

  return (
    <div className="my-3 pr-1">
      <div className="flex items-start gap-2.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-foreground/80">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">权限检查已拒绝操作</span>
            {toolName && (
              <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {toolName}
              </span>
            )}
          </div>
          {denialMessage && (
            <p className="break-words text-muted-foreground">{denialMessage}</p>
          )}
          {reason && reason !== denialMessage && (
            <p className="break-words text-muted-foreground/70">{reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ===== system 消息：压缩历史状态 =====

function CompactStatusNotice({ message }: { message: SDKSystemMessage }): React.ReactElement | null {
  const compactStatus = getSDKCompactStatus(message)
  if (compactStatus === 'success') return <CompactBoundaryDivider />
  if (compactStatus === 'compacting') {
    return (
      <div className="flex items-center gap-3 my-4 px-1">
        <div className="flex-1 h-px bg-border/40" />
        <span className="shrink-0 text-[11px] text-muted-foreground/60 px-2 py-0.5 rounded-full border border-border/30 bg-muted/20">
          开始压缩上下文
        </span>
        <div className="flex-1 h-px bg-border/40" />
      </div>
    )
  }
  if (compactStatus === 'noop') {
    return (
      <div className="flex items-center gap-3 my-4 px-1">
        <div className="flex-1 h-px bg-border/40" />
        <span className="shrink-0 text-[11px] text-muted-foreground/60 px-2 py-0.5 rounded-full border border-border/30 bg-muted/20">
          {message.message ?? '当前上下文无需压缩'}
        </span>
        <div className="flex-1 h-px bg-border/40" />
      </div>
    )
  }
  if (compactStatus === 'failed') {
    const error = typeof message.compact_error === 'string' ? message.compact_error : undefined
    return (
      <div className="my-3 pr-1">
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-foreground/80">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1">
            <div className="font-medium text-foreground">上下文压缩失败</div>
            {error && <p className="break-words text-muted-foreground">{error}</p>}
          </div>
        </div>
      </div>
    )
  }
  return null
}

// extractMeta / MessageMeta 已迁移至 @proma/session-core

/** 从 question 分区中提取 AskUserAnswerCard 需要的 tool_use 块 */
function extractQuestionBlocks(sections: readonly AssistantTurnSection[]): Array<{ toolUseId: string; input: Record<string, unknown> }> {
  return sections.flatMap((section) => {
    if (section.type !== 'question') return []
    const { block } = section.item
    return block.type === 'tool_use'
      ? [{ toolUseId: (block as SDKToolUseBlock).id, input: (block as SDKToolUseBlock).input }]
      : []
  })
}

/** 从 turn 消息列表中提取 result 消息的耗时和用量数据 */
function extractTurnUsage(turnMessages: SDKMessage[]): { durationMs?: number; usage?: AgentEventUsage } {
  for (const msg of turnMessages) {
    if (msg.type !== 'result') continue
    const resultMsg = msg as SDKResultMessage
    const raw = msg as Record<string, unknown>
    const durationMs = typeof raw._durationMs === 'number' ? raw._durationMs : undefined
    const u = resultMsg.usage
    if (!u) return { durationMs }
    // 多 entry 场景（Task 子 Agent 等）：取最大 contextWindow
    let contextWindow: number | undefined
    if (resultMsg.modelUsage) {
      for (const [modelId, info] of Object.entries(resultMsg.modelUsage)) {
        const fallbackModelId = resultMsg._channelModelId ?? modelId
        const fallbackWindow = inferContextWindow(fallbackModelId)
        const candidate = Math.max(info?.contextWindow ?? 0, fallbackWindow ?? 0) || undefined
        if (candidate && (contextWindow === undefined || candidate > contextWindow)) {
          contextWindow = candidate
        }
      }
    } else {
      contextWindow = inferContextWindow(resultMsg._channelModelId)
    }
    return {
      durationMs,
      usage: {
        inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        costUsd: resultMsg.total_cost_usd,
        contextWindow,
      },
    }
  }
  return {}
}

// extractUserText 已迁移至 @proma/session-core

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractStructuredToolResultText(message: SDKUserMessage): string | undefined {
  const raw = message as unknown as Record<string, unknown>
  const result = raw.toolUseResult ?? raw.tool_use_result
  if (!isRecord(result)) return undefined
  try {
    return JSON.stringify(result)
  } catch {
    return undefined
  }
}

function extractToolResultForTask(message: SDKUserMessage, resultBlock: SDKToolResultBlock): string | undefined {
  return extractStructuredToolResultText(message) ?? extractToolResultText(resultBlock.content)
}

// isUserInputMessage 已迁移至 @proma/session-core

// ===== 助手头像 =====

export function AssistantLogo({ model }: { model?: string }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (model) {
    return (
      <img
        src={getModelLogo(model, resolveModelProvider(model, channels))}
        alt={model}
        className="size-[35px] rounded-[25%] object-cover"
      />
    )
  }
  return (
    <div className="size-[35px] rounded-[25%] bg-primary/10 flex items-center justify-center">
      <Bot size={18} className="text-primary" />
    </div>
  )
}

// AssistantTurn / MessageGroup 类型已迁移至 @proma/session-core

// groupIntoTurns / mergeAdjacentSameModelTurns 已迁移至 @proma/session-core

export function buildTaskProgressData(
  topLevelBlocks: SDKContentBlock[],
  turnMessages: SDKMessage[],
): {
  taskActivities: ToolActivity[]
  firstTaskIndex: number
} {
  const taskBlocks: SDKToolUseBlock[] = []
  let firstTaskIndex = -1

  for (let i = 0; i < topLevelBlocks.length; i++) {
    const block = topLevelBlocks[i]!
    if (block.type === 'tool_use' && TASK_TOOL_NAMES.has((block as SDKToolUseBlock).name)) {
      if (firstTaskIndex === -1) firstTaskIndex = i
      taskBlocks.push(block as SDKToolUseBlock)
    }
  }

  const toolResultMap = new Map<string, string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const userMsg = msg as SDKUserMessage
    const blocks = userMsg.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const rb = b as SDKToolResultBlock
        const text = extractToolResultForTask(userMsg, rb)
        if (text) toolResultMap.set(rb.tool_use_id, text)
      }
    }
  }

  const taskActivities: ToolActivity[] = taskBlocks.map((tb) => ({
    toolUseId: tb.id,
    toolName: tb.name,
    input: tb.input as Record<string, unknown>,
    result: toolResultMap.get(tb.id),
    done: true,
  }))

  return { taskActivities, firstTaskIndex }
}

/**
 * 提取一个 turn 中直接属于当前 Agent 的任务工具活动。
 *
 * Task/Agent 容器内的子 Agent 工具不会进入父会话的浮动进度，避免跨执行单元串扰。
 */
export function buildTaskProgressDataForTurn(turn: AssistantTurn): { taskActivities: ToolActivity[] } {
  const enrichedBlocks: Array<{ block: SDKContentBlock; parentToolUseId?: string | null }> = []

  for (const message of turn.assistantMessages) {
    const blocks = message.message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      for (const normalizedBlock of normalizeThinkTagsInContentBlocks([block])) {
        enrichedBlocks.push({ block: normalizedBlock, parentToolUseId: message.parent_tool_use_id })
      }
    }
  }

  const agentToolIds = new Set<string>()
  for (const { block } of enrichedBlocks) {
    if (block.type !== 'tool_use') continue
    const tool = block as { name: string; id: string }
    if (tool.name === 'Agent' || tool.name === 'Task') agentToolIds.add(tool.id)
  }

  const topLevelBlocks = enrichedBlocks
    .filter(({ parentToolUseId }) => !parentToolUseId || !agentToolIds.has(parentToolUseId))
    .map(({ block }) => block)

  const { taskActivities } = buildTaskProgressData(topLevelBlocks, turn.turnMessages)
  return { taskActivities }
}


export interface AssistantTurnRendererProps {
  turn: AssistantTurn
  /** 所有消息（全局，供工具结果查找跨 turn 的结果） */
  allMessages: SDKMessage[]
  basePath?: string
  /** 分叉回调（传入最后一条 assistant 消息的 uuid） */
  onFork?: (upToMessageUuid: string) => void
  /** 回退回调（传入 assistant message uuid） */
  onRewind?: (assistantMessageUuid: string) => void
  /** 将本轮回复标记为 Todo */
  onCreateTodo?: (text: string) => void
  /** 错误重试回调（传入本轮开始前应删除的错误 UUID） */
  onRetry?: (errorUuid?: string) => void
  /** 在新会话中重试回调（仅当 turn 含错误消息时使用） */
  onRetryInNewSession?: () => void
  /** 压缩上下文回调（仅 prompt_too_long 错误使用） */
  onCompact?: () => void
  onRelinkProjectRoot?: () => void
  onRestoreProjectRoot?: () => void
  /** 是否正在流式输出中（隐藏操作栏） */
  isStreaming?: boolean
  /** 是否被用户中断 */
  stoppedByUser?: boolean
  /**
   * 被新消息打断的时间戳（插队用户消息的 _createdAt）。
   * undefined = 未被打断；null = 被打断但时间未知。
   */
  interruptedAt?: number | null
  /** 用户在前端选择的模型 ID（优先用于显示名称） */
  sessionModelId?: string
}

export function AssistantTurnRenderer({ turn, allMessages, basePath, onFork, onRewind, onCreateTodo, onRetry, onRetryInNewSession, onCompact, onRelinkProjectRoot, onRestoreProjectRoot, isStreaming, stoppedByUser, interruptedAt }: AssistantTurnRendererProps): React.ReactElement | null {
  // 收集所有 assistant 消息的内容块，保留 parent_tool_use_id 关联
  interface EnrichedBlock {
    block: SDKContentBlock
    sourceMessage: SDKAssistantMessage
    parentToolUseId?: string | null
  }

  const enrichedBlocks: EnrichedBlock[] = []
  let hasError = false
  let errorContent: SDKAssistantMessage | null = null

  for (const aMsg of turn.assistantMessages) {
    const msgAny = aMsg as unknown as Record<string, unknown>
    // 区分两种错误消息：
    // 1. Orchestrator 造的纯错误消息（带 _errorCode）：content 里的 text 就是错误摘要，不当正文渲染
    // 2. Pi 混合消息（只带 error、无 _errorCode）：provider 已吐完正文后收尾报错，content 是真正的 assistant 正文
    const isPureErrorSummary = typeof msgAny._errorCode === 'string'
    if (aMsg.error) {
      hasError = true
      errorContent = aMsg
      // 纯错误消息的 content 不当正文渲染（避免错误摘要重复出现两次）
      if (isPureErrorSummary) continue
      // Pi 混合消息：继续向下把 content 收集进 enrichedBlocks，保留真正的助手正文
    }
    const blocks = aMsg.message?.content
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        for (const normalizedBlock of normalizeThinkTagsInContentBlocks([block])) {
          enrichedBlocks.push({ block: normalizedBlock, sourceMessage: aMsg, parentToolUseId: aMsg.parent_tool_use_id })
        }
      }
    }
  }

  // 从 turnMessages 中提取 result 消息的耗时和用量
  const { durationMs, usage } = extractTurnUsage(turn.turnMessages)

  // 被新消息打断的轮次：用户消息带 _promaInterruptedPrevious 标记时，渲染层视为「已停止」
  const isInterrupted = interruptedAt !== undefined

  // 构建 Agent/Task tool_use → 子代理内容块映射
  const agentToolIds = new Set<string>()
  for (const eb of enrichedBlocks) {
    if (eb.block.type === 'tool_use') {
      const tu = eb.block as { name: string; id: string }
      if (tu.name === 'Agent' || tu.name === 'Task') {
        agentToolIds.add(tu.id)
      }
    }
  }

  const childBlocksMap = new Map<string, SDKContentBlock[]>()
  const topLevelEntries: EnrichedBlock[] = []

  for (const eb of enrichedBlocks) {
    if (eb.parentToolUseId && agentToolIds.has(eb.parentToolUseId)) {
      const children = childBlocksMap.get(eb.parentToolUseId) ?? []
      children.push(eb.block)
      childBlocksMap.set(eb.parentToolUseId, children)
    } else {
      topLevelEntries.push(eb)
    }
  }
  const topLevelBlocks = topLevelEntries.map((entry) => entry.block)

  // 检测是否有主要内容（text 块），用于决定 tool/thinking 是否 dimmed
  const hasTextContent = topLevelBlocks.some(
    (b) => b.type === 'text' && 'text' in b && !!(b as { text: string }).text
  )

  // 已答 AskUserQuestion 的 tool_use id：这些问答不再当作工具行，改由「你的回答」卡片回显
  const answeredQuestionToolIds = React.useMemo(
    () => collectAnsweredQuestionToolIds(allMessages),
    [allMessages]
  )

  // 将内容块拆分为「执行过程」与「最终输出」（与商业版轮次结构一致）。
  // 被新消息打断的轮次同样按「已停止」处理（影响 outputState 的 incomplete 判定）。
  const topLevelMessages = turn.assistantMessages.filter((m) => !m.parent_tool_use_id || !agentToolIds.has(m.parent_tool_use_id))
  const sections = buildAssistantTurnSections(topLevelEntries, {
    messages: topLevelMessages,
    isStreaming,
    stoppedByUser: stoppedByUser || isInterrupted,
    result: findTrailingResult(turn.turnMessages),
    answeredQuestionToolIds,
  })
  const sectionItems = sections.items
  const lastSectionIndex = sectionItems.length - 1
  const promotedThinkingText = sectionItems
    .filter((item) => item.type === 'block' && item.promotedFromThinking)
    .map((item) => {
      const block = item.type === 'block' ? topLevelBlocks[item.item.index] : undefined
      return block?.type === 'thinking' ? block.thinking : ''
    })
    .join('\n\n')
  const sectionKeys: string[] = []
  {
    let runIndex = 0
    let textIndex = 0
    let questionIndex = 0
    for (const item of sectionItems) {
      sectionKeys.push(item.type === 'activity'
        ? `run-${runIndex++}`
        : item.type === 'question'
          ? `question-${questionIndex++}`
          : `text-${textIndex++}`)
    }
  }
  const listEntries: AssistantTurnListEntry[] = sectionItems.map((item, itemIndex) => ({ item, itemIndex }))
  const firstOutputSectionIndex = sectionItems.findIndex((section) => section.type === 'block' && section.output)
  const showRunningTail = needsTrailingRunningPlaceholder(sectionItems, topLevelEntries, topLevelMessages, !!isStreaming)
  // 占位沿用「下一个执行过程分区」的 key：首个思考块到达后，同一节点直接变成真实步骤，
  // 不会先卸载占位再从 0 高展开新行。
  const runningTailKey = `run-${sectionItems.filter((section) => section.type === 'activity').length}`

  // 一旦经历过流式输出，后续的过程/正文切换使用动画；历史消息直接静态渲染
  const hasStreamedRef = React.useRef(false)
  if (isStreaming) hasStreamedRef.current = true
  const hasStreamed = hasStreamedRef.current

  // 轮次耗时：优先取 result 耗时；被新消息打断的轮次用「打断时间 − 起算时间」
  const turnDurationMs = durationMs ?? getTurnInterruptedDurationMs(turn, interruptedAt)
  const usageTooltip = !isStreaming && durationMs != null ? buildUsageTooltip(durationMs, usage) : undefined
  const { completedToolIds, failedToolIds } = React.useMemo(() => {
    const completed = new Set<string>()
    const failed = new Set<string>()
    for (const message of allMessages) {
      if (message.type !== 'user') continue
      for (const block of (message as SDKUserMessage).message?.content ?? []) {
        if (block.type !== 'tool_result') continue
        const resultBlock = block as SDKToolResultBlock
        completed.add(resultBlock.tool_use_id)
        if (resultBlock.is_error) failed.add(resultBlock.tool_use_id)
      }
    }
    return { completedToolIds: completed, failedToolIds: failed }
  }, [allMessages])
  const turnKey = getGroupId(turn)

  // 本轮「文件名 → 绝对路径」映射：与 footer chips 同源，供正文内联文件引用补全裸文件名
  const turnFileMap = React.useMemo(
    () => buildTurnFileNameMap(turn.turnMessages),
    [turn.turnMessages]
  )

  // 如果只有错误消息
  if (enrichedBlocks.length === 0 && hasError && errorContent) {
    return (
      <ErrorMessage
        message={errorContent}
        onRetry={onRetry}
        onRetryInNewSession={onRetryInNewSession}
        onCompact={onCompact}
        onRelinkProjectRoot={onRelinkProjectRoot}
        onRestoreProjectRoot={onRestoreProjectRoot}
      />
    )
  }

  // 如果没有任何内容
  if (enrichedBlocks.length === 0 && !hasError && !sections.completedWithoutAnswer && !isInterrupted) return null

  const renderTopLevelBlock = (block: SDKContentBlock, i: number, showFullThinking = false): React.ReactNode => {
    // 任务进度由底部浮层统一呈现，输出记录不再重复显示任务卡。
    if (block.type === 'tool_use' && TASK_TOOL_NAMES.has((block as SDKToolUseBlock).name)) {
      return null
    }

    const isAgentTool = block.type === 'tool_use'
      && ((block as { name: string }).name === 'Agent' || (block as { name: string }).name === 'Task')
    const childBlocks = isAgentTool
      ? childBlocksMap.get((block as { id: string }).id)
      : undefined

    return (
      <ContentBlock
        key={i}
        block={block}
        allMessages={allMessages}
        basePath={basePath}
        animate={!!isStreaming}
        index={i}
        dimmed={!showFullThinking && hasTextContent && block.type !== 'text'}
        childBlocks={childBlocks}
        isStreaming={isStreaming}
        showFullThinking={showFullThinking}
      />
    )
  }

  const renderBlockItem = (item: AssistantTurnSectionItem, promotedFromThinking?: boolean): React.ReactNode => {
    const block = topLevelBlocks[item.index]
    if (!block) return null
    if (promotedFromThinking && block.type === 'thinking') {
      return (
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground" role="note">模型将本轮结果写在了思考中，已作为正文展示</div>
          {renderTopLevelBlock({ type: 'text', text: block.thinking }, item.index)}
        </div>
      )
    }
    return renderTopLevelBlock(block, item.index)
  }

  const renderSection = (section: AssistantTurnSection, sectionIndex: number): React.ReactNode => {
    if (section.type === 'question') {
      const questionBlocks = extractQuestionBlocks([section])
      return questionBlocks.length === 0 ? null : <AskUserAnswerCard blocks={questionBlocks} allMessages={allMessages} />
    }
    if (section.type === 'block') return renderBlockItem(section.item, section.promotedFromThinking)
    return (
      <ProcessStepGroup
        key={sectionKeys[sectionIndex]}
        expandKey={`${turnKey}:${sectionKeys[sectionIndex]}`}
        blocks={section.items.map((entry) => entry.block)}
        isActive={!!isStreaming && sectionIndex === lastSectionIndex}
        startFromThinking={!!isStreaming && sectionIndex === 0}
        completedToolIds={completedToolIds}
        failedToolIds={failedToolIds}
        renderChildren={(showFullThinking) => section.items.map((entry, stepIndex) => (
          <ProcessMotion key={`step-${stepIndex}`} animate={!!isStreaming}>
            {renderTopLevelBlock(entry.block, entry.index, showFullThinking)}
          </ProcessMotion>
        ))}
      />
    )
  }
  const shouldAnimateSection = (section: AssistantTurnSection, sectionIndex: number): boolean => (
    hasStreamed && !(sectionIndex === 0 && section.type === 'activity')
  )
  const incompleteOutputNotice = sections.outputState === 'incomplete' ? (
    <div className="mb-1 text-xs text-muted-foreground" role="status">未完成输出</div>
  ) : null

  /** 单条分区渲染：output 用 reveal 动画，其余用 expand；首个 output 前挂「未完成输出」提示 */
  const renderEntry = (entry: AssistantTurnListEntry): React.ReactNode => {
    const { item, itemIndex } = entry
    const isOutput = item.type === 'block' && !!item.output
    return (
      <ProcessMotion
        key={sectionKeys[itemIndex]}
        mode={isOutput ? 'reveal' : 'expand'}
        animate={shouldAnimateSection(item, itemIndex)}
      >
        {itemIndex === firstOutputSectionIndex && incompleteOutputNotice}
        {renderSection(item, itemIndex)}
      </ProcessMotion>
    )
  }

  /** 相邻的已答问答合并成一张「你的回答」卡片，其余条目逐条渲染 */
  const renderMergedEntries = (entries: readonly AssistantTurnListEntry[]): React.ReactNode =>
    groupConsecutiveQuestions(entries).map((group) => {
      if (group.kind === 'entry') return renderEntry(group.entry)
      const first = group.entries[0]
      if (!first) return null
      const questionBlocks = extractQuestionBlocks(group.entries.map(({ item }) => item))
      if (questionBlocks.length === 0) return null
      return (
        <ProcessMotion
          key={`questions-${sectionKeys[first.itemIndex]}`}
          mode="reveal"
          animate={shouldAnimateSection(first.item, first.itemIndex)}
        >
          {first.itemIndex === firstOutputSectionIndex && incompleteOutputNotice}
          <AskUserAnswerCard blocks={questionBlocks} allMessages={allMessages} />
        </ProcessMotion>
      )
    })

  // 轮次结果状态与耗时文案
  const outcome: TurnOutcome = stoppedByUser || isInterrupted ? 'stopped' : sections.failed ? 'failed' : 'completed'
  const { body: bodyEntries, process: processEntries } = splitTurnBodyAndProcess(sectionItems, answeredQuestionToolIds.size > 0)
  const stepsTotal = sectionItems.reduce((count, section) => count + (section.type === 'activity' ? section.items.length : 0), 0)
  const hasOutputSections = firstOutputSectionIndex >= 0
  const summaryExpandKey = `${turnKey}:process`

  const layoutContent = (() => {
    // 运行中：顶部摘要 + 按原始顺序平铺所有分区（不合并问答）
    if (isStreaming) {
      // 末尾占位与 renderEntry 保持同一数组、同一 key 与同样的子节点位置（提示位 + 步骤组），
      // 真实步骤到达时 React 复用 ProcessMotion 与 ProcessStepGroup，文案停留状态也得以延续。
      const runningTail = showRunningTail ? (
        <ProcessMotion key={runningTailKey} mode="expand" animate={hasStreamed}>
          {null}
          <ProcessStepGroup
            key={runningTailKey}
            expandKey={`${turnKey}:${runningTailKey}`}
            blocks={[]}
            isActive
            completedToolIds={completedToolIds}
            failedToolIds={failedToolIds}
          />
        </ProcessMotion>
      ) : null
      return (
        <>
          <TurnProcessSummary
            streaming
            expandKey={summaryExpandKey}
            startedAt={getTurnLiveStartedAt(turn)}
            steps={stepsTotal}
          />
          {[...listEntries.map(renderEntry), runningTail]}
        </>
      )
    }
    // 已停止 / 运行失败：分区非空时渲染摘要（不可展开），下方平铺所有分区（合并问答）
    if (outcome !== 'completed') {
      return (
        <>
          {sectionItems.length > 0 && (
            <TurnProcessSummary
              expandKey={summaryExpandKey}
              outcome={outcome}
              steps={stepsTotal}
              tooltip={usageTooltip}
            />
          )}
          {renderMergedEntries(listEntries)}
        </>
      )
    }
    // 已完成：摘要行（可展开过程分区）+ 正文区（最终回复与你的回答卡片，始终可见）
    return (
      <>
        {processEntries.length > 0 && (
          <TurnProcessSummary
            expandKey={summaryExpandKey}
            outcome={outcome}
            durationText={formatTurnDuration(turnDurationMs)}
            steps={stepsTotal}
            tooltip={usageTooltip}
          >
            {processEntries.map(({ item, itemIndex }) => (
              <div key={`process-${sectionKeys[itemIndex]}`}>{renderSection(item, itemIndex)}</div>
            ))}
          </TurnProcessSummary>
        )}
        {renderMergedEntries(bodyEntries)}
      </>
    )
  })()

  return (
    <Message from="assistant">
      <MessageContent>
        <TurnFileMapProvider map={turnFileMap}>
          <TurnLayoutTransition
            animate={hasStreamed && (!isStreaming || hasOutputSections)}
            layoutKey={`${isStreaming ? 'running' : 'complete'}:${sectionKeys.join(',')}`}
            className="space-y-3"
          >
            {layoutContent}
          </TurnLayoutTransition>
          {sections.completedWithoutAnswer && (
            <div className="text-sm text-muted-foreground">本轮已结束，未提供文字总结。</div>
          )}
          {/* 如果有错误但也有内容块，在末尾以 tail 形式挂错误横幅附错误提示 + 重试按钮，保留正文本身的 markdown 排版 */}
          {hasError && errorContent && topLevelBlocks.length > 0 && (
            <AssistantErrorTail
              message={errorContent}
              onRetry={onRetry}
              onRetryInNewSession={onRetryInNewSession}
              onCompact={onCompact}
              onRelinkProjectRoot={onRelinkProjectRoot}
              onRestoreProjectRoot={onRestoreProjectRoot}
            />
          )}
        </TurnFileMapProvider>
      </MessageContent>
      {/* 完成态汇总：Skill 使用记录与文件改动 chip */}
      {!isStreaming && (
        <div className="animate-in fade-in duration-300">
          <TurnSkillUsageSummary
            inputMessage={turn.inputMessage}
            turnMessages={turn.turnMessages}
          />
          <TurnFileChangesSummary turnMessages={turn.turnMessages} basePath={basePath} />
        </div>
      )}
      {/* 操作栏：流式输出完成后显示操作按钮 */}
      {!isStreaming && (() => {
        const answerText = topLevelBlocks
          .filter((b) => b.type === 'text' && 'text' in b)
          .map((b) => (b as { text: string }).text)
          .join('\n\n')
        const textContent = promotedThinkingText
          ? [answerText, promotedThinkingText].filter((part) => part.trim()).join('\n\n')
          : answerText
        // 仅取主线 assistant 消息的 uuid 作为 fork/rewind 截断点。
        // SDK forkSession 内部会过滤掉 sidechain（parent_tool_use_id 非空的子代理消息），
        // 若把子代理 uuid 传过去会触发 "Message <uuid> not found in session" 错误。
        const lastUuid = getTurnForkTargetUuid(turn.assistantMessages)
        const hasActions = !!(textContent || (onFork && lastUuid) || (onRewind && lastUuid))
        if (!hasActions && !stoppedByUser && !isInterrupted) return null
        return (
          <MessageActions className="assistant-message-actions -ml-1.5 mt-4 min-h-[28px] justify-start animate-in fade-in duration-300">
            {textContent && <CopyButton content={textContent} />}
            {onFork && lastUuid && (
              <MessageAction tooltip="从此处探索（保留主线，结论可带回）" onClick={() => onFork(lastUuid)}>
                <Split className="size-3.5" />
              </MessageAction>
            )}
            {onRewind && lastUuid && (
              <MessageAction tooltip="回退到此处" onClick={() => onRewind(lastUuid)}>
                <Undo2 className="size-3.5" />
              </MessageAction>
            )}
            {(stoppedByUser || isInterrupted) && (
              <span className="inline-flex h-7 shrink-0 items-center gap-1.5 pl-1 text-[14px] text-foreground/40">
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                {stoppedByUser ? '已被用户中断' : '已被用户打断'}
              </span>
            )}
            {textContent && onCreateTodo && (
              <MessageAction tooltip="标记为 Todo" onClick={() => onCreateTodo(textContent)}>
                <ListTodo className="size-3.5" />
              </MessageAction>
            )}
          </MessageActions>
        )
      })()}
    </Message>
  )
}

/**
 * 轮次渲染所需的中断标记工具（对应商业版 hLt）。
 *
 * 用户在 Agent 运行中插队打断时，主进程把该用户消息标记为 _promaInterruptedPrevious：
 * 紧挨在它前面的助手轮次视为「已停止」。这里基于完整分组列表建立
 * 「被打断的轮次 → 插队消息时间」映射（消息无 _createdAt 时记为 null）。
 */
export function buildInterruptedTurnMap(groups: readonly MessageGroup[]): Map<MessageGroup, number | null> {
  const map = new Map<MessageGroup, number | null>()
  for (let index = 0; index < groups.length - 1; index++) {
    const current = groups[index]
    const next = groups[index + 1]
    if (!current || current.type !== 'assistant-turn' || !next || next.type !== 'user') continue
    if ((next.message as unknown as Record<string, unknown>)._promaInterruptedPrevious !== true) continue
    const createdAt = (next.message as unknown as Record<string, unknown>)._createdAt
    map.set(current, typeof createdAt === 'number' ? createdAt : null)
  }
  return map
}

// ===== SDKMessageRenderer 主组件（用于实时消息逐条渲染） =====

export function SDKMessageRenderer({
  message,
  allMessages,
  basePath,
  showHeader = true,
  sessionModelId,
}: SDKMessageRendererProps): React.ReactElement | null {
  const channels = useAtomValue(channelsAtom)
  const msgType = message.type

  // assistant 消息：遍历内容块渲染
  if (msgType === 'assistant') {
    const aMsg = message as SDKAssistantMessage

    // 跳过重放消息
    if (aMsg.isReplay) return null

    // 错误消息分发：
    // - Orchestrator 造的纯错误消息（带 _errorCode）：直接走 ErrorMessage 组件
    // - Pi 混合消息（只带 error、无 _errorCode）：走下方正常渲染 + 末尾挂 tail
    //   与 AssistantTurnRenderer 对齐：不检查 hasRenderableContent，有 blocks 就正常渲染正文，
    //   没有 blocks 才回退到 ErrorMessage
    if (aMsg.error) {
      const msgAny = aMsg as unknown as Record<string, unknown>
      const isPureErrorSummary = typeof msgAny._errorCode === 'string'
      if (isPureErrorSummary) {
        return <ErrorMessage message={aMsg} />
      }
      // Pi 混合消息：下面按正常路径收集 content blocks，末尾挂 AssistantErrorTail
    }

    const rawBlocks = aMsg.message?.content
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      if (aMsg.error) return <ErrorMessage message={aMsg} />
      return null
    }
    const blocks = normalizeThinkTagsInContentBlocks(rawBlocks)
    if (blocks.length === 0) {
      if (aMsg.error) return <ErrorMessage message={aMsg} />
      return null
    }

    const model = aMsg._channelModelId || aMsg.message?.model || sessionModelId
    const meta = extractMeta(message)

    // 检测是否有主要内容（text 块）
    const hasTextContent = blocks.some(
      (b) => b.type === 'text' && 'text' in b && !!(b as { text: string }).text
    )

    return (
      <Message from="assistant">
        {showHeader && (
          <MessageHeader
            model={model ? resolveModelDisplayName(model, channels) : undefined}
            time={meta.createdAt ? formatMessageTime(meta.createdAt) : undefined}
            logo={<AssistantLogo model={model} />}
          />
        )}
        <MessageContent>
          <div className={cn('space-y-2')}>
            {blocks.map((block, i) => (
              <ContentBlock
                key={i}
                block={block}
                allMessages={allMessages}
                basePath={basePath}
                index={i}
                dimmed={hasTextContent && block.type !== 'text'}
              />
            ))}
          </div>
          {/* Pi runtime 下「provider 已吐正文 + 收尾报错」的混合消息：末尾挂错误横幅 */}
          {aMsg.error && (
            <AssistantErrorTail message={aMsg} />
          )}
        </MessageContent>
      </Message>
    )
  }

  // user 消息
  if (msgType === 'user') {
    const uMsg = message as SDKUserMessage
    if (isUserInputMessage(uMsg)) {
      return <UserInputMessage message={uMsg} />
    }
    return null
  }

  // system 消息
  if (msgType === 'system') {
    const sysMsg = message as SDKSystemMessage
    const subtype = sysMsg.subtype
    const compactStatus = getSDKCompactStatus(sysMsg)

    if (compactStatus) return <CompactStatusNotice message={sysMsg} />
    if (subtype === 'permission_denied') {
      return <PermissionDeniedNotice message={sysMsg} />
    }

    return null
  }

  return null
}

// ===== 附件解析 =====

/** 解析的附件引用 */
export interface AttachedFileRef {
  filename: string
  path: string
}

/** 解析的引用文件 */
export type QuotedFileRef = ParsedQuotedSelectionRef

/** 解析消息中的 <attached_files>、<quoted_file> 和 <quoted_context> 块，返回文件列表、引用列表和剩余文本 */
export function parseAttachedFiles(
  content: string,
  options: ParseQuotedSelectionRefsOptions = {},
): { files: AttachedFileRef[]; quotes: QuotedFileRef[]; text: string } {
  const parsedQuotes = parseQuotedSelectionRefs(content, options)
  const quotes: QuotedFileRef[] = parsedQuotes.quotes

  const regex = /<attached_files>\n?([\s\S]*?)\n?<\/attached_files>\n*/
  const match = content.match(regex)
  if (!match) {
    return { files: [], quotes, text: parsedQuotes.text }
  }

  const files: AttachedFileRef[] = []
  const lines = match[1]!.split('\n')
  for (const line of lines) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/)
    if (lineMatch) {
      files.push({ filename: lineMatch[1]!.trim(), path: lineMatch[2]!.trim() })
    }
  }

  const text = parsedQuotes.text.replace(regex, '').trim()
  return { files, quotes, text }
}

/** 判断文件是否为图片类型 */
export function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename)
}

/** 图片附件缩略图，点击可预览大图 */
function AttachedImageThumb({ file, index, onOpen, onLoaded }: {
  file: AttachedFileRef
  /** 该图在同批图片中的索引 */
  index: number
  /** 点击缩略图打开大图预览（第 index 张） */
  onOpen: (index: number) => void
  /** 图片 src 加载完成上报父组件（供共享 lightbox 翻页使用） */
  onLoaded: (path: string, src: string) => void
}): React.ReactElement {
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)

  React.useEffect(() => {
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    }
    const mediaType = mimeMap[ext] ?? 'image/png'

    window.electronAPI
      .readAttachment(file.path)
      .then((base64) => {
        const src = `data:${mediaType};base64,${base64}`
        setImageSrc(src)
        onLoaded(file.path, src)
      })
      .catch((err) => console.error('[AttachedImageThumb] 读取附件失败:', err))
  }, [file.path, file.filename, onLoaded])

  const handleSave = React.useCallback((): void => {
    window.electronAPI.saveImageAs(file.path, file.filename)
  }, [file.path, file.filename])

  if (!imageSrc) {
    return <div className="w-[200px] h-[140px] rounded-lg bg-muted/30 animate-pulse shrink-0" />
  }

  return (
    <div className="relative group inline-block">
      <img
        src={imageSrc}
        alt={file.filename}
        className="max-w-[300px] max-h-[200px] rounded-lg object-contain cursor-pointer"
        onClick={() => onOpen(index)}
      />
      <button
        type="button"
        onClick={handleSave}
        className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
        title="保存图片"
      >
        <Download className="size-4" />
      </button>
    </div>
  )
}

/** 文件附件芯片 */
function AttachedFileChip({ file }: { file: AttachedFileRef }): React.ReactElement {
  const isImg = isImageFile(file.filename)
  const Icon = isImg ? FileImage : FileText
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const openPreview = useOpenPreview()

  const handleOpenPreview = React.useCallback((): void => {
    if (!activeSessionId) return
    const parentPath = getFileParentPath(file.path)
    openPreview(activeSessionId, {
      filePath: file.path,
      previewOnly: true,
      readOnly: true,
      basePaths: parentPath ? [parentPath] : undefined,
    })
  }, [activeSessionId, file.path, openPreview])

  return (
    <button
      type="button"
      onClick={handleOpenPreview}
      disabled={!activeSessionId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 text-[12px] text-muted-foreground',
        'transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-muted/60 disabled:hover:text-muted-foreground'
      )}
      title={file.path}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate max-w-[200px]">{file.filename}</span>
    </button>
  )
}

// ===== 用户输入消息渲染 =====

const SCHEDULED_RUN_MARKER = '<!--PROMA_SCHEDULED_RUN-->'

// stripScheduledRunMarker 已迁移至 @proma/session-core（本文件从该包 import 使用）

function ScheduledRunBadge(): React.ReactElement {
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const automations = useAtomValue(automationsAtom)
  const setForm = useSetAtom(automationFormAtom)
  const openWorkspaceComponent = useSetAtom(openWorkspaceComponentAtom)

  const session = sessions.find((s) => s.id === activeSessionId)
  const automation = session?.sourceAutomationId && !session.sourceDelegationId
    ? automations.find((a) => a.id === session.sourceAutomationId)
    : undefined

  const handleClick = (): void => {
    if (!automation) return
    openWorkspaceComponent('automations')
    setForm({
      open: true,
      draft: automationToDraft(automation),
    })
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 text-[10px] text-primary/70 hover:text-primary transition-colors"
      title="来自 Proma 定时任务，点击查看设置"
    >
      <Clock className="size-3" />
      <span>来自 Proma 定时任务</span>
    </button>
  )
}

function UserInputMessage({ message, onAgentHistoryQuoteClick }: {
  message: SDKUserMessage
  onAgentHistoryQuoteClick?: (quote: QuotedSelection) => void
}): React.ReactElement {
  const rawText = extractUserText(message) ?? ''
  const isScheduledRun = rawText.includes(SCHEDULED_RUN_MARKER)
  // 选区引用与 Agent 历史引用都在消息正文里回填为内联 chip，保持发送时的位置。
  const { files: attachedFiles, text } = parseAttachedFiles(
    stripScheduledRunMarker(rawText),
    { inlineQuotes: 'all' },
  )
  const imageFiles = attachedFiles.filter((f) => isImageFile(f.filename))
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const setSessionPendingFiles = useSetAtom(agentSessionPendingFilesAtom)
  const nonImageFiles = attachedFiles.filter((f) => !isImageFile(f.filename))
  const meta = extractMeta(message as unknown as SDKMessage)

  const handleImageEditComplete = React.useCallback((editedDataUrl: string): void => {
    const base64 = editedDataUrl.split(',')[1]
    if (!base64 || !activeSessionId) return

    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const pending: AgentPendingFile = {
      id,
      filename: `edited_image_${Date.now()}.png`,
      mediaType: 'image/png',
      size: Math.round(base64.length * 0.75),
      previewUrl: editedDataUrl,
    }

    if (!window.__pendingAgentFileData) {
      window.__pendingAgentFileData = new Map()
    }
    window.__pendingAgentFileData.set(id, base64)

    setSessionPendingFiles((prev) => {
      const sessionFiles = prev.get(activeSessionId) ?? []
      const map = new Map(prev)
      map.set(activeSessionId, [...sessionFiles, pending])
      return map
    })
  }, [activeSessionId, setSessionPendingFiles])

  // 共享大图预览状态（多图可左右翻页）
  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const [lightboxIndex, setLightboxIndex] = React.useState(0)
  // 各图加载好的 src（key = file.path）——缩略图渲染时已加载，翻页复用不再触发 IO
  const [loadedSrcs, setLoadedSrcs] = React.useState<Record<string, string>>({})

  const handleImageLoaded = React.useCallback((path: string, src: string): void => {
    setLoadedSrcs((prev) => (prev[path] ? prev : { ...prev, [path]: src }))
  }, [])

  const openLightbox = React.useCallback((index: number): void => {
    setLightboxIndex(index)
    setLightboxOpen(true)
  }, [])

  // lightbox 图片列表（索引与 imageFiles 对齐，每张带自己的保存回调）
  const lightboxImages = React.useMemo<LightboxImage[]>(
    () => imageFiles.map((file) => ({
      src: loadedSrcs[file.path] ?? '',
      alt: file.filename,
      onSave: () => window.electronAPI.saveImageAs(file.path, file.filename),
      onEditComplete: handleImageEditComplete,
    })),
    [imageFiles, loadedSrcs, handleImageEditComplete]
  )

  return (
    <Message from="user">
      <MessageContent>
        {/* 图片缩略图 */}
        {imageFiles.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2.5 mb-2">
            {imageFiles.map((file, index) => (
              <AttachedImageThumb
                key={file.path}
                file={file}
                index={index}
                onOpen={openLightbox}
                onLoaded={handleImageLoaded}
              />
            ))}
          </div>
        )}
        {/* 非图片文件芯片 */}
        {nonImageFiles.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-2">
            {nonImageFiles.map((file) => (
              <AttachedFileChip key={file.path} file={file} />
            ))}
          </div>
        )}
        {text && (
          <UserMessageContent onAgentHistoryQuoteClick={onAgentHistoryQuoteClick}>
            {text}
          </UserMessageContent>
        )}
      </MessageContent>
      {/* 共享大图预览 — 单图时无翻页，行为同以前 */}
      {imageFiles.length > 0 && (
        <ImageLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          images={lightboxImages}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
        />
      )}
      {isScheduledRun && (
        <div className="mt-1.5 pr-1">
          <ScheduledRunBadge />
        </div>
      )}
      {(text || meta.createdAt) && (
        <MessageActions className="user-message-actions mt-1.5 gap-2 pr-1">
          {meta.createdAt && (
            <span className="message-time pr-1 text-[14px] leading-none tabular-nums text-foreground/45">
              {formatMessageTime(meta.createdAt)}
            </span>
          )}
          {text && <CopyButton content={replaceAgentHistoryQuoteMentionsWithLabels(text)} />}
        </MessageActions>
      )}
    </Message>
  )
}

// ===== 错误消息渲染 =====

function shouldOfferProjectRootRestore(projectRootStatus: string | undefined): boolean {
  return projectRootStatus === 'missing'
}

interface ErrorMessageProps {
  message: SDKAssistantMessage
  /** 重试回调（在当前会话内重试） */
  onRetry?: (errorUuid?: string) => void
  /** 在新会话中重试回调（创建新会话并引用当前会话继续） */
  onRetryInNewSession?: () => void
  /** 压缩上下文回调（仅 prompt_too_long 错误使用） */
  onCompact?: () => void
  onRelinkProjectRoot?: () => void
  onRestoreProjectRoot?: () => void
}

interface AssistantErrorTailProps {
  message: SDKAssistantMessage
  /** 重试回调（在当前会话内重试） */
  onRetry?: (errorUuid?: string) => void
  /** 在新会话中重试回调（创建新会话并引用当前会话继续） */
  onRetryInNewSession?: () => void
  /** 压缩上下文回调（仅 prompt_too_long 错误使用） */
  onCompact?: () => void
  onRelinkProjectRoot?: () => void
  onRestoreProjectRoot?: () => void
  /**
   * 以「独立错误消息」形式渲染：正文用红色 MessageResponse 展示（用于 ErrorMessage 主体）。
   *
   * 以 tail 形式（默认 false）渲染时：正文本身已在上层用普通 MessageResponse 展示，这里只输出
   * 错误标题 + 简短描述 + 诊断详情 + recovery 按钮，附一条分隔线。
   */
  standalone?: boolean
}

/**
 * 助手消息的错误尾部（诊断详情 + recovery 按钮 + 简短错误描述）。
 *
 * 抽出这个组件是为了让「Pi runtime 已经吐了正文，但收尾时上游报错」这种混合消息
 * 也能保留正文的 markdown 排版，同时把错误提示以尾部 banner 形式挂在最下面。
 *
 * standalone=true 时兼容旧 ErrorMessage 的行为：把 error.message / content 里的所有 text
 * 一并作为红色 MessageResponse 渲染出来，用于「没有正文，只有错误」的场景。
 */
export function AssistantErrorTail({
  message,
  onRetry,
  onRetryInNewSession,
  onCompact,
  onRelinkProjectRoot,
  onRestoreProjectRoot,
  standalone = false,
}: AssistantErrorTailProps): React.ReactElement | null {
  const errorText = message.error?.message ?? '未知错误'

  const msgAny = message as unknown as Record<string, unknown>
  const errorTitle = typeof msgAny._errorTitle === 'string' ? msgAny._errorTitle : undefined
  const errorCode = typeof msgAny._errorCode === 'string' ? msgAny._errorCode : undefined
  const errorDetails = Array.isArray(msgAny._errorDetails)
    ? (msgAny._errorDetails as string[])
    : undefined
  const errorActions = Array.isArray(msgAny._errorActions)
    ? (msgAny._errorActions as RecoveryAction[])
    : undefined
  const isPromptTooLong = errorCode === 'prompt_too_long'
  const isLocalProjectRootUnavailable = errorCode === 'local_project_root_unavailable'
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const activeWorkspaceId = sessions.find((session) => session.id === activeSessionId)?.workspaceId
  const projectRootStatus = workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.projectRootStatus
  const canRestoreProjectRoot = shouldOfferProjectRootRestore(projectRootStatus)

  const setEnvDialogOpen = useSetAtom(environmentCheckDialogOpenAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setModelSelectorOpen = useSetAtom(modelSelectorOpenAtom)
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  // Error presentation always uses error.message. Assistant content is not error detail:
  // Pi may have generated it before a stream failure.
  const bodyText = errorText
  const isThinkingSignature = errorCode === THINKING_SIGNATURE_ERROR_CODE ||
    isThinkingSignatureError(bodyText, errorText)
  const displayTitle = errorTitle ?? (isThinkingSignature ? THINKING_SIGNATURE_ERROR_TITLE : undefined)
  const displayContentText = isThinkingSignature ? THINKING_SIGNATURE_ERROR_MESSAGE : bodyText
  const displayedErrorActions = (errorActions ?? []).filter((action) => {
    if (action.action === 'retry' && !onRetry) return false
    if (action.action === 'compact' && !onCompact) return false
    if (action.action === 'retry_in_new_session' && !onRetryInNewSession) return false
    return true
  })

  const handleRecoveryAction = (action: RecoveryAction) => {
    switch (action.action) {
      case 'open_environment_check':
        setEnvDialogOpen(true)
        break
      case 'open_channel_settings':
        setSettingsTab('channels')
        setSettingsOpen(true)
        break
      case 'settings':
        setSettingsOpen(true)
        break
      case 'select_model':
        setModelSelectorOpen(true)
        break
      case 'open_external':
        if (action.payload) {
          window.electronAPI.openExternal(action.payload)
        }
        break
      case 'retry':
        onRetry?.(typeof message.uuid === 'string' ? message.uuid : undefined)
        break
      case 'compact':
        onCompact?.()
        break
      case 'retry_in_new_session':
        onRetryInNewSession?.()
        break
      default:
        console.warn('[ErrorMessage] 未处理的 recovery action:', action)
    }
  }

  const iconForAction = (action: RecoveryAction['action']) => {
    switch (action) {
      case 'open_environment_check':
        return <Wrench className="size-3.5 mr-1.5" />
      case 'open_channel_settings':
      case 'settings':
        return <Settings className="size-3.5 mr-1.5" />
      case 'select_model':
        return <Cpu className="size-3.5 mr-1.5" />
      case 'open_external':
        return <ExternalLink className="size-3.5 mr-1.5" />
      case 'retry':
        return <RotateCw className="size-3.5 mr-1.5" />
      case 'compact':
        return <Minimize2 className="size-3.5 mr-1.5" />
      case 'retry_in_new_session':
        return <Plus className="size-3.5 mr-1.5" />
      default:
        return null
    }
  }

  const hasStructuredActions = displayedErrorActions.length > 0
  const hasLegacyActions = !!(onRetry || onRetryInNewSession || (isPromptTooLong && onCompact))
  const hasProjectRootActions = isLocalProjectRootUnavailable && !!(
    onRelinkProjectRoot || (canRestoreProjectRoot && onRestoreProjectRoot)
  )
  const hasActions = hasStructuredActions || hasLegacyActions || hasProjectRootActions

  // tail 模式：给出上边距 + 顶部细边分隔线，让它视觉上是「正文之后的一段警告」而不是「消息本身」
  const rootClass = standalone
    ? undefined
    : 'mt-3 pt-3 border-t border-destructive/20'

  return (
    <div className={rootClass}>
      {displayTitle && (
        <div className="text-sm font-medium text-destructive mb-1 flex items-center gap-1.5">
          {!standalone && <AlertTriangle size={14} className="shrink-0" />}
          {displayTitle}
        </div>
      )}
      {standalone ? (
        <div className="text-destructive">
          <MessageResponse className="text-[length:var(--chat-body-font-size,16px)]">{displayContentText}</MessageResponse>
        </div>
      ) : (
        displayContentText && (
          <div className="text-[length:var(--chat-body-font-size,16px)] text-destructive/90 whitespace-pre-wrap break-words">
            {displayContentText}
          </div>
        )
      )}
      {errorDetails && errorDetails.length > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="underline-offset-2 hover:underline"
          >
            {detailsOpen ? '收起诊断详情' : '查看诊断详情'}
          </button>
          {detailsOpen && (
            <ul className="mt-1.5 space-y-0.5 list-disc list-inside">
              {errorDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {hasActions && (
        <div className="flex items-center flex-wrap gap-2 mt-3">
          {hasProjectRootActions && (
            <>
              {onRelinkProjectRoot && (
                <Button size="sm" onClick={onRelinkProjectRoot}>
                  <FolderInput className="size-3.5 mr-1.5" />
                  重新选择文件夹
                </Button>
              )}
              {canRestoreProjectRoot && onRestoreProjectRoot && (
                <Button size="sm" variant="outline" onClick={onRestoreProjectRoot}>
                  <FolderPlus className="size-3.5 mr-1.5" />
                  在原路径新建空文件夹
                </Button>
              )}
            </>
          )}
          {hasStructuredActions &&
            displayedErrorActions.map((a, i) => (
              <Button
                key={`${a.action}-${i}`}
                size="sm"
                variant={i === 0 ? 'default' : 'outline'}
                onClick={() => handleRecoveryAction(a)}
              >
                {iconForAction(a.action)}
                {a.label}
              </Button>
            ))}
          {!hasStructuredActions && isPromptTooLong && onCompact && (
            <Button size="sm" onClick={onCompact}>
              <Minimize2 className="size-3.5 mr-1.5" />
              压缩上下文
            </Button>
          )}
          {!hasStructuredActions && isThinkingSignature && onRetryInNewSession && (
            <Button
              size="sm"
              onClick={onRetryInNewSession}
              title="新建对话并引用当前会话继续"
            >
              <Plus className="size-3.5 mr-1.5" />
              在新对话继续
            </Button>
          )}
          {!hasStructuredActions && onRetry && (
            <Button size="sm" variant={isPromptTooLong || isThinkingSignature ? 'outline' : 'default'} onClick={() => onRetry(typeof message.uuid === 'string' ? message.uuid : undefined)}>
              <RotateCw className="size-3.5 mr-1.5" />
              重试
            </Button>
          )}
          {!hasStructuredActions && !isThinkingSignature && onRetryInNewSession && (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetryInNewSession}
              title="如遇到未知错误，可点此按钮在新会话中尝试解决"
            >
              <Plus className="size-3.5 mr-1.5" />
              在新会话中重试
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ErrorMessage({ message, onRetry, onRetryInNewSession, onCompact, onRelinkProjectRoot, onRestoreProjectRoot }: ErrorMessageProps): React.ReactElement {
  // Do not copy assistant content carried by an error record.
  const copyText = message.error?.message ?? 'Unknown error'

  return (
    <Message from="assistant">
      <MessageContent>
        <AssistantErrorTail
          message={message}
          onRetry={onRetry}
          onRetryInNewSession={onRetryInNewSession}
          onCompact={onCompact}
          onRelinkProjectRoot={onRelinkProjectRoot}
          onRestoreProjectRoot={onRestoreProjectRoot}
          standalone
        />
      </MessageContent>
      <MessageActions className="assistant-message-actions -ml-1.5 mt-4">
        <CopyButton content={copyText} />
      </MessageActions>
    </Message>
  )
}

// ===== MessageGroup 渲染器（统一入口，同时支持 turn 和单条消息） =====

export interface MessageGroupRendererProps {
  group: MessageGroup
  allMessages: SDKMessage[]
  /** 仅跨 turn 工具元数据变化时更新历史 assistant；普通 live 数组新引用不触发重渲染。 */
  externalMetadataSignature?: string
  basePath?: string
  onFork?: (upToMessageUuid: string) => void
  onRewind?: (assistantMessageUuid: string) => void
  /** 已发送的 Agent 历史引用 chip 请求定位时的精确范围。 */
  onAgentHistoryQuoteClick?: (quote: QuotedSelection) => void
  /** 将 assistant 回复标记为 Todo */
  onCreateTodo?: (text: string) => void
  /** 错误重试回调（传入本轮开始前应删除的错误 UUID） */
  onRetry?: (errorUuid?: string) => void
  /** 在新会话中重试回调（仅当 turn 含错误消息时使用） */
  onRetryInNewSession?: () => void
  /** 压缩上下文回调（仅 prompt_too_long 错误使用） */
  onCompact?: () => void
  onRelinkProjectRoot?: () => void
  onRestoreProjectRoot?: () => void
  /** 当前历史轮次；直接写入消息 DOM，避免划选时回扫整段历史。 */
  historyTurn?: number
  /** 是否正在流式输出中（隐藏操作栏） */
  isStreaming?: boolean
  /** 是否被用户中断 */
  stoppedByUser?: boolean
  /** 被新消息打断的时间；undefined = 未被打断，null = 被打断但时间未知 */
  interruptedAt?: number | null
  /** 用户在前端选择的模型 ID（优先用于显示名称） */
  sessionModelId?: string
}

/**
 * WeakMap 缓存：为没有 uuid 的消息生成稳定的 fallback ID
 * 使用 message 对象（而非 group 对象）作为 key，因为 group 在 useMemo 重算时会
 * 被重建为新对象，而 group.message 引用的底层 SDK message 对象是稳定的。
 */
const messageIdCache = new WeakMap<object, string>()
let fallbackIdCounter = 0

/**
 * 从 MessageGroup 中提取稳定的 ID，用于 data-message-id 和迷你地图
 */
export function getGroupId(group: MessageGroup): string {
  if (group.type === 'user') {
    if (group.message.uuid) return group.message.uuid
    const stableKey = (group.message as unknown as Record<string, unknown>)._promaStableKey
    if (typeof stableKey === 'string') return stableKey
    // 没有 uuid：使用基于 message 对象引用的缓存 ID（message 引用在重渲染间稳定）
    if (!messageIdCache.has(group.message)) {
      messageIdCache.set(group.message, `user-${++fallbackIdCounter}`)
    }
    return messageIdCache.get(group.message)!
  }
  if (group.type === 'system') {
    if (!messageIdCache.has(group.identityMessage)) {
      messageIdCache.set(group.identityMessage, `system-${group.identityMessage.subtype ?? 'unknown'}-${++fallbackIdCounter}`)
    }
    return messageIdCache.get(group.identityMessage)!
  }
  // assistant-turn：取首条 assistant 消息的 uuid
  const first = group.assistantMessages[0]
  if (first?.uuid) return first.uuid
  const stableKey = first ? (first as unknown as Record<string, unknown>)._promaStableKey : undefined
  if (typeof stableKey === 'string') return stableKey
  // 没有 uuid：使用基于首条 assistant message 对象引用的缓存 ID
  if (first) {
    if (!messageIdCache.has(first)) {
      messageIdCache.set(first, `turn-${++fallbackIdCounter}`)
    }
    return messageIdCache.get(first)!
  }
  // 极端情况：空 turn
  return `turn-empty-${++fallbackIdCounter}`
}

// getGroupPreview 已迁移至 @proma/session-core（本文件从该包 import 并 re-export）

export const MessageGroupRenderer = React.memo(function MessageGroupRenderer({ group, allMessages, basePath, onFork, onRewind, onAgentHistoryQuoteClick, onCreateTodo, onRetry, onRetryInNewSession, onCompact, onRelinkProjectRoot, onRestoreProjectRoot, historyTurn, isStreaming, stoppedByUser, interruptedAt, sessionModelId }: MessageGroupRendererProps): React.ReactElement | null {
  const groupId = getGroupId(group)

  if (group.type === 'user') {
    return (
      <div data-message-id={groupId} data-message-role="user" data-message-turn={historyTurn}>
        <UserInputMessage message={group.message} onAgentHistoryQuoteClick={onAgentHistoryQuoteClick} />
      </div>
    )
  }

  if (group.type === 'system') {
    const subtype = group.message.subtype
    // system 消息同样需要稳定 DOM 锚点，保留既有历史引用与精确回跳能力。
    const historySelectionAttributes = {
      'data-message-id': groupId,
      'data-message-role': 'system',
      'data-message-turn': historyTurn,
    }
    if (getSDKCompactStatus(group.message)) return <div {...historySelectionAttributes}><CompactStatusNotice message={group.message} /></div>
    if (subtype === 'permission_denied') return <div {...historySelectionAttributes}><PermissionDeniedNotice message={group.message} /></div>
    return null
  }

  // assistant-turn
  return (
    <div
      data-message-id={groupId}
      data-message-role="assistant"
      data-message-turn={historyTurn}
      // 轮次分叉点：本轮最后一条主线 assistant 消息。历史选区据此从轮末而非选区所在消息分叉。
      data-turn-fork-uuid={getTurnForkTargetUuid(group.assistantMessages)}
      data-agent-live={isStreaming ? 'true' : undefined}
    >
      <AssistantTurnRenderer
        turn={group}
        allMessages={allMessages}
        basePath={basePath}
        onFork={onFork}
        onRewind={onRewind}
        onCreateTodo={onCreateTodo}
        onRetry={onRetry}
        onRetryInNewSession={onRetryInNewSession}
        onCompact={onCompact}
        onRelinkProjectRoot={onRelinkProjectRoot}
        onRestoreProjectRoot={onRestoreProjectRoot}
        isStreaming={isStreaming}
        stoppedByUser={stoppedByUser}
        interruptedAt={interruptedAt}
        sessionModelId={sessionModelId}
      />
    </div>
  )
}, (previous, next) => (
  previous.group === next.group
  && previous.basePath === next.basePath
  && previous.onFork === next.onFork
  && previous.onRewind === next.onRewind
  && previous.onAgentHistoryQuoteClick === next.onAgentHistoryQuoteClick
  && previous.onCreateTodo === next.onCreateTodo
  && previous.onRetry === next.onRetry
  && previous.onRetryInNewSession === next.onRetryInNewSession
  && previous.onCompact === next.onCompact
  && previous.onRelinkProjectRoot === next.onRelinkProjectRoot
  && previous.onRestoreProjectRoot === next.onRestoreProjectRoot
  && previous.historyTurn === next.historyTurn
  && previous.isStreaming === next.isStreaming
  && previous.stoppedByUser === next.stoppedByUser
  && previous.interruptedAt === next.interruptedAt
  && previous.sessionModelId === next.sessionModelId
  && previous.externalMetadataSignature === next.externalMetadataSignature
))
