/**
 * assistant-turn-sections — 助手轮次的「执行过程 / 最终输出」分区与过程文案
 *
 * 与商业版 0.22.0 的轮次渲染保持一致：
 * - 分区保持内容块的原始顺序（最终输出不再整体挪到最后）；
 * - 最后一条非错误 assistant 消息里的正文视为最终输出；没有正文时，
 *   最后一段非空文字也归入正文区，保证「最终回复始终独立可见」；
 * - 已答的 AskUserQuestion 从执行过程里摘出，作为 question 分区
 *   交给「你的回答」卡片（见 splitTurnBodyAndProcess / groupConsecutiveQuestions）；
 * - 过程区收拢为轮次顶部的一行摘要（TurnProcessSummary，见 ProcessTimeline.tsx）。
 */

import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKThinkingBlock, SDKToolUseBlock, SDKUserMessage } from '@proma/shared'

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

/** 分区列表条目：分区本身 + 在分区列表中的下标（供渲染层定位动画 key 与活动组） */
export interface AssistantTurnListEntry {
  item: AssistantTurnSection
  itemIndex: number
}

export interface AssistantTurnSections {
  items: AssistantTurnSection[]
  /** answer = 有最终输出；incomplete = 输出被中断；none = 没有最终输出 */
  outputState: 'answer' | 'incomplete' | 'none'
  /** 本轮成功结束但没有任何文字总结 */
  completedWithoutAnswer: boolean
  /** 本轮以失败/中断收尾（用户停止、消息级错误或 result 异常） */
  failed: boolean
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

/** 将轮次内容块拆分为过程片段与最终输出（保持原始顺序） */
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

  const items: AssistantTurnSection[] = []
  let activity: AssistantTurnSectionItem[] = []
  const flushActivity = (): void => {
    if (activity.length === 0) return
    items.push({ type: 'activity', items: activity })
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
        items.push({ type: 'question', item })
        return
      }
    }
    if (outputIndexes.has(index)) {
      flushActivity()
      items.push(index === promotedIndex
        ? { type: 'block', item, output: true, promotedFromThinking: true }
        : { type: 'block', item, output: true })
      return
    }
    if (block.type === 'text') {
      flushActivity()
      items.push({ type: 'block', item })
      return
    }
    activity.push(item)
  })
  flushActivity()

  return {
    items,
    outputState: outputIndexes.size ? (interrupted ? 'incomplete' : 'answer') : 'none',
    completedWithoutAnswer: succeeded && !outputIndexes.size,
    failed: interrupted,
  }
}

// ===== 正文 / 过程拆分 =====

/**
 * 把分区列表拆成正文区与过程区（对应商业版 aLt）。
 *
 * - 有最终输出分区时，正文 = 全部 output 分区；
 * - 没有最终输出时，正文 = 最后一个非空 text 的 block 分区，
 *   即使本轮最后一条消息没被识别为最终输出，最后一段文字也不会被折进过程；
 * - question 分区始终归正文；
 * - 会话中存在任一已答 AskUserQuestion 时（hasAnsweredQuestions），
 *   非 output 的 text 分区也归正文（0.22.0 行为）；
 * - 其余归过程。两侧都保留原始顺序。
 */
export function splitTurnBodyAndProcess(
  sections: readonly AssistantTurnSection[],
  hasAnsweredQuestions: boolean,
): { body: AssistantTurnListEntry[]; process: AssistantTurnListEntry[] } {
  const entries: AssistantTurnListEntry[] = sections.map((item, itemIndex) => ({ item, itemIndex }))
  const hasOutput = sections.some((section) => section.type === 'block' && !!section.output)
  const lastTextEntryIndex = hasOutput
    ? -1
    : entries.findLast(({ item }) => {
      if (item.type !== 'block') return false
      const { block } = item.item
      return block.type === 'text' && typeof block.text === 'string' && !!block.text.trim()
    })?.itemIndex ?? -1

  const isBody = (entry: AssistantTurnListEntry): boolean => {
    const { item } = entry
    if (item.type === 'question') return true
    if (item.type !== 'block') return false
    const isOutput = hasOutput ? !!item.output : entry.itemIndex === lastTextEntryIndex
    if (isOutput) return true
    // 存在已答问答时，过程里的说明文字也归正文（与 0.22.0 一致）
    return hasAnsweredQuestions && !item.output && item.item.block.type === 'text'
  }

  const body: AssistantTurnListEntry[] = []
  const process: AssistantTurnListEntry[] = []
  for (const entry of entries) (isBody(entry) ? body : process).push(entry)
  return { body, process }
}

// ===== 正文条目分组 =====

export type AssistantTurnBodyGroup =
  | { kind: 'entry'; entry: AssistantTurnListEntry }
  | { kind: 'questions'; entries: AssistantTurnListEntry[] }

/**
 * 对传入列表中相邻的 question 条目合并成一组（对应商业版 lLt）。
 *
 * 注意「相邻」按传入列表判断：已完成态传入正文列表（两次提问之间只隔了
 * 工具步骤时会合并成一张卡片），停止/失败态传入全部分区。
 */
export function groupConsecutiveQuestions(entries: readonly AssistantTurnListEntry[]): AssistantTurnBodyGroup[] {
  const groups: AssistantTurnBodyGroup[] = []
  for (const entry of entries) {
    if (entry.item.type !== 'question') {
      groups.push({ kind: 'entry', entry })
      continue
    }
    const last = groups.at(-1)
    if (last?.kind === 'questions') {
      last.entries.push(entry)
    } else {
      groups.push({ kind: 'questions', entries: [entry] })
    }
  }
  return groups
}

// ===== 轮次计时 =====

/** 轮次计时所需的最小结构（AssistantTurn 的输入消息与创建时间） */
export interface TurnTimingInfo {
  inputMessage?: SDKUserMessage
  createdAt?: number
}

function isInterruptedPreviousUserMessage(message: SDKUserMessage | undefined): boolean {
  return (message as Record<string, unknown> | undefined)?._promaInterruptedPrevious === true
}

function getUserMessageCreatedAt(message: SDKUserMessage | undefined): number | undefined {
  const value = (message as Record<string, unknown> | undefined)?._createdAt
  return typeof value === 'number' ? value : undefined
}

/**
 * 已结束轮次的起算时间（对应商业版 uLt）：
 * 输入消息带「打断前一轮」标记时取输入消息时间与轮次创建时间中较晚者，
 * 否则只取轮次创建时间。
 */
export function getTurnSettledStartedAt({ inputMessage, createdAt }: TurnTimingInfo): number | undefined {
  const interruptedInputCreatedAt = isInterruptedPreviousUserMessage(inputMessage)
    ? getUserMessageCreatedAt(inputMessage)
    : undefined
  if (interruptedInputCreatedAt == null) return createdAt
  if (createdAt == null) return interruptedInputCreatedAt
  return Math.max(createdAt, interruptedInputCreatedAt)
}

/**
 * 运行中轮次的起始时间（对应商业版 fLt）：
 * 直接取输入消息的 _createdAt，没有再用轮次创建时间。
 */
export function getTurnLiveStartedAt({ inputMessage, createdAt }: TurnTimingInfo): number | undefined {
  return getUserMessageCreatedAt(inputMessage) ?? createdAt
}

/**
 * 被打断轮次的耗时（对应商业版 pLt）：
 * 打断时间 − 起算时间；打断早于起算时间（或缺少时间）时视为无值。
 */
export function getTurnInterruptedDurationMs(turn: TurnTimingInfo, interruptedAt: number | null | undefined): number | undefined {
  if (interruptedAt == null) return undefined
  const startedAt = getTurnSettledStartedAt(turn)
  if (startedAt == null || interruptedAt < startedAt) return undefined
  return interruptedAt - startedAt
}

/** 完成轮次的耗时文案（对应商业版 X8t） */
export function formatTurnDuration(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`
}

/** 运行中轮次的实时耗时文案（对应商业版 Z8t） */
export function formatLiveElapsed(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分 ${String(totalSeconds % 60).padStart(2, '0')} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

// ===== 过程步骤文案 =====

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
  TaskCreate: { action: '创建任务', operation: '任务创建', completed: '创建了任务' },
  TaskUpdate: { action: '更新任务进度', operation: '任务进度更新', completed: '更新了任务进度' },
  TaskGet: { action: '查看任务详情', operation: '任务详情读取', completed: '查看了任务详情' },
  TaskList: { action: '查看任务列表', operation: '任务列表读取', completed: '查看了任务列表' },
  TodoRead: { action: '读取待办事项', operation: '待办事项读取', completed: '读取了待办事项' },
  TodoWrite: { action: '更新待办事项', operation: '待办事项更新', completed: '更新了待办事项' },
  Read: { action: '读取文件', operation: '文件读取', completed: '读取了文件' },
  Write: { action: '写入文件', operation: '文件写入', completed: '写入了文件' },
  Edit: { action: '编辑文件', operation: '文件编辑', completed: '编辑了文件' },
  MultiEdit: { action: '编辑文件', operation: '文件编辑', completed: '文件编辑完成' },
  Bash: { action: '执行命令', operation: '命令执行', completed: '执行了命令' },
  Grep: { action: '搜索内容', operation: '内容搜索', completed: '搜索了内容' },
  Glob: { action: '查找文件', operation: '文件查找', completed: '查找了文件' },
  WebSearch: { action: '搜索网页', operation: '网页搜索', completed: '搜索了网页' },
  WebFetch: { action: '读取网页', operation: '网页读取', completed: '读取了网页' },
  EnterPlanMode: { action: '进入计划模式', operation: '进入计划模式', completed: '进入了计划模式' },
  ExitPlanMode: { action: '提交计划审批', operation: '计划审批', completed: '提交了计划审批' },
  SelectWorktree: { action: '切换代码工作目录', operation: '代码工作目录切换', completed: '切换了代码工作目录' },
  CompactContext: { action: '准备压缩上下文', operation: '上下文压缩准备', completed: '安排了上下文压缩' },
  AskUserQuestion: { action: '等待你的选择', operation: '交互问答', completed: '收到了你的选择' },
  TerminalExecute: { action: '启动终端命令', operation: '终端命令启动', completed: '启动了终端命令' },
  TerminalRead: { action: '读取终端输出', operation: '终端输出读取', completed: '读取了终端输出' },
  TerminalList: { action: '查看终端列表', operation: '终端列表读取', completed: '查看了终端列表' },
}

/** 工具状态短语，例如「正在读取文件」「读取了文件」「命令执行失败」 */
export function getToolStatusLabel(toolName: string, input: Record<string, unknown>, status: ToolRunStatus): string {
  const reference = getToolReference(toolName, input)
  if (reference) {
    const kind = reference.kind === 'skill' ? 'Skill' : 'MCP'
    switch (status) {
      case 'running': return `正在调用 ${kind}`
      case 'completed': return `调用了 ${kind}`
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

// ===== 工具输入摘要 =====

/** 取文本中第一行非空内容 */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** 取文本中最后一行非空内容 */
function lastNonEmptyLine(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const trimmed = lines[index]?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** 把用户目录前缀缩写为 ~（对应商业版 vhe） */
function abbreviateHomePath(text: string): string {
  return text
    .replace(/^\/(?:Users|home)\/[^/]+\//, '~/')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '~\\')
}

/** 各工具的摘要字段优先级（对应商业版 Q8t） */
const TOOL_INPUT_SUMMARY_FIELDS: Record<string, readonly string[]> = {
  Bash: ['description', 'command'],
  TerminalExecute: ['description', 'command'],
  TerminalRead: ['description', 'terminal_id'],
  TerminalList: ['description'],
  Read: ['path', 'file_path'],
  Write: ['path', 'file_path'],
  Edit: ['path', 'file_path'],
  MultiEdit: ['path', 'file_path'],
  LS: ['path'],
  Grep: ['pattern', 'path'],
  Glob: ['pattern', 'path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description', 'prompt'],
  Task: ['description', 'prompt'],
  Skill: ['skill'],
  AskUserQuestion: ['question'],
  SelectWorktree: ['worktreePath', 'path'],
  CompactContext: ['reason', 'description'],
  BrowserNavigate: ['url'],
  BrowserObserve: ['url'],
  BrowserExecuteJavaScript: ['script'],
  BrowserFind: ['name', 'role'],
  BrowserExtract: ['selector'],
}

/**
 * 工具输入的单行摘要（对应商业版 G8t）。
 *
 * Skill / MCP 引用已有徽标展示，返回 undefined；否则按工具的字段优先级
 * 取第一个非空字符串，取不到再取 input 中第一个非空字符串值，
 * 结果取第一行非空文本并把用户目录前缀缩写为 ~。
 */
export function getToolInputSummary(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input || getToolReference(toolName, input)) return undefined
  const fields = TOOL_INPUT_SUMMARY_FIELDS[toolName]
  if (fields) {
    for (const field of fields) {
      const value = input[field]
      if (typeof value === 'string' && value.trim()) return abbreviateHomePath(firstNonEmptyLine(value))
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return abbreviateHomePath(firstNonEmptyLine(value))
  }
  return undefined
}

/** 取最后一段非空 thinking 的完整文本 */
function findLastThinkingText(blocks: SDKContentBlock[]): string {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (!isThinkingBlock(block)) continue
    const thinking = block.thinking
    if (typeof thinking === 'string' && thinking.trim()) return thinking
  }
  return ''
}

export interface ProcessStepContent {
  label: string
  summary?: string
  reference?: ToolReference
  markerTool?: string
}

export const THINKING_STEP_CONTENT: ProcessStepContent = { label: '正在思考...' }

/**
 * 步骤组折叠行的当前文案（对应商业版 J8t）。
 *
 * - 有工具：活动中看最后一个块，非活动取最后一次工具调用，按工具状态给短语与输入摘要；
 * - 无工具且非活动：「已完成分析」，摘要取最后一段思考的第一行；
 * - 活动且最后一块是 thinking：空思考「正在思考...」，否则「正在分析」+ 思考最后一行；
 * - 其余：「正在思考...」。
 */
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
      summary: getToolInputSummary(tool.name, tool.input),
      reference: getToolReference(tool.name, tool.input) ?? undefined,
      markerTool: tool.name,
    }
  }
  const lastThinking = findLastThinkingText(blocks)
  if (!isActive) {
    const summary = lastThinking ? firstNonEmptyLine(lastThinking) : ''
    return summary ? { label: '已完成分析', summary } : { label: '已完成分析' }
  }
  if (isThinkingBlock(last)) {
    if (!lastThinking.trim()) return THINKING_STEP_CONTENT
    const summary = lastNonEmptyLine(lastThinking)
    return summary ? { label: '正在分析', summary } : { label: '正在分析' }
  }
  return THINKING_STEP_CONTENT
}
