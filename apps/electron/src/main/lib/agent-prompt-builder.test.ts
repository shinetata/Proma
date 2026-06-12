import { describe, expect, test } from 'bun:test'
import { buildDynamicContext } from './agent-prompt-builder'

describe('buildDynamicContext — Cursor 当前模式信号', () => {
  test('Cursor + 完全自动：注入 <current_mode> 并声明不在计划模式', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      permissionMode: 'bypassPermissions',
      channelProvider: 'cursor',
    })
    expect(ctx).toContain('<current_mode>')
    expect(ctx).toContain('完全自动模式')
    expect(ctx).not.toContain('自动审批模式')
    expect(ctx).toContain('**不在**计划模式')
    expect(ctx).toContain('忽略历史对话中任何关于')
  })

  test('Cursor + 自动审批：注入 <current_mode> 并声明不在计划模式', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      permissionMode: 'auto',
      channelProvider: 'cursor',
    })
    expect(ctx).toContain('<current_mode>')
    expect(ctx).toContain('自动审批模式')
    expect(ctx).toContain('**不在**计划模式')
  })

  test('Cursor + 计划模式：注入 <current_mode> 声明处于计划模式', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      permissionMode: 'plan',
      channelProvider: 'cursor',
    })
    expect(ctx).toContain('<current_mode>')
    expect(ctx).toContain('**计划模式**')
    expect(ctx).toContain('CreatePlan')
    expect(ctx).not.toContain('**不在**计划模式')
  })

  test('非 Cursor 渠道：不注入 <current_mode>', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      permissionMode: 'plan',
      channelProvider: 'anthropic',
    })
    expect(ctx).not.toContain('<current_mode>')
  })

  test('Cursor 但缺少 permissionMode：不注入 <current_mode>', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      channelProvider: 'cursor',
    })
    expect(ctx).not.toContain('<current_mode>')
  })

  test('仍包含基础动态上下文（时间 + 工作目录）', () => {
    const ctx = buildDynamicContext({
      agentCwd: '/tmp/sess',
      permissionMode: 'bypassPermissions',
      channelProvider: 'cursor',
    })
    expect(ctx).toContain('当前时间:')
    expect(ctx).toContain('<working_directory>/tmp/sess</working_directory>')
  })
})
