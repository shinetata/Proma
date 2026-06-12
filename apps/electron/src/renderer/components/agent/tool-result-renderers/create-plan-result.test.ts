import { describe, expect, test } from 'bun:test'
import {
  isCreatePlanResultEmpty,
  parseCreatePlanInput,
  resolveCreatePlanBody,
} from './create-plan-result'

describe('CreatePlan 结果解析', () => {
  test('Given 空字符串 When 判断 result Then 视为空', () => {
    expect(isCreatePlanResultEmpty('')).toBe(true)
    expect(isCreatePlanResultEmpty('   ')).toBe(true)
  })

  test('Given "{}" When 判断 result Then 视为空', () => {
    expect(isCreatePlanResultEmpty('{}')).toBe(true)
    expect(isCreatePlanResultEmpty(' {} ')).toBe(true)
  })

  test('Given 空 JSON 对象 When 判断 result Then 视为空', () => {
    expect(isCreatePlanResultEmpty('{"foo":null}')).toBe(false)
    expect(isCreatePlanResultEmpty('[]')).toBe(false)
  })

  test('Given 非空 result When 解析计划正文 Then 优先使用 result', () => {
    const input = { plan: '# Plan from input' }
    expect(resolveCreatePlanBody('Plan from result', input)).toBe('Plan from result')
  })

  test('Given 空 result 与 input.plan When 解析计划正文 Then 回退到 input.plan', () => {
    const input = { plan: '# Plan from input\n\n## Section' }
    expect(resolveCreatePlanBody('{}', input)).toBe('# Plan from input\n\n## Section')
    expect(resolveCreatePlanBody('', input)).toBe('# Plan from input\n\n## Section')
  })

  test('Given overview 与 todos When 解析 input Then 提取结构化字段', () => {
    const parsed = parseCreatePlanInput({
      overview: '调研记忆调度方案',
      todos: [
        { id: 'a', content: '阅读文档', status: 'TODO_STATUS_PENDING' },
        { content: '写报告' },
        42,
      ],
    })

    expect(parsed.overview).toBe('调研记忆调度方案')
    expect(parsed.todos).toEqual([
      { id: 'a', content: '阅读文档', status: 'TODO_STATUS_PENDING' },
      { content: '写报告', id: undefined, status: undefined },
    ])
  })
})
