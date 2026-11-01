import { describe, expect, test } from 'bun:test'
import { extractMentionLabels, stripMentionMarkers } from './mention-text'
import { createFallbackTitle, MAX_TITLE_LENGTH, sanitizeGeneratedTitle } from './title-generation'

const SESSION_MARKER = '&session:b31ee7c1-f28e-403e-911c-0095f845c919::Proma%E6%80%9D%E8%80%83%E5%BC%BA%E5%BA%A6'

describe('mention 标记处理', () => {
  test('Given 会话引用标记后接正文 When 剥离 Then 只保留用户正文', () => {
    expect(stripMentionMarkers(`${SESSION_MARKER} 看一下这个会话的内容，你建议怎么改？`))
      .toBe('看一下这个会话的内容，你建议怎么改？')
  })

  test('Given 无空格的 Skill 标记 When 剥离 Then 不会吞掉后面的中文正文', () => {
    expect(stripMentionMarkers('/skill:follow-builders帮我收集下最新的AI观点'))
      .toBe('帮我收集下最新的AI观点')
  })

  test('Given 文件引用 When 剥离 Then 去掉编码路径且保留正文', () => {
    expect(stripMentionMarkers('@file:%2FUsers%2Fme%2FMy%20report.pdf 分析这份报告'))
      .toBe('分析这份报告')
  })

  test('Given 只有引用没有正文 When 取标签 Then 返回可读标签', () => {
    expect(extractMentionLabels(SESSION_MARKER)).toEqual(['Proma思考强度'])
    expect(extractMentionLabels('@file:%2FUsers%2Fme%2Freport.pdf')).toEqual(['report.pdf'])
    expect(extractMentionLabels('&session:b31ee7c1-f2')).toEqual([])
  })
})

describe('兜底标题', () => {
  test('Given 首条消息以会话引用开头 When 生成兜底标题 Then 不出现标记前缀', () => {
    expect(createFallbackTitle(`${SESSION_MARKER} 看一下这个会话的内容，你建议怎么改？`))
      .toBe('看一下这个会话的内容，你建议怎么改？')
  })

  test('Given 首条消息只有引用 When 生成兜底标题 Then 使用引用标签', () => {
    expect(createFallbackTitle(SESSION_MARKER)).toBe('Proma思考强度')
  })

  test('Given 普通消息 When 生成兜底标题 Then 截断到最大长度', () => {
    const title = createFallbackTitle('帮我排查一下构建失败的原因，顺便看看依赖是否需要升级')
    expect(title).toBe('帮我排查一下构建失败的原因，顺便看看依赖')
    expect(title?.length).toBe(MAX_TITLE_LENGTH)
  })

  test('Given 空白消息 When 生成兜底标题 Then 返回 null 而不是空串', () => {
    expect(createFallbackTitle('   \n  ')).toBeNull()
    expect(createFallbackTitle('&session:b31ee7c1-f2')).toBeNull()
  })
})

describe('模型标题清理', () => {
  test('Given 模型把原始消息当成标题回传 When 清理 Then 剥离标记并截断', () => {
    expect(sanitizeGeneratedTitle(`${SESSION_MARKER} 看一下这个会话的内容，你建议怎么改？`))
      .toBe('看一下这个会话的内容，你建议怎么改？')
  })

  test('Given 标题带引号 When 清理 Then 去掉首尾标点', () => {
    expect(sanitizeGeneratedTitle('“会话标题排查”')).toBe('会话标题排查')
  })

  test('Given 内容块数组 When 清理 Then 拼接文本块', () => {
    expect(sanitizeGeneratedTitle([{ type: 'text', text: '会话标' }, { type: 'text', text: '题排查' }]))
      .toBe('会话标题排查')
  })

  test('Given 只有标记没有正文 When 清理 Then 返回 null', () => {
    expect(sanitizeGeneratedTitle('&session:b31ee7c1-f2')).toBeNull()
  })
})
