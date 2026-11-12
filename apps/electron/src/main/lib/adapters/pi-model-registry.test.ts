import { describe, expect, test } from 'bun:test'
import { clampThinkingLevel, streamSimple, type Api, type Model } from '@earendil-works/pi-ai/compat'
import type { AgentThinkingLevel, ProviderType } from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { buildModel, resolvePiReasoningCapability } from './pi-model-registry'

type PiSdk = Parameters<typeof buildModel>[0]
type PiModel = Model<Api>

interface RegisteredProvider {
  models: PiModel[]
}

/**
 * 只实现 buildModel 用到的 ModelRuntime 子集：记录 registerProvider 的模型条目并原样返回，
 * 避免测试读取 ~/.pi 下的认证与模型配置。
 */
function createStubSdk(): PiSdk {
  const providers = new Map<string, RegisteredProvider>()
  const runtime = {
    registerProvider(name: string, config: RegisteredProvider) {
      providers.set(name, config)
    },
    getModel(name: string, id: string): PiModel | undefined {
      const model = providers.get(name)?.models.find((candidate) => candidate.id === id)
      return model ? { ...model, provider: name } : undefined
    },
  }
  return { ModelRuntime: { create: async () => runtime } } as unknown as PiSdk
}

async function buildTestModel(provider: ProviderType, model: string, baseUrl: string): Promise<PiModel> {
  const input = {
    provider,
    model,
    baseUrl,
    apiKey: 'test-key',
    sessionId: 'gemini-4-test',
    channelName: 'Memtensor',
  } as PiAgentQueryOptions
  return (await buildModel(createStubSdk(), input)).model as PiModel
}

const PAYLOAD_CAPTURED = 'payload-captured'

/**
 * 按 Pi Agent 的实际流程构造一次请求：先用 clampThinkingLevel 收敛会话档位，
 * off 时不传 reasoning；在 onPayload 钩子里截获请求体后中止，不发出任何网络请求。
 */
async function capturePayload(model: PiModel, sessionLevel: AgentThinkingLevel): Promise<Record<string, unknown>> {
  const level = clampThinkingLevel(model, sessionLevel)
  let captured: Record<string, unknown> | undefined
  const stream = streamSimple(model, {
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
  }, {
    apiKey: 'test-key',
    ...(level === 'off' ? {} : { reasoning: level }),
    onPayload: (params) => {
      captured = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
      throw new Error(PAYLOAD_CAPTURED)
    },
  })
  const result = await stream.result()
  expect(result.errorMessage ?? '').toContain(PAYLOAD_CAPTURED)
  if (!captured) throw new Error('未截获请求体')
  return captured
}

const GEMINI_4_MODELS = ['gemini-4-argon', 'gemini-4-carbon'] as const
const GEMINI_4_THINKING_LEVEL_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }

describe('Gemini 4 在 Google 原生协议下的 Pi 注册', () => {
  for (const modelId of GEMINI_4_MODELS) {
    test(`Given ${modelId} When 注册 google 渠道 Then 1,048,576 / 65,536 且只开放 low/medium/high`, async () => {
      const model = await buildTestModel('google', modelId, 'https://api-int.memtensor.cn')
      expect(model.api).toBe('google-generative-ai')
      expect(model.baseUrl).toBe('https://api-int.memtensor.cn/v1beta')
      expect(model.contextWindow).toBe(1_048_576)
      expect(model.maxTokens).toBe(65_536)
      expect(model.reasoning).toBe(true)
      expect(model.thinkingLevelMap).toEqual(GEMINI_4_THINKING_LEVEL_MAP)
      expect(model.input).toEqual(['text', 'image'])
    })

    test(`Given ${modelId} When 会话档位 medium Then 请求体写入 thinkingConfig.thinkingLevel=MEDIUM`, async () => {
      const model = await buildTestModel('google', modelId, 'https://api-int.memtensor.cn')
      const payload = await capturePayload(model, 'medium')
      expect(payload.model).toBe(modelId)
      const config = payload.config as Record<string, unknown>
      expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'MEDIUM' })
      expect(config.maxOutputTokens).toBe(65_536)
    })
  }

  test('Given 沿用的旧档位 xhigh / off When 构造请求 Then 分别收敛为 HIGH / LOW，不会报错', async () => {
    const model = await buildTestModel('google', 'gemini-4-argon', 'https://api-int.memtensor.cn')
    const high = await capturePayload(model, 'xhigh')
    expect((high.config as Record<string, unknown>).thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' })
    const low = await capturePayload(model, 'off')
    expect((low.config as Record<string, unknown>).thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' })
  })

  test('Given google 渠道 When 解析会话 capability Then 展示 low/medium/high、默认 medium', async () => {
    for (const modelId of GEMINI_4_MODELS) {
      expect(await resolvePiReasoningCapability('google', modelId)).toEqual({
        source: 'profile',
        levels: ['low', 'medium', 'high'],
        defaultLevel: 'medium',
      })
    }
  })
})

describe('Gemini 4 在 Anthropic 兼容协议下的 Pi 注册', () => {
  const baseUrl = 'https://api-int.memtensor.cn/v1/messages'

  for (const modelId of GEMINI_4_MODELS) {
    test(`Given ${modelId} When 注册 anthropic-compatible 渠道 Then 尺寸固定且声明为不可调推理`, async () => {
      const model = await buildTestModel('anthropic-compatible', modelId, baseUrl)
      expect(model.api).toBe('anthropic-messages')
      expect(model.contextWindow).toBe(1_048_576)
      expect(model.maxTokens).toBe(65_536)
      expect(model.reasoning).toBe(false)
      expect(model.thinkingLevelMap).toBeUndefined()
    })

    test(`Given ${modelId} When 解析会话 capability Then 不展示思考档位`, async () => {
      expect(await resolvePiReasoningCapability('anthropic-compatible', modelId)).toBeUndefined()
    })
  }

  for (const level of ['xhigh', 'high', 'medium', 'off'] as const) {
    test(`Given 会话沿用 ${level} When 构造请求 Then 不出现 thinking / output_config，也不加 interleaved beta`, async () => {
      const model = await buildTestModel('anthropic-compatible', 'gemini-4-argon', baseUrl)
      expect(clampThinkingLevel(model, level)).toBe('off')
      const payload = await capturePayload(model, level)
      expect(payload.model).toBe('gemini-4-argon')
      expect(payload.max_tokens).toBe(65_536)
      expect(payload).not.toHaveProperty('thinking')
      expect(payload).not.toHaveProperty('output_config')
      expect(JSON.stringify(payload.betas ?? [])).not.toContain('interleaved-thinking')
    })
  }

  test('Given 未经收敛直接传入 reasoning=xhigh When 构造请求 Then 仍不发送思考字段', async () => {
    const model = await buildTestModel('anthropic-compatible', 'gemini-4-carbon', baseUrl)
    let captured: Record<string, unknown> | undefined
    const stream = streamSimple(model, {
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    }, {
      apiKey: 'test-key',
      reasoning: 'xhigh',
      onPayload: (params) => {
        captured = JSON.parse(JSON.stringify(params)) as Record<string, unknown>
        throw new Error(PAYLOAD_CAPTURED)
      },
    })
    await stream.result()
    expect(captured).toBeDefined()
    expect(captured).not.toHaveProperty('thinking')
    expect(captured).not.toHaveProperty('output_config')
  })
})

describe('非 Gemini 4 模型不受影响', () => {
  test('Given anthropic-compatible 的 Claude 模型 When 注册 Then 仍按 catalog 声明推理能力，请求保留 thinking', async () => {
    const model = await buildTestModel('anthropic-compatible', 'claude-opus-4-6', 'https://api.example.com')
    expect(model.reasoning).toBe(true)
    // 对照：同一截获方式能看到推理模型的 thinking 字段，证明上面的「不出现」断言有效。
    const payload = await capturePayload(model, 'high')
    expect(payload).toHaveProperty('thinking')
  })

  test('Given google 渠道的 Gemini 3.7 Flash When 注册 Then minimal 仍被排除', async () => {
    const capability = await resolvePiReasoningCapability('google', 'gemini-3.7-flash')
    expect(capability?.levels).not.toContain('minimal')
  })
})
