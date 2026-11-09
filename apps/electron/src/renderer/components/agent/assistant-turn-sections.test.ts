import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage, SDKResultMessage, SDKUserMessage } from '@proma/shared'
import {
  buildAssistantTurnSections,
  findTrailingResult,
  formatLiveElapsed,
  formatTurnDuration,
  getProcessStepContent,
  getToolInputSummary,
  getToolStatusLabel,
  getTurnInterruptedDurationMs,
  getTurnLiveStartedAt,
  groupConsecutiveQuestions,
  splitTurnBodyAndProcess,
  type AssistantTurnSourceBlock,
} from './assistant-turn-sections'
import { hasLiveFinalOutput } from './scroll-follow'

function assistantText(text: string, stopReason = 'end_turn'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], stop_reason: stopReason },
    parent_tool_use_id: null,
  }
}

function assistantThinking(text: string, stopReason = 'tool_use'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: text }], stop_reason: stopReason },
    parent_tool_use_id: null,
  }
}

function assistantToolUse(id: string, input: Record<string, unknown>, name = 'Bash'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
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

function successResult(durationMs?: number): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(durationMs != null ? { _durationMs: durationMs } : {}),
  } as SDKResultMessage
}

function toSourceBlocks(messages: SDKMessage[]): AssistantTurnSourceBlock[] {
  const blocks: AssistantTurnSourceBlock[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of (message as SDKAssistantMessage).message.content) {
      blocks.push({ block: block as SDKContentBlock, sourceMessage: message as SDKAssistantMessage })
    }
  }
  return blocks
}

// ===== 分区 =====

describe('buildAssistantTurnSections', () => {
  test('given 思考 + 工具 + 最终回复 when 分区 then 保持原始顺序', () => {
    const messages: SDKMessage[] = [
      assistantThinking('先想一想'),
      assistantToolUse('tool-1', { command: 'ls' }),
      userToolResult('tool-1', 'ok'),
      assistantText('最终回复'),
      successResult(),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: findTrailingResult(messages),
    })

    expect(sections.items.map((section) => section.type)).toEqual(['activity', 'block'])
    expect(sections.failed).toBe(false)
    expect(sections.outputState).toBe('answer')
    // output 分区在原始顺序中的位置：thinking/tool 过程在前，最终回复在后
    const output = sections.items.at(-1)
    expect(output?.type === 'block' && output.output).toBe(true)
  })

  test('given 工具后有过程文字再有最终回复 when 分区 then 顺序为 activity → text → output', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { command: 'ls' }),
      userToolResult('tool-1', 'ok'),
      assistantText('中间说明'),
      assistantText('最终回复'),
      successResult(),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: findTrailingResult(messages),
    })

    // 中间说明与其后的最终回复都来自最后一条 assistant 消息：说明不是 output，
    // 最终回复是 output；顺序保持 message 内的块顺序
    expect(sections.items.map((section) => section.type)).toEqual(['activity', 'block', 'block'])
    const texts = sections.items.filter((s) => s.type === 'block') as Array<{ type: 'block'; item: { block: { text?: string } }; output?: boolean }>
    // '中间说明' 来自非最后一条 assistant 消息，不是最终输出
    expect(texts[0]?.output).toBeUndefined()
    expect(texts[0]?.item.block.text).toBe('中间说明')
    expect(texts[1]?.output).toBe(true)
    expect(texts[1]?.item.block.text).toBe('最终回复')
  })

  test('given 用户停止 when 分区 then failed 为真', () => {
    const messages: SDKMessage[] = [assistantText('写到一半')]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      stoppedByUser: true,
    })
    expect(sections.failed).toBe(true)
  })

  test('given result 异常 when 分区 then failed 与 interrupted 一致', () => {
    const messages: SDKMessage[] = [assistantText('部分输出'), successResult()]
    const failing = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: { type: 'result', subtype: 'error_during_execution', usage: { input_tokens: 0, output_tokens: 0 } } as SDKResultMessage,
    })
    expect(failing.failed).toBe(true)
  })
})

// ===== 正文 / 过程拆分 =====

describe('splitTurnBodyAndProcess', () => {
  test('given 有 output 分区 when 拆分 then 正文只含 output 与 question', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-1', { command: 'ls' }),
      userToolResult('tool-1', 'ok'),
      assistantText('最终回复'),
      successResult(),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: findTrailingResult(messages),
    })
    const { body, process } = splitTurnBodyAndProcess(sections.items, false)

    expect(body.map((entry) => entry.item.type)).toEqual(['block'])
    expect(process.map((entry) => entry.item.type)).toEqual(['activity'])
  })

  test('given 无 output 分区 when 拆分 then 正文取最后一段非空文字', () => {
    const messages: SDKMessage[] = [
      assistantText('第一段说明', 'tool_use'),
      assistantToolUse('tool-1', { command: 'ls' }),
      userToolResult('tool-1', 'ok'),
      assistantText('第二段说明', 'tool_use'),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
    })
    const { body, process } = splitTurnBodyAndProcess(sections.items, false)

    expect(body).toHaveLength(1)
    const entry = body[0]!
    expect(entry.item.type).toBe('block')
    expect(entry.item.type === 'block' && entry.item.item.block).toMatchObject({ type: 'text', text: '第二段说明' })
    expect(process.map((e) => e.item.type)).toEqual(['block', 'activity'])
  })

  test('given question 分区 when 拆分 then question 始终归正文', () => {
    const messages: SDKMessage[] = [
      assistantToolUse('tool-ask', { questions: [{ question: 'A', options: [] }] }, 'AskUserQuestion'),
      userToolResult('tool-ask', JSON.stringify({ answers: { A: '答案' } })),
      assistantText('最终回复'),
      successResult(),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: findTrailingResult(messages),
      answeredQuestionToolIds: new Set(['tool-ask']),
    })
    const { body } = splitTurnBodyAndProcess(sections.items, false)

    expect(body.map((entry) => entry.item.type)).toEqual(['question', 'block'])
  })

  test('given 会话存在已答问答 when 拆分 then 过程里的文字也归正文', () => {
    const messages: SDKMessage[] = [
      assistantText('中间说明', 'tool_use'),
      assistantToolUse('tool-1', { command: 'ls' }),
      userToolResult('tool-1', 'ok'),
      assistantText('最终回复'),
      successResult(),
    ]
    const sections = buildAssistantTurnSections(toSourceBlocks(messages), {
      messages: messages.filter((m): m is SDKAssistantMessage => m.type === 'assistant'),
      result: findTrailingResult(messages),
    })
    const withoutAnswered = splitTurnBodyAndProcess(sections.items, false)
    const withAnswered = splitTurnBodyAndProcess(sections.items, true)

    expect(withoutAnswered.body.map((entry) => entry.item.type)).toEqual(['block'])
    expect(withAnswered.body.map((entry) => entry.item.type)).toEqual(['block', 'block'])
  })
})

// ===== 问答合并 =====

describe('groupConsecutiveQuestions', () => {
  test('given 相邻 question 条目 when 分组 then 合并成一组', () => {
    const question = (index: number) => ({
      item: { type: 'question' as const, item: { block: { type: 'tool_use' as const, id: `tool-${index}`, name: 'AskUserQuestion', input: {} }, index } },
      itemIndex: index,
    })
    const groups = groupConsecutiveQuestions([question(0), question(1), question(2)])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind).toBe('questions')
    expect(groups[0]?.kind === 'questions' && groups[0].entries).toHaveLength(3)
  })

  test('given 被其他条目隔开的 question when 分组 then 各自成组', () => {
    const question = (index: number) => ({
      item: { type: 'question' as const, item: { block: { type: 'tool_use' as const, id: `tool-${index}`, name: 'AskUserQuestion', input: {} }, index } },
      itemIndex: index,
    })
    const block = (index: number) => ({
      item: { type: 'block' as const, item: { block: { type: 'text' as const, text: '正文' }, index } },
      itemIndex: index,
    })
    const groups = groupConsecutiveQuestions([question(0), block(1), question(2)])
    expect(groups.map((group) => group.kind)).toEqual(['questions', 'entry', 'questions'])
  })

  test('given 单个 question when 分组 then 也是 questions 组', () => {
    const question = { item: { type: 'question' as const, item: { block: { type: 'tool_use' as const, id: 'tool-0', name: 'AskUserQuestion', input: {} }, index: 0 } }, itemIndex: 0 }
    const groups = groupConsecutiveQuestions([question])
    expect(groups[0]?.kind).toBe('questions')
  })
})

// ===== 步骤文案 =====

describe('getProcessStepContent', () => {
  test('given 活动且最后一块是工具 when 取文案 then running 状态 + 输入摘要', () => {
    const content = getProcessStepContent(
      [{ type: 'thinking', thinking: '想一想' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la\necho hi' } }],
      true,
    )
    expect(content.label).toBe('正在执行命令')
    expect(content.summary).toBe('ls -la')
    expect(content.markerTool).toBe('Bash')
  })

  test('given 非活动且最后工具已完成 when 取文案 then 0.22.0 完成态措辞', () => {
    const content = getProcessStepContent(
      [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.txt' } }],
      false,
      new Set(['t1']),
    )
    expect(content.label).toBe('读取了文件')
    expect(content.summary).toBe('/tmp/a.txt')
  })

  test('given 非活动且只有思考 when 取文案 then 已完成分析 + 思考第一行', () => {
    const content = getProcessStepContent(
      [{ type: 'thinking', thinking: '第一行分析\n第二行分析' }],
      false,
    )
    expect(content).toEqual({ label: '已完成分析', summary: '第一行分析' })
  })

  test('given 活动且最后一块是思考 when 取文案 then 正在分析 + 思考最后一行', () => {
    const content = getProcessStepContent(
      [{ type: 'thinking', thinking: '第一行分析\n第二行分析' }],
      true,
    )
    expect(content).toEqual({ label: '正在分析', summary: '第二行分析' })
  })

  test('given 活动且思考为空 when 取文案 then 正在思考...', () => {
    const content = getProcessStepContent([{ type: 'thinking', thinking: '  ' }], true)
    expect(content).toEqual({ label: '正在思考...' })
  })

  test('given 空步骤组 when 取文案 then 正在思考...', () => {
    expect(getProcessStepContent([], true)).toEqual({ label: '正在思考...' })
    expect(getProcessStepContent([], false)).toEqual({ label: '已完成分析' })
  })
})

// ===== 工具输入摘要 =====

describe('getToolInputSummary', () => {
  test('given 字段优先级 when 取摘要 then 按表顺序取第一个非空字段', () => {
    expect(getToolInputSummary('Bash', { command: 'echo hi', description: '列目录' })).toBe('列目录')
    expect(getToolInputSummary('Bash', { command: 'echo hi' })).toBe('echo hi')
    expect(getToolInputSummary('Read', { file_path: '/a/b.txt', path: '/c/d.txt' })).toBe('/c/d.txt')
  })

  test('given 表中没有命中 when 取摘要 then 兜底取第一个非空字符串值', () => {
    expect(getToolInputSummary('UnknownTool', { foo: 123, bar: '内容', baz: '第二个' })).toBe('内容')
  })

  test('given 用户目录路径 when 取摘要 then 缩写为 ~', () => {
    expect(getToolInputSummary('Read', { file_path: '/Users/sunq/GitHub/Proma/a.txt' })).toBe('~/GitHub/Proma/a.txt')
    expect(getToolInputSummary('Read', { file_path: '/home/alice/work/b.txt' })).toBe('~/work/b.txt')
    expect(getToolInputSummary('Write', { file_path: 'C:\\Users\\bob\\c.txt' })).toBe('~\\c.txt')
  })

  test('given 多行命令 when 取摘要 then 只取第一行非空文本', () => {
    expect(getToolInputSummary('Bash', { command: '\n  echo hi\necho bye' })).toBe('echo hi')
  })

  test('given Skill / MCP 引用 when 取摘要 then 返回 undefined', () => {
    expect(getToolInputSummary('Skill', { skill: 'my-skill' })).toBeUndefined()
    expect(getToolInputSummary('mcp__server__tool', { query: 'x' })).toBeUndefined()
  })
})

// ===== 工具状态短语 =====

describe('getToolStatusLabel', () => {
  test('given 完成态 when 取措辞 then 使用 0.22.0「动词 + 了」', () => {
    expect(getToolStatusLabel('Read', {}, 'completed')).toBe('读取了文件')
    expect(getToolStatusLabel('Bash', {}, 'completed')).toBe('执行了命令')
    expect(getToolStatusLabel('MultiEdit', {}, 'completed')).toBe('文件编辑完成')
    expect(getToolStatusLabel('EnterPlanMode', {}, 'completed')).toBe('进入了计划模式')
    expect(getToolStatusLabel('AskUserQuestion', {}, 'completed')).toBe('收到了你的选择')
    expect(getToolStatusLabel('TaskCreate', {}, 'completed')).toBe('创建了任务')
    expect(getToolStatusLabel('TaskUpdate', {}, 'completed')).toBe('更新了任务进度')
    expect(getToolStatusLabel('TaskGet', {}, 'completed')).toBe('查看了任务详情')
    expect(getToolStatusLabel('TaskList', {}, 'completed')).toBe('查看了任务列表')
  })

  test('given Skill / MCP 引用 when 取措辞 then 完成态为「调用了 …」', () => {
    expect(getToolStatusLabel('Skill', { skill: 'demo' }, 'completed')).toBe('调用了 Skill')
    expect(getToolStatusLabel('mcp__srv__tool', {}, 'completed')).toBe('调用了 MCP')
    expect(getToolStatusLabel('mcp__srv__tool', {}, 'running')).toBe('正在调用 MCP')
  })

  test('given 三态 when 取措辞 then running/failed/incomplete 措辞不变', () => {
    expect(getToolStatusLabel('Read', {}, 'running')).toBe('正在读取文件')
    expect(getToolStatusLabel('Read', {}, 'failed')).toBe('文件读取失败')
    expect(getToolStatusLabel('Read', {}, 'incomplete')).toBe('文件读取未完成')
  })
})

// ===== 耗时格式 =====

describe('formatTurnDuration', () => {
  test('given 边界值 when 格式化 then 与 0.22.0 一致', () => {
    expect(formatTurnDuration(undefined)).toBeUndefined()
    expect(formatTurnDuration(59_900)).toBe('59.9 秒')
    expect(formatTurnDuration(60_000)).toBe('1 分 00 秒')
    expect(formatTurnDuration(3_599_000)).toBe('59 分 59 秒')
    expect(formatTurnDuration(3_600_000)).toBe('60 分 00 秒')
  })
})

describe('formatLiveElapsed', () => {
  test('given 边界值 when 格式化 then 与 0.22.0 一致', () => {
    expect(formatLiveElapsed(undefined)).toBeUndefined()
    expect(formatLiveElapsed(59_900)).toBe('59 秒')
    expect(formatLiveElapsed(60_000)).toBe('1 分 00 秒')
    expect(formatLiveElapsed(3_599_000)).toBe('59 分 59 秒')
    expect(formatLiveElapsed(3_600_000)).toBe('1 小时 00 分')
  })
})

// ===== 轮次计时 =====

describe('轮次起始时间与打断耗时', () => {
  test('given 运行中 when 取起始时间 then 输入消息 _createdAt 优先', () => {
    const turn = {
      inputMessage: { type: 'user', _createdAt: 1000 } as unknown as SDKUserMessage,
      createdAt: 2000,
    }
    expect(getTurnLiveStartedAt(turn)).toBe(1000)
    expect(getTurnLiveStartedAt({ inputMessage: undefined, createdAt: 2000 })).toBe(2000)
  })

  test('given 打断时间 when 计算耗时 then 打断时间 − 起算时间', () => {
    const turn = { inputMessage: undefined, createdAt: 1000 }
    expect(getTurnInterruptedDurationMs(turn, 5000)).toBe(4000)
    expect(getTurnInterruptedDurationMs(turn, 500)).toBeUndefined()
    expect(getTurnInterruptedDurationMs(turn, null)).toBeUndefined()
    expect(getTurnInterruptedDurationMs(turn, undefined)).toBeUndefined()
  })
})

// ===== 滚动跟随 =====

describe('hasLiveFinalOutput', () => {
  const liveMessage = (overrides: Record<string, unknown>): SDKMessage => ({
    type: 'assistant',
    parent_tool_use_id: null,
    _promaLiveRunStartedAt: 1,
    message: { content: [], stop_reason: 'end_turn' },
    ...overrides,
  } as unknown as SDKMessage)

  test('given 无 assistant 消息 when 判断 then false', () => {
    expect(hasLiveFinalOutput([], 1)).toBe(false)
    expect(hasLiveFinalOutput([userToolResult('t', 'ok')], 1)).toBe(false)
  })

  test('given 有 final_answer 文本 when 判断 then true', () => {
    const message = liveMessage({
      message: { content: [{ type: 'text', text: '答案', phase: 'final_answer' }], stop_reason: 'end_turn' },
    })
    expect(hasLiveFinalOutput([message], 1)).toBe(true)
  })

  test('given 带 error / _partial / tool_use when 判断 then false', () => {
    const base = { message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'end_turn' } }
    expect(hasLiveFinalOutput([liveMessage({ ...base, error: { message: 'x' } })], 1)).toBe(false)
    expect(hasLiveFinalOutput([liveMessage({ ...base, _partial: true })], 1)).toBe(false)
    expect(hasLiveFinalOutput([liveMessage({
      message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'end_turn' },
    })], 1)).toBe(false)
  })

  test('given stop_reason 非 stop/end_turn when 判断 then false', () => {
    const message = liveMessage({
      message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'max_tokens' },
    })
    expect(hasLiveFinalOutput([message], 1)).toBe(false)
  })

  test('given 只有 commentary 文本 when 判断 then false', () => {
    const message = liveMessage({
      message: { content: [{ type: 'text', text: '过程', phase: 'commentary' }], stop_reason: 'end_turn' },
    })
    expect(hasLiveFinalOutput([message], 1)).toBe(false)
  })

  test('given 无 phase 的普通文本 + stop when 判断 then true', () => {
    const message = liveMessage({
      message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'stop' },
    })
    expect(hasLiveFinalOutput([message], 1)).toBe(true)
  })

  test('given runStartedAt 不匹配 when 判断 then 忽略该消息', () => {
    const message = liveMessage({
      _promaLiveRunStartedAt: 42,
      message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'stop' },
    })
    expect(hasLiveFinalOutput([message], 1)).toBe(false)
    expect(hasLiveFinalOutput([message], 42)).toBe(true)
    expect(hasLiveFinalOutput([message], undefined)).toBe(true)
  })

  test('given 重放或子代理消息 when 判断 then 忽略', () => {
    const replay = liveMessage({
      isReplay: true,
      message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'stop' },
    })
    const child = liveMessage({
      parent_tool_use_id: 'parent-1',
      message: { content: [{ type: 'text', text: '答案' }], stop_reason: 'stop' },
    })
    expect(hasLiveFinalOutput([replay], undefined)).toBe(false)
    expect(hasLiveFinalOutput([child], undefined)).toBe(false)
  })
})
