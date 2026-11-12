/**
 * Tab Atoms — 当前工作区入口状态管理
 *
 * 顶部只保留当前会话入口；会话恢复与导航交给左侧列表。
 * 文件预览不再占用主内容区标签，一律在右侧工作区里以标签形式呈现，
 * 因此这里只维护 Agent 会话标签的状态。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  agentRunningSessionIdsAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
} from './agent-atoms'
import type { SessionIndicatorStatus } from './agent-atoms'

// ===== 类型定义 =====

/** 标签页类型（Settings 不作为 Tab，保留独立视图） */
export type TabType = 'agent'

/** 标签页数据 */
export interface TabItem {
  /** 唯一标签 ID（直接使用 sessionId） */
  id: string
  /** 标签页类型 */
  type: TabType
  /** Agent sessionId */
  sessionId: string
  /** 标签页显示标题 */
  title: string
}

/** Tab 持久化数据（保存到 settings.json） */
export interface PersistedTabState {
  tabs: TabItem[]
  activeTabId: string | null
}

// ===== 核心 Atoms =====

/** 顶部入口列表：当前会话 */
export const tabsAtom = atom<TabItem[]>([])

/** 当前激活的标签 ID */
export const activeTabIdAtom = atom<string | null>(null)

/** 标签页 MRU（最近使用）顺序，最近使用的 ID 排在前面 */
export const tabMruAtom = atom<string[]>([])

/** 侧边栏是否收起（持久化） */
export const sidebarCollapsedAtom = atomWithStorage<boolean>(
  'proma-sidebar-collapsed',
  false,
)

/** Tab 迷你地图缓存（每个 Tab 的消息预览列表，在消息组件中填充） */
export interface TabMinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
}
export const tabMinimapCacheAtom = atom<Map<string, TabMinimapItem[]>>(new Map())

// ===== 派生 Atoms =====

/** 当前活跃标签 */
export const activeTabAtom = atom<TabItem | null>((get) => {
  const activeId = get(activeTabIdAtom)
  if (!activeId) return null
  return get(tabsAtom).find((t) => t.id === activeId) ?? null
})

/** 当前活跃标签所属的会话 ID */
export const activeSessionIdAtom = atom<string | null>((get) => {
  const activeTab = get(activeTabAtom)
  return activeTab?.sessionId ?? null
})

/** 标签是否在流式输出中（派生，从 Agent 运行状态计算） */
export const tabStreamingMapAtom = atom<Map<string, boolean>>((get) => {
  const tabs = get(tabsAtom)
  const agentRunning = get(agentRunningSessionIdsAtom)
  const map = new Map<string, boolean>()
  for (const tab of tabs) {
    map.set(tab.id, agentRunning.has(tab.sessionId))
  }
  return map
})

/** 标签页指示点状态 */
export const tabIndicatorMapAtom = atom<Map<string, SessionIndicatorStatus>>((get) => {
  const tabs = get(tabsAtom)
  const agentIndicator = get(agentSessionIndicatorMapAtom)
  const unviewedCompletedIds = get(unviewedCompletedSessionIdsAtom)
  const map = new Map<string, SessionIndicatorStatus>()
  for (const tab of tabs) {
    const status = agentIndicator.get(tab.sessionId)
      ?? (unviewedCompletedIds.has(tab.sessionId) ? 'completed' : 'idle')
    map.set(tab.id, status)
  }
  return map
})

// ===== 操作函数 =====

/** Agent 会话标签是唯一可承载右侧工作区的标签类型。 */
export function isAgentContextTab(tab: TabItem | undefined): boolean {
  return tab?.type === 'agent'
}

export function getPersistableTabState(
  tabs: TabItem[],
  activeTabId: string | null,
): PersistedTabState {
  // 顶部只保留会话入口；其他视图（收藏、定时任务等）不写入 settings.json。
  const persistentTabs = tabs.filter((tab) => tab.type === 'agent')
  const persistentActiveTabId = activeTabId && persistentTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : persistentTabs.at(-1)?.id ?? null

  return {
    tabs: persistentTabs,
    activeTabId: persistentActiveTabId,
  }
}

/** 打开或聚焦会话入口：始终用目标会话替换当前会话，避免顶部累积多个 Tab。 */
export function openTab(
  tabs: TabItem[],
  item: { type: TabType; sessionId: string; title: string },
): { tabs: TabItem[]; activeTabId: string } {
  const existingTab = tabs.find((t) => t.sessionId === item.sessionId && t.type === item.type)
  const sessionTab: TabItem = existingTab ?? {
    id: item.sessionId,
    type: item.type,
    sessionId: item.sessionId,
    title: item.title,
  }

  return {
    tabs: [sessionTab],
    activeTabId: sessionTab.id,
  }
}

/** 关闭标签页 */
export function closeTab(
  tabs: TabItem[],
  activeTabId: string | null,
  tabId: string,
): { tabs: TabItem[]; activeTabId: string | null } {
  const tabIndex = tabs.findIndex((t) => t.id === tabId)
  if (tabIndex === -1) return { tabs, activeTabId }
  const newTabs = tabs.filter((t) => t.id !== tabId)

  // 如果关闭的是当前激活的标签，切换到相邻标签
  let newActiveTabId = activeTabId
  if (activeTabId === tabId) {
    if (newTabs.length > 0) {
      const nextIndex = Math.min(tabIndex, newTabs.length - 1)
      newActiveTabId = newTabs[nextIndex]!.id
    } else {
      newActiveTabId = null
    }
  }

  return { tabs: newTabs, activeTabId: newActiveTabId }
}

/** 重排标签顺序（保留函数用于兼容旧调用） */
export function reorderTabs(
  tabs: TabItem[],
  fromIndex: number,
  toIndex: number,
): TabItem[] {
  if (fromIndex === toIndex) return tabs
  const newTabs = [...tabs]
  const [moved] = newTabs.splice(fromIndex, 1)
  newTabs.splice(toIndex, 0, moved!)
  return newTabs
}

/** 更新标签标题 */
export function updateTabTitle(
  tabs: TabItem[],
  sessionId: string,
  title: string,
): TabItem[] {
  return tabs.map((t) =>
    t.sessionId === sessionId ? { ...t, title } : t
  )
}
