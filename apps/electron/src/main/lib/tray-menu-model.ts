import { compareAgentSessionsByActivityDesc, type AgentSessionMeta, type AgentWorkspace } from '@proma/shared'

export const TRAY_RECENT_LIMIT = 3
export const TRAY_MORE_LIMIT = 10

export interface TrayRecentSessionItem {
  id: string
  title: string
  subtitle: string
}

export interface TrayMenuModel {
  runningSessions: TrayRecentSessionItem[]
  recentSessions: TrayRecentSessionItem[]
  moreSessions: TrayRecentSessionItem[]
}

function getWorkspaceLabel(session: AgentSessionMeta, workspacesById: Map<string, AgentWorkspace>): string {
  if (!session.workspaceId) return '未选择项目'
  const workspace = workspacesById.get(session.workspaceId)
  return workspace?.name ?? '未知项目'
}

function toRecentSessionItem(
  session: AgentSessionMeta,
  workspacesById: Map<string, AgentWorkspace>,
): TrayRecentSessionItem {
  return {
    id: session.id,
    title: session.title.trim() || '未命名会话',
    subtitle: getWorkspaceLabel(session, workspacesById),
  }
}

export function createTrayMenuModel(
  sessions: AgentSessionMeta[],
  workspaces: AgentWorkspace[],
  runningSessionIds: Set<string> = new Set(),
): TrayMenuModel {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  // 托盘「最近会话」按最后活跃时间排序：标记已读、改标题等元数据变更不应让
  // 旧会话挤掉用户真正刚用过的会话。
  const visibleSessions = sessions
    .filter((session) => !session.archived || runningSessionIds.has(session.id))
    .slice()
    .sort(compareAgentSessionsByActivityDesc)

  const runningSessions = visibleSessions
    .filter((session) => runningSessionIds.has(session.id))
    .map((session) => toRecentSessionItem(session, workspacesById))

  const recentSessions = visibleSessions
    .filter((session) => !runningSessionIds.has(session.id))
    .slice(0, TRAY_MORE_LIMIT)
    .map((session) => toRecentSessionItem(session, workspacesById))

  return {
    runningSessions,
    recentSessions: recentSessions.slice(0, TRAY_RECENT_LIMIT),
    moreSessions: recentSessions.slice(TRAY_RECENT_LIMIT),
  }
}
