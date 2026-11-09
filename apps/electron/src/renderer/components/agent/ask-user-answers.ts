/**
 * ask-user-answers — 历史消息中 AskUserQuestion 问答条目的解析
 *
 * 与商业版 0.22.0 一致：历史里的 AskUserQuestion 不再只当作一次普通工具调用，
 * 而是把「问题 → 用户回答」还原成问答条目，交给 AskUserAnswerCard 回显。
 *
 * 关键约定：
 * - 答案的唯一真源是工具结果里的 JSON（`{"answers": {问题文本: 回答文本}}`）；
 * - 工具结果缺失时回退到工具输入里的 `answers`
 *   （部分渠道把答案作为 updatedInput 写回 tool_use.input）；
 * - 工具结果 is_error、答案 JSON 损坏、整组问题都没有答案的，一律视为无有效回显，
 *   既不进入卡片，也不渲染空壳。
 *
 * 本模块只做纯数据解析，不依赖 React，便于单测覆盖各种损坏输入。
 */

import type { AskUserQuestion, SDKMessage, SDKToolResultBlock, SDKToolUseBlock } from '@proma/shared'

/** 一张回显卡片里的单条问答 */
export interface AskUserAnswerItem {
  question: string
  /** 问题短标签（存在时展示在问题前） */
  header?: string
  /** 用户回答；多选答案在提交侧已合并为一个字符串，这里保持单元素数组 */
  answers: string[]
  /** 用户未回答该题就继续了 */
  skipped: boolean
}

/** 一组已答问答（对应一次 AskUserQuestion 工具调用） */
export interface AskUserAnswerGroup {
  toolUseId: string
  items: AskUserAnswerItem[]
}

/** 卡片渲染所需的数据 */
export interface AskUserAnswerCardData {
  groups: AskUserAnswerGroup[]
  /** 复制按钮使用的整段纯文本表示 */
  plainText: string
}

/** 卡片输入：同一轮内连续已答的 AskUserQuestion 工具块 */
export interface AskUserAnswerCardBlock {
  toolUseId: string
  input: Record<string, unknown>
}

/** 选项标签里可能带的「推荐」后缀，展示时需剔除 */
const RECOMMENDATION_MARKER = /(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)/gi

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取消息里的内容块数组；SDKMessage 联合类型里的宽松成员不带 message，统一按结构访问 */
function getMessageContentBlocks(message: SDKMessage): readonly unknown[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? content : []
}

/** 工具结果 content 既可能是字符串，也可能是文本块数组，统一取纯文本 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => (
      isPlainRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('\n')
}

/**
 * 在消息流中查找 toolUseId 对应的工具结果。
 *
 * 工具结果只出现在 user 消息的 tool_result 块里，与 ContentBlock 的配对方式一致。
 */
export function findAskUserToolResult(
  allMessages: readonly SDKMessage[],
  toolUseId: string,
): { text: string; isError: boolean } | null {
  for (const message of allMessages) {
    if (message.type !== 'user') continue
    for (const block of getMessageContentBlocks(message)) {
      if (!isPlainRecord(block) || block.type !== 'tool_result') continue
      const resultBlock = block as unknown as SDKToolResultBlock
      if (resultBlock.tool_use_id !== toolUseId) continue
      return { text: extractToolResultText(resultBlock.content), isError: resultBlock.is_error === true }
    }
  }
  return null
}

/** 把 `{ answers: { 问题: 回答 } }` 归一成只含字符串值的记录；结构不符返回 null */
export function normalizeAskUserAnswerRecord(value: unknown): Record<string, string> | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.answers)) return null
  const record: Record<string, string> = {}
  for (const [question, answer] of Object.entries(value.answers)) {
    if (typeof answer === 'string') record[question] = answer
  }
  return record
}

/** 解析工具结果文本中的答案 JSON；空白或损坏时返回 null */
export function parseAskUserAnswerRecord(text: string | undefined): Record<string, string> | null {
  if (!text?.trim()) return null
  try {
    return normalizeAskUserAnswerRecord(JSON.parse(text))
  } catch {
    return null
  }
}

/** 从工具输入还原问题列表，与主进程 parseQuestions 的宽松解析保持一致 */
export function normalizeAskUserQuestions(input: Record<string, unknown> | undefined): AskUserQuestion[] {
  const rawQuestions = input?.questions
  if (!Array.isArray(rawQuestions)) return []

  return rawQuestions.map((raw): AskUserQuestion => {
    const question = isPlainRecord(raw) ? raw : {}
    const rawOptions = Array.isArray(question.options) ? question.options : []
    const options = rawOptions.map((rawOption) => {
      const option = isPlainRecord(rawOption) ? rawOption : {}
      return {
        label: typeof option.label === 'string' ? option.label : '',
        description: typeof option.description === 'string' ? option.description : undefined,
        preview: typeof option.preview === 'string' ? option.preview : undefined,
      }
    })
    return {
      question: typeof question.question === 'string' ? question.question : '',
      header: typeof question.header === 'string' ? question.header : undefined,
      options,
      multiSelect: question.multiSelect === true,
    }
  })
}

/**
 * 归一单条答案文本。
 *
 * 选项标签可能带「(推荐)」后缀，提交后会被原样写进答案，回显时需要剔除；
 * 同时压缩多余空格，避免多选拼接留下「A ,  B」这类空洞排版。
 */
export function normalizeAskUserAnswerText(raw: string): string {
  return raw
    .replace(RECOMMENDATION_MARKER, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .trim()
}

/**
 * 把答案记录匹配到问题上。
 *
 * 答案键既可能是问题文本，也可能是下标字符串（问题文本为空时提交侧会退化到下标）。
 */
export function buildAskUserAnswerItems(
  questions: readonly AskUserQuestion[],
  answers: Record<string, string>,
): AskUserAnswerItem[] {
  return questions.map((question, index) => {
    const raw = answers[question.question] ?? answers[String(index)]
    const normalized = normalizeAskUserAnswerText(raw?.trim() ?? '')
    const items = normalized ? [normalized] : []
    return {
      question: question.question,
      header: question.header,
      answers: items,
      skipped: items.length === 0,
    }
  })
}

/**
 * 还原一次 AskUserQuestion 的问答条目。
 *
 * 返回 null 的三种情况与商业版一致：工具结果 is_error、解析不到答案记录、
 * 整组问题都没答案（用户全部跳过）。只有部分题目跳过时仍然回显。
 */
export function buildAskUserAnswerGroup(
  toolUseId: string,
  input: Record<string, unknown> | undefined,
  allMessages: readonly SDKMessage[],
): AskUserAnswerGroup | null {
  const result = findAskUserToolResult(allMessages, toolUseId)
  if (result?.isError) return null

  const answers = parseAskUserAnswerRecord(result?.text)
    ?? normalizeAskUserAnswerRecord({ answers: isPlainRecord(input?.answers) ? input.answers : undefined })
  if (!answers) return null

  const questions = normalizeAskUserQuestions(input)
  if (questions.length === 0) return null

  const items = buildAskUserAnswerItems(questions, answers)
  return items.some((item) => !item.skipped) ? { toolUseId, items } : null
}

/**
 * 收集「已答」的 AskUserQuestion tool_use id。
 *
 * 轮次分区用这个集合把已答问答从执行过程里摘出来单独成卡片；
 * 未答（进行中或中断）的仍按普通工具行展示。
 */
export function collectAnsweredQuestionToolIds(allMessages: readonly SDKMessage[]): Set<string> {
  const askUserToolIds = new Set<string>()
  for (const message of allMessages) {
    if (message.type !== 'assistant') continue
    for (const block of getMessageContentBlocks(message)) {
      if (!isPlainRecord(block) || block.type !== 'tool_use') continue
      const toolBlock = block as unknown as SDKToolUseBlock
      if (toolBlock.name === 'AskUserQuestion') askUserToolIds.add(toolBlock.id)
    }
  }

  const answered = new Set<string>()
  if (askUserToolIds.size === 0) return answered

  for (const message of allMessages) {
    if (message.type !== 'user') continue
    for (const block of getMessageContentBlocks(message)) {
      if (!isPlainRecord(block) || block.type !== 'tool_result') continue
      const resultBlock = block as unknown as SDKToolResultBlock
      if (!askUserToolIds.has(resultBlock.tool_use_id) || resultBlock.is_error === true) continue
      const answers = parseAskUserAnswerRecord(extractToolResultText(resultBlock.content))
      if (answers && Object.keys(answers).length > 0) answered.add(resultBlock.tool_use_id)
    }
  }
  return answered
}

/** 纯文本表示：每个问题一行、回答一行，组之间空行分隔 */
export function formatAskUserAnswersPlainText(items: readonly AskUserAnswerItem[]): string {
  return items
    .map((item) => `${item.question}\n${item.skipped ? '（已跳过）' : item.answers.join('、')}`)
    .join('\n\n')
}

/**
 * 组装一张卡片的数据。
 *
 * blocks 应是同一轮内连续的已答 AskUserQuestion；无任何有效条目时返回 null，
 * 由调用方决定不渲染，避免出现空壳。
 */
export function buildAskUserAnswerCardData(
  blocks: readonly AskUserAnswerCardBlock[],
  allMessages: readonly SDKMessage[],
): AskUserAnswerCardData | null {
  const groups: AskUserAnswerGroup[] = []
  for (const block of blocks) {
    const group = buildAskUserAnswerGroup(block.toolUseId, block.input, allMessages)
    if (group) groups.push(group)
  }
  if (groups.length === 0) return null

  return {
    groups,
    plainText: groups.map((group) => formatAskUserAnswersPlainText(group.items)).join('\n\n'),
  }
}