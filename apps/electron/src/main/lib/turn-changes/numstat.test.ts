import { describe, expect, test } from 'bun:test'
import { parseNumstat } from './numstat'

describe('turn-changes parseNumstat', () => {
  test('空输出返回空数组', () => {
    expect(parseNumstat('')).toEqual([])
  })

  test('解析普通增删记录', () => {
    const output = '3\t1\tsrc/a.ts\0'
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1, binary: false },
    ])
  })

  test('二进制文件记 0 行并标记 binary', () => {
    const output = '-\t-\tassets/logo.png\0'
    expect(parseNumstat(output)).toEqual([
      { path: 'assets/logo.png', added: 0, deleted: 0, binary: true },
    ])
  })

  test('解析重命名记录（旧路径 + 新路径）', () => {
    const output = '2\t0\t\0old/name.ts\0new/name.ts\0'
    expect(parseNumstat(output)).toEqual([
      { path: 'new/name.ts', oldPath: 'old/name.ts', added: 2, deleted: 0, binary: false },
    ])
  })

  test('多条记录按顺序解析', () => {
    const output = '1\t0\ta.ts\0-\t-\tb.bin\0'
    expect(parseNumstat(output).map((entry) => entry.path)).toEqual(['a.ts', 'b.bin'])
  })

  test('字段缺失时报错而不是静默丢掉记录', () => {
    expect(() => parseNumstat('broken\0')).toThrow()
  })
})
