import { describe, expect, test } from 'bun:test'
import {
  buildQuotedSelectionBlock,
  parseQuotedSelectionMention,
  parseQuotedSelectionRefs,
  replaceAgentHistoryQuoteMentionsWithLabels,
  serializeQuotedSelectionMention,
} from './quoted-selection'

const FILE_QUOTE_BLOCK = '<quoted_file path="/Users/me/notes.md">\n重点结论写在第二段。\n</quoted_file>\n\n'

function buildHistoryBlock(): string {
  return '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="msg-1" role="assistant" turn="3" selection_start="586" selection_end="646">\n列表里有的 Agent 不需要在这里添加。\n</quoted_context>\n\n'
}

describe('选区引用的内联展示', () => {
  test('Given 文件选区夹在句子中间 When inlineQuotes=all Then chip 留在原位置并可解析回引用', () => {
    const content = `前文${FILE_QUOTE_BLOCK}后文`

    const { quotes, text } = parseQuotedSelectionRefs(content, { inlineQuotes: 'all' })

    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ sourceType: 'file', filename: 'notes.md' })
    expect(quotes[0]?.quote?.text).toBe('重点结论写在第二段。')
    expect(text.startsWith('前文&quote:')).toBe(true)
    expect(text.endsWith('后文')).toBe(true)
    expect(text).not.toContain('<quoted_file')

    const marker = text.slice('前文'.length, text.length - '后文'.length)
    expect(parseQuotedSelectionMention(marker)).toMatchObject({
      sourceType: 'file',
      filePath: '/Users/me/notes.md',
      text: '重点结论写在第二段。',
    })
  })

  test('Given 历史引用 When inlineQuotes=all Then 仍保留可定位字段', () => {
    const { text } = parseQuotedSelectionRefs(buildHistoryBlock(), { inlineQuotes: 'all' })

    const quote = parseQuotedSelectionMention(text)
    expect(quote).toMatchObject({
      sourceType: 'agent-history',
      messageId: 'msg-1',
      turn: 3,
      selectionStart: 586,
      selectionEnd: 646,
    })
  })

  test('Given 没有开启内联 When 解析 Then 仍按旧行为剥离引用块（Chat 模式不受影响）', () => {
    const content = `前文${FILE_QUOTE_BLOCK}后文`

    const { quotes, text } = parseQuotedSelectionRefs(content)

    expect(quotes).toHaveLength(1)
    expect(text).toBe('前文后文')
  })

  test('Given inlineQuotes=agent-history When 遇到文件选区 Then 文件引用仍被剥离', () => {
    const content = `前文${FILE_QUOTE_BLOCK}后文`

    const { text } = parseQuotedSelectionRefs(content, { inlineQuotes: 'agent-history' })

    expect(text).toBe('前文后文')
  })

  test('Given 内联后的消息 When 复制为纯文本 Then 输出 chip 文案而不是内部 payload', () => {
    const content = `前文${FILE_QUOTE_BLOCK}后文`
    const { text } = parseQuotedSelectionRefs(content, { inlineQuotes: 'all' })

    const copyText = replaceAgentHistoryQuoteMentionsWithLabels(text)

    expect(copyText).toBe('前文notes.md：重点结论写在第二段。后文')
  })

  test('Given 引用正文含 * 和 _ When 生成展示 marker Then 不产生 Markdown 强调定界符且可原样还原', () => {
    const content = '<quoted_file path="/Users/me/code.py">\nif snake_case * factor * 2:\n</quoted_file>\n\n'

    const { text } = parseQuotedSelectionRefs(content, { inlineQuotes: 'all' })

    expect(text).not.toContain('*')
    expect(text).not.toContain('_')
    expect(parseQuotedSelectionMention(text)).toMatchObject({
      sourceType: 'file',
      text: 'if snake_case * factor * 2:',
    })
  })

  test('Given 草稿里的文件引用 marker When 展开为发送文本 Then 还原为 quoted_file 块', () => {
    const quote = {
      text: '重点结论写在第二段。',
      filePath: '/Users/me/notes.md',
      sourceType: 'file' as const,
      sourceLabel: '/Users/me/notes.md',
      capturedAt: 0,
    }

    const marker = serializeQuotedSelectionMention(quote)
    expect(marker).not.toBeNull()
    expect(buildQuotedSelectionBlock(parseQuotedSelectionMention(marker!)!)).toContain('<quoted_file path="/Users/me/notes.md">')
  })
})
