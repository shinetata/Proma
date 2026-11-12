import { describe, expect, test } from 'bun:test'
import { getGeminiModelCapability } from '../utils/gemini-model-capabilities'
import { inferContextWindow } from '../utils/context-window'
import {
  getGemini4ModelLeafId,
  inferReasoningTransport,
  isReasoningControlUnsupported,
  normalizeReasoningCapabilityLevel,
  resolveReasoningCapability,
  resolveReasoningProfile,
} from './reasoning-profile'

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

describe('GPT-6.1 Terra / Sol reasoning profile', () => {
  test('Given gpt-6.1-terra When openai-completions Then 命中 Terra 档位', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'openai-completions' })
    expect(profile?.id).toBe('openai-reasoning-terra')
    expect(profile?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(profile?.defaultLevel).toBe('low')
    expect(profile?.encodings['openai-completions']?.kind).toBe('openai-reasoning-effort')
    expect(profile?.encodings['openai-completions']?.effortMap).toMatchObject({ off: 'low', max: 'max' })
  })

  test('Given terra-1 / 大小写与空白 When 解析 Then 归一后仍命中', () => {
    expect(
      resolveReasoningProfile({ modelId: ' GPT-6.1-Terra-1 ', transport: 'openai-completions' })?.id,
    ).toBe('openai-reasoning-terra')
    expect(
      resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'openai-responses' })?.id,
    ).toBe('openai-reasoning-terra')
  })

  test('Given Terra When off 或 minimal Then 归一为 low', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-terra', transport: 'openai-completions' })!
    expect(profile.normalize('off')).toBe('low')
    expect(profile.normalize('minimal')).toBe('low')
    expect(profile.normalize('max')).toBe('max')
  })

  test('Given gpt-6.1-sol When openai-completions Then 走 Sol/Luna 档位并允许关闭', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-6.1-sol', transport: 'openai-completions' })
    expect(profile?.id).toBe('openai-reasoning-sol-luna')
    expect(profile?.levels).toContain('off')
  })

  test('Given 相近 ID When 解析 Then 不误伤', () => {
    for (const id of ['gpt-6.1-terra-preview', 'gpt-61-terra', 'gpt-6.1-terrax']) {
      expect(resolveReasoningProfile({ modelId: id, transport: 'openai-completions' })).toBeUndefined()
    }
  })
})

describe('Gemini 4 Argon / Carbon reasoning profile', () => {
  test('Given google 渠道 When 推断 transport Then 归为 google-generative-ai', () => {
    expect(inferReasoningTransport('google')).toBe('google-generative-ai')
    // 其他渠道保持原归类，不受新增 transport 影响。
    expect(inferReasoningTransport('anthropic-compatible')).toBe('anthropic-messages')
    expect(inferReasoningTransport('custom')).toBe('openai-completions')
    expect(inferReasoningTransport('openai-responses')).toBe('openai-responses')
  })

  test('Given Argon / Carbon When google-generative-ai Then 命中 low/medium/high、默认 medium 的 thinkingLevel 编码', () => {
    for (const [modelId, expectedId] of [
      ['gemini-4-argon', 'gemini-4-argon'],
      ['gemini-4-carbon', 'gemini-4-carbon'],
    ] as const) {
      const profile = resolveReasoningProfile({ modelId, transport: 'google-generative-ai' })
      expect(profile?.id).toBe(expectedId)
      expect(profile?.levels).toEqual(['low', 'medium', 'high'])
      expect(profile?.defaultLevel).toBe('medium')
      expect(profile?.encodings['google-generative-ai']).toEqual({
        kind: 'google-thinking-level',
        effortMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      })
    }
  })

  test('Given 网关前缀、大小写与 [1m] 后缀 When 解析 Then 按叶子 ID 命中', () => {
    expect(resolveReasoningProfile({ modelId: 'google/gemini-4-argon', transport: 'google-generative-ai' })?.id)
      .toBe('gemini-4-argon')
    expect(resolveReasoningProfile({ modelId: ' Gemini-4-Carbon[1m] ', transport: 'google-generative-ai' })?.id)
      .toBe('gemini-4-carbon')
    expect(getGemini4ModelLeafId('models/gemini-4-argon')).toBe('gemini-4-argon')
  })

  test('Given Anthropic 兼容或 OpenAI 协议 When 解析 Then 不命中 profile（思考参数在该路径无效）', () => {
    for (const transport of ['anthropic-messages', 'openai-completions', 'openai-responses', 'other'] as const) {
      expect(resolveReasoningProfile({ modelId: 'gemini-4-argon', transport })).toBeUndefined()
      expect(resolveReasoningProfile({ modelId: 'gemini-4-carbon', transport })).toBeUndefined()
    }
  })

  test('Given 相近 ID When 解析 Then 不误伤', () => {
    for (const modelId of ['gemini-4-argon-preview', 'gemini-4', 'gemini-4-argonx', 'gemini-4.1-argon']) {
      expect(resolveReasoningProfile({ modelId, transport: 'google-generative-ai' })).toBeUndefined()
      expect(getGemini4ModelLeafId(modelId)).toBeUndefined()
    }
  })

  test('Given 沿用前一模型的旧档位 When 归一 Then 落在 low/medium/high', () => {
    const profile = resolveReasoningProfile({ modelId: 'gemini-4-argon', transport: 'google-generative-ai' })!
    expect(profile.normalize('off')).toBe('low')
    expect(profile.normalize('minimal')).toBe('low')
    expect(profile.normalize('low')).toBe('low')
    expect(profile.normalize('medium')).toBe('medium')
    expect(profile.normalize(undefined)).toBe('medium')
    expect(profile.normalize('high')).toBe('high')
    expect(profile.normalize('xhigh')).toBe('high')
    expect(profile.normalize('max')).toBe('high')
  })

  test('Given profile When 解析会话 capability Then 只暴露三档并保持默认 medium', () => {
    const profile = resolveReasoningProfile({ modelId: 'gemini-4-carbon', transport: 'google-generative-ai' })
    const capability = resolveReasoningCapability({ profile })
    expect(capability).toEqual({ source: 'profile', levels: ['low', 'medium', 'high'], defaultLevel: 'medium' })
    expect(normalizeReasoningCapabilityLevel(capability, 'xhigh')).toBe('high')
  })

  test('Given Anthropic 兼容协议 When 判断思考控制 Then 仅 Gemini 4 被锁定', () => {
    expect(isReasoningControlUnsupported({ modelId: 'gemini-4-argon', transport: 'anthropic-messages' })).toBe(true)
    expect(isReasoningControlUnsupported({ modelId: 'google/gemini-4-carbon', transport: 'anthropic-messages' })).toBe(true)
    expect(isReasoningControlUnsupported({ modelId: 'gemini-4-argon', transport: 'google-generative-ai' })).toBe(false)
    expect(isReasoningControlUnsupported({ modelId: 'gemini-4-argon', transport: 'openai-completions' })).toBe(false)
    expect(isReasoningControlUnsupported({ modelId: 'claude-opus-5-5', transport: 'anthropic-messages' })).toBe(false)
    expect(isReasoningControlUnsupported({ modelId: undefined, transport: 'anthropic-messages' })).toBe(false)
  })

  test('Given reasoning=false 的 catalog When 解析 capability Then 不展示档位', () => {
    expect(resolveReasoningCapability({ catalog: { reasoning: false } })).toBeUndefined()
  })

  test('Given Argon / Carbon When 查询能力表 Then 均为 1,048,576 上下文与 64K 输出', () => {
    for (const modelId of ['gemini-4-argon', 'gemini-4-carbon', 'models/gemini-4-carbon']) {
      expect(getGeminiModelCapability(modelId)).toEqual({
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        thinkingLevels: ['low', 'medium', 'high'],
        defaultThinkingLevel: 'medium',
      })
      expect(inferContextWindow(modelId)).toBe(1_048_576)
    }
  })
})
