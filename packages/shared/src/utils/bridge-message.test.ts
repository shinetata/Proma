import { describe, expect, test } from 'bun:test'
import { stripPromaInjectedBlocks } from './bridge-message'

describe('stripPromaInjectedBlocks', () => {
  test('Given 完整飞书桥消息 When 剥离 Then 仅保留 user_message 正文', () => {
    const raw = [
      '<!-- bridge prelude -->',
      '',
      '<bridge_context>',
      'chat_id: oc_abc',
      'chat_type: group',
      'sender_id: ou_xyz',
      'sender_name: sunQ',
      '</bridge_context>',
      '',
      '<group_extra>',
      '[群聊: Test Group] [发送者: sunQ]',
      '--- 群聊历史消息（最近） ---',
      '[10:00] sunQ: hello',
      '--- 历史消息结束 ---',
      '</group_extra>',
      '',
      '<user_message>',
      '开始优化吧',
      '</user_message>',
    ].join('\n')

    expect(stripPromaInjectedBlocks(raw)).toBe('开始优化吧')
  })

  test('Given 带属性的 quoted_message When 剥离 Then 去掉引用块', () => {
    const raw = [
      '<quoted_message id="om_123" sender_name="Bot" type="text">',
      '被引用的内容',
      '</quoted_message>',
      '',
      '<user_message>请解释上面</user_message>',
    ].join('\n')

    expect(stripPromaInjectedBlocks(raw)).toBe('请解释上面')
  })

  test('Given 桌面端 attached_files When 剥离 Then 保留正文', () => {
    const raw = '<attached_files>\n- screenshot.png: /tmp/a.png\n</attached_files>\n\n请分析这张图'
    expect(stripPromaInjectedBlocks(raw)).toBe('请分析这张图')
  })

  test('Given 桌面端 quoted_file When 剥离 Then 保留正文', () => {
    const raw = '<quoted_file path="/a/b.ts">code</quoted_file>\n\n解释这段代码'
    expect(stripPromaInjectedBlocks(raw)).toBe('解释这段代码')
  })

  test('Given interactive_card When 剥离 Then 不残留 JSON', () => {
    const raw = [
      '<interactive_card>',
      '{"header":{"title":"test"}}',
      '</interactive_card>',
      '<user_message>总结卡片</user_message>',
    ].join('\n')

    expect(stripPromaInjectedBlocks(raw)).toBe('总结卡片')
  })
})
