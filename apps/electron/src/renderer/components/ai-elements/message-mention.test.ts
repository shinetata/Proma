import { describe, expect, test } from 'bun:test'
import { remarkMentions } from './message'

interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: MdastNode[]
}

/** 用最小 mdast 树驱动 remark 插件，验证引用 marker 在文本中的位置没有被移动。 */
function runRemarkMentions(text: string): MdastNode[] {
  const tree: MdastNode = blankNode()
  const paragraph: MdastNode = { type: 'paragraph', children: [{ type: 'text', value: text }] }
  tree.children = [paragraph]
  remarkMentions()(tree as never)
  return paragraph.children ?? []
}

function blankNode(): MdastNode {
  return { type: 'root', children: [] }
}

function visibleOrder(nodes: MdastNode[]): string[] {
  return nodes.map((node) => {
    if (node.type === 'link' && node.url) return node.url
    return node.value ?? node.type
  })
}

describe('消息内联引用渲染', () => {
  test('Given 引用与文件引用夹在句中 When 渲染 Then 按原顺序转为 mention link', () => {
    const quoteMarker = '&quote:%7B%22version%22%3A2%2C%22text%22%3A%22hello%22%2C%22filePath%22%3A%22%2Ftmp%2Fa.md%22%2C%22sourceType%22%3A%22file%22%7D'
    const fileMarker = '@file:%2Ftmp%2Fimage-8.png'

    const nodes = runRemarkMentions(`前文${quoteMarker}中间${fileMarker}后文`)

    expect(visibleOrder(nodes)).toEqual([
      '前文',
      // marker 已编码，插件不会重复编码
      `mention://quote/${quoteMarker.slice('&quote:'.length)}`,
      '中间',
      `mention://file/${fileMarker.slice('@file:'.length)}`,
      '后文',
    ])
  })

  test('Given 引用在句首 When 渲染 Then chip 仍在句首而不是被移到消息顶部', () => {
    const quoteMarker = '&quote:%7B%22version%22%3A2%2C%22text%22%3A%22hello%22%2C%22filePath%22%3A%22%2Ftmp%2Fa.md%22%2C%22sourceType%22%3A%22file%22%7D'

    const nodes = runRemarkMentions(`${quoteMarker}后面的正文`)

    expect(nodes[0]?.type).toBe('link')
    expect(nodes[1]?.value).toBe('后面的正文')
  })
})