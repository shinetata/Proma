import { describe, expect, test } from 'bun:test'
import { stream } from '@earendil-works/pi-ai/api/google-generative-ai'
import {
  applyGoogleRequestCompat,
  downgradeGoogleValidatedToolMode,
  fillMissingGoogleThoughtSignatures,
  isOfficialGoogleGenerativeAiBaseUrl,
  SKIP_THOUGHT_SIGNATURE,
} from './pi-google-request-compat'

function googlePayload(mode: string | undefined): Record<string, unknown> {
  return {
    model: 'gemini-4-argon',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    config: {
      maxOutputTokens: 65536,
      tools: [{ functionDeclarations: [{ name: 'read' }] }],
      ...(mode ? { toolConfig: { functionCallingConfig: { mode } } } : {}),
    },
  }
}

describe('downgradeGoogleValidatedToolMode', () => {
  test('VALIDATED 降为 AUTO，其余字段保持不变', () => {
    const payload = googlePayload('VALIDATED')
    const result = downgradeGoogleValidatedToolMode(payload) as ReturnType<typeof googlePayload>
    expect(result).not.toBe(payload)
    expect(result).toEqual({
      ...payload,
      config: {
        ...(payload.config as Record<string, unknown>),
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
    })
    // 不修改原对象
    expect((payload.config as { toolConfig: { functionCallingConfig: { mode: string } } }).toolConfig.functionCallingConfig.mode).toBe('VALIDATED')
  })

  test('ANY / NONE / AUTO 与未设置工具模式时原样返回', () => {
    for (const mode of ['ANY', 'NONE', 'AUTO', undefined]) {
      const payload = googlePayload(mode)
      expect(downgradeGoogleValidatedToolMode(payload)).toBe(payload)
    }
  })

  test('非 Google 形态的 payload 原样返回', () => {
    const anthropicPayload = { model: 'claude', messages: [], tool_choice: { type: 'auto' } }
    expect(downgradeGoogleValidatedToolMode(anthropicPayload)).toBe(anthropicPayload)
    expect(downgradeGoogleValidatedToolMode(null)).toBeNull()
    expect(downgradeGoogleValidatedToolMode('x')).toBe('x')
  })
})

describe('isOfficialGoogleGenerativeAiBaseUrl', () => {
  test('官方端点与空地址视为官方', () => {
    expect(isOfficialGoogleGenerativeAiBaseUrl(undefined)).toBe(true)
    expect(isOfficialGoogleGenerativeAiBaseUrl('')).toBe(true)
    expect(isOfficialGoogleGenerativeAiBaseUrl('https://generativelanguage.googleapis.com')).toBe(true)
    expect(isOfficialGoogleGenerativeAiBaseUrl('https://generativelanguage.googleapis.com/v1beta/')).toBe(true)
  })

  test('中转网关与无法解析的地址视为非官方', () => {
    expect(isOfficialGoogleGenerativeAiBaseUrl('https://api-int.memtensor.cn')).toBe(false)
    expect(isOfficialGoogleGenerativeAiBaseUrl('https://proxy.example.com/generativelanguage.googleapis.com')).toBe(false)
    expect(isOfficialGoogleGenerativeAiBaseUrl('not a url')).toBe(false)
  })
})

/** 用 Pi 真实的 Google 适配器与内置工具构造请求，在 onPayload 截获后中止，不发网络请求。 */
async function capturePiGooglePayload(modelId: string, history: unknown[] = []): Promise<Record<string, unknown>> {
  // 与 Pi 内置 Read / Write / Edit / Bash 工具相同：声明 `constrainedSampling: json_schema + prefer`。
  // 不直接导入 pi-coding-agent，避免与其他测试文件的 mock.module 互相污染。
  const tools = ['read', 'write', 'edit', 'bash'].map((name) => ({
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' } },
      required: ['path'],
    },
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
  }))
  let captured: Record<string, unknown> | undefined
  const model = {
    id: modelId,
    name: modelId,
    api: 'google-generative-ai',
    provider: 'proma-google-test',
    baseUrl: 'https://gateway.invalid/v1beta',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }
  // Pi 1.4 的工具集合挂在 system 消息的 toolsAdded 上（见 pi-ai utils/transcript getCurrentTools）。
  const events = stream(model as never, {
    messages: [
      { role: 'system', content: 'test', toolsAdded: tools, timestamp: Date.now() },
      ...history,
      { role: 'user', content: 'hi', timestamp: Date.now() },
    ],
  } as never, {
    apiKey: 'test-key',
    onPayload: (params: unknown) => {
      captured = params as Record<string, unknown>
      throw new Error('captured')
    },
  } as never)
  for await (const _event of events) { /* 等待 onPayload 抛错结束流 */ }
  if (!captured) throw new Error('payload not captured')
  return captured
}

describe('Pi Google 适配器真实请求', () => {
  test('Gemini 4 + 内置工具时 Pi 发出 VALIDATED，扩展改写后为 AUTO', async () => {
    const payload = await capturePiGooglePayload('gemini-4-argon')
    const mode = (payload.config as { toolConfig?: { functionCallingConfig?: { mode?: string } } }).toolConfig?.functionCallingConfig?.mode
    expect(mode).toBe('VALIDATED')
    const rewritten = downgradeGoogleValidatedToolMode(payload) as typeof payload
    const rewrittenConfig = rewritten.config as { toolConfig: { functionCallingConfig: { mode: string } }, tools: unknown }
    expect(rewrittenConfig.toolConfig.functionCallingConfig.mode).toBe('AUTO')
    // 工具声明不变
    expect(rewrittenConfig.tools).toBe((payload.config as { tools: unknown }).tools)
  })
})

describe('fillMissingGoogleThoughtSignatures', () => {
  test('每个 model 轮次只给首个缺签名的 functionCall 补占位签名', () => {
    const payload: { contents: Array<{ role: string, parts: Array<Record<string, unknown>> }> } = {
      contents: [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ text: 'thinking' }, { functionCall: { name: 'a' } }, { functionCall: { name: 'b' } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'a' } }, { functionResponse: { name: 'b' } }] },
        { role: 'model', parts: [{ functionCall: { name: 'c' }, thoughtSignature: 'real-sig' }] },
        { role: 'model', parts: [{ text: 'done' }] },
      ],
    }
    const result = fillMissingGoogleThoughtSignatures(payload) as typeof payload
    expect(result).not.toBe(payload)
    expect(result.contents[1]!.parts).toEqual([
      { text: 'thinking' },
      { functionCall: { name: 'a' }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
      { functionCall: { name: 'b' } },
    ])
    // 已有真实签名、无工具调用的轮次与用户轮次保持原对象
    expect(result.contents[0]).toBe(payload.contents[0])
    expect(result.contents[2]).toBe(payload.contents[2])
    expect(result.contents[3]).toBe(payload.contents[3])
    expect(result.contents[4]).toBe(payload.contents[4])
  })

  test('没有缺签名的工具调用时原样返回', () => {
    const payload = { contents: [{ role: 'model', parts: [{ functionCall: { name: 'a' }, thoughtSignature: 'sig' }] }] }
    expect(fillMissingGoogleThoughtSignatures(payload)).toBe(payload)
    const noContents = { model: 'x' }
    expect(fillMissingGoogleThoughtSignatures(noContents)).toBe(noContents)
  })
})

describe('applyGoogleRequestCompat', () => {
  test('官方端点只补签名，不降级工具模式', () => {
    const payload = {
      contents: [{ role: 'model', parts: [{ functionCall: { name: 'a' } }] }],
      config: { toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } },
    }
    const result = applyGoogleRequestCompat(payload, { downgradeValidatedToolMode: false }) as typeof payload
    expect(result.config).toBe(payload.config)
    expect((result.contents[0]!.parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
  })

  test('中转网关同时降级工具模式与补签名', () => {
    const payload = {
      contents: [{ role: 'model', parts: [{ functionCall: { name: 'a' } }] }],
      config: { toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } },
    }
    const result = applyGoogleRequestCompat(payload, { downgradeValidatedToolMode: true }) as typeof payload
    expect(result.config.toolConfig.functionCallingConfig.mode).toBe('AUTO')
    expect((result.contents[0]!.parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
  })
})

describe('Pi Google 适配器跨模型历史', () => {
  test('从其他模型切到 Gemini 4 后历史工具调用无签名，扩展补齐占位签名', async () => {
    const now = Date.now()
    const history = [
      { role: 'user', content: '读一下 hosts', timestamp: now },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/etc/hosts' } }],
        api: 'anthropic-messages',
        provider: 'proma-anthropic-compatible-test',
        model: 'deepseek-v4.1-flash-1017',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: now,
      },
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: '127.0.0.1 localhost' }], isError: false, timestamp: now },
    ]
    const payload = await capturePiGooglePayload('gemini-4-argon', history)
    const modelTurns = (payload.contents as Array<{ role: string, parts: Array<Record<string, unknown>> }>).filter((content) => content.role === 'model')
    const call = modelTurns.flatMap((content) => content.parts).find((part) => part.functionCall)
    expect(call).toBeDefined()
    expect(call!.thoughtSignature).toBeUndefined()

    const rewritten = applyGoogleRequestCompat(payload, { downgradeValidatedToolMode: true }) as typeof payload
    const rewrittenCall = (rewritten.contents as typeof modelTurns)
      .filter((content) => content.role === 'model')
      .flatMap((content) => content.parts)
      .find((part) => part.functionCall)
    expect(rewrittenCall!.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
  })
})
