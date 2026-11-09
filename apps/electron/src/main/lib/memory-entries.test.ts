/**
 * 记忆单行条目操作：判重、锚点插入、多匹配报错与跳过回报。
 *
 * 这些断言锁住 `MemoryUpdate` 的 operations 语义，避免误改或丢内容。
 */

import { describe, expect, test } from 'bun:test'
import {
  applyMemoryEntryOperations,
  entryLine,
  indexOfMatches,
  insertPosition,
  normalizeEntryText,
} from './memory-entries'

const BASE = `# 全局用户画像

## 角色与技术背景

- Q sun，MemOS 产品负责人。
- 具备代码级技术判断力（来源：memos，2026-07-21）。

## 待确认

- 用户岗位与团队规模：尚无记录。
`

describe('条目规范化', () => {
  test('去掉 bullet、来源注记、标点与大小写', () => {
    expect(normalizeEntryText('- Foo Bar（来源：memos，2026-09-19）')).toBe('foobar')
    expect(normalizeEntryText('* 具备代码级技术判断力。')).toBe('具备代码级技术判断力')
    expect(normalizeEntryText('- ABC, def')).toBe('abcdef')
  })

  test('entryLine 补 bullet 并拒绝空内容与多行', () => {
    expect(entryLine('新增事实')).toBe('- 新增事实')
    expect(entryLine('- 已有 bullet')).toBe('- 已有 bullet')
    expect(() => entryLine('   ')).toThrow('条目内容不能为空')
    expect(() => entryLine('第一行\n第二行')).toThrow('一次只能操作一个单行条目')
  })
})

describe('匹配与插入位置', () => {
  test('先精确包含再规范化全等匹配', () => {
    const lines = BASE.split('\n')
    expect(indexOfMatches(lines, 'MemOS 产品负责人')).toHaveLength(1)
    // 带来源注记的整行与去掉注记后的文本都能匹配。
    expect(indexOfMatches(lines, '具备代码级技术判断力')).toHaveLength(1)
    expect(indexOfMatches(lines, '不存在的条目')).toHaveLength(0)
  })

  test('非条目行不参与匹配', () => {
    const lines = ['# 标题', '- 一条', '普通文本']
    expect(indexOfMatches(lines, '标题')).toHaveLength(0)
  })

  test('after 锚点唯一定位时插在其后，多条匹配报错', () => {
    const lines = ['- A', '- B', '- A 的补充'].map((line) => line)
    expect(insertPosition(lines, 'B')).toBe(2)
    expect(() => insertPosition([...lines, '- B 之二'], 'B')).toThrow('after 匹配到多条条目')
  })

  test('无锚点追加到最后一个条目之后', () => {
    expect(insertPosition(['# 标题', '- A', '', '结尾说明'])).toBe(2)
    expect(insertPosition(['# 标题'])).toBe(1)
  })
})

describe('批量条目操作', () => {
  test('add 插入并回报 changes；重复条目录入 skipped', () => {
    const result = applyMemoryEntryOperations(BASE, [{ op: 'add', entry: '重视可验证性' }])
    expect(result.content).toContain('- 重视可验证性')
    expect(result.changes).toEqual([{ op: 'add', entry: '- 重视可验证性' }])
    expect(result.skipped).toEqual([])

    const duplicate = applyMemoryEntryOperations(result.content, [{ op: 'add', entry: '重视可验证性' }])
    expect(duplicate.changes).toEqual([])
    expect(duplicate.skipped).toEqual([{ op: 'add', reason: 'duplicate', entry: '- 重视可验证性' }])
    // 规范化后相同（含来源注记差异）也视为重复。
    expect(
      applyMemoryEntryOperations(result.content, [{ op: 'add', entry: '重视可验证性（来源：memos）' }]).skipped[0]?.reason,
    ).toBe('duplicate')
  })

  test('update 替换唯一匹配，未命中记 not-found 而不是抛错', () => {
    const result = applyMemoryEntryOperations(BASE, [
      { op: 'update', match: '用户岗位与团队规模', entry: '用户岗位：产品负责人。' },
    ])
    expect(result.content).toContain('- 用户岗位：产品负责人。')
    expect(result.content).not.toContain('尚无记录')
    expect(result.changes).toEqual([{ op: 'update', entry: '- 用户岗位：产品负责人。' }])

    const missing = applyMemoryEntryOperations(BASE, [{ op: 'update', match: '不存在', entry: '新内容' }])
    expect(missing.content).toBe(BASE)
    expect(missing.skipped).toEqual([{ op: 'update', reason: 'not-found', entry: '不存在' }])
  })

  test('remove 删除唯一匹配，多匹配默认报错，all 可全删', () => {
    const result = applyMemoryEntryOperations(BASE, [{ op: 'remove', match: 'MemOS 产品负责人' }])
    expect(result.content).not.toContain('MemOS 产品负责人')
    expect(result.changes[0]?.op).toBe('remove')

    const ambiguous = '- A 之一\n- A 之二\n'
    expect(() => applyMemoryEntryOperations(ambiguous, [{ op: 'remove', match: 'A' }])).toThrow('无法唯一定位')

    const all = applyMemoryEntryOperations(ambiguous, [{ op: 'remove', match: 'A', all: true }])
    expect(all.changes).toHaveLength(2)
    expect(all.content.trim()).toBe('')
  })

  test('多条操作按提交顺序生效，删除后行号仍然正确', () => {
    const content = '- A\n- B\n- C\n'
    const result = applyMemoryEntryOperations(content, [
      { op: 'remove', match: '- A' },
      { op: 'add', entry: 'D' },
    ])
    expect(result.content).toBe('- B\n- C\n- D\n')
  })

  test('空操作列表报错；内容完全保留非条目文本', () => {
    expect(() => applyMemoryEntryOperations(BASE, [])).toThrow('请提供至少一条条目操作')
    const result = applyMemoryEntryOperations(BASE, [{ op: 'add', entry: 'X' }])
    expect(result.content.startsWith('# 全局用户画像\n\n## 角色与技术背景')).toBe(true)
    expect(result.content.endsWith('- 用户岗位与团队规模：尚无记录。\n- X\n')).toBe(true)
  })
})