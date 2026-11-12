/**
 * Proma Cloud 联网检索请求模块
 *
 * 负责调用 Proma Cloud 的 `/api/v1/tools/search` 与 `/api/v1/tools/fetch`，
 * 把上游响应归一化成工具返回结构，并把错误映射成带 hint 的失败结果。
 *
 * 与商业版的差异只有凭据来源：商业版从云端登录态取 Agent Inner Key，
 * 开源版从用户在能力中心填写的 API Key 取；字段映射、截断与 hint 文案保持一致。
 * 任何返回值都不得包含 API Key。
 */

import type { PromaCloudConnectionTestResult } from '@proma/shared'
import { normalizePromaCloudBaseUrl, resolvePromaCloudCredentials } from './proma-cloud-config'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getFetchFn } from './proxy-fetch'

/** 搜索与抓取的请求超时。 */
const REQUEST_TIMEOUT_MS = 25_000
/** 连接测试的超时；只做鉴权探测，不需要等完整检索。 */
const CONNECTION_TEST_TIMEOUT_MS = 15_000
/** 单页正文的最大字符数。 */
export const MAX_FETCH_CONTENT_CHARS = 40_000

/** 上游状态码到行动建议的映射；模型据此决定重试、换来源还是停止。 */
export const STATUS_HINTS: Record<number, string> = {
  400: 'Request rejected as invalid. Check query length (1-128 chars), count (1-50) or URL format, then retry once with corrected input.',
  401: 'The Proma Cloud API key is invalid or has been revoked. Tell the user to update it in Capabilities → MCP → Proma Cloud, and use the managed browser meanwhile.',
  402: 'The user has insufficient credits. Stop searching and tell the user plainly; do not retry.',
  403: 'The target site refused access for this fetch. Use another source.',
  404: 'This URL produced no usable page content. Use another source instead of retrying the same URL.',
  429: 'Rate limited. Wait for the Retry-After delay (1-2s is typical) and retry at most once.',
  502: 'Proma upstream is temporarily unavailable. Retry at most once; if it fails again, use the managed browser or report the failure.',
  503: 'The search tool is temporarily disabled on the server. Fall back to the managed browser or answer without live data.',
}

/** 搜索失败结果（带状态码时可用于特殊处理）。 */
export interface PromaWebSearchFailure {
  ok: false
  status?: number
  error: string
  hint?: string
}

/** 搜索返回的单条结果。 */
export interface PromaWebSearchItem {
  title: string
  url: string
  snippet?: string
  summary?: string
  content?: string
  date: string | null
  siteName: string | null
  authority: number | null
  score: number | null
}

export type PromaWebSearchResult =
  | {
      ok: true
      query: string
      resultCount: number
      results: PromaWebSearchItem[]
      note?: string
    }
  | PromaWebSearchFailure

export type PromaWebFetchResult =
  | {
      ok: true
      url: string
      title: string
      content: string
      truncated?: boolean
    }
  | PromaWebSearchFailure

/** 已解析的凭据；只在主进程内使用，不进入任何返回值。 */
interface PromaCloudCredentials {
  apiKey: string
  apiRoot: string
}

/** 请求依赖；单测注入假 fetch 与固定凭据，生产按用户代理设置与本地配置解析。 */
export interface PromaCloudRequestDeps {
  fetchImpl: typeof globalThis.fetch
  credentials: PromaCloudCredentials | null
}

/** 默认依赖：按用户代理设置取 fetch，凭据来自本机配置。 */
async function resolveDefaultDeps(): Promise<PromaCloudRequestDeps> {
  const proxyUrl = await getEffectiveProxyUrl()
  return {
    fetchImpl: getFetchFn(proxyUrl),
    credentials: resolvePromaCloudCredentials(),
  }
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从错误响应体里取最能说明原因的文字；取不到时用兜底文案。 */
export function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const detail = record.detail
    const nested = record.error
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    if (nested && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>).message
      if (typeof message === 'string') return message.trim() || fallback
    }
  }
  return fallback
}

/** 单条搜索结果归一化；没有 url 的条目直接丢弃。 */
export function normalizeSearchItem(raw: unknown): PromaWebSearchItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const url = readString(item.url)
  if (!url) return null
  return {
    title: readString(item.title) ?? url,
    url,
    snippet: readString(item.snippet),
    summary: readString(item.summary),
    content: readString(item.content),
    date: typeof item.date === 'string' ? item.date : null,
    siteName: readString(item.site_name) ?? null,
    authority: readNumber(item.authority),
    score: readNumber(item.rerank_score),
  }
}

type PostResult = { ok: true; payload: unknown } | PromaWebSearchFailure

/** POST 一次工具接口，把网络异常与 HTTP 错误统一转成失败结果。 */
async function postToolApi(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  deps: PromaCloudRequestDeps,
): Promise<PostResult> {
  const credentials: PromaCloudCredentials | null = deps.credentials
  if (!credentials || !credentials.apiKey) {
    return {
      ok: false,
      error: 'Proma Cloud API key is not configured.',
      hint: 'Web search is unavailable in this run. Use the managed browser instead.',
    }
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    response = await deps.fetchImpl(`${credentials.apiRoot}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return {
      ok: false,
      error: timedOut
        ? 'Search request timed out.'
        : `Search request failed: ${error instanceof Error ? error.message : String(error)}`,
      hint: timedOut ? 'Retry at most once, then fall back to the managed browser.' : undefined,
    }
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: errorMessage(payload, `Proma search API returned HTTP ${response.status}.`),
      hint: STATUS_HINTS[response.status],
    }
  }

  return { ok: true, payload }
}

/** 搜索公开网页；空结果返回 note 但不计费。 */
export async function searchPromaWeb(
  params: {
    query: string
    count?: number
    needContent?: boolean
    oriQuestion?: string
    localization?: string
  },
  signal?: AbortSignal,
  deps?: PromaCloudRequestDeps,
): Promise<PromaWebSearchResult> {
  const body: Record<string, unknown> = {
    query: params.query,
    count: params.count ?? 10,
    need_content: params.needContent === true,
  }
  if (params.oriQuestion) body.ori_question = params.oriQuestion
  if (params.localization) body.localization = params.localization

  const resolvedDeps = deps ?? (await resolveDefaultDeps())
  const response = await postToolApi('/api/v1/tools/search', body, signal, resolvedDeps)
  if (response.ok === false) {
    if (response.status === 404) {
      return {
        ...response,
        hint: 'This Proma API build does not expose web search yet. Use the managed browser instead of retrying.',
      }
    }
    return response
  }

  const payload = response.payload as { results?: unknown } | null
  const rawResults = Array.isArray(payload?.results) ? payload.results : []
  const results = rawResults
    .map(normalizeSearchItem)
    .filter((item): item is PromaWebSearchItem => item !== null)

  return {
    ok: true,
    query: params.query,
    resultCount: results.length,
    results,
    note: results.length === 0
      ? 'No results. Broaden the query, drop overly strict operators, or try another language; this call was not billed.'
      : undefined,
  }
}

/** 抓取单个网页正文并转成 Markdown（由上游完成转换），超长时截断。 */
export async function fetchPromaPage(
  url: string,
  signal?: AbortSignal,
  deps?: PromaCloudRequestDeps,
): Promise<PromaWebFetchResult> {
  const resolvedDeps = deps ?? (await resolveDefaultDeps())
  const response = await postToolApi('/api/v1/tools/fetch', { url }, signal, resolvedDeps)
  if (response.ok === false) return response

  const payload = response.payload as { content?: unknown; title?: unknown } | null
  const content = readString(payload?.content)
  if (!content) {
    return {
      ok: false,
      status: 404,
      error: 'The page returned no extractable content.',
      hint: STATUS_HINTS[404],
    }
  }

  const clipped = truncate(content, MAX_FETCH_CONTENT_CHARS)
  return {
    ok: true,
    url,
    title: readString(payload?.title) ?? url,
    content: clipped.text,
    truncated: clipped.truncated || undefined,
  }
}

/**
 * 连接测试：只验证 Key 与地址是否可用，不写入配置、不扣积分。
 *
 * 鉴权先于参数校验，空查询必然被拒（400/422），因此这次请求不计费。
 */
export async function testPromaCloudConnection(
  input?: { apiKey?: string; baseUrl?: string },
  deps?: PromaCloudRequestDeps,
): Promise<PromaCloudConnectionTestResult> {
  let credentials: PromaCloudCredentials | null
  if (deps) {
    credentials = deps.credentials
  } else {
    const saved = resolvePromaCloudCredentials()
    const draftKey = (input?.apiKey ?? '').trim()
    if (draftKey || input?.baseUrl !== undefined) {
      let apiRoot: string
      try {
        apiRoot = normalizePromaCloudBaseUrl(input?.baseUrl ?? saved?.apiRoot)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '服务地址格式不正确' }
      }
      const apiKey = draftKey || saved?.apiKey || ''
      // 显式传入 apiKey 为空串时会落到已保存的 Key；两者都没有才算未配置。
      credentials = apiKey ? { apiKey, apiRoot } : null
    } else {
      credentials = saved
    }
  }

  if (!credentials) return { ok: false, message: '请先填写 Proma Cloud API Key' }

  const fetchImpl = deps?.fetchImpl ?? getFetchFn(await getEffectiveProxyUrl())

  let response: Response
  try {
    response = await fetchImpl(`${credentials.apiRoot}/api/v1/tools/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '', count: 1 }),
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return {
      ok: false,
      message: timedOut
        ? '无法连接 Proma Cloud：请求超时'
        : `无法连接 Proma Cloud：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (response.status === 200) return { ok: true, message: 'Key 有效，联网检索可用' }
  // 400/422 说明请求已通过鉴权，只因参数不合法被拒——正是本次探测的预期结果。
  if (response.status === 400 || response.status === 422) {
    return { ok: true, message: 'Key 有效，联网检索可用' }
  }
  if (response.status === 401) return { ok: false, message: 'Key 无效或已撤销' }
  if (response.status === 402) return { ok: true, message: 'Key 有效，但账户积分不足' }
  if (response.status === 404) return { ok: false, message: '该服务地址没有联网检索接口，请检查服务地址' }
  return { ok: false, message: `Proma Cloud 返回 HTTP ${response.status}` }
}
