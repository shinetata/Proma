import { describe, expect, test } from 'bun:test'
import { SKILL_IDLE_DAYS, describeSkillUsage, formatSkillUsageAge, isIdleSkill } from './skillUsage'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-12T12:00:00+08:00').getTime()

describe('Skill 使用时间短语', () => {
  test('Given 没有使用记录 When 取短语 Then 显示未使用', () => {
    expect(formatSkillUsageAge(undefined, NOW)).toBe('未使用')
  })

  test('Given 一小时内用过 When 取短语 Then 显示刚刚用过', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW - 10 * 60 * 1000 }, NOW)).toBe('刚刚用过')
  })

  test('Given 当天用过 When 取短语 Then 显示今天用过', () => {
    expect(formatSkillUsageAge({ count: 3, lastUsedAt: NOW - 5 * 60 * 60 * 1000 }, NOW)).toBe('今天用过')
  })

  test('Given 三天前用过 When 取短语 Then 显示天数', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW - 3 * DAY_MS }, NOW)).toBe('3 天前用过')
  })

  test('Given 十天前用过 When 取短语 Then 显示周数', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW - 10 * DAY_MS }, NOW)).toBe('1 周前用过')
  })

  test('Given 半年前用过 When 取短语 Then 显示月数', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW - 180 * DAY_MS }, NOW)).toBe('6 个月前用过')
  })

  test('Given 超过一年 When 取短语 Then 显示很久前用过', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW - 400 * DAY_MS }, NOW)).toBe('很久前用过')
  })

  test('Given 未来时间戳 When 取短语 Then 不出现负数', () => {
    expect(formatSkillUsageAge({ count: 1, lastUsedAt: NOW + 10 * DAY_MS }, NOW)).toBe('刚刚用过')
  })
})

describe('Skill 使用 tooltip 文案', () => {
  test('Given 有使用记录 When 取说明 Then 包含会话数与最近时间', () => {
    const text = describeSkillUsage({ count: 4, lastUsedAt: NOW })
    expect(text.startsWith('4 个会话使用过，最近一次 ')).toBe(true)
  })

  test('Given 没有使用记录 When 取说明 Then 提示从未触发', () => {
    expect(describeSkillUsage(undefined)).toBe('还没有在会话中触发过这个 Skill')
  })
})

describe('闲置判定', () => {
  test('Given 内置 Skill When 判定闲置 Then 永不闲置', () => {
    expect(isIdleSkill({ usage: undefined, isBuiltin: true, now: NOW })).toBe(false)
  })

  test('Given 从未使用的工作区 Skill When 判定闲置 Then 视为闲置', () => {
    expect(isIdleSkill({ usage: undefined, isBuiltin: false, now: NOW })).toBe(true)
  })

  test('Given 恰好满 30 天 When 判定闲置 Then 视为闲置', () => {
    const usage = { count: 1, lastUsedAt: NOW - SKILL_IDLE_DAYS * DAY_MS }
    expect(isIdleSkill({ usage, isBuiltin: false, now: NOW })).toBe(true)
  })

  test('Given 29 天前用过 When 判定闲置 Then 不闲置', () => {
    const usage = { count: 1, lastUsedAt: NOW - 29 * DAY_MS }
    expect(isIdleSkill({ usage, isBuiltin: false, now: NOW })).toBe(false)
  })
})
