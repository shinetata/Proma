/**
 * useOpenSession — 统一的"打开/聚焦会话 Tab"操作
 *
 * 封装 openTab + setTabs + setActiveTabId + setCurrentXxxId，
 * 确保所有打开会话的入口都能正确同步当前会话。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  openTab,
  type TabType,
} from '@/atoms/tab-atoms'
import { activeViewAtom, type ActiveView } from '@/atoms/active-view'
import { automationFormAtom } from '@/atoms/automation-atoms'
import {
  currentAgentSessionIdAtom,
  agentSessionsAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import {
  channelFormDirtyAtom,
  settingsOpenAtom,
  settingsPendingSessionNavigationAtom,
} from '@/atoms/settings-tab'

interface OpenSessionOptions {
  bypassSettingsGuard?: boolean
  /**
   * 会话打开在哪个视图（商业版 xh 的 view，默认会话首页）。
   * 收藏、定时任务视图各自持有 Tab 集合，需先切到目标视图再打开会话。
   */
  view?: ActiveView
  /** 仅在导航实际执行后调用；设置 Guard 取消时不会调用。 */
  onOpened?: () => void
}

type OpenSessionFn = (type: TabType, sessionId: string, title: string, options?: OpenSessionOptions) => void

export function useOpenSession(): OpenSessionFn {
  const store = useStore()
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setPendingSessionNavigation = useSetAtom(settingsPendingSessionNavigationAtom)

  return React.useCallback(
    (type: TabType, sessionId: string, title: string, options?: OpenSessionOptions): void => {
      if (!options?.bypassSettingsGuard && settingsOpen && channelFormDirty) {
        setPendingSessionNavigation({ type, sessionId, title, onOpened: options?.onOpened })
        return
      }
      setSettingsOpen(false)

      // 先切到目标视图（会换入该视图的 Tab 集合），再在其上打开会话（商业版 xh）。
      const targetView = options?.view ?? 'conversations'
      if (store.get(activeViewAtom) !== targetView) setActiveView(targetView)
      const result = openTab(store.get(tabsAtom), { type, sessionId, title })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      setAutomationForm({ open: false, draft: null })

      if (type === 'agent') {
        setCurrentAgentSessionId(sessionId)

        // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
        setUnviewedCompleted((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })

        // 同步 workspaceId，确保与 TabBar 切换行为一致
        const session = agentSessions.find((s) => s.id === sessionId)
        if (session?.workspaceId) {
          setCurrentAgentWorkspaceId(session.workspaceId)
          window.electronAPI.updateSettings({
            agentWorkspaceId: session.workspaceId,
          }).catch(console.error)
        }
      } else {
        // 非会话 Tab（如预览）不创建或选择任何草稿视图。
        setCurrentAgentSessionId(null)
      }

      options?.onOpened?.()
    },
    [store, setTabs, setActiveTabId, setAutomationForm, setActiveView, setCurrentAgentSessionId, agentSessions, setCurrentAgentWorkspaceId, setUnviewedCompleted, settingsOpen, channelFormDirty, setSettingsOpen, setPendingSessionNavigation],
  )
}
