import { describe, expect, test } from 'bun:test'
import { getTurnForkTargetUuid, resolveTurnForkTargetUuid } from './turn-fork-target'

const mainline = (uuid: string) => ({ uuid, parent_tool_use_id: null })
const subagent = (uuid: string) => ({ uuid, parent_tool_use_id: 'tool-use-1' })

describe('getTurnForkTargetUuid', () => {
  test('取普通轮次最后一条主线消息', () => {
    expect(getTurnForkTargetUuid([
      mainline('a1'),
      mainline('a2'),
      mainline('a3'),
    ])).toBe('a3')
  })

  test('末尾是子 Agent 消息时退到最后一条主线消息', () => {
    expect(getTurnForkTargetUuid([
      mainline('a1'),
      mainline('a2'),
      subagent('s1'),
      subagent('s2'),
    ])).toBe('a2')
  })

  test('全部是子 Agent 消息时没有分叉点', () => {
    expect(getTurnForkTargetUuid([subagent('s1'), subagent('s2')])).toBeUndefined()
  })

  test('空数组没有分叉点', () => {
    expect(getTurnForkTargetUuid([])).toBeUndefined()
  })

  test('跳过缺 uuid 的末尾消息', () => {
    expect(getTurnForkTargetUuid([
      mainline('a1'),
      { parent_tool_use_id: null },
      { uuid: '', parent_tool_use_id: null },
    ])).toBe('a1')
  })
})

describe('resolveTurnForkTargetUuid', () => {
  const forkable = (uuids: string[]) => (uuid: string) => uuids.includes(uuid)

  test('轮末消息可分叉时以轮末为准', () => {
    expect(resolveTurnForkTargetUuid({
      turnEndUuid: 'turn-end',
      selectedMessageId: 'selected',
      isForkable: forkable(['turn-end', 'selected']),
    })).toBe('turn-end')
  })

  test('轮末消息没有 Pi 绑定时退回选区消息', () => {
    expect(resolveTurnForkTargetUuid({
      turnEndUuid: 'turn-end',
      selectedMessageId: 'selected',
      isForkable: forkable(['selected']),
    })).toBe('selected')
  })

  test('都没有绑定时返回 undefined', () => {
    expect(resolveTurnForkTargetUuid({
      turnEndUuid: 'turn-end',
      selectedMessageId: 'selected',
      isForkable: () => false,
    })).toBeUndefined()
  })

  test('缺少轮末 uuid 时直接用选区消息', () => {
    expect(resolveTurnForkTargetUuid({
      turnEndUuid: undefined,
      selectedMessageId: 'selected',
      isForkable: forkable(['selected']),
    })).toBe('selected')
  })

  test('缺少选区 uuid 时只用轮末 uuid', () => {
    expect(resolveTurnForkTargetUuid({
      turnEndUuid: 'turn-end',
      selectedMessageId: undefined,
      isForkable: forkable(['turn-end']),
    })).toBe('turn-end')
  })

  test('都为空时返回 undefined', () => {
    expect(resolveTurnForkTargetUuid({ isForkable: () => true })).toBeUndefined()
  })
})
