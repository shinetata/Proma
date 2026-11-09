/**
 * 收藏面板的数据整理 — 复刻商业版 0.21.88（`kM` / `ZPt` / `Hf`）
 */

import { getAgentSessionActivityAt, type AgentSessionMeta, type AgentWorkspace } from '@proma/shared'

export type FavoriteSort = 'collected' | 'updated' | 'project'
export type FavoriteArchiveFilter = 'active' | 'archived'

export const FAVORITE_SORT_OPTIONS: ReadonlyArray<readonly [FavoriteSort, string]> = [
  ['collected', '按收藏时间'],
  ['updated', '按最新活跃'],
  ['project', '按项目'],
]

export interface FavoriteSessionEntry {
  session: AgentSessionMeta
  workspace: AgentWorkspace | undefined
  archived: boolean
}

/** 会话所属项目；workspaceId 缺失或项目已不存在时回退到默认项目。 */
export function resolveSessionWorkspaceId(session: AgentSessionMeta, workspaces: AgentWorkspace[]): string | undefined {
  if (session.workspaceId && workspaces.some((workspace) => workspace.id === session.workspaceId)) {
    return session.workspaceId
  }
  return workspaces.find((workspace) => workspace.slug === 'default')?.id ?? workspaces[0]?.id
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function getStarredAt(session: AgentSessionMeta): number {
  return session.starredAt ?? session.updatedAt
}

function compareZh(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN')
}

export function listFavoriteSessions({
  sessions,
  workspaces,
  query = '',
  sort = 'collected',
  archiveFilter = 'active',
}: {
  sessions: AgentSessionMeta[]
  workspaces: AgentWorkspace[]
  query?: string
  sort?: FavoriteSort
  archiveFilter?: FavoriteArchiveFilter
}): FavoriteSessionEntry[] {
  const normalizedQuery = normalizeQuery(query)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  return sessions
    .filter((session) => session.starred && !session.isDraft)
    .map((session) => {
      const workspaceId = resolveSessionWorkspaceId(session, workspaces)
      const workspace = workspaceId ? workspaceById.get(workspaceId) : undefined
      return { session, workspace, archived: !!session.archived }
    })
    .filter((entry) => (archiveFilter === 'archived' ? entry.archived : !entry.archived))
    .filter(({ session, workspace }) => (
      normalizedQuery
        ? normalizeQuery(session.title).includes(normalizedQuery) || normalizeQuery(workspace?.name ?? '').includes(normalizedQuery)
        : true
    ))
    .sort((a, b) => {
      if (sort === 'project') {
        const byProject = compareZh(a.workspace?.name ?? '未归属项目', b.workspace?.name ?? '未归属项目')
        if (byProject !== 0) return byProject
        const byStarred = getStarredAt(b.session) - getStarredAt(a.session)
        if (byStarred !== 0) return byStarred
      } else {
        // 「按最新活跃」用活动时间，不看元数据写入时间。
        const delta = sort === 'updated'
          ? getAgentSessionActivityAt(b.session) - getAgentSessionActivityAt(a.session)
          : getStarredAt(b.session) - getStarredAt(a.session)
        if (delta !== 0) return delta
      }
      const byTitle = compareZh(a.session.title, b.session.title)
      return byTitle !== 0 ? byTitle : a.session.id.localeCompare(b.session.id)
    })
}

/** 进入收藏面板且没有当前会话时，自动打开的收藏会话：优先置顶，其次第一条；活跃为空时回退归档收藏。 */
export function pickInitialFavoriteSession(params: {
  sessions: AgentSessionMeta[]
  workspaces: AgentWorkspace[]
  sort: FavoriteSort
  archiveFilter: FavoriteArchiveFilter
}): FavoriteSessionEntry | undefined {
  const entries = listFavoriteSessions(params)
  if (entries.length > 0) {
    return (params.archiveFilter === 'active' ? entries.find((entry) => entry.session.pinned) : undefined) ?? entries[0]
  }
  return params.archiveFilter === 'active'
    ? listFavoriteSessions({ ...params, archiveFilter: 'archived' })[0]
    : undefined
}
