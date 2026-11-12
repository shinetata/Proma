/**
 * WebSearch 工具结果渲染器 — 搜索结果卡片
 *
 * 兼容三种输入：
 * - Proma Cloud 对象结果 `{ ok: true, results: [...], note? }`；
 * - 旧的 JSON 数组结果；
 * - 纯文本"标题 + URL + 摘要"段落。
 * 失败对象 `{ ok: false, error, hint? }` 按错误样式显示，hint 作为下一行小字。
 */

import * as React from 'react'
import { AlertCircle, Globe } from 'lucide-react'
import { CollapsibleResult } from './collapsible-result'

interface WebSearchResultRendererProps {
  result: string
  isError: boolean
}

interface SearchResult {
  title: string
  url: string
  snippet: string
  siteName?: string
  /** 已格式化为 YYYY-MM-DD 的发布时间 */
  date?: string
}

interface ParsedResults {
  kind: 'results'
  results: SearchResult[]
  note?: string
}

interface ParsedFailure {
  kind: 'error'
  error: string
  hint?: string
}

type ParsedSearch = ParsedResults | ParsedFailure

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把上游 ISO 时间裁剪为 YYYY-MM-DD；无法识别时返回 undefined。 */
function formatDate(value: unknown): string | undefined {
  const text = readString(value).trim()
  if (!text) return undefined
  const match = text.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : text
}

function normalizeItem(item: Record<string, unknown>): SearchResult {
  return {
    title: readString(item.title) || readString(item.url),
    url: readString(item.url) || readString(item.link),
    // Proma Cloud 结果优先 snippet，缺失时才用 summary。
    snippet: readString(item.snippet) || readString(item.summary) || readString(item.description),
    siteName: readString(item.siteName) || readString(item.site_name) || undefined,
    date: formatDate(item.date),
  }
}

/** 对象结果解析：成功取 results，失败取 error/hint。 */
function parseObjectResult(parsed: Record<string, unknown>): ParsedSearch | null {
  if (parsed.ok === false) {
    const error = readString(parsed.error) || '联网检索失败'
    const hint = readString(parsed.hint) || undefined
    return { kind: 'error', error, hint }
  }
  if (Array.isArray(parsed.results)) {
    const results = parsed.results
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => item.title || item.url)
      .map(normalizeItem)
    const note = readString(parsed.note) || undefined
    return { kind: 'results', results, note }
  }
  return null
}

/** 尝试解析搜索结果（支持 Proma Cloud 对象、JSON 数组与常见文本格式） */
function parseSearchResults(text: string): ParsedSearch | null {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      const results = parsed
        .filter((item: Record<string, unknown>) => item.title || item.url)
        .map((item: Record<string, unknown>) => ({
          title: String(item.title ?? ''),
          url: String(item.url ?? item.link ?? ''),
          snippet: String(item.snippet ?? item.description ?? item.content ?? ''),
        }))
      return { kind: 'results', results }
    }
    if (parsed && typeof parsed === 'object') {
      const objectResult = parseObjectResult(parsed as Record<string, unknown>)
      if (objectResult) return objectResult
    }
  } catch {
    // 非 JSON，尝试文本解析
  }

  // 尝试解析常见的文本格式（标题 + URL + 摘要，按段落分隔）
  const blocks = text.split(/\n{2,}/).filter(Boolean)
  if (blocks.length < 2) return null

  const results: SearchResult[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    if (lines.length >= 2) {
      const urlLine = lines.find((l) => l.match(/https?:\/\//))
      const titleLine = lines.find((l) => !l.match(/https?:\/\//) && l.length > 0)
      if (urlLine && titleLine) {
        const urlMatch = urlLine.match(/(https?:\/\/\S+)/)
        results.push({
          title: titleLine.replace(/^\d+\.\s*/, '').replace(/\*\*/g, ''),
          url: urlMatch?.[1] ?? urlLine,
          snippet: lines.filter((l) => l !== urlLine && l !== titleLine).join(' ').slice(0, 200),
        })
      }
    }
  }

  return results.length > 0 ? { kind: 'results', results } : null
}

export function WebSearchResultRenderer({ result, isError }: WebSearchResultRendererProps): React.ReactElement {
  const parsed = React.useMemo(() => parseSearchResults(result), [result])

  if (isError) {
    return (
      <pre className="rounded-md p-3 text-[12px] font-mono text-destructive/80 bg-destructive/5 whitespace-pre-wrap break-all overflow-x-auto">
        {result}
      </pre>
    )
  }

  if (parsed?.kind === 'error') {
    return (
      <div className="rounded-md bg-destructive/5 p-2.5 space-y-1">
        <div className="flex items-start gap-1.5">
          <AlertCircle className="mt-0.5 size-3 shrink-0 text-destructive/70" />
          <span className="text-[12px] text-destructive/80 break-all">{parsed.error}</span>
        </div>
        {parsed.hint && (
          <div className="pl-[18px] text-[11px] text-muted-foreground/70 leading-relaxed">{parsed.hint}</div>
        )}
      </div>
    )
  }

  // 无法解析为搜索结果时 fallback
  if (!parsed) {
    return (
      <CollapsibleResult
        content={result}
        renderContent={(text) => (
          <pre className="rounded-md p-3 text-[12px] font-mono text-foreground/60 bg-muted/30 whitespace-pre-wrap break-all overflow-x-auto">
            {text}
          </pre>
        )}
      />
    )
  }

  const searchResults = parsed.results

  if (searchResults.length === 0) {
    return (
      <div className="rounded-md bg-muted/20 p-2.5 space-y-1">
        <div className="text-[11px] text-muted-foreground/60">未返回结果</div>
        {parsed.note && (
          <div className="text-[11px] text-muted-foreground/70 leading-relaxed">{parsed.note}</div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground/60">
        {searchResults.length} 条结果
      </div>
      {searchResults.map((item, i) => {
        const meta = [item.siteName, item.date].filter(Boolean).join(' · ')
        return (
          <div key={i} className="rounded-md bg-muted/20 p-2.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <Globe className="size-3 shrink-0 text-muted-foreground/50" />
              <span className="text-[12px] font-medium text-foreground/80 truncate">
                {item.title}
              </span>
            </div>
            {item.url && (
              <div className="text-[11px] text-primary/60 font-mono truncate">
                {item.url}
              </div>
            )}
            {meta && (
              <div className="text-[11px] text-muted-foreground/50 truncate">{meta}</div>
            )}
            {item.snippet && (
              <div className="text-[11px] text-muted-foreground/70 leading-relaxed line-clamp-2">
                {item.snippet}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
