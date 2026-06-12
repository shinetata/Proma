import { describe, expect, test } from 'bun:test'
import {
  buildPlanExecutionUserMessage,
  shouldAutoContinuePlanExecution,
} from './agent-plan-continuation-utils'

describe('Plan 批准后自动续跑', () => {
  test('Given 无 planPath When 构建执行消息 Then 返回默认文案', () => {
    expect(buildPlanExecutionUserMessage()).toBe('请执行该计划')
    expect(buildPlanExecutionUserMessage('   ')).toBe('请执行该计划')
  })

  test('Given planPath When 构建执行消息 Then 附带计划文件路径', () => {
    expect(buildPlanExecutionUserMessage('/tmp/.context/plan/foo.md')).toBe(
      '请执行该计划\n\n计划文件：/tmp/.context/plan/foo.md',
    )
  })

  test('Given cursor_synthetic 批准 When 判断是否自动续跑 Then 返回 true', () => {
    expect(shouldAutoContinuePlanExecution('cursor_synthetic', 'approve_auto')).toBe(true)
    expect(shouldAutoContinuePlanExecution('cursor_synthetic', 'approve_edit')).toBe(true)
  })

  test('Given 非批准或 tool 来源 When 判断是否自动续跑 Then 返回 false', () => {
    expect(shouldAutoContinuePlanExecution('cursor_synthetic', 'deny')).toBe(false)
    expect(shouldAutoContinuePlanExecution('cursor_synthetic', 'feedback')).toBe(false)
    expect(shouldAutoContinuePlanExecution('tool', 'approve_auto')).toBe(false)
    expect(shouldAutoContinuePlanExecution(undefined, 'approve_auto')).toBe(false)
  })
})
