/**
 * Skill 使用统计 — 工作区汇总服务
 *
 * 扫描工作区最近的会话消息文件，汇总每个 Skill 被多少个会话加载过、最近一次是什么时候。
 * 会话消息可能很大，因此：
 * - 只读取最近 MAX_SESSIONS_PER_WORKSPACE 个会话（按最后活动时间倒序）；
 * - 用 mtime + size 把每个会话的解析结果缓存到 ~/.proma/skill-usage-cache.json，
 *   只有会话文件变化时才重新解析；
 * - 并发读文件但限制到 READ_CONCURRENCY，避免大量会话同时打开句柄；
 * - 同一工作区同时只跑一次汇总（inflight 去重），UI 重复请求不会重复扫描。
 */

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentWorkspace, SkillUsageSummary } from '@proma/shared'
import { getAgentSessionMessagesPath, getConfigDir } from './config-paths'
import { listAgentSessions } from './agent-session-manager'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { extractSkillActivations, type SkillUsageActivationRef } from './skill-usage-parse'
import { summarizeSkillUsage, type SessionSkillUsageRecord } from './skill-usage-aggregate'

/** 每个工作区最多统计多少个最近会话。 */
const MAX_SESSIONS_PER_WORKSPACE = 400
/** 同时读取的会话文件数上限。 */
const READ_CONCURRENCY = 8
/** 缓存结构版本；解析口径变化时递增以丢弃旧缓存。 */
const CACHE_VERSION = 1

interface CachedSessionUsage {
  mtimeMs: number
  size: number
  activations: SkillUsageActivationRef[]
}

interface SkillUsageCache {
  version: number
  sessions: Record<string, CachedSessionUsage>
}

let memoryCache: SkillUsageCache | null = null
const inflight = new Map<string, Promise<SkillUsageSummary>>()

function getCachePath(): string {
  return join(getConfigDir(), 'skill-usage-cache.json')
}

function loadCache(): SkillUsageCache {
  if (memoryCache) return memoryCache
  const cached = readJsonFileSafe<SkillUsageCache>(getCachePath())
  memoryCache = cached && cached.version === CACHE_VERSION && cached.sessions
    ? cached
    : { version: CACHE_VERSION, sessions: {} }
  return memoryCache
}

function saveCache(cache: SkillUsageCache): void {
  try {
    writeJsonFileAtomic(getCachePath(), cache)
  } catch (error) {
    console.warn('[Skill 使用统计] 写入缓存失败:', error)
  }
}

/** 读取单个会话的 Skill 激活记录；文件缺失或解析失败时返回 null。 */
async function readSessionUsage(sessionId: string): Promise<CachedSessionUsage | null> {
  const filePath = getAgentSessionMessagesPath(sessionId)
  try {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    const raw = await readFile(filePath, 'utf-8')
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      activations: extractSkillActivations(raw),
    }
  } catch (error) {
    console.warn(`[Skill 使用统计] 读取会话 ${sessionId} 失败:`, error)
    return null
  }
}

/** 限并发的 map，结果按输入顺序返回。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      // cursor 只会在 items.length 内递增，下标必然存在。
      results[index] = await mapper(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

async function collectSkillUsage(workspace: AgentWorkspace): Promise<SkillUsageSummary> {
  const sessions = listAgentSessions()
    .filter((session) => session.workspaceId === workspace.id)
    .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
    .slice(0, MAX_SESSIONS_PER_WORKSPACE)
  if (sessions.length === 0) return {}

  const cache = loadCache()
  let cacheDirty = false

  const records = await mapWithConcurrency(sessions, READ_CONCURRENCY, async (session) => {
    const filePath = getAgentSessionMessagesPath(session.id)
    let mtimeMs: number
    let size: number
    try {
      const stat = statSync(filePath)
      mtimeMs = stat.mtimeMs
      size = stat.size
    } catch {
      return { session, usage: null as CachedSessionUsage | null }
    }

    const cached = cache.sessions[session.id]
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return { session, usage: cached }
    }

    const usage = await readSessionUsage(session.id)
    if (usage) {
      cache.sessions[session.id] = usage
      cacheDirty = true
    }
    return { session, usage }
  })

  const sessionRecords: SessionSkillUsageRecord[] = []
  for (const { session, usage } of records) {
    if (!usage) continue
    sessionRecords.push({
      lastUsedAt: session.lastActivityAt ?? session.updatedAt,
      activations: usage.activations,
    })
  }

  // 已删除或移出统计窗口的会话不再占缓存。
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  for (const sessionId of Object.keys(cache.sessions)) {
    if (!liveSessionIds.has(sessionId)) {
      delete cache.sessions[sessionId]
      cacheDirty = true
    }
  }
  if (cacheDirty) saveCache(cache)

  return summarizeSkillUsage(sessionRecords, workspace.slug)
}

/**
 * 读取工作区的 Skill 使用统计，同一工作区并发请求复用同一次扫描。
 *
 * 返回的 key 是 Skill slug；工作区没有任何会话时返回空对象。
 */
export function getSkillUsageSummary(workspace: AgentWorkspace): Promise<SkillUsageSummary> {
  const existing = inflight.get(workspace.slug)
  if (existing) return existing

  const task = collectSkillUsage(workspace).finally(() => {
    inflight.delete(workspace.slug)
  })
  inflight.set(workspace.slug, task)
  return task
}
