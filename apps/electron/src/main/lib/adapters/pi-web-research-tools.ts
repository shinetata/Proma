/**
 * 联网检索工具：WebSearch / WebFetch
 *
 * 两个工具由主进程直连 Proma Cloud 完成，模型只需一次工具调用。
 * name、label、description、promptSnippet 与参数 schema 全部沿用商业版 0.22.28 原文：
 * 工作区 Skills 目录里已安装的 `proma-web-search` / `in-app-browser` 描述的就是这份契约。
 *
 * 成功时 WebSearch 返回 JSON 结果，WebFetch 返回 `# 标题 / URL / 正文` 文本；
 * 失败时返回 JSON，其中 hint 指明该重试、换来源还是转用受管浏览器。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { fetchPromaPage, searchPromaWeb } from '../proma-cloud-search'
import { serializePiToolResultPayload } from './pi-tool-result-json'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

const WEB_SEARCH_DESCRIPTION = 'Search the public web and return cited results with title, url, snippet, summary, publish date, site and authority. Use it for information that is current, changing or outside training data (news, releases, prices, versions, product or people details), for an explicit look-up, and for automation or delegated runs where no user-visible browser window exists. It is stateless and read-only, so independent calls issued in the same turn run in parallel: send two to four focused queries together when you need several angles instead of running them one by one. Each successful call bills the user credits, empty results are free, and a burst above four concurrent calls risks 429. Do not use it when the answer is stable knowledge, when the content is already in the conversation, or when the page needs interaction, a login, JavaScript rendering or the user must see it; those belong to BrowserObserve/BrowserNavigate.'

const WEB_SEARCH_PROMPT_SNIPPET = 'WebSearch: one focused query returns cited web results (title, url, snippet, summary, date, authority) through Proma Cloud in a single tool call; no HTTP code needed. It is parallel-safe: send two to four independent queries in one turn for breadth, not the same query twice, and keep bursts small to avoid 429. Empty results are free, successful searches bill credits. When a search fails, returns thin or stale results, or contradicts known facts, switch to the managed browser to open the source page and verify.'

const WEB_FETCH_DESCRIPTION = 'Fetch one specific page as Markdown. Use it after WebSearch when the answer lives in long-form content, or when the user names a page or provides a URL. Calls are stateless, so several URLs can be fetched in parallel in the same turn. One call bills the user credits, so fetch only the pages that matter instead of every search result. JavaScript-rendered pages, logins, forms and anything the user must interact with belong to the managed browser.'

const WEB_FETCH_PROMPT_SNIPPET = 'WebFetch: fetch one specific URL as Markdown after WebSearch points at long-form content; several independent URLs can be fetched in parallel. Do not fetch every result and do not re-fetch the same URL; each call bills credits. If a page fails, returns no content, or needs rendering or login, open it with the managed browser instead.'

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  const serialized = serializePiToolResultPayload(payload)
  return {
    content: [{ type: 'text', text: serialized.text }],
    details: serialized.details,
  } as AgentToolResult<unknown>
}

function textToolResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  const serialized = serializePiToolResultPayload(details)
  return {
    content: [{ type: 'text', text }],
    details: serialized.details,
  } as AgentToolResult<unknown>
}

/** 构建 WebSearch / WebFetch；凭据不可用时请求层直接返回失败，不会发请求。 */
export function buildWebResearchTools(sdk: PiSdk): ToolDefinition[] {
  return [
    sdk.defineTool({
      name: 'WebSearch',
      label: '联网搜索',
      description: WEB_SEARCH_DESCRIPTION,
      promptSnippet: WEB_SEARCH_PROMPT_SNIPPET,
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 128, description: 'Search query, 1-128 characters. Supports site:, -site:, -, "exact phrase", lang:, after:, before: operators.' }),
        count: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: 'Number of results, 1-50. Defaults to 10 and does not change the price.' })),
        need_content: Type.Optional(Type.Boolean({ description: 'Return page content inline. Usually false: judge relevance from snippet and summary, then WebFetch only the pages that matter.' })),
        ori_question: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'The user question that triggered this search, which improves query understanding.' })),
        localization: Type.Optional(Type.String({ description: 'Optional IP address used to localize results.' })),
      }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = params as Record<string, unknown>
        return jsonToolResult(await searchPromaWeb({
          query: typeof args.query === 'string' ? args.query : '',
          count: typeof args.count === 'number' ? args.count : undefined,
          needContent: args.need_content === true,
          oriQuestion: typeof args.ori_question === 'string' ? args.ori_question : undefined,
          localization: typeof args.localization === 'string' ? args.localization : undefined,
        }, signal))
      },
    }),
    sdk.defineTool({
      name: 'WebFetch',
      label: '抓取网页正文',
      description: WEB_FETCH_DESCRIPTION,
      promptSnippet: WEB_FETCH_PROMPT_SNIPPET,
      parameters: Type.Object({
        url: Type.String({ minLength: 1, maxLength: 8192, description: 'Absolute http(s) URL without embedded credentials; usually taken from a previous WebSearch result.' }),
      }),
      async execute(_toolCallId, params, signal?: AbortSignal) {
        const args = params as Record<string, unknown>
        const url = typeof args.url === 'string' ? args.url : ''
        const page = await fetchPromaPage(url, signal)
        if (page.ok === false) return jsonToolResult(page)
        const heading = page.title && page.title !== page.url
          ? `# ${page.title}\n\n${page.url}`
          : `# ${page.url}`
        const truncated = page.truncated ? '\n\n> Content truncated at 40,000 characters.' : ''
        return textToolResult(`${heading}\n\n${page.content}${truncated}`, {
          url: page.url,
          title: page.title,
          truncated: page.truncated === true,
        })
      },
    }),
  ] as ToolDefinition[]
}
