/**
 * Google Generative AI 模型列表解析。
 *
 * 同时兼容官方端点与 Gemini 原生协议的兼容网关（如 new-api 类中转）。纯函数、无 Electron
 * 依赖，供渠道连接测试与模型拉取共用，也便于独立单元测试。
 */

import type { ChannelModel } from '@proma/shared'

/** `GET /v1beta/models` 的响应项；网关可能把可选字段置为 null。 */
export interface GoogleModelItem {
  name?: string | null
  displayName?: string | null
  description?: string | null
  supportedGenerationMethods?: string[] | null
}

/**
 * 解析模型列表接口地址。
 *
 * 渠道 Base URL 通常保存为协议根（如 `https://generativelanguage.googleapis.com`），此时补上
 * `/v1beta`；用户已填写 `/v1` 或 `/v1beta`（含代理路径）时直接使用，避免拼出 `/v1beta/v1beta`。
 * 与 Pi runtime 注册时的 `normalizePiBaseUrl` 规则一致。
 */
export function resolveGoogleModelsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  return /\/v1(?:beta)?$/i.test(normalized) ? `${normalized}/models` : `${normalized}/v1beta/models`
}

/** 名称明显属于向量模型时排除；仅在接口未声明 supportedGenerationMethods 时使用。 */
const EMBEDDING_MODEL_PATTERN = /(?:^|[-_/.])embed(?:ding)?(?:s)?(?:$|[-_/.\d])/i

/**
 * 判断模型能否用于对话。
 *
 * 官方端点总会返回 supportedGenerationMethods，按是否包含 generateContent 过滤；
 * 兼容网关可能返回 null，此时无法判断能力，保留模型，只按名称排除向量模型。
 */
function supportsGenerateContent(item: GoogleModelItem, id: string): boolean {
  if (Array.isArray(item.supportedGenerationMethods)) {
    return item.supportedGenerationMethods.includes('generateContent')
  }
  return !EMBEDDING_MODEL_PATTERN.test(id)
}

/**
 * 把模型列表响应转换为渠道模型。
 *
 * 官方 `name` 形如 `models/gemini-pro`，需去掉 `models/` 前缀作为实际模型 ID；网关返回的
 * `name` 可能本身就是模型 ID。空 ID 跳过，重复 ID 只保留首个。
 */
export function toGoogleChannelModels(items: readonly GoogleModelItem[] | null | undefined): ChannelModel[] {
  const models: ChannelModel[] = []
  const seen = new Set<string>()
  for (const item of items ?? []) {
    const id = item.name?.trim().replace(/^models\//, '')
    if (!id || seen.has(id) || !supportsGenerateContent(item, id)) continue
    seen.add(id)
    models.push({
      id,
      name: item.displayName?.trim() || id,
      enabled: true,
    })
  }
  return models
}
