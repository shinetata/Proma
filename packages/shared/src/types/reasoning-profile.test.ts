import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from './reasoning-profile'

describe('DeepSeek v4.1 点号小版本 ID 解析', () => {
  test('Given v4.1 flash ID When openai-completions Then 命中 openai-reasoning-effort 编码', () => {
    const profile = resolveReasoningProfile({
      modelId: 'deepseek-v4.1-flash-1017',
      transport: 'openai-completions',
    })
    expect(profile?.id).toBe('deepseek-v4.1-flash')
    expect(profile?.encodings['openai-completions']?.kind).toBe('openai-reasoning-effort')
    const map = profile?.encodings['openai-completions']?.effortMap
    expect(map?.off).toBe('none')
    expect(map?.low).toBe('low')
    expect(map?.high).toBe('high')
    expect(map?.xhigh).toBe('high')
    expect(map?.max).toBe('max')
  })

  test('Given v4.1 flash ID When anthropic-messages Then 沿用 deepseek-output-effort 编码', () => {
    const profile = resolveReasoningProfile({
      modelId: 'deepseek-v4.1-flash-1017',
      transport: 'anthropic-messages',
    })
    expect(profile?.id).toBe('deepseek-v4.1-flash')
    expect(profile?.encodings['anthropic-messages']?.kind).toBe('deepseek-output-effort')
  })

  test('Given v4.1 pro ID When 双 transport Then 分别命中对应编码', () => {
    const openai = resolveReasoningProfile({
      modelId: 'deepseek-v4.1-pro-0201',
      transport: 'openai-completions',
    })
    expect(openai?.id).toBe('deepseek-v4.1-pro')
    expect(openai?.encodings['openai-completions']?.effortMap.low).toBe('high')

    const anthropic = resolveReasoningProfile({
      modelId: 'deepseek-v4.1-pro-0201',
      transport: 'anthropic-messages',
    })
    expect(anthropic?.encodings['anthropic-messages']?.kind).toBe('deepseek-output-effort')
  })

  test('Given 大小写混合的 v4.1 ID When 解析 Then 不区分大小写命中', () => {
    const profile = resolveReasoningProfile({
      modelId: 'DeepSeek-V4.1-Flash-1017',
      transport: 'openai-completions',
    })
    expect(profile?.id).toBe('deepseek-v4.1-flash')
  })

  test('Given 非 flash/pro 的点号 ID When 解析 Then 不误伤', () => {
    for (const modelId of ['deepseek-v4.1', 'deepseek-v4.1-flashy', 'deepseek-v4.1-vision']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })).toBeUndefined()
    }
  })
})

describe('DeepSeek 旧 ID 行为回归保护', () => {
  test('Given deepseek-flash When openai-completions Then 保持仅 Anthropic 编码', () => {
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'openai-completions' }),
    ).toBeUndefined()
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-flash', transport: 'anthropic-messages' })?.id,
    ).toBe('deepseek-flash')
  })

  test('Given deepseek-v4-flash-0731 When openai-completions Then 不命中，anthropic 命中', () => {
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-v4-flash-0731', transport: 'openai-completions' }),
    ).toBeUndefined()
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-v4-flash-0731', transport: 'anthropic-messages' })?.id,
    ).toBe('deepseek-v4-flash')
  })

  test('Given deepseek-v4-pro-0813 When openai-completions Then 不命中，anthropic 命中', () => {
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-v4-pro-0813', transport: 'openai-completions' }),
    ).toBeUndefined()
    expect(
      resolveReasoningProfile({ modelId: 'deepseek-v4-pro-0813', transport: 'anthropic-messages' })?.id,
    ).toBe('deepseek-v4-pro')
  })

  test('Given 其他 DeepSeek 模型 When 双 transport Then 均不误伤', () => {
    for (const modelId of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2']) {
      expect(resolveReasoningProfile({ modelId, transport: 'openai-completions' })).toBeUndefined()
      expect(resolveReasoningProfile({ modelId, transport: 'anthropic-messages' })).toBeUndefined()
    }
  })
})
