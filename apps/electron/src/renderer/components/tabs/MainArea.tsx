/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + TabContent。文件、Markdown 和 Diff 预览统一由右侧工作区承载；
 * MainArea 仅保留对话主区。
 */

import * as React from 'react'
import type { BrowserPresentRequest, BrowserStateChange, BrowserTabFocusChange } from '@proma/shared'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  activeTabAtom,
} from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'
import { AutomationFormView } from '@/components/automation/AutomationFormView'
import { PlanningView } from '@/components/planning/PlanningView'
import { AgentSkillsView } from '@/components/agent-skills/AgentSkillsView'
import { VaultView } from '@/components/vault/VaultView'
import { MemoryView } from '@/components/agent-skills/MemoryView'
import { AutomationWelcome } from '@/components/automation/AutomationWelcome'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { themeModeAtom, themeStyleAtom } from '@/atoms/theme'
import { cn } from '@/lib/utils'
import { registerShortcut } from '@/lib/shortcut-registry'
import {
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtomFamily,
  currentSessionSidePanelOpenAtom,
  getBrowserSidePanelTab,
} from '@/atoms/agent-atoms'
import {
  browserFocusRequestMapAtom,
  browserPanelMinimizedMapAtom,
  browserPanelOpenMapAtom,
  browserPendingNavigationMapAtom,
  browserStateMapAtom,
} from '@/atoms/browser-atoms'
import { browserFrequentSitesAtom, recordFrequentSiteVisit } from '@/components/browser/browser-frequent-sites'

export function MainArea(): React.ReactElement {

  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const activeTab = useAtomValue(activeTabAtom)
  const automationFormOpen = useAtomValue(automationFormAtom).open
  const activeView = useAtomValue(activeViewAtom)
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)
  const store = useStore()

  // TabBar 立即反馈，较重的中心内容可让出当前交互帧；Agent 历史则保持当前会话避免旧内容占屏。
  const deferredActiveTabId = React.useDeferredValue(activeTabId)
  const contentTabId = activeTab?.type === 'agent' ? activeTabId : deferredActiveTabId
  // Agent 会话从左侧历史列表切换，中心区不再重复展示同一组顶部 Tab。
  const showCenterTabBar = activeTab?.type !== 'agent'
  const [isRightPanelOpen, setRightPanelOpen] = useAtom(currentSessionSidePanelOpenAtom)
  const toggleRightPanel = React.useCallback(() => {
    if (activeTab?.type !== 'agent') return
    setRightPanelOpen(!isRightPanelOpen)
  }, [activeTab?.type, isRightPanelOpen, setRightPanelOpen])

  // 不能依赖 TabBar 注册：Agent 会话已不渲染中心 TabBar，快捷键需要在常驻主内容区监听。
  React.useEffect(() => registerShortcut('toggle-right-panel', toggleRightPanel), [toggleRightPanel])

  // 浏览器状态仍由主内容区常驻订阅，右侧工作区只读取 atom 渲染，避免侧栏收起时遗漏状态更新。
  const setBrowserOpenMap = useSetAtom(browserPanelOpenMapAtom)
  const setBrowserMinimizedMap = useSetAtom(browserPanelMinimizedMapAtom)
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const setBrowserFocusRequestMap = useSetAtom(browserFocusRequestMapAtom)
  const setPendingNavigationMap = useSetAtom(browserPendingNavigationMapAtom)
  const setAgentSidePanelTabMap = useSetAtom(agentDiffPanelTabAtom)
  const setFrequentSites = useSetAtom(browserFrequentSitesAtom)
  // 商业版 Ftn：每个网页标签的 URL 变化记为一次访问，供右侧「新建标签页」推荐常用网站。
  const lastRecordedTabUrlsRef = React.useRef(new Map<string, string>())
  const browserSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null
  // 同一条状态会因原生视图显示/隐藏重复广播；仅新的 Agent 浏览器活动才激活对应右侧 Tab。
  const handledBrowserActivityIdsRef = React.useRef(new Map<string, string>())

  const publishBrowserState = React.useCallback((state: BrowserStateChange) => {
    if ('closed' in state) {
      setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(state.sessionId, false); return next })
      setBrowserMinimizedMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      setBrowserStateMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      setPendingNavigationMap((previous) => { const next = new Map(previous); next.delete(state.sessionId); return next })
      return
    }
    setBrowserStateMap((previous) => { const next = new Map(previous); next.set(state.sessionId, state); return next })
    const visitedTabs = state.tabs.filter((tab) => {
      const key = `${state.sessionId}\u0000${tab.tabId}`
      if (!tab.url || lastRecordedTabUrlsRef.current.get(key) === tab.url) return false
      lastRecordedTabUrlsRef.current.set(key, tab.url)
      return true
    })
    if (visitedTabs.length > 0) {
      const visitedAt = Date.now()
      setFrequentSites((previous) => visitedTabs.reduce((sites, tab) => recordFrequentSiteVisit(sites, { url: tab.url, visitedAt }), previous))
    }
    const isMinimized = store.get(browserPanelMinimizedMapAtom).get(state.sessionId) === true
    setBrowserOpenMap((previous) => { const next = new Map(previous); next.set(state.sessionId, !isMinimized); return next })

    const activity = state.activity
    const shouldActivateAgentBrowserTab = Boolean(
      activity
      && activeTab?.type === 'agent'
      && activeTab.sessionId === state.sessionId
      && state.agentTabId === state.activeTabId
      && activity.tabId === state.activeTabId
      && handledBrowserActivityIdsRef.current.get(state.sessionId) !== activity.id,
    )
    if (shouldActivateAgentBrowserTab) {
      handledBrowserActivityIdsRef.current.set(state.sessionId, activity!.id)
      store.set(agentSidePanelOpenAtomFamily(state.sessionId), true)
      setAgentSidePanelTabMap((previous) => {
        const next = new Map(previous)
        next.set(state.sessionId, getBrowserSidePanelTab(state.activeTabId))
        return next
      })
    }
  }, [activeTab, setAgentSidePanelTabMap, setBrowserOpenMap, setBrowserMinimizedMap, setBrowserStateMap, setFrequentSites, setPendingNavigationMap, store])

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserStateChanged
    if (typeof subscribe !== 'function') return
    return subscribe(publishBrowserState)
  }, [publishBrowserState])

  const focusNativeBrowserTab = React.useCallback((change: BrowserTabFocusChange) => {
    // WebContentsView 不在 React DOM 中；点击后台 Browser Pane 的网页正文只能由主进程
    // 把原生 focus 映射回右侧 Pane/Tab 焦点。后台 Agent Session 不得借此抢前台。
    if (activeTab?.type !== 'agent' || activeTab.sessionId !== change.sessionId) return
    store.set(agentSidePanelOpenAtomFamily(change.sessionId), true)
    setAgentSidePanelTabMap((previous) => {
      if (previous.get(change.sessionId) === getBrowserSidePanelTab(change.tabId)) return previous
      const next = new Map(previous)
      next.set(change.sessionId, getBrowserSidePanelTab(change.tabId))
      return next
    })
  }, [activeTab, setAgentSidePanelTabMap, store])

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserTabFocused
    if (typeof subscribe !== 'function') return
    return subscribe(focusNativeBrowserTab)
  }, [focusNativeBrowserTab])

  // Agent 主动展示页面：只在用户当前查看的会话内切换到那个网页标签，
  // 不把其他会话的前台强行抢过来。
  const presentBrowserTab = React.useCallback((request: BrowserPresentRequest) => {
    if (activeTab?.type !== 'agent' || activeTab.sessionId !== request.sessionId) return
    setBrowserMinimizedMap((previous) => {
      if (!previous.has(request.sessionId)) return previous
      const next = new Map(previous)
      next.delete(request.sessionId)
      return next
    })
    store.set(agentSidePanelOpenAtomFamily(request.sessionId), true)
    setBrowserFocusRequestMap((previous) => {
      if (previous.get(request.sessionId) === request.tabId) return previous
      const next = new Map(previous)
      next.set(request.sessionId, request.tabId)
      return next
    })
  }, [activeTab, setBrowserFocusRequestMap, setBrowserMinimizedMap, store])

  React.useEffect(() => {
    const subscribe = (window.electronAPI as Partial<typeof window.electronAPI>).onAgentBrowserPresentRequested
    if (typeof subscribe !== 'function') return
    return subscribe(presentBrowserTab)
  }, [presentBrowserTab])

  React.useEffect(() => {
    if (!browserSessionId) return
    const getState = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserState
    if (typeof getState !== 'function') return
    let cancelled = false
    void getState(browserSessionId)
      .then((state) => { if (!cancelled && state) publishBrowserState(state) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [browserSessionId, publishBrowserState])

  React.useEffect(() => {
    if (tabs.length > 0 && !activeTabId) setActiveTabId(tabs[0]!.id)
  }, [tabs, activeTabId, setActiveTabId])


  // 商业版 ztn：会话首页与收藏视图的主区左上角为 2xl 圆角（特殊主题下的 Agent 会话除外）。
  const roundedMainArea = (activeView === 'conversations' || activeView === 'favorites')
    && !(activeTab?.type === 'agent' && themeMode === 'special' && themeStyle !== 'default')

  return (
    <Panel variant="grow" className={cn('bg-content-area', roundedMainArea && 'rounded-tl-2xl')}>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex flex-1 flex-col min-w-0 h-full">
          {activeView === 'planning' ? (
            automationFormOpen ? <AutomationFormView /> : <PlanningView />
          ) : activeView === 'agent-skills' ? (
            <AgentSkillsView />
          ) : activeView === 'memory' ? (
            <MemoryView />
          ) : activeView === 'vault' ? (
            <VaultView sessionId={activeTab?.type === 'agent' ? activeTab.sessionId : undefined} />
          ) : (
            <>
              {showCenterTabBar && tabs.length > 0 && <TabBar />}
              {automationFormOpen && activeView === 'automations' ? (
                <AutomationFormView />
              ) : activeView === 'automations' && !activeTab ? (
                <AutomationWelcome />
              ) : activeView === 'favorites' && !activeTab ? (
                <div className="flex flex-1 items-center justify-center px-8 text-center text-sm leading-6 text-muted-foreground">
                  从左侧选择收藏会话，继续工作。<br />你也可以在会话菜单中添加收藏，方便随时回来。
                </div>
              ) : tabs.length === 0 ? (
                <WelcomeView />
              ) : contentTabId ? (
                <div className="flex-1 min-h-0 titlebar-no-drag"><TabContent tabId={contentTabId} /></div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Panel>
  )
}
