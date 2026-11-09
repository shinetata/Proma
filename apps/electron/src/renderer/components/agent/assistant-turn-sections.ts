/**
 * assistant-turn-sections — 助手轮次的「执行过程 / 最终输出」分区与过程文案
 *
 * 与商业版 0.21.88 的轮次渲染保持一致：
 * - 最后一条非错误 assistant 消息里的正文视为最终输出，排在过程之后单独展示；
 * - 其余 thinking / tool_use 连续片段合并为一个「步骤组」，中间穿插的正文作为过程中的说明；
 * - 过程区顶部汇总为「已思考 N 次、执行 N 次工具、耗时 Xs」。
 *
 * 已答的 AskUserQuestion 例外：它从执行过程里摘出，作为 question 分区
 * 交给「你的回答」卡片（见 collectAssistantTurnBodyEntries）。
 */

import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKThinkingBlock, SDKToolUseBlock } from '@proma/shared'

function isToolUseBlock(block: SDKContentBlock | undefined): block is SDKToolUseBlock {
  return block?.type === 'tool_use'
}

function isThinkingBlock(block: SDKContentBlock | undefined): block is SDKThinkingBlock {
  return block?.type === 'thinking'
}

/** 带来源消息的内容块 */
export interface AssistantTurnSourceBlock {
  block: SDKContentBlock
  sourceMessage: SDKAssistantMessage
}

export interface AssistantTurnSectionItem {
  block: SDKContentBlock
  index: number
}

export type AssistantTurnSection =
  | { type: 'activity'; items: AssistantTurnSectionItem[] }
  | { type: 'block'; item: AssistantTurnSectionItem; output?: boolean; promotedFromThinking?: boolean }
  // 已答的 AskUserQuestion：从执行过程里摘出，作为「你的回答」卡片回显
  | { type: 'question'; item: AssistantTurnSectionItem }

/** 正文区条目：单条正文块，或一组连续问答（合并成一张回显卡片） */
export type AssistantTurnBodyEntry =
  | { type: 'block'; item: AssistantTurnSectionItem; sectionIndex: number; promotedFromThinking?: boolean }
  | { type: 'question'; entries: AssistantTurnSectionItem[]; sectionIndex: number }

export interface AssistantTurnSections {
  items: AssistantTurnSection[]
  /** answer = 有最终输出；incomplete = 输出被中断；none = 没有最终输出 */
  outputState: 'answer' | 'incomplete' | 'none'
  /** 本轮成功结束但没有任何文字总结 */
  completedWithoutAnswer: boolean
}

type LooseAssistantMessage = SDKAssistantMessage & {
  _partial?: boolean
  _errorCode?: string
  _sourceSessionId?: string
}

type PhasedTextBlock = { type: 'text'; text: string; phase?: string }

function isFailedAssistantMessage(message: SDKAssistantMessage): boolean {
  return !!message.error || ['error', 'aborted', 'length', 'max_tokens'].includes(message.message.stop_reason ?? '')
}

function isNaturalStop(message: SDKAssistantMessage): boolean {
  return !message.message.stop_reason || message.message.stop_reason === 'stop' || message.message.stop_reason === 'end_turn'
}

function isExplicitStop(message: SDKAssistantMessage): boolean {
  return message.message.stop_reason === 'stop' || message.message.stop_reason === 'end_turn'
}

function hasThinkingText(block: SDKContentBlock): boolean {
  return isThinkingBlock(block) && typeof block.thinking === 'string' && !!block.thinking.trim()
}

/** 当前轮次最后一条 assistant 之后的 result 消息（没有则视为仍在进行或被截断） */
export function findTrailingResult(turnMessages: SDKMessage[]): SDKResultMessage | undefined {
  for (let index = turnMessages.length - 1; index >= 0; index--) {
    const message = turnMessages[index]
    if (message?.type === 'assistant') return undefined
    if (message?.type === 'result') return message as SDKResultMessage
  }
  return undefined
}

/** 将轮次内容块拆分为过程片段与最终输出 */
export function buildAssistantTurnSections(
  blocks: AssistantTurnSourceBlock[],
  {
    messages,
    isStreaming = false,
    stoppedByUser = false,
    result,
    answeredQuestionToolIds,
  }: {
    messages: SDKAssistantMessage[]
    isStreaming?: boolean
    stoppedByUser?: boolean
    result?: SDKResultMessage
    /**
     * 已答 AskUserQuestion 的 tool_use id：这些工具块不再进入执行过程，
     * 而是作为 question 分区交给「你的回答」卡片渲染。
     */
    answeredQuestionToolIds?: ReadonlySet<string>
  },
): AssistantTurnSections {
  const effectiveResult = result?.isSyntheticCompactionResult ? undefined : result
  const lastMessage = messages.at(-1)
  const interrupted = stoppedByUser
    || (!!lastMessage && isFailedAssistantMessage(lastMessage))
    || (!!effectiveResult && (effectiveResult.subtype !== 'success' || (!!effectiveResult.terminal_reason && effectiveResult.terminal_reason !== 'completed')))
  const succeeded = !isStreaming && !interrupted && effectiveResult?.subtype === 'success'
  const outputMessage = messages.findLast((message) => typeof (message as LooseAssistantMessage)._errorCode !== 'string') as LooseAssistantMessage | undefined
  const outputTexts = blocks
    .filter(({ sourceMessage }) => sourceMessage === outputMessage)
    .map(({ block }) => block)
    .filter((block): block is PhasedTextBlock => block.type === 'text' && typeof block.text === 'string')
  const hasPhasedText = outputTexts.some((block) => block.phase === 'commentary' || block.phase === 'final_answer')
  const outputHasToolUse = outputMessage?.message.content.some((block) => block.type === 'tool_use') ?? false
  const openWithoutResult = !result && !!outputMessage && !outputMessage.message.stop_reason && !outputMessage._sourceSessionId
  const stoppedWithoutResult = !result && !!outputMessage?.message.stop_reason
  const outputSettled = !!outputMessage
    && !isStreaming
    && !interrupted
    && outputMessage._partial !== true
    && !outputHasToolUse
    && isNaturalStop(outputMessage)
    && (succeeded || openWithoutResult || stoppedWithoutResult)

  const outputIndexes = new Set<number>()
  blocks.forEach(({ block, sourceMessage }, index) => {
    if (sourceMessage !== outputMessage || block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) return
    const phased = block as PhasedTextBlock
    if (phased.phase === 'commentary') return
    if (phased.phase === 'final_answer' || (!hasPhasedText && (outputSettled || (!isStreaming && interrupted && !outputHasToolUse)))) {
      outputIndexes.add(index)
    }
  })

  // 模型把结论写进思考且没有正文时，提升最后一段思考作为正文。
  let promotedIndex: number | undefined
  if (!outputIndexes.size && outputSettled && outputMessage && isExplicitStop(outputMessage) && !outputTexts.some((block) => block.text.trim())) {
    blocks.forEach(({ block, sourceMessage }, index) => {
      if (sourceMessage === outputMessage && hasThinkingText(block)) promotedIndex = index
    })
    if (promotedIndex !== undefined) outputIndexes.add(promotedIndex)
  }

  const processItems: AssistantTurnSection[] = []
  const outputItems: AssistantTurnSection[] = []
  let activity: AssistantTurnSectionItem[] = []
  const flushActivity = (): void => {
    if (activity.length === 0) return
    processItems.push({ type: 'activity', items: activity })
    activity = []
  }

  blocks.forEach(({ block }, index) => {
    if (block.type === 'text' && typeof block.text === 'string' && !block.text.trim()) return
    const item = { block, index }
    if (block.type === 'tool_use') {
      const toolBlock = block as SDKToolUseBlock
      if (toolBlock.name === 'AskUserQuestion' && answeredQuestionToolIds?.has(toolBlock.id)) {
        // 已答问答打断了执行过程：先收束当前步骤组，再单独成卡片
        flushActivity()
        processItems.push({ type: 'question', item })
        return
      }
    }
    if (outputIndexes.has(index)) {
      flushActivity()
      outputItems.push(index === promotedIndex
        ? { type: 'block', item, output: true, promotedFromThinking: true }
        : { type: 'block', item, output: true })
      return
    }
    if (block.type === 'text') {
      flushActivity()
      processItems.push({ type: 'block', item })
      return
    }
    activity.push(item)
  })
  flushActivity()

  return {
    items: [...processItems, ...outputItems],
    outputState: outputIndexes.size ? (interrupted ? 'incomplete' : 'answer') : 'none',
    completedWithoutAnswer: succeeded && !outputIndexes.size,
  }
}

/**
 * 归集正文区条目。
 *
 * 正文区包含最终输出与「你的回答」卡片；连续相邻的多个已答 AskUserQuestion
 * 合并成同一张卡片（对应商业版的分组合并）。
 * 「相邻」按完整分区顺序判断：被过程区正文或其它内容隔开的两次提问各自成卡片，
 * 与商业版一致。
 */
export function collectAssistantTurnBodyEntries(sections: readonly AssistantTurnSection[]): AssistantTurnBodyEntry[] {
  const entries: AssistantTurnBodyEntry[] = []
  sections.forEach((section, sectionIndex) => {
    if (section.type === 'question') {
      const isAdjacent = sections[sectionIndex - 1]?.type === 'question'
      const last = entries.at(-1)
      if (isAdjacent && last && last.type === 'question') {
        last.entries.push(section.item)
        return
      }
      entries.push({ type: 'question', entries: [section.item], sectionIndex })
      return
    }
    if (section.type === 'block' && section.output) {
      entries.push({
        type: 'block',
        item: section.item,
        sectionIndex,
        promotedFromThinking: section.promotedFromThinking,
      })
    }
  })
  return entries
}

// ===== 过程摘要文案 =====

export function countProcessBlocks(blocks: SDKContentBlock[]): { thinkingCount: number; toolCount: number; lastTool?: SDKToolUseBlock } {
  let thinkingCount = 0
  let toolCount = 0
  let lastTool: SDKToolUseBlock | undefined
  for (const block of blocks) {
    if (isThinkingBlock(block)) {
      if (block.thinking?.trim()) thinkingCount += 1
    } else if (isToolUseBlock(block)) {
      toolCount += 1
      lastTool = block
    }
  }
  return { thinkingCount, toolCount, lastTool }
}

export function formatProcessElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

/** 「已思考 N 次、执行 N 次工具、耗时 Xs」 */
export function buildProcessSummary(blocks: SDKContentBlock[], elapsedMs?: number): string | null {
  const { thinkingCount, toolCount } = countProcessBlocks(blocks)
  const parts: string[] = []
  if (thinkingCount > 0) parts.push(`已思考 ${thinkingCount} 次`)
  if (toolCount > 0) parts.push(`执行 ${toolCount} 次工具`)
  if (elapsedMs != null) parts.push(`耗时 ${formatProcessElapsed(elapsedMs)}`)
  return parts.length > 0 ? parts.join('、') : null
}

// ===== 工具显示名、引用与状态短语 =====

/** 工具的中文显示名（工具行「类别 · 短语」中的类别），与商业版共用同一份映射 */
export { getToolDisplayName } from './tool-utils'

export interface ToolReference {
  kind: 'mcp' | 'skill'
  label: string
  title: string
}

function getSkillSlugFromPath(path: string): string | null {
  const match = path.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i)
  return match?.[1] ?? null
}

/** Skill / MCP 调用的引用徽标信息 */
export function getToolReference(toolName: string, input: Record<string, unknown>): ToolReference | null {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    const server = parts[1]
    const tool = parts.slice(2).join('__')
    if (server && tool) return { kind: 'mcp', label: `${server} / ${tool}`, title: `MCP 工具：${toolName}` }
  }
  if (toolName === 'Skill' && typeof input.skill === 'string' && input.skill.trim()) {
    const skill = input.skill.trim()
    return { kind: 'skill', label: skill, title: `Skill：${skill}` }
  }
  if (toolName === 'Read') {
    const path = input.file_path ?? input.filePath ?? input.path
    if (typeof path === 'string') {
      const slug = getSkillSlugFromPath(path)
      if (slug) return { kind: 'skill', label: slug, title: `Skill：${slug}` }
    }
  }
  return null
}

export type ToolRunStatus = 'running' | 'completed' | 'failed' | 'incomplete'

const TOOL_STATUS_PHRASES: Record<string, { action: string; operation: string; completed: string }> = {
  TaskCreate: { action: '创建任务', operation: '任务创建', completed: '任务已创建' },
  TaskUpdate: { action: '更新任务进度', operation: '任务进度更新', completed: '任务进度已更新' },
  TaskGet: { action: '查看任务详情', operation: '任务详情读取', completed: '任务详情已获取' },
  TaskList: { action: '查看任务列表', operation: '任务列表读取', completed: '任务列表已获取' },
  TodoRead: { action: '读取待办事项', operation: '待办事项读取', completed: '待办事项读取完成' },
  TodoWrite: { action: '更新待办事项', operation: '待办事项更新', completed: '待办事项已更新' },
  Read: { action: '读取文件', operation: '文件读取', completed: '文件读取完成' },
  Write: { action: '写入文件', operation: '文件写入', completed: '文件写入完成' },
  Edit: { action: '编辑文件', operation: '文件编辑', completed: '文件编辑完成' },
  MultiEdit: { action: '编辑文件', operation: '文件编辑', completed: '文件编辑完成' },
  Bash: { action: '执行命令', operation: '命令执行', completed: '命令执行结束' },
  Grep: { action: '搜索内容', operation: '内容搜索', completed: '内容搜索完成' },
  Glob: { action: '查找文件', operation: '文件查找', completed: '文件查找完成' },
  WebSearch: { action: '搜索网页', operation: '网页搜索', completed: '网页搜索完成' },
  WebFetch: { action: '读取网页', operation: '网页读取', completed: '网页读取完成' },
  EnterPlanMode: { action: '进入计划模式', operation: '进入计划模式', completed: '已进入计划模式' },
  ExitPlanMode: { action: '提交计划审批', operation: '计划审批', completed: '计划审批已返回' },
  SelectWorktree: { action: '切换代码工作目录', operation: '代码工作目录切换', completed: '代码工作目录已切换' },
  CompactContext: { action: '准备压缩上下文', operation: '上下文压缩准备', completed: '已安排上下文压缩' },
  AskUserQuestion: { action: '等待你的选择', operation: '交互问答', completed: '已收到你的选择' },
  TerminalExecute: { action: '启动终端命令', operation: '终端命令启动', completed: '终端命令已启动' },
  TerminalRead: { action: '读取终端输出', operation: '终端输出读取', completed: '终端输出已读取' },
  TerminalList: { action: '查看终端列表', operation: '终端列表读取', completed: '终端列表已获取' },
}

/** 工具状态短语，例如「正在读取文件」「文件读取完成」「命令执行失败」 */
export function getToolStatusLabel(toolName: string, input: Record<string, unknown>, status: ToolRunStatus): string {
  const reference = getToolReference(toolName, input)
  if (reference) {
    const kind = reference.kind === 'skill' ? 'Skill' : 'MCP'
    switch (status) {
      case 'running': return `正在调用 ${kind}`
      case 'completed': return `已调用 ${kind}`
      case 'failed': return `${kind} 调用失败`
      case 'incomplete': return `${kind} 调用未完成`
    }
  }
  const phrase = Object.hasOwn(TOOL_STATUS_PHRASES, toolName) ? TOOL_STATUS_PHRASES[toolName] : undefined
  if (phrase) {
    switch (status) {
      case 'running': return `正在${phrase.action}`
      case 'completed': return phrase.completed
      case 'failed': return `${phrase.operation}失败`
      case 'incomplete': return `${phrase.operation}未完成`
    }
  }
  switch (status) {
    case 'running': return `正在执行 ${toolName} 工具`
    case 'completed': return `已执行工具 ${toolName}`
    case 'failed': return `工具 ${toolName} 执行失败`
    case 'incomplete': return `工具 ${toolName} 执行未完成`
  }
}

export interface ProcessStepContent {
  label: string
  reference?: ToolReference
  markerTool?: string
  suffix?: string
}

export const THINKING_STEP_CONTENT: ProcessStepContent = { label: '正在思考...' }

/** 步骤组折叠行的当前文案：活动中显示最后一步，完成后显示最后一次工具调用的结果 */
export function getProcessStepContent(
  blocks: SDKContentBlock[],
  isActive: boolean,
  completedToolIds?: ReadonlySet<string>,
  failedToolIds?: ReadonlySet<string>,
): ProcessStepContent {
  const last = blocks[blocks.length - 1]
  const tool = isActive
    ? (isToolUseBlock(last) ? last : undefined)
    : countProcessBlocks(blocks).lastTool
  if (tool) {
    const status: ToolRunStatus = failedToolIds?.has(tool.id)
      ? 'failed'
      : completedToolIds?.has(tool.id) || (!isActive && !completedToolIds)
        ? 'completed'
        : isActive ? 'running' : 'incomplete'
    return {
      label: getToolStatusLabel(tool.name, tool.input, status),
      reference: getToolReference(tool.name, tool.input) ?? undefined,
      markerTool: tool.name,
    }
  }
  if (!isActive) return { label: '思考完成' }
  if (isThinkingBlock(last)) return { label: last.thinking?.trim() ? '思考完成' : '正在思考...' }
  return THINKING_STEP_CONTENT
}
