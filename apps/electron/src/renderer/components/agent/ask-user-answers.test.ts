import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@proma/shared'
import {
  buildAskUserAnswerCardData,
  buildAskUserAnswerGroup,
  collectAnsweredQuestionToolIds,
  extractToolResultText,
  normalizeAskUserAnswerText,
  parseAskUserAnswerRecord,
} from './ask-user-answers'
import {
  buildAssistantTurnSections,
  collectAssistantTurnBodyEntries,
  type AssistantTurnSection,
} from './assistant-turn-sections'

function assistantToolUse(id: string, input: Record<string, unknown>, name = 'AskUserQuestion'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
    parent_tool_use_id: null,
  }
}

function assistantText(text: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    parent_tool_use_id: null,
  }
}

function userToolResult(toolUseId: string, content: unknown, isError = false): SDKUserMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    parent_tool_use_id: null,
  }
}

/** 构造一次 AskUserQuestion 的 tool_use + tool_result 消息对 */
function askUserRound(
  id: string,
  questions: Array<{ question: string; header?: string }>,
  answers: Record<string, string> | string,
  isError = false,
): SDKMessage[] {
  const input = { questions: questions.map((q) => ({ ...q, options: [] })) }
  const content = typeof answers === 'string' ? answers : JSON.stringify({ answers })
  return [assistantToolUse(id, input), userToolResult(id, content, isError)]
}

describe('AskUserQuestion 答案解析', () => {
  test('given 一次问答的工具结果 when 还原问答条目 then 按问题文本匹配答案', () => {
    const messages = askUserRound('tool-1', [
      { question: '用哪个分支？', header: '分支' },
      { question: '是否补单测？' },
    ], { '用哪个分支？': 'main', '是否补单测？': '需要' })

    const group = buildAskUserAnswerGroup('tool-1', { questions: [
      { question: '用哪个分支？', header: '分支', options: [] },
      { question: '是否补单测？', options: [] },
    ] }, messages)

    expect(group?.items).toEqual([
      { question: '用哪个分支？', header: '分支', answers: ['main'], skipped: false },
      { question: '是否补单测？', header: undefined, answers: ['需要'], skipped: false },
    ])
  })

  test('given 答案键退化为下标 when 还原问答条目 then 仍能按序号匹配', () => {
    const messages = askUserRound('tool-1', [{ question: '' }], { '0': '第一个答案' })

    const group = buildAskUserAnswerGroup('tool-1', { questions: [{ question: '', options: [] }] }, messages)

    expect(group?.items).toEqual([{ question: '', header: undefined, answers: ['第一个答案'], skipped: false }])
  })

  test('given 部分问题未回答 when 还原问答条目 then 该条标为已跳过', () => {
    const messages = askUserRound('tool-1', [{ question: 'A' }, { question: 'B' }], { A: '已选' })

    const group = buildAskUserAnswerGroup('tool-1', { questions: [
      { question: 'A', options: [] },
      { question: 'B', options: [] },
    ] }, messages)

    expect(group?.items[1]).toEqual({ question: 'B', header: undefined, answers: [], skipped: true })
  })

  test('given 全部问题都跳过 when 还原问答条目 then 返回 null 不渲染空壳', () => {
    const messages = askUserRound('tool-1', [{ question: 'A' }], {})

    expect(buildAskUserAnswerGroup('tool-1', { questions: [{ question: 'A', options: [] }] }, messages)).toBeNull()
  })

  test('given 工具结果 is_error when 还原问答条目 then 该组不进入卡片', () => {
    const messages = askUserRound('tool-1', [{ question: 'A' }], { A: '答案' }, true)

    expect(buildAskUserAnswerGroup('tool-1', { questions: [{ question: 'A', options: [] }] }, messages)).toBeNull()
  })

  test('given 答案 JSON 损坏 when 还原问答条目 then 回退到工具输入里的 answers', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { questions: [{ question: 'A', options: [] }] }),
      userToolResult('tool-1', '{"answers": {不是合法 JSON'),
    ]

    const group = buildAskUserAnswerGroup('tool-1', {
      questions: [{ question: 'A', options: [] }],
      answers: { A: '来自工具输入' },
    }, messages)

    expect(group?.items[0]?.answers).toEqual(['来自工具输入'])
  })

  test('given 答案 JSON 损坏且工具输入无 answers when 还原问答条目 then 返回 null', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { questions: [{ question: 'A', options: [] }] }),
      userToolResult('tool-1', 'not json at all'),
    ]

    expect(buildAskUserAnswerGroup('tool-1', { questions: [{ question: 'A', options: [] }] }, messages)).toBeNull()
  })

  test('given tool_use 没有对应工具结果 when 工具输入带 answers then 仍能回显', () => {
    const messages: SDKMessage[] = [assistantToolUse('tool-1', { questions: [{ question: 'A', options: [] }] })]

    const group = buildAskUserAnswerGroup('tool-1', {
      questions: [{ question: 'A', options: [] }],
      answers: { A: '写回输入的答案' },
    }, messages)

    expect(group?.items[0]?.answers).toEqual(['写回输入的答案'])
  })

  test('given tool_use 没有对应工具结果且无 answers when 还原问答条目 then 返回 null', () => {
    const messages: SDKMessage[] = [assistantToolUse('tool-1', { questions: [{ question: 'A', options: [] }] })]

    expect(buildAskUserAnswerGroup('tool-1', { questions: [{ question: 'A', options: [] }] }, messages)).toBeNull()
  })

  test('given 工具结果内容为文本块数组 when 解析 then 拼接文本后解析答案', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { questions: [{ question: 'A', options: [] }] }),
      userToolResult('tool-1', [{ type: 'text', text: '{"answers":' }, { type: 'text', text: '{"A":"数组内容"}}' }]),
    ]

    expect(extractToolResultText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }])).toBe('a')
    expect(buildAskUserAnswerGroup('tool-1', { questions: [{ question: 'A', options: [] }] }, messages)?.items[0]?.answers)
      .toEqual(['数组内容'])
  })

  test('given 答案带推荐后缀与多余空格 when 归一 then 剔除后缀并压缩空白', () => {
    expect(normalizeAskUserAnswerText('方案 A（推荐） ,   方案 B')).toBe('方案 A, 方案 B')
  })

  test('given 工具结果不是对象结构 when 解析 then 返回 null', () => {
    expect(parseAskUserAnswerRecord('')).toBeNull()
    expect(parseAskUserAnswerRecord('{"answers":"字符串"}')).toBeNull()
    expect(parseAskUserAnswerRecord('{"foo":1}')).toBeNull()
  })
})

describe('已答 AskUserQuestion 集合', () => {
  test('given 有答案的问答 when 收集已答 id then 只包含有效问答', () => {
    const messages: SDKMessage[] = [
      ...askUserRound('tool-answered', [{ question: 'A' }], { A: '答案' }),
      ...askUserRound('tool-error', [{ question: 'A' }], { A: '答案' }, true),
      ...askUserRound('tool-empty', [{ question: 'A' }], {}),
      assistantToolUse('tool-pending', { questions: [{ question: 'A', options: [] }] }),
    ]

    expect([...collectAnsweredQuestionToolIds(messages)]).toEqual(['tool-answered'])
  })

  test('given 没有 AskUserQuestion 工具调用 when 收集已答 id then 返回空集合', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { command: 'ls' }, 'Bash'),
      userToolResult('tool-1', 'ok'),
    ]

    expect(collectAnsweredQuestionToolIds(messages).size).toBe(0)
  })
})

describe('「你的回答」卡片数据', () => {
  test('given 连续两组已答问答 when 组装卡片数据 then 两组都保留并以空行分隔纯文本', () => {
    const messages: SDKMessage[] = [
      ...askUserRound('tool-1', [{ question: '第一组问题' }], { '第一组问题': '答案一' }),
      ...askUserRound('tool-2', [{ question: '第二组问题' }], { '第二组问题': '答案二' }),
    ]
    const blocks = [
      { toolUseId: 'tool-1', input: { questions: [{ question: '第一组问题', options: [] }] } },
      { toolUseId: 'tool-2', input: { questions: [{ question: '第二组问题', options: [] }] } },
    ]

    const data = buildAskUserAnswerCardData(blocks, messages)

    expect(data?.groups.map((group) => group.toolUseId)).toEqual(['tool-1', 'tool-2'])
    expect(data?.plainText).toBe('第一组问题\n答案一\n\n第二组问题\n答案二')
  })

  test('given 跳过与正常答案混排 when 组装卡片数据 then 纯文本用「（已跳过）」占位', () => {
    const messages = askUserRound('tool-1', [{ question: 'A' }, { question: 'B' }], { A: '已选' })
    const blocks = [{ toolUseId: 'tool-1', input: { questions: [{ question: 'A', options: [] }, { question: 'B', options: [] }] } }]

    expect(buildAskUserAnswerCardData(blocks, messages)?.plainText).toBe('A\n已选\n\nB\n（已跳过）')
  })

  test('given 全部组都无效 when 组装卡片数据 then 返回 null', () => {
    const messages: SDKMessage[] = [
      ...askUserRound('tool-1', [{ question: 'A' }], {}),
      ...askUserRound('tool-2', [{ question: 'B' }], { B: '答案' }, true),
    ]
    const blocks = [
      { toolUseId: 'tool-1', input: { questions: [{ question: 'A', options: [] }] } },
      { toolUseId: 'tool-2', input: { questions: [{ question: 'B', options: [] }] } },
    ]

    expect(buildAskUserAnswerCardData(blocks, messages)).toBeNull()
  })
})

describe('轮次分区与正文条目', () => {
  function buildSections(messages: SDKMessage[], answeredIds: Set<string>): AssistantTurnSection[] {
    const assistantMessages = messages.filter((message): message is SDKAssistantMessage => message.type === 'assistant')
    return buildAssistantTurnSections(
      assistantMessages.map((sourceMessage) => ({ block: sourceMessage.message.content[0]!, sourceMessage })),
      { messages: assistantMessages, answeredQuestionToolIds: answeredIds },
    ).items
  }

  test('given 已答问答 when 分区 then 从执行过程摘出并打断步骤组', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-bash', { command: 'ls' }, 'Bash'),
      userToolResult('tool-bash', 'ok'),
      ...askUserRound('tool-ask', [{ question: 'A' }], { A: '答案' }),
      assistantText('最终回答'),
    ]

    const sections = buildSections(messages, new Set(['tool-ask']))

    expect(sections.map((section) => section.type)).toEqual(['activity', 'question', 'block'])
    expect(collectAssistantTurnBodyEntries(sections).map((entry) => entry.type)).toEqual(['question', 'block'])
  })

  test('given 未答问答 when 分区 then 仍留在执行过程里', () => {
    const messages: SDKMessage[] = [assistantToolUse('tool-ask', { questions: [{ question: 'A', options: [] }] })]

    const sections = buildSections(messages, new Set())

    expect(sections.map((section) => section.type)).toEqual(['activity'])
    expect(collectAssistantTurnBodyEntries(sections)).toEqual([])
  })

  test('given 连续多组已答问答 when 归集正文条目 then 合并成同一张卡片', () => {
    const messages: SDKMessage[] = [
      ...askUserRound('tool-1', [{ question: 'A' }], { A: '答案一' }),
      ...askUserRound('tool-2', [{ question: 'B' }], { B: '答案二' }),
      assistantText('最终回答'),
    ]

    const entries = collectAssistantTurnBodyEntries(buildSections(messages, new Set(['tool-1', 'tool-2'])))

    expect(entries.map((entry) => entry.type)).toEqual(['question', 'block'])
    expect(entries[0]?.type === 'question' ? entries[0].entries.length : 0).toBe(2)
  })

  test('given 问答被正文隔开 when 归集正文条目 then 分成两张卡片', () => {
    const messages: SDKMessage[] = [
      ...askUserRound('tool-1', [{ question: 'A' }], { A: '答案一' }),
      assistantText('中间说明'),
      ...askUserRound('tool-2', [{ question: 'B' }], { B: '答案二' }),
    ]

    const sections = buildSections(messages, new Set(['tool-1', 'tool-2']))
    const entries = collectAssistantTurnBodyEntries(sections)

    expect(entries.filter((entry) => entry.type === 'question').length).toBe(2)
  })
})