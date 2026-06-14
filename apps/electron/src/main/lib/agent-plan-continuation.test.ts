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

  test('Given 任意来源 When 判断是否自动续跑 Then 返回 false（统一 tool_callback 路径）', () => {
    expect(shouldAutoContinuePlanExecution('tool', 'approve_auto')).toBe(false)
    expect(shouldAutoContinuePlanExecution('tool', 'approve_edit')).toBe(false)
    expect(shouldAutoContinuePlanExecution(undefined, 'approve_auto')).toBe(false)
    expect(shouldAutoContinuePlanExecution('old_source', 'deny')).toBe(false)
  })
})
