import { describe, expect, test } from 'vitest'
import { stripMessageForTitle } from './bridge-attachment-utils'

describe('stripMessageForTitle', () => {
  test('Given 附件块 + 正文 When 剥离 Then 保留正文', () => {
    const msg = [
      '<attached_files>',
      '- image.png: /tmp/image.png',
      '</attached_files>',
      '',
      '工作区Proma的Cursor渠道支持这么多模型？',
    ].join('\n')

    expect(stripMessageForTitle(msg)).toBe('工作区Proma的Cursor渠道支持这么多模型？')
  })

  test('Given 仅附件无正文 When 剥离 Then 回退为文件名（去扩展名）', () => {
    const msg = [
      '<attached_files>',
      '- screenshot.png: /tmp/screenshot.png',
      '</attached_files>',
      '',
    ].join('\n')

    expect(stripMessageForTitle(msg)).toBe('screenshot')
  })

  test('Given 含 quoted_file When 剥离 Then 去掉引用块', () => {
    const msg = [
      '<quoted_file path="/a/b.ts">code</quoted_file>',
      '',
      '解释这段代码',
    ].join('\n')

    expect(stripMessageForTitle(msg)).toBe('解释这段代码')
  })

  test('Given 飞书桥完整 XML When 剥离 Then 保留 user_message 正文', () => {
    const msg = [
      '<!-- bridge prelude -->',
      '<bridge_context>',
      'chat_id: oc_abc',
      'chat_type: group',
      '</bridge_context>',
      '<group_extra>[群聊: Test]</group_extra>',
      '<user_message>开始优化吧</user_message>',
    ].join('\n')

    expect(stripMessageForTitle(msg)).toBe('开始优化吧')
  })
})
