import { describe, expect, test } from 'bun:test'
import { compareText } from './compare'

describe('turn-changes compareText', () => {
  test('内容相同返回空 hunks', () => {
    const result = compareText('a\nb\n', 'a\nb\n')
    expect(result.hunks).toEqual([])
    expect(result.coarse).toBe(false)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(0)
  })

  test('新增文件按整体新增统计', () => {
    const result = compareText(null, 'l1\nl2\nl3\n')
    expect(result.added).toBe(3)
    expect(result.deleted).toBe(0)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]?.lines).toEqual(['+l1', '+l2', '+l3'])
  })

  test('删除文件按整体删除统计', () => {
    const result = compareText('l1\nl2\n', null)
    expect(result.added).toBe(0)
    expect(result.deleted).toBe(2)
    expect(result.hunks[0]?.lines).toEqual(['-l1', '-l2'])
  })

  test('单行修改输出带上下文的 hunk 与增删计数', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')
    const after = ['one', 'two', 'three', 'FOUR', 'five', 'six', 'seven', 'eight'].join('\n')
    const result = compareText(before, after)

    expect(result.added).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.coarse).toBe(false)
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]
    expect(hunk?.lines).toContain('-four')
    expect(hunk?.lines).toContain('+FOUR')
    // 上下文行数两侧各 3 行
    expect(hunk?.lines.filter((line) => line.startsWith(' '))).toHaveLength(6)
    expect(hunk?.oldStart).toBe(1)
    expect(hunk?.newStart).toBe(1)
  })

  test('相距很远的改动拆成多个 hunk', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`)
    const before = lines.join('\n')
    const modified = [...lines]
    modified[1] = 'changed-2'
    modified[35] = 'changed-36'
    const result = compareText(before, modified.join('\n'))

    expect(result.added).toBe(2)
    expect(result.deleted).toBe(2)
    expect(result.hunks).toHaveLength(2)
  })

  test('超出格子上限退化为整体替换并标记 coarse', () => {
    const before = Array.from({ length: 30 }, (_, index) => `old-${index}`).join('\n')
    const after = Array.from({ length: 30 }, (_, index) => `new-${index}`).join('\n')
    const result = compareText(before, after, 10)

    expect(result.coarse).toBe(true)
    expect(result.added).toBe(30)
    expect(result.deleted).toBe(30)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]?.oldLines).toBe(30)
    expect(result.hunks[0]?.newLines).toBe(30)
  })

  test('CRLF 与 LF 视为同样内容', () => {
    const result = compareText('a\r\nb\r\n', 'a\nb\n')
    expect(result.hunks).toEqual([])
  })
})
