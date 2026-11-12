/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Agent 会话首页）
 * - favorites: 收藏会话（左侧面板切换为收藏列表，主区仍显示会话）
 * - automations: 定时任务（左侧面板切换为任务列表，主区为欢迎页 / 表单 / 运行会话）
 * - planning: Todo 与日程（仅保留 rail，页面自带左侧导航）
 * - memory: 记忆整页（仅保留 rail）
 * - agent-skills: Skills/MCP 全屏管理视图（仅保留 rail）
 * - vault: Obsidian Vault 视图
 *
 * 对齐商业版 0.21.88：conversations / favorites / automations / vault 显示「rail + 侧栏面板」，
 * 其余视图只显示 60px rail（utilityRailOnly）。
 */

import { atom } from 'jotai'
import { activeTabIdAtom, tabsAtom, type PersistedTabState, type TabItem } from './tab-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from './agent-atoms'
import { automationFormAtom } from './automation-atoms'
import { lastFavoriteSessionIdAtom } from './sidebar-atoms'

export type ActiveView = 'conversations' | 'favorites' | 'automations' | 'planning' | 'memory' | 'agent-skills' | 'vault'

/** 显示「rail + 侧栏面板」的视图（商业版 p9e） */
export function isSidebarPanelView(view: ActiveView): boolean {
  return view === 'conversations' || view === 'favorites' || view === 'automations' || view === 'vault'
}

/** 只显示 60px rail 的视图（商业版 PZt：vault 也只保留 rail） */
export function isUtilityRailOnlyView(view: ActiveView): boolean {
  return view === 'vault' || !isSidebarPanelView(view)
}
export type AgentSkillsCapabilityTab = 'skills' | 'mcp' | 'memory'

/** 拥有独立会话 Tab 集合的视图：会话首页、收藏、定时任务（商业版 Bs 的切换分支）。 */
export type TabHostView = 'conversations' | 'favorites' | 'automations'

export function isTabHostView(view: ActiveView): view is TabHostView {
  return view === 'conversations' || view === 'favorites' || view === 'automations'
}

interface ViewTabSnapshot extends PersistedTabState {
  workspaceId: string | null
}

/** 视图实际值（不持久化，每次启动默认显示对话） */
const baseActiveViewAtom = atom<ActiveView>('conversations')
/** 当前 tabsAtom 归属的视图（商业版 pB） */
const tabHostViewAtom = atom<TabHostView>('conversations')
/** 各视图离开时保存的 Tab 集合（商业版 dx） */
const viewTabSnapshotsAtom = atom<Partial<Record<TabHostView, ViewTabSnapshot>>>({})

/** 可跨视图保存与恢复的 Tab：当前只有会话 Tab（商业版 Uc）。 */
function isRestorableTab(tab: TabItem): boolean {
  if (!tab || typeof tab.sessionId !== 'string' || tab.sessionId.trim().length === 0) return false
  return tab.type === 'agent' && tab.id === tab.sessionId
}

/**
 * 当前活跃视图。
 *
 * 对齐商业版 0.21.88：会话首页、收藏、定时任务各自持有一组会话 Tab。切换到另一个 Tab 宿主视图时，
 * 先保存当前视图的 Tab 集合，再恢复目标视图上次的集合；定时任务每次进入都从空集合开始（主区显示欢迎页），
 * 收藏只有在上次查看的会话仍被收藏时才恢复。切换时关闭定时任务表单。
 */
export const activeViewAtom = atom(
  (get) => get(baseActiveViewAtom),
  (get, set, next: ActiveView) => {
    const host = get(tabHostViewAtom)
    if (isTabHostView(next) && (next !== host || next === 'automations')) {
      const sessions = get(agentSessionsAtom)
      if (host !== 'automations') {
        const tabs = get(tabsAtom)
        const activeTabId = get(activeTabIdAtom)
        const activeTab = tabs.find((tab) => tab.id === activeTabId)
        const activeSession = sessions.find((session) => session.id === activeTab?.sessionId)
        set(viewTabSnapshotsAtom, (previous) => ({
          ...previous,
          [host]: {
            tabs: tabs.filter(isRestorableTab),
            activeTabId,
            workspaceId: activeSession?.workspaceId ?? get(currentAgentWorkspaceIdAtom),
          },
        }))
      }

      let snapshot = next === 'automations' ? undefined : get(viewTabSnapshotsAtom)[next]
      if (next === 'favorites') {
        const lastFavoriteId = get(lastFavoriteSessionIdAtom)
        if (!sessions.some((session) => session.id === lastFavoriteId && session.starred)) {
          snapshot = undefined
          set(lastFavoriteSessionIdAtom, null)
        }
      }

      const tabs = (snapshot?.tabs ?? []).filter(isRestorableTab)
      const activeTabId = tabs.find((tab) => tab.id === snapshot?.activeTabId)?.id ?? tabs[0]?.id ?? null
      const activeTab = tabs.find((tab) => tab.id === activeTabId)
      set(tabHostViewAtom, next)
      set(tabsAtom, tabs)
      set(activeTabIdAtom, activeTabId)
      set(currentAgentSessionIdAtom, activeTab?.sessionId ?? null)
      if (snapshot) {
        const activeSession = sessions.find((session) => session.id === activeTab?.sessionId)
        set(currentAgentWorkspaceIdAtom, activeSession?.workspaceId ?? snapshot.workspaceId)
      }
      set(automationFormAtom, (previous) => ({ ...previous, open: false }))
    }
    set(baseActiveViewAtom, next)
  },
)

/**
 * 需要持久化到 settings.tabState 的会话首页 Tab 集合（商业版 QL）：
 * 当前在会话首页时取实时 Tab，否则取离开会话首页时保存的集合。
 */
export const conversationTabStateAtom = atom<PersistedTabState>((get) => {
  if (get(tabHostViewAtom) === 'conversations') {
    return { tabs: get(tabsAtom), activeTabId: get(activeTabIdAtom) }
  }
  const snapshot = get(viewTabSnapshotsAtom).conversations
  return snapshot ? { tabs: snapshot.tabs, activeTabId: snapshot.activeTabId } : { tabs: [], activeTabId: null }
})

/** Agent 技能视图当前子页，用于外部入口直达 MCP 管理 */
export const agentSkillsTabAtom = atom<AgentSkillsCapabilityTab>('skills')
/** 外部入口要求技能中心打开指定 Skill 详情。 */
export const pendingAgentSkillSlugAtom = atom<string | null>(null)
