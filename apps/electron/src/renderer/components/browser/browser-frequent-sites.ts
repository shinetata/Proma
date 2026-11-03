/**
 * 受管浏览器常用网站统计。
 *
 * 对齐商业版 0.21.88 的 `proma-browser-frequent-sites`：按 origin 聚合访问次数，
 * 只保留 30 天内访问过的 12 个站点，供右侧工作区「新建标签页」的推荐区使用。
 */

import { atomWithStorage } from 'jotai/utils'

export interface BrowserFrequentSite {
  origin: string
  visitCount: number
  lastVisitedAt: number
}

const MAX_FREQUENT_SITES = 12
const FREQUENT_SITE_TTL_MS = 720 * 60 * 60 * 1000

export const browserFrequentSitesAtom = atomWithStorage<BrowserFrequentSite[]>(
  'proma-browser-frequent-sites',
  [],
  undefined,
  { getOnInit: true },
)

function normalizeSiteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol !== 'https:' && parsed.protocol !== 'http:' ? null : `${parsed.origin}/`
  } catch {
    return null
  }
}

export function getFrequentSites(sites: readonly BrowserFrequentSite[], now = Date.now()): BrowserFrequentSite[] {
  const cutoff = now - FREQUENT_SITE_TTL_MS
  const merged = new Map<string, BrowserFrequentSite>()
  for (const site of sites) {
    const origin = normalizeSiteOrigin(site.origin)
    if (!origin || !Number.isFinite(site.visitCount) || !Number.isFinite(site.lastVisitedAt) || site.lastVisitedAt < cutoff) continue
    const existing = merged.get(origin)
    merged.set(origin, existing
      ? { origin, visitCount: existing.visitCount + Math.max(0, site.visitCount), lastVisitedAt: Math.max(existing.lastVisitedAt, site.lastVisitedAt) }
      : { origin, visitCount: Math.max(0, site.visitCount), lastVisitedAt: site.lastVisitedAt })
  }
  return [...merged.values()]
    .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, MAX_FREQUENT_SITES)
}

export function recordFrequentSiteVisit(
  sites: readonly BrowserFrequentSite[],
  { url, visitedAt = Date.now() }: { url: string; visitedAt?: number },
): BrowserFrequentSite[] {
  const origin = normalizeSiteOrigin(url)
  if (!origin) return sites as BrowserFrequentSite[]
  const current = getFrequentSites(sites, visitedAt)
  const index = current.findIndex((site) => site.origin === origin)
  const visited = index >= 0
    ? { ...current[index]!, visitCount: current[index]!.visitCount + 1, lastVisitedAt: visitedAt }
    : { origin, visitCount: 1, lastVisitedAt: visitedAt }
  return (index >= 0 ? current.map((site, i) => i === index ? visited : site) : [...current, visited])
    .sort((a, b) => b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, MAX_FREQUENT_SITES)
}
