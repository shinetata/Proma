import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type ProviderPayload = Record<string, unknown>

/** Gemini 3+ 的「严格工具采样」模式；仅官方端点与部分中转上游支持。 */
const VALIDATED_FUNCTION_CALLING_MODE = 'VALIDATED'
const AUTO_FUNCTION_CALLING_MODE = 'AUTO'

/**
 * Google 文档给出的占位签名：历史中的 functionCall 不是由当前 Gemini 模型生成（换模型、换渠道、
 * 会话导入）时，用它跳过 thought signature 校验。
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

function isRecord(value: unknown): value is ProviderPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 Gemini 请求中的 `functionCallingConfig.mode = "VALIDATED"` 降为 `"AUTO"`。
 *
 * Pi 1.4 对 Gemini 3+ 模型且工具声明了 `constrainedSampling`（Read / Write / Edit / Bash 等内置工具）
 * 时，会改用严格 JSON Schema 并把调用模式设为 VALIDATED。Memtensor 等 Gemini 原生协议中转在部分
 * 上游路由上不认识该模式，返回 400「unsupported functionCallingConfig mode "VALIDATED"」，整轮失败。
 * AUTO 是 Gemini 的默认模式，所有上游都支持；工具 schema 仍保持严格形态（可选字段为 `anyOf null`），
 * Pi 在执行工具前会把模型传回的 null 可选参数剔除，因此降级后工具调用语义不变，只是失去服务端
 * 的 schema 强校验。只改写 VALIDATED，`ANY` / `NONE` 等显式选择保持原样。
 *
 * Pi Google 适配器的 payload 形如 `{ model, contents, config: { toolConfig: { functionCallingConfig } } }`。
 */
export function downgradeGoogleValidatedToolMode(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.config)) return payload
  const toolConfig = payload.config.toolConfig
  if (!isRecord(toolConfig) || !isRecord(toolConfig.functionCallingConfig)) return payload
  if (toolConfig.functionCallingConfig.mode !== VALIDATED_FUNCTION_CALLING_MODE) return payload

  return {
    ...payload,
    config: {
      ...payload.config,
      toolConfig: {
        ...toolConfig,
        functionCallingConfig: {
          ...toolConfig.functionCallingConfig,
          mode: AUTO_FUNCTION_CALLING_MODE,
        },
      },
    },
  }
}

/**
 * 为缺少 `thoughtSignature` 的历史 functionCall 补占位签名。
 *
 * Gemini 3+ 要求请求里每个 model 轮次的 functionCall part 都带回 thoughtSignature，缺失即 400
 * 「Function call is missing a thought_signature in functionCall parts」。Pi 只在助手消息来自同一
 * provider 与模型时回传签名，因此同一会话从 DeepSeek、Anthropic 兼容渠道或另一个 Gemini 模型
 * 切换过来后，历史工具调用都没有签名。按 Google 的兼容做法，只给每个 model 轮次中第一个缺签名的
 * functionCall 补 {@link SKIP_THOUGHT_SIGNATURE}（并行调用只需首个带签名）；已有签名的不动。
 */
export function fillMissingGoogleThoughtSignatures(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.contents)) return payload

  let changed = false
  const contents = payload.contents.map((content: unknown) => {
    if (!isRecord(content) || content.role !== 'model' || !Array.isArray(content.parts)) return content
    const firstCallIndex = content.parts.findIndex((part: unknown) => isRecord(part) && isRecord(part.functionCall))
    if (firstCallIndex < 0) return content
    const firstCall = content.parts[firstCallIndex] as ProviderPayload
    if (typeof firstCall.thoughtSignature === 'string' && firstCall.thoughtSignature.length > 0) return content

    changed = true
    const parts = [...content.parts]
    parts[firstCallIndex] = { ...firstCall, thoughtSignature: SKIP_THOUGHT_SIGNATURE }
    return { ...content, parts }
  })

  return changed ? { ...payload, contents } : payload
}

export interface GoogleRequestCompatSettings {
  /** 是否把 VALIDATED 工具调用模式降为 AUTO；仅中转网关需要，官方端点保持 Pi 默认行为。 */
  downgradeValidatedToolMode: boolean
}

/** 依次应用 Gemini 请求兼容改写；没有改动时返回原对象。 */
export function applyGoogleRequestCompat(payload: unknown, settings: GoogleRequestCompatSettings): unknown {
  const toolModeCompatible = settings.downgradeValidatedToolMode ? downgradeGoogleValidatedToolMode(payload) : payload
  return fillMissingGoogleThoughtSignatures(toolModeCompatible)
}

/**
 * Pi inline extension：Google 渠道的 Gemini 请求兼容改写。
 *
 * - 所有 Google 渠道：为缺签名的历史 functionCall 补占位签名，避免换模型或换渠道后整轮 400。
 * - 非官方 Base URL（中转网关）：额外把 VALIDATED 工具调用模式降为 AUTO。
 */
export function createGoogleRequestCompatExtension(settings: GoogleRequestCompatSettings): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = applyGoogleRequestCompat(event.payload, settings)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}

/** 判断 Google 渠道是否走官方 Gemini API 端点；空 Base URL 视为官方默认地址。 */
export function isOfficialGoogleGenerativeAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return true
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === 'generativelanguage.googleapis.com'
  } catch {
    return false
  }
}
