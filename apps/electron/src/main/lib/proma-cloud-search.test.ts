/**
 * Proma Cloud 联网检索请求模块单测
 *
 * 全部使用注入的假 fetch 与固定凭据，不发真实请求、不使用真实 Key。
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'

const TEST_KEY = 'sk-test-abcdef0123456789'

mock.module('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8').slice(4),
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

type SearchModule = typeof import('./proma-cloud-search')
let search: SearchModule

const CONFIGURED = { apiKey: TEST_KEY, apiRoot: 'https://api.proma.cool' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deps(fetchImpl: typeof globalThis.fetch, credentials: { apiKey: string; apiRoot: string } | null = CONFIGURED) {
  return { fetchImpl, credentials }
}

beforeAll(async () => {
  search = await import('./proma-cloud-search')
})

describe('searchPromaWeb', () => {
  test('Given a successful response When searching Then fields are mapped and rerank_score becomes score', async () => {
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url)
      requestedInit = init
      return jsonResponse(200, {
        results: [
          {
            title: '示例标题',
            url: 'https://example.com/a',
            snippet: '短摘要',
            summary: '长摘要',
            date: '2026-10-01T00:00:00+00:00',
            site_name: '示例站',
            authority: 3,
            rerank_score: 2.4,
          },
          // 没有 url 的条目必须被丢弃
          { title: '缺链接' },
        ],
      })
    }) as typeof globalThis.fetch

    const result = await search.searchPromaWeb({ query: 'proma cloud', count: 5, oriQuestion: '原始问题' }, undefined, deps(fetchImpl))

    expect(requestedUrl).toBe('https://api.proma.cool/api/v1/tools/search')
    expect((requestedInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      query: 'proma cloud',
      count: 5,
      need_content: false,
      ori_question: '原始问题',
    })

    expect(result.ok).toBe(true)
    if (result.ok !== true) throw new Error('expected success')
    expect(result.resultCount).toBe(1)
    expect(result.results[0]).toEqual({
      title: '示例标题',
      url: 'https://example.com/a',
      snippet: '短摘要',
      summary: '长摘要',
      content: undefined,
      date: '2026-10-01T00:00:00+00:00',
      siteName: '示例站',
      authority: 3,
      score: 2.4,
    })
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  test('Given an empty result set When searching Then a free-result note is returned', async () => {
    const fetchImpl = (async () => jsonResponse(200, { results: [] })) as unknown as typeof globalThis.fetch
    const result = await search.searchPromaWeb({ query: 'nothing' }, undefined, deps(fetchImpl))
    expect(result.ok).toBe(true)
    if (result.ok !== true) throw new Error('expected success')
    expect(result.resultCount).toBe(0)
    expect(result.note).toBe('No results. Broaden the query, drop overly strict operators, or try another language; this call was not billed.')
  })

  test('Given no configured key When searching Then no request is sent', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return jsonResponse(200, { results: [] })
    }) as unknown as typeof globalThis.fetch

    const result = await search.searchPromaWeb({ query: 'x' }, undefined, deps(fetchImpl, null))
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('expected failure')
    expect(result.error).toBe('Proma Cloud API key is not configured.')
    expect(result.hint).toBe('Web search is unavailable in this run. Use the managed browser instead.')
  })

  test('Given a 401 When searching Then the hint points at the capability centre instead of login', async () => {
    const fetchImpl = (async () => jsonResponse(401, { detail: 'Invalid token' })) as unknown as typeof globalThis.fetch
    const result = await search.searchPromaWeb({ query: 'x' }, undefined, deps(fetchImpl))
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('expected failure')
    expect(result.status).toBe(401)
    expect(result.error).toBe('Invalid token')
    expect(result.hint).toContain('Capabilities → MCP → Proma Cloud')
    expect(result.hint).not.toContain('login')
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  test('Given 402/404/429 When searching Then hints match the commercial build', async () => {
    const statuses = [402, 404, 429]
    for (const status of statuses) {
      const fetchImpl = (async () => jsonResponse(status, { detail: `err-${status}` })) as unknown as typeof globalThis.fetch
      const result = await search.searchPromaWeb({ query: 'x' }, undefined, deps(fetchImpl))
      expect(result.ok).toBe(false)
      if (result.ok !== false) throw new Error('expected failure')
      expect(result.status).toBe(status)
      if (status === 404) {
        expect(result.hint).toBe('This Proma API build does not expose web search yet. Use the managed browser instead of retrying.')
      } else {
        expect(result.hint).toBe(search.STATUS_HINTS[status])
      }
    }
  })

  test('Given a timeout When searching Then the retry-once hint is returned', async () => {
    const timeoutError = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    const fetchImpl = (async () => { throw timeoutError }) as unknown as typeof globalThis.fetch
    const result = await search.searchPromaWeb({ query: 'x' }, undefined, deps(fetchImpl))
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('expected failure')
    expect(result.error).toBe('Search request timed out.')
    expect(result.hint).toBe('Retry at most once, then fall back to the managed browser.')
  })

  test('Given a generic network error When searching Then no retry hint is added', async () => {
    const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof globalThis.fetch
    const result = await search.searchPromaWeb({ query: 'x' }, undefined, deps(fetchImpl))
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('expected failure')
    expect(result.error).toBe('Search request failed: getaddrinfo ENOTFOUND')
    expect(result.hint).toBeUndefined()
  })
})

describe('fetchPromaPage', () => {
  test('Given a long page When fetching Then content is truncated and marked', async () => {
    const longContent = 'x'.repeat(search.MAX_FETCH_CONTENT_CHARS + 100)
    let requestedUrl = ''
    const fetchImpl = (async (url: string | URL | Request) => {
      requestedUrl = String(url)
      return jsonResponse(200, { title: '长页面', content: longContent })
    }) as unknown as typeof globalThis.fetch

    const result = await search.fetchPromaPage('https://example.com/long', undefined, deps(fetchImpl))
    expect(requestedUrl).toBe('https://api.proma.cool/api/v1/tools/fetch')
    expect(result.ok).toBe(true)
    if (result.ok !== true) throw new Error('expected success')
    expect(result.title).toBe('长页面')
    expect(result.content.length).toBe(search.MAX_FETCH_CONTENT_CHARS)
    expect(result.truncated).toBe(true)
  })

  test('Given no extractable content When fetching Then it is reported as 404 with the source hint', async () => {
    const fetchImpl = (async () => jsonResponse(200, { title: '空页面' })) as unknown as typeof globalThis.fetch
    const result = await search.fetchPromaPage('https://example.com/empty', undefined, deps(fetchImpl))
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('expected failure')
    expect(result.status).toBe(404)
    expect(result.error).toBe('The page returned no extractable content.')
    expect(result.hint).toBe(search.STATUS_HINTS[404])
  })
})

describe('testPromaCloudConnection', () => {
  test('Given a 400 (auth passed, params rejected) When testing Then the key is reported valid', async () => {
    const fetchImpl = (async () => jsonResponse(400, { detail: 'query required' })) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result).toEqual({ ok: true, message: 'Key 有效，联网检索可用' })
  })

  test('Given a 401 When testing Then the key is reported invalid', async () => {
    const fetchImpl = (async () => jsonResponse(401, { detail: 'Invalid token' })) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result).toEqual({ ok: false, message: 'Key 无效或已撤销' })
  })

  test('Given a 402 When testing Then the key is valid but credits are insufficient', async () => {
    const fetchImpl = (async () => jsonResponse(402, { detail: 'no credits' })) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result).toEqual({ ok: true, message: 'Key 有效，但账户积分不足' })
  })

  test('Given a 404 When testing Then the address is reported as missing the tool API', async () => {
    const fetchImpl = (async () => jsonResponse(404, { detail: 'Not Found' })) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result).toEqual({ ok: false, message: '该服务地址没有联网检索接口，请检查服务地址' })
  })

  test('Given a network error When testing Then the reason is included without the key', async () => {
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result.ok).toBe(false)
    expect(result.message).toBe('无法连接 Proma Cloud：connect ECONNREFUSED')
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
  })

  test('Given an unexpected status When testing Then it is reported verbatim', async () => {
    const fetchImpl = (async () => jsonResponse(500, { detail: 'boom' })) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl))
    expect(result).toEqual({ ok: false, message: 'Proma Cloud 返回 HTTP 500' })
  })

  test('Given no credentials When testing Then it asks the user to fill the key first', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return jsonResponse(200, {}) }) as unknown as typeof globalThis.fetch
    const result = await search.testPromaCloudConnection(undefined, deps(fetchImpl, null))
    expect(called).toBe(false)
    expect(result).toEqual({ ok: false, message: '请先填写 Proma Cloud API Key' })
  })
})
