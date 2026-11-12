/**
 * LeftSidebar - 左侧导航（复刻商业版 0.21.88 `wMt`）
 *
 * 四种形态：
 * - 折叠态：只有 60px rail（新建 / 项目 / 搜索 / 工作区工具 / 最近会话迷你 rail / 设置）
 * - 收藏：rail + 收藏面板
 * - 定时任务：rail + AutomationSidebarPanel
 * - 默认：rail + Agent 会话面板；utilityRailOnly（Todo / 记忆 / Skills 等整页视图）只保留 rail
 */

import * as React from 'react'
import { useAtom, useSetAtom, useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import { Pin, PinOff, Star, Settings, Plus, Trash2, Pencil, PanelLeft, PanelRight, ArrowRightLeft, Search, Archive, ArchiveRestore, ArrowLeft, MessageSquare, MoreHorizontal, FolderOpen, FolderClosed, FolderInput, FolderPlus, Clock, CalendarDays, ChevronRight, ChevronDown, ChevronUp, ChevronsDownUp, ListTodo, GitBranch, Info, Bookmark, LibraryBig, Plug, House } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { SearchDialog } from './SearchDialog'
import { UserAvatar } from '@/components/common/UserAvatar'
import { activeViewAtom, agentSkillsTabAtom } from '@/atoms/active-view'
import { automationFormAtom, automationsAtom } from '@/atoms/automation-atoms'
import { planningTabAtom } from '@/atoms/planning-atoms'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import {
  agentSessionsAtom,
  agentSDKMessagesCacheAtom,
  currentAgentSessionIdAtom,
  agentSessionIndicatorMapAtom,
  unviewedCompletedSessionIdsAtom,
  unviewedCompletedDelegatedSessionIdsAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentSessionPathMapAtom,
  currentAgentWorkspaceIdAtom,
  agentWorkspacesAtom,
  workspaceCapabilitiesVersionAtom,
  agentDiffPanelTabAtom,
  agentDiffRefreshVersionAtom,
  agentDiffUnseenChangesAtom,
  agentDiffUnseenFilesAtom,
  agentNonGitFileChangesAtom,
  agentFileChangesCurrentRunAtom,
  agentDiffDataAtom,
  agentSidePanelOpenMapAtom,
  agentSidePanelOpenAtomFamily,
  agentSideDelegationMapAtom,
  agentSidePanelSplitMapAtom,
  getDelegationSidePanelTab,
  agentStreamingStatesAtom,
  liveMessagesMapAtom,
  agentSessionPendingFilesAtom,
  agentSessionStreamingStateAtomFamily,
  agentSessionViewStreamStateAtomFamily,
  agentSessionInputStreamStateAtomFamily,
  agentLiveMessagesAtomFamily,
  agentSessionDraftAtomFamily,
  agentSessionDraftHtmlAtomFamily,
  agentPendingFilesAtomFamily,
  sessionPersistedPermissionModeAtom,
  sessionExistsAtom,
} from '@/atoms/agent-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import {
  previewPanelOpenMapAtom,
  previewFileMapAtom,
  previewFilesMapAtom,
  previewContentRefreshVersionAtom,
  previewResolvedPathAtom,
} from '@/atoms/preview-atoms'
import { clearPreviewCacheForSession } from '@/components/diff/DiffTabContent'
import {
  tabsAtom,
  activeTabIdAtom,
  activeSessionIdAtom,
  sidebarCollapsedAtom,
  closeTab,
  updateTabTitle,
} from '@/atoms/tab-atoms'
import { userProfileAtom } from '@/atoms/user-profile'
import { lastFavoriteSessionIdAtom, sidebarViewModeAtom } from '@/atoms/sidebar-atoms'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import { hasUpdateAtom, updateStatusAtom } from '@/atoms/updater'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { clearBrowserSessionStateAtom } from '@/atoms/browser-atoms'
import { hasEnvironmentIssuesAtom } from '@/atoms/environment'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'
import { productivityToolsAtom, sessionHoverPreviewEnabledAtom } from '@/atoms/ui-preferences'
import { CollapsedWorkspacePopover } from '@/components/agent/CollapsedWorkspacePopover'
import { CollapsedToolsPopover, type CollapsedToolItem } from '@/components/agent/CollapsedToolsPopover'
import { AutomationSidebarPanel } from '@/components/automation/AutomationSidebarPanel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  SIDEBAR_ACTION_SURFACE_CLASS,
  SIDEBAR_RAIL_DRAG_STRIP_HEIGHT,
  SIDEBAR_RAIL_WIDTH,
  SidebarNewTaskButton,
  SidebarRailButton,
  SidebarRailEntry,
  SidebarRailUpdateButton,
} from './sidebar-rail'
import {
  FAVORITE_SORT_OPTIONS,
  listFavoriteSessions,
  pickInitialFavoriteSession,
  resolveSessionWorkspaceId,
  type FavoriteArchiveFilter,
  type FavoriteSort,
} from './favorite-sessions'
import { CollapsedSessionRail, type RailRecentItem } from '@/components/agent/CollapsedSessionRail'
import { ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import { VirtualSidebarList, type VirtualSidebarRow } from '@/components/ui/virtual-sidebar-list'
import { SidebarScrollBoundary } from '@/components/ui/sidebar-scroll-boundary'
import { LocalProjectBadge } from '@/components/agent/LocalProjectBadge'
import { MoveSessionDialog } from '@/components/agent/MoveSessionDialog'
import {
  SessionMiniMapPopover,
  useSessionMiniMapHover,
  type SessionMiniMapType,
} from '@/components/session-preview/SessionMiniMapPopover'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import { ShortcutKeycaps } from '@/components/shortcuts/ShortcutKeycaps'
import { getActiveAccelerator, getAcceleratorDisplay } from '@/lib/shortcut-registry'
import { rememberStopGenerationTarget } from '@/lib/stop-generation-target'
import { markSessionCompletionViewed } from '@/lib/agent-completion-presence'
import {
  buildAgentSessionTrees,
  getCollapsedAgentRailTreeStatus,
  getCollapsedAgentRailTrees,
  isDelegatedChildSession,
  sortDelegatedChildSessions,
  type AgentSessionTreeItem,
} from '@/lib/collapsed-agent-rail'
import {
  collectAgentSessionTreeIds,
  countSettledDelegatedChildren,
  getAgentSessionTreeIndicatorStatus,
  getDelegatedChildSessionStatus,
  getDelegationStatusIconClass,
  groupArchivedAgentSessionsByProject,
  isAgentSessionVisibleInTrees,
  isDelegationObservationVisible,
  removeDelegatedSessionSelection,
  replaceAgentSessionInFreshnessOrder,
  selectDelegatedSession,
  sortAgentSessionsByActivityDesc,
} from '@/lib/agent-session-list'
import { clearSessionReferenceDragState, getSessionReferenceDragData, insertSessionReferenceMention, isSessionReferenceDrag, setSessionReferenceDragData } from '@/lib/session-reference-drag'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { getAgentSessionActivityAt, type AgentSessionMeta, type AgentWorkspace, type WorkspaceCapabilities } from '@proma/shared'

function formatAutomationCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export interface LeftSidebarProps {
  /** 可选固定宽度，默认使用 CSS 响应式宽度 */
  width?: number
  /** 拖拽过程中禁用 CSS transition，保证即时响应 */
  noTransition?: boolean
  /** Todo / 日程 / 记忆 / Skills 等整页视图只保留 60px rail（商业版 utilityRailOnly） */
  utilityRailOnly?: boolean
}

/** 日期分组标签 */
type DateGroup = '今天' | '昨天' | '更早'

interface AgentProjectGroup {
  workspace: AgentWorkspace
  sessions: AgentSessionMeta[]
}


const PROJECT_SESSION_PREVIEW_LIMIT = 5
/** 收藏行预估高度（商业版 tMt） */
const FAVORITE_ROW_ESTIMATE_SIZE = 56
const PROJECT_SESSION_RECENT_WINDOW_MS = 3 * 86_400_000
/** 点击"显示更多"时每次额外展开的会话数量 */
const PROJECT_SESSION_EXPAND_STEP = 10
const SESSION_QUICK_SWITCH_HINT_DELAY_MS = 1000
const SESSION_QUICK_SWITCH_LIMIT = 9
const SESSION_QUICK_SWITCH_KEYDOWN_EVENT = 'proma:session-quick-switch-keydown'
const SESSION_QUICK_SWITCH_KEYUP_EVENT = 'proma:session-quick-switch-keyup'

const ACTIVE_SESSION_STATUSES: ReadonlySet<SessionIndicatorStatus> = new Set([
  'blocked',
  'running',
  'completed',
])

const ACTIVE_SESSION_STATUS_PRIORITY: Record<SessionIndicatorStatus, number> = {
  blocked: 0,
  running: 1,
  completed: 2,
  idle: 3,
}

/** 相对时间文案；传入的应当是会话的最后活跃时间。 */
function formatRelativeActivityAt(activityAt: number, now: number): string {
  const diff = Math.max(0, now - activityAt)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟`
  if (diff < day) return `${Math.floor(diff / hour)} 小时`
  if (diff < month) return `${Math.floor(diff / day)} 天`
  if (diff < year) return `${Math.floor(diff / month)} 月`
  return `${Math.floor(diff / year)} 年`
}

/** 按 updatedAt 将项目分为 今天 / 昨天 / 更早 三组 */
function groupByDate<T extends { updatedAt: number }>(items: T[]): Array<{ label: DateGroup; items: T[] }> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const today: T[] = []
  const yesterday: T[] = []
  const earlier: T[] = []

  for (const item of items) {
    if (item.updatedAt >= todayStart) {
      today.push(item)
    } else if (item.updatedAt >= yesterdayStart) {
      yesterday.push(item)
    } else {
      earlier.push(item)
    }
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = []
  if (today.length > 0) groups.push({ label: '今天', items: today })
  if (yesterday.length > 0) groups.push({ label: '昨天', items: yesterday })
  if (earlier.length > 0) groups.push({ label: '更早', items: earlier })
  return groups
}

interface QuickSwitchTarget {
  id: string
  title: string
  type: SessionMiniMapType
}

function getPrimaryModifierLabel(isMac: boolean): string {
  return isMac ? '⌘' : 'Ctrl'
}

function isPrimaryModifierKey(event: KeyboardEvent, isMac: boolean): boolean {
  if (isMac) {
    return event.key === 'Meta' || event.key === 'OS' || event.code === 'MetaLeft' || event.code === 'MetaRight'
  }
  return event.key === 'Control' || event.code === 'ControlLeft' || event.code === 'ControlRight'
}

function hasOnlyPrimaryModifier(event: KeyboardEvent, isMac: boolean): boolean {
  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  }
  return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
}

function getQuickSwitchNumber(event: KeyboardEvent): number | null {
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key)
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right
}

function isQuickSwitchRowVisible(row: HTMLElement, root: HTMLElement): boolean {
  const rowRect = row.getBoundingClientRect()
  if (rowRect.width <= 0 || rowRect.height <= 0) return false
  if (!rectsIntersect(rowRect, root.getBoundingClientRect())) return false

  let parent = row.parentElement
  while (parent && parent !== root) {
    const style = window.getComputedStyle(parent)
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`)) {
      const parentRect = parent.getBoundingClientRect()
      if (!rectsIntersect(rowRect, parentRect)) return false
    }
    parent = parent.parentElement
  }

  return true
}

function SessionQuickSwitchKeycap(): React.ReactElement {
  return (
    <span className="session-quick-switch-keycap" aria-hidden="true">
      <span className="session-quick-switch-modifier" />
      <span className="session-quick-switch-number" />
    </span>
  )
}

function getRailInitial(title: string): string {
  return title.trim().slice(0, 1).toUpperCase() || '·'
}

/**
 * 是否为「应从项目会话列表隐藏」的自动任务会话：
 * 来自定时任务（sourceAutomationId）且未被置顶。
 * 这类会话的"家"是「自动任务」视图，始终不出现在普通项目列表。
 */
function isHiddenAutomationSession(session: AgentSessionMeta): boolean {
  return !!session.sourceAutomationId && !session.pinned
}

/** 可作为项目入口打开的普通会话：未归档、未置顶、非草稿、非自动任务运行、非协作子会话（商业版 cse）。 */
function isProjectEntrySession(session: AgentSessionMeta, draftSessionIds: ReadonlySet<string>): boolean {
  return !session.archived
    && !session.pinned
    && !session.isDraft
    && !draftSessionIds.has(session.id)
    && !(session.sourceAutomationId && !session.automationGraduated)
    && !(session.parentSessionId && session.sourceDelegationId)
}

function getDelegatedChildStatus(
  session: AgentSessionMeta,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  return getDelegatedChildSessionStatus(session, agentIndicatorMap)
}

function getSessionTreeStatus(
  item: AgentSessionTreeItem,
  agentIndicatorMap: Map<string, SessionIndicatorStatus>,
): SessionIndicatorStatus {
  return getAgentSessionTreeIndicatorStatus(item.session, item.childSessions, agentIndicatorMap)
}

function treeContainsSessionId(item: AgentSessionTreeItem, sessionId: string | null): boolean {
  if (!sessionId) return false
  return item.session.id === sessionId || item.childSessions.some((session) => session.id === sessionId)
}

function getDirectDelegatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
): AgentSessionMeta[] {
  return sessions.filter((session) => (
    session.parentSessionId === parentSessionId
    && !!session.sourceDelegationId
  ))
}

function collectDelegatedSessionTreeIds(sessions: AgentSessionMeta[], rootSessionId: string): Set<string> {
  const ids = new Set<string>([rootSessionId])
  let changed = true

  while (changed) {
    changed = false
    for (const session of sessions) {
      if (ids.has(session.id)) continue
      // 与主进程迁移逻辑保持一致：只处理协作委派子会话。
      if (!session.sourceDelegationId) continue
      if (
        (session.parentSessionId && ids.has(session.parentSessionId))
        || session.rootSessionId === rootSessionId
      ) {
        ids.add(session.id)
        changed = true
      }
    }
  }

  return ids
}

function hasPinnedVisibleParent(session: AgentSessionMeta, sessions: AgentSessionMeta[]): boolean {
  if (!isDelegatedChildSession(session) || !session.parentSessionId) return false
  const parent = sessions.find((item) => item.id === session.parentSessionId)
  return !!parent?.pinned && !parent.archived
}

function getSyncableDelegatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
  draftSessionIds: Set<string>,
): AgentSessionMeta[] {
  return getDirectDelegatedChildren(sessions, parentSessionId).filter((child) => (
    !child.archived
    && !child.isDraft
    && !draftSessionIds.has(child.id)
  ))
}

/**
 * 解归档时收集应跟随父会话一起恢复的子会话：
 * 已归档、非 draft、非隐藏自动任务会话的委派子会话。
 */
function getArchivedDelegatedChildren(
  sessions: AgentSessionMeta[],
  parentSessionId: string,
  draftSessionIds: Set<string>,
): AgentSessionMeta[] {
  return getDirectDelegatedChildren(sessions, parentSessionId).filter((child) => (
    child.archived
    && !child.isDraft
    && !draftSessionIds.has(child.id)
  ))
}

function SidebarWindowDragStrip({ height }: { height: number }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="sidebar-window-drag-strip"
      style={{ height }}
    />
  )
}

/** 不可变地切换 Set 中某个成员的存在状态（存在则删除，不存在则添加），返回新 Set */
function toggleSetEntry<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

/** 不可变地从 Set 中移除某个成员，若不存在则原样返回 */
function deleteSetEntry<T>(prev: Set<T>, value: T): Set<T> {
  if (!prev.has(value)) return prev
  const next = new Set(prev)
  next.delete(value)
  return next
}

export function LeftSidebar({ width, noTransition, utilityRailOnly = false }: LeftSidebarProps): React.ReactElement {
  const [activeView, setActiveView] = useAtom(activeViewAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const [planningTab, setPlanningTab] = useAtom(planningTabAtom)
  const [agentSkillsTab, setAgentSkillsTab] = useAtom(agentSkillsTabAtom)
  const automations = useAtomValue(automationsAtom)
  const setAutomations = useSetAtom(automationsAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  const setDraftSessionIds = useSetAtom(draftSessionIdsAtom)
  const setAgentMessagesCache = useSetAtom(agentSDKMessagesCacheAtom)

  /** 待删除对话 ID，非空时显示确认弹窗 */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null)
  /** 待删除项目 ID，非空时显示项目删除确认弹窗 */
  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = React.useState<string | null>(null)
  const [deletingWorkspaceId, setDeletingWorkspaceId] = React.useState<string | null>(null)
  /** 待在原路径重建根目录的本地项目 ID。 */
  const [pendingRestoreProjectRootId, setPendingRestoreProjectRootId] = React.useState<string | null>(null)
  const [restoringProjectRootId, setRestoringProjectRootId] = React.useState<string | null>(null)
  /** 待迁移会话 ID，非空时显示迁移对话框 */
  const [moveTargetId, setMoveTargetId] = React.useState<string | null>(null)
  /** 待迁移会话所属的工作区 ID（用于对话框排除当前分区） */
  const [moveSourceWorkspaceId, setMoveSourceWorkspaceId] = React.useState<string | undefined>()
  /** 每个项目额外展开显示的会话数量（每次点击"显示更多" +10），未点击则为 0 或无值 */
  const [expandedExtraCountMap, setExpandedExtraCountMap] = React.useState<Map<string, number>>(new Map())
  /** 记录被用户手动折叠的工作区 ID（点击当前工作区标题时折叠/展开）。刻意不持久化：折叠被视为临时查看行为，刷新/重启后恢复默认展开 */
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Set<string>>(new Set())
  /** 归档项目默认折叠；只记录用户主动展开的项目，避免影响活跃视图的临时状态。 */
  const [expandedArchivedProjectIds, setExpandedArchivedProjectIds] = React.useState<Set<string>>(new Set())
  /** 记录已展开的委派母会话；默认收起，避免批量派遣后撑满侧栏 */
  const [expandedDelegationParentIds, setExpandedDelegationParentIds] = React.useState<Set<string>>(new Set())
  /** 记录用户手动收起的委派母会话；用于覆盖“当前子会话自动展开”的兜底可见性 */
  const [collapsedDelegationParentIds, setCollapsedDelegationParentIds] = React.useState<Set<string>>(new Set())
  /** 项目拖拽排序状态 */
  const [dragProjectId, setDragProjectId] = React.useState<string | null>(null)
  const [projectDropIndicator, setProjectDropIndicator] = React.useState<{ id: string; position: 'before' | 'after' } | null>(null)
  /** 新建项目输入状态 */
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState('')
  const newProjectInputRef = React.useRef<HTMLInputElement>(null)
  const [relativeTimeNow, setRelativeTimeNow] = React.useState(() => Date.now())
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const isMac = React.useMemo(() => detectIsMac(), [])
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  /** 收藏面板：搜索、排序、活跃/归档筛选与排序弹层（商业版 me / X / ae / le） */
  const [favoriteQuery, setFavoriteQuery] = React.useState('')
  const [favoriteSort, setFavoriteSort] = React.useState<FavoriteSort>('collected')
  const [favoriteArchiveFilter, setFavoriteArchiveFilter] = React.useState<FavoriteArchiveFilter>('active')
  const [favoriteSortOpen, setFavoriteSortOpen] = React.useState(false)
  /** 每次从 rail 进入收藏都回到列表顶部（商业版 scrollResetKey） */
  const [favoriteScrollResetKey, setFavoriteScrollResetKey] = React.useState(0)
  /** 从 rail 进入收藏时，若无当前会话则自动打开第一条收藏（商业版 Ce） */
  const autoOpenFavoriteRef = React.useRef(false)
  /** 把会话拖到 rail 收藏图标上时的高亮态（商业版 xe） */
  const [favoriteDropActive, setFavoriteDropActive] = React.useState(false)
  /** 每个项目最近查看的普通会话，切换项目时优先回到它（商业版 mc） */
  const lastSessionByWorkspaceRef = React.useRef<Map<string, string>>(new Map())
  const hasUpdate = useAtomValue(hasUpdateAtom)
  const updateStatus = useAtomValue(updateStatusAtom)
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom)
  const sessionHoverPreviewEnabled = useAtomValue(sessionHoverPreviewEnabledAtom)
  const productivityTools = useAtomValue(productivityToolsAtom)

  // Agent 模式状态
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom)
  const [archivedAgentSessionCount, setArchivedAgentSessionCount] = React.useState(0)
  const [currentAgentSessionId, setCurrentAgentSessionId] = useAtom(currentAgentSessionIdAtom)
  const sideDelegationMap = useAtomValue(agentSideDelegationMapAtom)
  const diffPanelTabMap = useAtomValue(agentDiffPanelTabAtom)
  const sidePanelSplitMap = useAtomValue(agentSidePanelSplitMapAtom)
  const sidePanelOpenMap = useAtomValue(agentSidePanelOpenMapAtom)
  const activeParentSessionId = currentAgentSessionId ?? ''
  const activeRightWorkspaceTab = diffPanelTabMap.get(activeParentSessionId)
  const activeRightWorkspaceSplit = sidePanelSplitMap.get(activeParentSessionId) ?? null
  const isActiveSidePanelOpen = activeParentSessionId
    ? sidePanelOpenMap[activeParentSessionId] ?? true
    : false
  const isDelegationVisible = isDelegationObservationVisible(
    isActiveSidePanelOpen,
    activeRightWorkspaceTab,
    activeRightWorkspaceSplit,
  )
  const activeDelegationSessionId = isDelegationVisible
    ? sideDelegationMap.get(activeParentSessionId) ?? null
    : null
  const agentIndicatorMap = useAtomValue(agentSessionIndicatorMapAtom)
  const unviewedCompletedSessionIds = useAtomValue(unviewedCompletedSessionIdsAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const setUnviewedDelegatedCompleted = useSetAtom(unviewedCompletedDelegatedSessionIdsAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const agentModelId = useAtomValue(agentModelIdAtom)
  const setSessionChannelMap = useSetAtom(agentSessionChannelMapAtom)
  const setSessionModelMap = useSetAtom(agentSessionModelMapAtom)
  const setSessionPathMap = useSetAtom(agentSessionPathMapAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom)
  const [workspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)

  // 当前项目能力（MCP + Skill 计数）
  const [capabilities, setCapabilities] = React.useState<WorkspaceCapabilities | null>(null)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)

  // Tab 状态
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  // 会话高亮按"激活 Tab 所属会话"判定：预览 Tab 激活时其 owner 会话仍保持高亮
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()
  const store = useStore()
  const sidebarRootRef = React.useRef<HTMLDivElement>(null)
  const quickSwitchTargetsRef = React.useRef<QuickSwitchTarget[]>([])
  // 快捷切换只会标注前 9 行；保留它们避免滚动时全量清理/重写所有列表行。
  const quickSwitchHintRowsRef = React.useRef<HTMLElement[]>([])
  const quickSwitchRefreshFrameRef = React.useRef<number | null>(null)
  const quickSwitchHintTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const processedQuickSwitchEventsRef = React.useRef<WeakSet<KeyboardEvent>>(new WeakSet())
  const [quickSwitchHintsVisible, setQuickSwitchHintsVisible] = React.useState(false)

  // 归档 & 搜索状态
  const [viewMode, setViewMode] = useAtom(sidebarViewModeAtom)
  /** 收藏面板需要同时列出已归档的收藏会话（商业版 Yn） */
  const includeArchivedSessions = activeView === 'favorites' || viewMode === 'archived'
  const searchDialogOpen = useAtomValue(searchDialogOpenAtom)
  const setSearchDialogOpen = useSetAtom(searchDialogOpenAtom)
  const newChatShortcutLabel = getAcceleratorDisplay(getActiveAccelerator('new-session'))

  /** 归档会话只在用户打开归档视图时加载；active 视图只保留未归档元数据。 */
  const refreshAgentSidebarSessions = React.useCallback(async (includeArchived: boolean): Promise<void> => {
    const [activeSessions, archivedCount] = await Promise.all([
      window.electronAPI.listActiveAgentSessions(),
      window.electronAPI.countArchivedAgentSessions(),
    ])
    const sessions = includeArchived
      ? [...activeSessions, ...(await window.electronAPI.listArchivedAgentSessions())]
      : activeSessions
    setAgentSessions(sessions)
    setArchivedAgentSessionCount(archivedCount)
  }, [setAgentSessions])

  const handleOpenSettings = React.useCallback((): void => {
    setSettingsOpen(true)
  }, [setSettingsOpen])

  /** 归档视图按需加载归档列表，离开后恢复轻量 active 列表。 */
  React.useEffect(() => {
    refreshAgentSidebarSessions(includeArchivedSessions).catch(console.error)
  }, [refreshAgentSidebarSessions, viewMode, includeArchivedSessions])

  const handleUpdateButtonClick = React.useCallback((): void => {
    setSettingsTab('about')
    setSettingsOpen(true)
  }, [setSettingsOpen, setSettingsTab])

  React.useEffect(() => {
    const id = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // Chat 列表改由 virtualizer 按 index 定位；普通 Agent 项目列表当前仍是树状 DOM，
  // 保留既有的原生定位行为，避免打开后台 Agent 会话后选中项不可见。
  React.useEffect(() => {
    if (!activeTabId || viewMode !== 'active') return
    requestAnimationFrame(() => {
      const el = document.querySelector('.agent-session-item-active')
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [activeTabId, viewMode])

  // per-conversation/session Map atoms（删除时清理）
  const setPreviewPanelOpen = useSetAtom(previewPanelOpenMapAtom)
  const setPreviewFile = useSetAtom(previewFileMapAtom)
  const setPreviewFiles = useSetAtom(previewFilesMapAtom)
  const setPreviewContentRefreshVersion = useSetAtom(previewContentRefreshVersionAtom)
  const setPreviewResolvedPaths = useSetAtom(previewResolvedPathAtom)
  const setDiffPanelTab = useSetAtom(agentDiffPanelTabAtom)
  const setDiffRefreshVersion = useSetAtom(agentDiffRefreshVersionAtom)
  const setDiffUnseen = useSetAtom(agentDiffUnseenChangesAtom)
  const setDiffUnseenFiles = useSetAtom(agentDiffUnseenFilesAtom)
  const setNonGitFileChanges = useSetAtom(agentNonGitFileChangesAtom)
  const setFileChangesCurrentRun = useSetAtom(agentFileChangesCurrentRunAtom)
  const setDiffData = useSetAtom(agentDiffDataAtom)
  const setAgentSidePanelOpenMap = useSetAtom(agentSidePanelOpenMapAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setLiveMessagesMap = useSetAtom(liveMessagesMapAtom)
  const setSessionPendingFiles = useSetAtom(agentSessionPendingFilesAtom)
  const clearBrowserSessionState = useSetAtom(clearBrowserSessionStateAtom)

  /** 清理 per-conversation/session Map atoms 条目 */
  const cleanupMapAtoms = React.useCallback((id: string) => {
    const deleteKey = <T,>(prev: Map<string, T>): Map<string, T> => {
      if (!prev.has(id)) return prev
      const map = new Map(prev)
      map.delete(id)
      return map
    }
    setPreviewPanelOpen(deleteKey)
    setPreviewFile(deleteKey)
    setPreviewFiles(deleteKey)
    const deletePreviewSessionEntries = <T,>(prev: Map<string, T>): Map<string, T> => {
      const prefix = `${id}\u0000`
      const keys = [...prev.keys()].filter((key) => key.startsWith(prefix))
      if (keys.length === 0) return prev
      const next = new Map(prev)
      for (const key of keys) next.delete(key)
      return next
    }
    setPreviewContentRefreshVersion(deletePreviewSessionEntries)
    setPreviewResolvedPaths(deletePreviewSessionEntries)
    store.set(agentSideDelegationMapAtom, (prev) => removeDelegatedSessionSelection(prev, id))
    setUnviewedDelegatedCompleted((prev) => markSessionCompletionViewed(prev, id))
    setDiffPanelTab(deleteKey)
    setDiffRefreshVersion(deleteKey)
    setDiffUnseen(deleteKey)
    setDiffUnseenFiles(deleteKey)
    setNonGitFileChanges(deleteKey)
    setFileChangesCurrentRun(deleteKey)
    setDiffData(deleteKey)
    setAgentSidePanelOpenMap((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setSessionChannelMap(deleteKey)
    setSessionModelMap(deleteKey)
    // 会话工作目录路径：不清理会导致右侧文件面板继续用已删除目录请求 list-directory
    setSessionPathMap(deleteKey)
    // 即使主进程的 browser-closed 事件因删除过程中的重渲染晚到，也不能让右侧工作区
    // 保留已删除会话的浏览器面板。
    clearBrowserSessionState(id)

    // 重型流式数据：streamingStates（累积 content + toolActivities）与 liveMessages（SDK 消息数组）
    setStreamingStates(deleteKey)
    setLiveMessagesMap(deleteKey)

    // 待发送附件：先释放 blob URL 和 window 缓存中的 base64，再删 base map entry。
    // 与文字草稿不同，附件涉及 ObjectURL 和大体积二进制数据，删除/归档时不保留。
    const sessionPending = store.get(agentSessionPendingFilesAtom).get(id)
    if (sessionPending && sessionPending.length > 0) {
      for (const f of sessionPending) {
        if (f.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(f.previewUrl)
        window.__pendingAgentFileData?.delete(f.id)
      }
      setSessionPendingFiles(deleteKey)
    }

    // atomFamily 内部缓存（Jotai 对 string key 强引用 Map，不显式 remove 永不释放）。
    // 删除/归档是会话的终态，连同草稿一起清理，无需像关闭 Tab 那样保留可恢复输入。
    agentSessionStreamingStateAtomFamily.remove(id)
    agentSessionViewStreamStateAtomFamily.remove(id)
    agentSessionInputStreamStateAtomFamily.remove(id)
    agentLiveMessagesAtomFamily.remove(id)
    agentSessionDraftAtomFamily.remove(id)
    agentSessionDraftHtmlAtomFamily.remove(id)
    agentPendingFilesAtomFamily.remove(id)
    agentSidePanelOpenAtomFamily.remove(id)
    sessionPersistedPermissionModeAtom.remove(id)
    sessionExistsAtom.remove(id)

    clearPreviewCacheForSession(id)
  }, [clearBrowserSessionState, setPreviewPanelOpen, setPreviewFile, setPreviewFiles, setPreviewContentRefreshVersion, setPreviewResolvedPaths, setDiffPanelTab, setDiffRefreshVersion, setDiffUnseen, setDiffUnseenFiles, setNonGitFileChanges, setFileChangesCurrentRun, setDiffData, setAgentSidePanelOpenMap, setSessionChannelMap, setSessionModelMap, setSessionPathMap, setStreamingStates, setLiveMessagesMap, setSessionPendingFiles, store])

  const currentWorkspaceSlug = React.useMemo(() => {
    if (!currentWorkspaceId) return null
    return workspaces.find((w) => w.id === currentWorkspaceId)?.slug ?? null
  }, [currentWorkspaceId, workspaces])

  const workspaceNameMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const w of workspaces) map.set(w.id, w.name)
    return map
  }, [workspaces])

  const pendingDeleteWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === pendingDeleteWorkspaceId) ?? null,
    [pendingDeleteWorkspaceId, workspaces],
  )
  const pendingRestoreProjectRootWorkspace = React.useMemo(
    () => workspaces.find((workspace) => workspace.id === pendingRestoreProjectRootId) ?? null,
    [pendingRestoreProjectRootId, workspaces],
  )

  /** 待删除 Agent 会话下的委派子会话数量，用于删除确认弹窗提示是否级联删除 */
  const pendingDeleteChildCount = React.useMemo<number>(() => {
    if (!pendingDeleteId) return 0
    return getDirectDelegatedChildren(agentSessions, pendingDeleteId).length
  }, [agentSessions, pendingDeleteId])

  React.useEffect(() => {
    if (!currentWorkspaceSlug) {
      setCapabilities(null)
      return
    }
    window.electronAPI
      .getWorkspaceCapabilities(currentWorkspaceSlug)
      .then(setCapabilities)
      .catch(console.error)
  }, [currentWorkspaceSlug, activeView, capabilitiesVersion])

  /** 置顶 Agent 会话列表（仅活跃模式显示，跨项目展示，排除 draft） */
  const pinnedAgentSessions = React.useMemo(
    () => {
      if (viewMode !== 'active') return []
      const filtered = agentSessions.filter((s) =>
        s.pinned
        && !s.isDraft
        && !draftSessionIds.has(s.id)
        && !hasPinnedVisibleParent(s, agentSessions)
      )
      return sortAgentSessionsByActivityDesc(filtered)
    },
    [agentSessions, viewMode, draftSessionIds]
  )

  const pinnedAgentSessionTrees = React.useMemo<AgentSessionTreeItem[]>(
    () => pinnedAgentSessions.map((session) => ({
      session,
      childSessions: sortDelegatedChildSessions(
        getDirectDelegatedChildren(agentSessions, session.id).filter((child) => (
          !child.archived
          && !child.isDraft
          && !draftSessionIds.has(child.id)
          && !isHiddenAutomationSession(child)
        )),
        agentIndicatorMap,
      ),
    })),
    [agentIndicatorMap, agentSessions, draftSessionIds, pinnedAgentSessions],
  )

  /** 已归档 Agent 会话数量由主进程轻量统计返回，active 视图不扫描归档元数据。 */

  // 初始加载用户档案
  React.useEffect(() => {
    window.electronAPI
      .getUserProfile()
      .then(setUserProfile)
      .catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setUserProfile])

  // 窗口聚焦时重新同步列表，修复长时间后前后端不一致
  React.useEffect(() => {
    const handleFocus = (): void => {
      refreshAgentSidebarSessions(includeArchivedSessions).catch(console.error)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [refreshAgentSidebarSessions, viewMode, includeArchivedSessions])

  /**
   * Rail 导航：Todo / 日程 / 定时任务 / 记忆 / Skills 直接切换整页视图（商业版 wMt 内 fi / gp / hc / pc / io）。
   * 定时任务在左侧面板显示任务列表，因此需要展开侧栏。
   */
  const isPlanningRailActive = React.useCallback((tab: 'todos' | 'calendar' | 'automations'): boolean => (
    tab === 'automations'
      ? activeView === 'automations' || (activeView === 'planning' && planningTab === 'automations')
      : activeView === 'planning' && planningTab === tab
  ), [activeView, planningTab])

  const handleOpenPlanningView = React.useCallback((tab: 'todos' | 'calendar' | 'automations'): void => {
    setAutomationForm({ open: false, draft: null })
    setPlanningTab(tab)
    if (tab === 'automations') setSidebarCollapsed(false)
    setActiveView(tab === 'automations' ? 'automations' : 'planning')
  }, [setActiveView, setAutomationForm, setPlanningTab, setSidebarCollapsed])

  const handleOpenVault = React.useCallback((): void => {
    setActiveView('vault')
  }, [setActiveView])

  const handleOpenMemory = React.useCallback((): void => {
    setActiveView('memory')
  }, [setActiveView])

  const handleOpenMcpSkills = React.useCallback((): void => {
    setAgentSkillsTab('skills')
    setActiveView('agent-skills')
  }, [setActiveView, setAgentSkillsTab])

  const isMcpSkillsActive = activeView === 'agent-skills' && (agentSkillsTab === 'skills' || agentSkillsTab === 'mcp')

  /** 进入收藏面板：上次打开的收藏若已归档则直接显示「已归档收藏」。 */
  const handleOpenFavorites = React.useCallback((): void => {
    autoOpenFavoriteRef.current = true
    setSidebarCollapsed(false)
    setViewMode('active')
    const lastFavoriteId = store.get(lastFavoriteSessionIdAtom)
    const lastFavorite = agentSessions.find((session) => session.id === lastFavoriteId && session.starred)
    setFavoriteArchiveFilter(lastFavorite?.archived ? 'archived' : 'active')
    setFavoriteQuery('')
    setFavoriteScrollResetKey((key) => key + 1)
    setActiveView('favorites')
  }, [agentSessions, setActiveView, setSidebarCollapsed, setViewMode, store])

  const handleFavoriteDragOver = React.useCallback((event: React.DragEvent<HTMLButtonElement>): void => {
    if (!isSessionReferenceDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setFavoriteDropActive(true)
  }, [])

  /** 把会话拖到 rail 的收藏图标上即可收藏。 */
  const handleFavoriteDrop = React.useCallback(async (event: React.DragEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault()
    setFavoriteDropActive(false)
    const item = getSessionReferenceDragData(event.dataTransfer)
    if (!item) return
    const session = store.get(agentSessionsAtom).find((candidate) => candidate.id === item.sessionId)
    if (!session) return
    if (session.starred) {
      toast.info('该会话已收藏')
      return
    }
    try {
      const updated = await window.electronAPI.toggleStarAgentSession(session.id)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      toast.success('已收藏', { description: '可从左侧工具条的收藏打开。' })
    } catch (error) {
      console.error('[收藏] 拖入收藏失败:', error)
      toast.error('收藏失败')
    }
  }, [setAgentSessions, store])

  // 切换模式时重置归档视图
  React.useEffect(() => {
    setViewMode('active')
  }, [setViewMode])

  /** 请求删除对话（弹出确认框） */
  const handleRequestDelete = React.useCallback((id: string): void => {
    setPendingDeleteId(id)
  }, [])

  /** 确认删除会话 */
  const handleConfirmDelete = async (cascade: boolean = false): Promise<void> => {
    if (!pendingDeleteId) return

    {
      const sessionId = pendingDeleteId
      // activeSessionId 会把 Preview Tab 归一化为其所属 Agent 会话，不能只比较 Tab ID。
      const deletingActiveSession = activeSessionId === sessionId
      // 级联删除时在发起 IPC 前固定子会话快照，确保删除范围与弹窗展示一致，
      // 避免弹窗打开期间新增的子会话被意外删除。
      const childIds = cascade
        ? getDirectDelegatedChildren(store.get(agentSessionsAtom), sessionId).map((child) => child.id)
        : []

      try {
        // 先删子后删父：若子会话删除中途失败，父会话仍在，UI 一致性更好。
        if (childIds.length > 0) {
          const failedChildIds: string[] = []
          for (const childId of childIds) {
            try {
              await window.electronAPI.deleteAgentSession(childId)
            } catch (error) {
              console.error(`[侧边栏] 级联删除子会话失败 (${childId}):`, error)
              failedChildIds.push(childId)
            }
          }
          if (failedChildIds.length > 0) {
            toast.error(`部分子会话删除失败（${failedChildIds.length} 个），请手动清理`)
          }
          closeArchivedAgentTabs(childIds)
          for (const childId of childIds) {
            setExpandedDelegationParentIds((prev) => deleteSetEntry(prev, childId))
            setAgentMessagesCache((prev) => {
              if (!prev.has(childId)) return prev
              const next = new Map(prev)
              next.delete(childId)
              return next
            })
          }
        }

        // 先由主进程确认删除成功，再清理本地状态；失败时保留当前会话与输入，避免假删除。
        await window.electronAPI.deleteAgentSession(sessionId)
        // 刷新失败不应中断已成功删除会话的本地收尾，否则会残留一个指向已删除数据的 Tab。
        await refreshAgentSidebarSessions(includeArchivedSessions).catch((refreshError) => {
          console.error('[侧边栏] 刷新 Agent 会话列表失败:', refreshError)
          setAgentSessions((prev) => prev.filter((session) => session.id !== sessionId))
        })

        const currentTabs = store.get(tabsAtom)
        const currentActiveTabId = store.get(activeTabIdAtom)
        const tabResult = closeTab(currentTabs, currentActiveTabId, sessionId)
        setTabs(tabResult.tabs)
        setActiveTabId(tabResult.activeTabId)

        // 删除/归档是会话终态，清理 draft 与所有 per-session 内存状态。
        setDraftSessionIds((prev: Set<string>) => {
          if (!prev.has(sessionId)) return prev
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
        cleanupMapAtoms(sessionId)
        setExpandedDelegationParentIds((prev) => deleteSetEntry(prev, sessionId))
        setAgentMessagesCache((prev) => {
          if (!prev.has(sessionId)) return prev
          const next = new Map(prev)
          next.delete(sessionId)
          return next
        })

        if (deletingActiveSession) {
          // Scratch Pad 在普通 Agent 工作流中要保留当前上下文；仅在会话已被删除时
          // 显式清空旧指针，防止右侧面板继续引用已删除会话。
          setCurrentAgentSessionId(null)

          // 保持用户在 Agent 工作流内：新会话先作为隐藏 draft，首条消息发出后才进入侧栏。
          const draftId = await createAgent({ draft: true })
          if (!draftId) {
            toast.error('已删除会话，但无法创建新的 Agent 会话')
          }
        }
      } catch (error) {
        console.error('[侧边栏] 删除 Agent 会话失败:', error)
        toast.error('删除 Agent 会话失败，请重试')
      } finally {
        setPendingDeleteId(null)
      }
      return
    }
  }

  /** 在指定项目中创建 Agent 会话；未指定时使用当前项目 */
  const createAgentSessionInWorkspace = React.useCallback(async (workspaceId?: string): Promise<void> => {
    try {
      const targetWorkspaceId = workspaceId ?? currentWorkspaceId ?? undefined
      if (targetWorkspaceId && targetWorkspaceId !== currentWorkspaceId) {
        setCurrentWorkspaceId(targetWorkspaceId)
        window.electronAPI.updateSettings({ agentWorkspaceId: targetWorkspaceId }).catch(console.error)
      }
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        agentChannelId || undefined,
        targetWorkspaceId,
        agentModelId || undefined,
      )
      if (targetWorkspaceId) {
        setCollapsedWorkspaceIds((prev) => deleteSetEntry(prev, targetWorkspaceId))
      }
      setAgentSessions((prev) => [meta, ...prev])
      // 从全局默认值初始化 per-session 渠道/模型配置
      if (agentChannelId) {
        setSessionChannelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentChannelId)
          return map
        })
      }
      if (agentModelId) {
        setSessionModelMap((prev) => {
          const map = new Map(prev)
          map.set(meta.id, agentModelId)
          return map
        })
      }
      // 打开新标签页
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
    } catch (error) {
      console.error('[侧边栏] 创建 Agent 会话失败:', error)
    }
  }, [agentChannelId, agentModelId, currentWorkspaceId, openSession, setActiveView, setAgentSessions, setCurrentWorkspaceId, setSessionChannelMap, setSessionModelMap])

  /**
   * 点击项目标题：当前项目 → 折叠/展开；其他项目 → 打开该项目最近查看（或最新）的普通会话，
   * 没有会话时仅切换当前项目（商业版 bl）。
   */
  const handleSelectProject = React.useCallback((workspaceId: string): void => {
    if (workspaceId === currentWorkspaceId) {
      setCollapsedWorkspaceIds((prev) => toggleSetEntry(prev, workspaceId))
      return
    }
    const isEligible = (session: AgentSessionMeta | undefined): session is AgentSessionMeta => (
      !!session
      && resolveSessionWorkspaceId(session, workspaces) === workspaceId
      && isProjectEntrySession(session, draftSessionIds)
    )
    const remembered = agentSessions.find((session) => session.id === lastSessionByWorkspaceRef.current.get(workspaceId))
    const target = isEligible(remembered)
      ? remembered
      : sortAgentSessionsByActivityDesc(agentSessions.filter(isEligible))[0]
    setCollapsedWorkspaceIds((prev) => deleteSetEntry(prev, workspaceId))
    if (target) {
      openSession('agent', target.id, target.title, { onOpened: () => setActiveView('conversations') })
      return
    }
    setActiveView('conversations')
    setCurrentWorkspaceId(workspaceId)
    window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
  }, [agentSessions, currentWorkspaceId, draftSessionIds, openSession, setActiveView, setCurrentWorkspaceId, workspaces])

  React.useEffect(() => {
    if (!currentAgentSessionId) return
    const session = agentSessions.find((item) => item.id === currentAgentSessionId)
    if (!session || !isProjectEntrySession(session, draftSessionIds)) return
    const workspaceId = resolveSessionWorkspaceId(session, workspaces)
    if (workspaceId) lastSessionByWorkspaceRef.current.set(workspaceId, session.id)
  }, [agentSessions, currentAgentSessionId, draftSessionIds, workspaces])

  /** 归档项目默认折叠；点击后仅在归档视图内切换展开状态。 */
  const handleToggleArchivedProject = React.useCallback((groupId: string): void => {
    setExpandedArchivedProjectIds((prev) => toggleSetEntry(prev, groupId))
  }, [])

  const handleToggleDelegationParent = React.useCallback((sessionId: string, expanded: boolean): void => {
    if (expanded) {
      setExpandedDelegationParentIds((prev) => deleteSetEntry(prev, sessionId))
      setCollapsedDelegationParentIds((prev) => {
        if (prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.add(sessionId)
        return next
      })
      return
    }

    setCollapsedDelegationParentIds((prev) => deleteSetEntry(prev, sessionId))
    setExpandedDelegationParentIds((prev) => {
      if (prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }, [])

  const canDeleteWorkspace = React.useCallback(
    (workspace: AgentWorkspace): boolean => workspace.slug !== 'default' && workspaces.length > 1,
    [workspaces.length],
  )

  /** 请求删除项目（弹出二次确认框） */
  const handleRequestDeleteWorkspace = React.useCallback((workspaceId: string): void => {
    setPendingDeleteWorkspaceId(workspaceId)
  }, [])

  /** 确认删除项目及其绑定资源 */
  const handleConfirmDeleteWorkspace = React.useCallback(async (): Promise<void> => {
    const workspaceId = pendingDeleteWorkspaceId
    const workspace = workspaces.find((item) => item.id === workspaceId)
    if (!workspaceId || !workspace) return

    if (!canDeleteWorkspace(workspace)) {
      toast.error(workspace.slug === 'default' ? '默认项目不能删除' : '至少需要保留一个项目')
      setPendingDeleteWorkspaceId(null)
      return
    }

    const deletedSessionIds = new Set(
      agentSessions
        .filter((session) => session.workspaceId === workspaceId)
        .map((session) => session.id),
    )

    try {
      setDeletingWorkspaceId(workspaceId)

      await window.electronAPI.deleteAgentWorkspace(workspaceId)

      for (const sessionId of deletedSessionIds) {
        cleanupMapAtoms(sessionId)
      }

      setDraftSessionIds((prev: Set<string>) => {
        let changed = false
        const next = new Set(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })

      setAgentMessagesCache((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })
      setAutomations((prev) => prev.filter((automation) => automation.workspaceId !== workspaceId))

      const currentTabs = store.get(tabsAtom)
      const currentActiveTabId = store.get(activeTabIdAtom)
      const nextTabs = currentTabs.filter((tab) => (
        (tab.type !== 'agent' && tab.type !== 'preview') || !deletedSessionIds.has(tab.sessionId)
      ))
      const nextActiveTabId = currentActiveTabId && nextTabs.some((tab) => tab.id === currentActiveTabId)
        ? currentActiveTabId
        : nextTabs[0]?.id ?? null

      setTabs(nextTabs)
      setActiveTabId(nextActiveTabId)
      syncActiveTabSideEffects(nextActiveTabId ? nextTabs.find((tab) => tab.id === nextActiveTabId) ?? null : null)

      const remainingWorkspaces = await window.electronAPI.listAgentWorkspaces()

      setWorkspaces(remainingWorkspaces)
      await refreshAgentSidebarSessions(includeArchivedSessions)

      setExpandedExtraCountMap((prev) => {
        if (!prev.has(workspaceId)) return prev
        const next = new Map(prev)
        next.delete(workspaceId)
        return next
      })

      setCollapsedWorkspaceIds((prev) => deleteSetEntry(prev, workspaceId))
      setExpandedArchivedProjectIds((prev) => deleteSetEntry(prev, workspaceId))
      setExpandedDelegationParentIds((prev) => {
        let changed = false
        const next = new Set(prev)
        for (const sessionId of deletedSessionIds) {
          if (next.delete(sessionId)) changed = true
        }
        return changed ? next : prev
      })

      if (workspaceId === currentWorkspaceId) {
        const fallback = remainingWorkspaces.find((item) => item.slug === 'default') ?? remainingWorkspaces[0] ?? null
        setCurrentWorkspaceId(fallback?.id ?? null)
        if (fallback) {
          window.electronAPI.updateSettings({ agentWorkspaceId: fallback.id }).catch(console.error)
        }
      }

      toast.success('项目已删除', {
        description: `已删除「${workspace.name}」及其绑定资源`,
      })
    } catch (error) {
      console.error('[侧边栏] 删除项目失败:', error)
      const msg = error instanceof Error ? error.message : '删除项目失败'
      toast.error(msg)
    } finally {
      setDeletingWorkspaceId(null)
      setPendingDeleteWorkspaceId(null)
    }
  }, [
    pendingDeleteWorkspaceId,
    workspaces,
    canDeleteWorkspace,
    agentSessions,
    cleanupMapAtoms,
    setDraftSessionIds,
    setAgentMessagesCache,
    setAutomations,
    store,
    setTabs,
    setActiveTabId,
    syncActiveTabSideEffects,
    setWorkspaces,
    setAgentSessions,
    refreshAgentSidebarSessions,
    includeArchivedSessions,
    currentWorkspaceId,
    setCurrentWorkspaceId,
  ])

  const handleConfigureProject = React.useCallback((workspaceId: string): void => {
    // 项目菜单显式指定目标项目；不能借用当前会话的右侧组件宿主，否则会打开另一项目的 MCP。
    handleSelectProject(workspaceId)
    setAgentSkillsTab('mcp')
    setActiveView('agent-skills')
  }, [handleSelectProject, setActiveView, setAgentSkillsTab])

  /** 展开某个项目时每次额外显示的会话数量 */
  const handleShowMoreSessions = React.useCallback((workspaceId: string): void => {
    setExpandedExtraCountMap((prev) => {
      const next = new Map(prev)
      next.set(workspaceId, (prev.get(workspaceId) ?? 0) + PROJECT_SESSION_EXPAND_STEP)
      return next
    })
  }, [])

  /** 收起某个项目额外展开的会话 */
  const handleCollapseExtraSessions = React.useCallback((workspaceId: string): void => {
    setExpandedExtraCountMap((prev) => {
      if (!prev.has(workspaceId)) return prev
      const next = new Map(prev)
      next.delete(workspaceId)
      return next
    })
  }, [])

  /** 开始拖拽项目排序 */
  const handleProjectDragStart = React.useCallback((e: React.DragEvent, workspaceId: string): void => {
    setDragProjectId(workspaceId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', workspaceId)
  }, [])

  /** 根据鼠标位置计算项目插入点 */
  const handleProjectDragOver = React.useCallback((e: React.DragEvent, workspaceId: string): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragProjectId || dragProjectId === workspaceId) {
      setProjectDropIndicator(null)
      return
    }

    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    const position: 'before' | 'after' = ratio < 0.5 ? 'before' : 'after'
    setProjectDropIndicator((prev) => (
      prev?.id === workspaceId && prev.position === position
        ? prev
        : { id: workspaceId, position }
    ))
  }, [dragProjectId])

  const handleProjectDragLeave = React.useCallback((e: React.DragEvent): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setProjectDropIndicator(null)
    }
  }, [])

  /** 完成项目排序并持久化（商业版 Gi） */
  const handleProjectDrop = React.useCallback((e: React.DragEvent, targetWorkspaceId: string): void => {
    e.preventDefault()
    const indicator = projectDropIndicator
    if (!dragProjectId || dragProjectId === targetWorkspaceId || !indicator || indicator.id !== targetWorkspaceId) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }

    const baseIds = workspaces.map((workspace) => workspace.id)
    const fromIndex = baseIds.indexOf(dragProjectId)
    const toIndex = baseIds.indexOf(targetWorkspaceId)
    if (fromIndex === -1 || toIndex === -1) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }

    const reordered = [...baseIds]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) {
      setDragProjectId(null)
      setProjectDropIndicator(null)
      return
    }
    const adjustedToIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
    const insertIndex = indicator.position === 'after' ? adjustedToIndex + 1 : adjustedToIndex
    reordered.splice(insertIndex, 0, moved)

    setDragProjectId(null)
    setProjectDropIndicator(null)

    if (reordered.some((id, i) => id !== baseIds[i])) {
      const reorderedWorkspaces = reordered
        .map((id) => workspaces.find((w) => w.id === id))
        .filter((w): w is AgentWorkspace => !!w)
      setWorkspaces(reorderedWorkspaces)
      window.electronAPI
        .reorderAgentWorkspaces(reordered)
        .then(setWorkspaces)
        .catch((error) => {
          console.error('[侧边栏] 项目排序失败:', error)
          setWorkspaces(workspaces)
          toast.error('项目排序失败')
        })
    }
  }, [dragProjectId, projectDropIndicator, setWorkspaces, workspaces])

  const handleProjectDragEnd = React.useCallback((): void => {
    setDragProjectId(null)
    setProjectDropIndicator(null)
  }, [])

  /** 开始创建新项目 */
  const handleStartCreateProject = React.useCallback((): void => {
    setCreatingProject(true)
    setNewProjectName('')
    requestAnimationFrame(() => {
      newProjectInputRef.current?.focus()
    })
  }, [])

  /** 创建新项目，并设为当前项目 */
  const handleCreateProject = React.useCallback(async (): Promise<void> => {
    const trimmed = newProjectName.trim()
    if (!trimmed) {
      setCreatingProject(false)
      return
    }

    try {
      const { workspace, session } = await window.electronAPI.createAgentProject(
        { name: trimmed },
        agentChannelId || undefined,
        agentModelId || undefined,
      )
      setWorkspaces((prev) => [workspace, ...prev])
      setAgentSessions((prev) => [session, ...prev])
      setCurrentWorkspaceId(workspace.id)
      openSession('agent', session.id, session.title)
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
      setCreatingProject(false)
      setNewProjectName('')
    } catch (error) {
      const msg = error instanceof Error ? error.message : '创建项目失败'
      toast.error(msg)
    }
  }, [agentChannelId, agentModelId, newProjectName, openSession, setAgentSessions, setCurrentWorkspaceId, setWorkspaces])

  const handleCreateProjectKeyDown = React.useCallback((e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      void handleCreateProject()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setCreatingProject(false)
      setNewProjectName('')
    }
  }, [handleCreateProject])

  const handleCreateProjectFromFolder = React.useCallback(async (): Promise<void> => {
    try {
      const folder = await window.electronAPI.openFolderDialog()
      if (!folder) return
      const { workspace, session } = await window.electronAPI.createAgentProject(
        {
          name: folder.name,
          projectRootPath: folder.path,
        },
        agentChannelId || undefined,
        agentModelId || undefined,
      )
      setWorkspaces((prev) => [workspace, ...prev])
      setAgentSessions((prev) => [session, ...prev])
      setCurrentWorkspaceId(workspace.id)
      openSession('agent', session.id, session.title)
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '从文件夹创建项目失败'
      toast.error(msg)
    }
  }, [agentChannelId, agentModelId, openSession, setAgentSessions, setCurrentWorkspaceId, setWorkspaces])

  /** 选择 Agent 会话（打开或聚焦标签页）。协作子 Agent 保持左侧树形条目，但在父会话右侧查看。 */
  const handleSelectAgentSession = React.useCallback((id: string, title: string): void => {
    // 从收藏 / 定时任务面板打开会话时保留当前面板（商业版 ea 的 view 参数）
    const targetView = activeView === 'favorites' || activeView === 'automations' ? activeView : 'conversations'
    const rememberFavorite = (): void => {
      if (targetView === 'favorites') store.set(lastFavoriteSessionIdAtom, id)
    }
    const selectedSession = agentSessions.find((session) => session.id === id)
    if (selectedSession?.sourceDelegationId && selectedSession.parentSessionId) {
      const parentSession = agentSessions.find((session) => session.id === selectedSession.parentSessionId)
      if (parentSession) {
        openSession('agent', parentSession.id, parentSession.title, {
          view: targetView,
          onOpened: () => {
            if (store.get(agentSidePanelSplitMapAtom).has(parentSession.id)) {
              toast.info('请先退出并排模式，再切换子会话', {
                id: 'split-delegation-sidebar-navigation',
              })
            }
            store.set(agentSideDelegationMapAtom, (previous) => (
              selectDelegatedSession(previous, parentSession.id, selectedSession.id)
            ))
            store.set(agentSidePanelOpenAtomFamily(parentSession.id), true)
            rememberStopGenerationTarget({ kind: 'agent', sessionId: selectedSession.id })
            setUnviewedDelegatedCompleted((prev) => (
              markSessionCompletionViewed(prev, selectedSession.id)
            ))
            store.set(agentDiffPanelTabAtom, (previous) => {
              const next = new Map(previous)
              next.set(parentSession.id, getDelegationSidePanelTab())
              return next
            })
            rememberFavorite()
            setUnviewedCompleted((prev: Set<string>) => {
              if (!prev.has(id)) return prev
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          },
        })
        return
      }
    }

    openSession('agent', id, title, {
      view: targetView,
      onOpened: () => {
        rememberFavorite()
        // 清除该会话的"已完成未查看"标记
        setUnviewedCompleted((prev: Set<string>) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      },
    })
  }, [activeView, agentSessions, openSession, setActiveView, setUnviewedCompleted, setUnviewedDelegatedCompleted, store])

  const clearQuickSwitchHints = React.useCallback((): void => {
    for (const row of quickSwitchHintRowsRef.current) {
      delete row.dataset.quickSwitchLabel
      delete row.dataset.quickSwitchIndex
      row.querySelector<HTMLElement>('.session-quick-switch-modifier')?.replaceChildren()
      row.querySelector<HTMLElement>('.session-quick-switch-number')?.replaceChildren()
    }
    quickSwitchHintRowsRef.current = []
    quickSwitchTargetsRef.current = []
  }, [])

  const refreshQuickSwitchTargets = React.useCallback((): QuickSwitchTarget[] => {
    const root = sidebarRootRef.current
    if (!root) {
      clearQuickSwitchHints()
      return []
    }

    // 先完成所有布局读取，再只写入上次/本次涉及的最多 9 行，避免 write→read
    // 交错造成的 forced reflow。
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.session-quick-switch-row'))
    const selectedRows: HTMLElement[] = []
    const targets: QuickSwitchTarget[] = []
    for (const row of rows) {
      if (targets.length >= SESSION_QUICK_SWITCH_LIMIT) break
      if (!isQuickSwitchRowVisible(row, root)) continue

      const { sessionSwitchId, sessionSwitchTitle, sessionSwitchType } = row.dataset
      if (
        !sessionSwitchId
        || !sessionSwitchTitle
        || (sessionSwitchType !== 'chat' && sessionSwitchType !== 'agent')
      ) continue

      selectedRows.push(row)
      targets.push({ id: sessionSwitchId, title: sessionSwitchTitle, type: sessionSwitchType })
    }

    const modifierLabel = getPrimaryModifierLabel(isMac)
    const nextRows = new Set(selectedRows)
    for (const row of quickSwitchHintRowsRef.current) {
      if (nextRows.has(row)) continue
      delete row.dataset.quickSwitchLabel
      delete row.dataset.quickSwitchIndex
      row.querySelector<HTMLElement>('.session-quick-switch-modifier')?.replaceChildren()
      row.querySelector<HTMLElement>('.session-quick-switch-number')?.replaceChildren()
    }
    selectedRows.forEach((row, index) => {
      const position = String(index + 1)
      if (row.dataset.quickSwitchIndex === position) return
      row.dataset.quickSwitchIndex = position
      row.dataset.quickSwitchLabel = `${modifierLabel}${position}`
      const modifier = row.querySelector<HTMLElement>('.session-quick-switch-modifier')
      const number = row.querySelector<HTMLElement>('.session-quick-switch-number')
      if (modifier) modifier.textContent = modifierLabel
      if (number) number.textContent = position
    })

    quickSwitchHintRowsRef.current = selectedRows
    quickSwitchTargetsRef.current = targets
    return targets
  }, [clearQuickSwitchHints, isMac])

  React.useEffect(() => {
    const root = sidebarRootRef.current
    if (!root) return

    if (!quickSwitchHintsVisible) {
      if (quickSwitchRefreshFrameRef.current !== null) {
        cancelAnimationFrame(quickSwitchRefreshFrameRef.current)
        quickSwitchRefreshFrameRef.current = null
      }
      clearQuickSwitchHints()
      return
    }

    const refresh = (): void => {
      if (quickSwitchRefreshFrameRef.current !== null) return
      quickSwitchRefreshFrameRef.current = requestAnimationFrame(() => {
        quickSwitchRefreshFrameRef.current = null
        refreshQuickSwitchTargets()
      })
    }
    refresh()
    root.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    return () => {
      if (quickSwitchRefreshFrameRef.current !== null) {
        cancelAnimationFrame(quickSwitchRefreshFrameRef.current)
        quickSwitchRefreshFrameRef.current = null
      }
      root.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
    }
  }, [
    quickSwitchHintsVisible,
    clearQuickSwitchHints,
    refreshQuickSwitchTargets,
    sidebarCollapsed,
    viewMode,
    agentSessions,
    pinnedAgentSessions,
    expandedExtraCountMap,
    collapsedWorkspaceIds,
    expandedArchivedProjectIds,
    expandedDelegationParentIds,
    collapsedDelegationParentIds,
    activeSessionId,
  ])

  React.useEffect(() => {
    const clearHintTimer = (): void => {
      if (quickSwitchHintTimerRef.current !== null) {
        clearTimeout(quickSwitchHintTimerRef.current)
        quickSwitchHintTimerRef.current = null
      }
    }

    const hideHints = (): void => {
      clearHintTimer()
      setQuickSwitchHintsVisible(false)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (processedQuickSwitchEventsRef.current.has(event)) return
      processedQuickSwitchEventsRef.current.add(event)
      if (event.isComposing) return
      if (settingsOpen || searchDialogOpen) return

      const number = getQuickSwitchNumber(event)
      if (number !== null && hasOnlyPrimaryModifier(event, isMac)) {
        const targets = refreshQuickSwitchTargets()
        const target = targets[number - 1]
        if (!target) return

        event.preventDefault()
        event.stopPropagation()
        handleSelectAgentSession(target.id, target.title)
        return
      }

      if (!isPrimaryModifierKey(event, isMac) || event.repeat) return
      clearHintTimer()
      quickSwitchHintTimerRef.current = setTimeout(() => {
        quickSwitchHintTimerRef.current = null
        if (refreshQuickSwitchTargets().length === 0) return
        setQuickSwitchHintsVisible(true)
      }, SESSION_QUICK_SWITCH_HINT_DELAY_MS)
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (processedQuickSwitchEventsRef.current.has(event)) return
      processedQuickSwitchEventsRef.current.add(event)
      if (isPrimaryModifierKey(event, isMac)) {
        hideHints()
      }
    }

    const handleForwardedKeyDown = (event: Event): void => {
      const forwarded = event as CustomEvent<{ event?: KeyboardEvent }>
      const originalEvent = forwarded.detail?.event
      if (originalEvent) handleKeyDown(originalEvent)
    }

    const handleForwardedKeyUp = (event: Event): void => {
      const forwarded = event as CustomEvent<{ event?: KeyboardEvent }>
      const originalEvent = forwarded.detail?.event
      if (originalEvent) handleKeyUp(originalEvent)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    window.addEventListener(SESSION_QUICK_SWITCH_KEYDOWN_EVENT, handleForwardedKeyDown)
    window.addEventListener(SESSION_QUICK_SWITCH_KEYUP_EVENT, handleForwardedKeyUp)
    window.addEventListener('blur', hideHints)
    document.addEventListener('visibilitychange', hideHints)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      window.removeEventListener(SESSION_QUICK_SWITCH_KEYDOWN_EVENT, handleForwardedKeyDown)
      window.removeEventListener(SESSION_QUICK_SWITCH_KEYUP_EVENT, handleForwardedKeyUp)
      window.removeEventListener('blur', hideHints)
      document.removeEventListener('visibilitychange', hideHints)
      clearHintTimer()
    }
  }, [
    isMac,
    settingsOpen,
    searchDialogOpen,
    handleSelectAgentSession,
    refreshQuickSwitchTargets,
  ])

  /** 重命名工作区（项目）名称 */
  const handleWorkspaceRename = React.useCallback(async (workspaceId: string, newName: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentWorkspace(workspaceId, { name: newName })
      setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
    } catch (error) {
      console.error('[侧边栏] 重命名工作区失败:', error)
      const msg = error instanceof Error ? error.message : '重命名失败'
      toast.error(msg)
    }
  }, [setWorkspaces])

  /** 重新选择已有文件夹作为本地项目根，保留该项目的会话和设置。 */
  const handleRelinkProjectRoot = React.useCallback(async (workspaceId: string): Promise<void> => {
    try {
      const folder = await window.electronAPI.openFolderDialog()
      if (!folder) return
      const updated = await window.electronAPI.relinkAgentWorkspaceProjectRoot(workspaceId, folder.path)
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)))
      toast.success('本地项目根已重新关联', { description: folder.path })
    } catch (error) {
      console.error('[侧边栏] 重新关联本地项目根失败:', error)
      toast.error(error instanceof Error ? error.message : '重新关联项目文件夹失败')
    }
  }, [setWorkspaces])

  /** 确认在原路径新建空目录。 */
  const handleConfirmRestoreProjectRoot = React.useCallback(async (): Promise<void> => {
    const workspaceId = pendingRestoreProjectRootId
    if (!workspaceId) return

    try {
      setRestoringProjectRootId(workspaceId)
      const updated = await window.electronAPI.restoreAgentWorkspaceProjectRoot(workspaceId)
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)))
      toast.success('已在原路径新建空项目文件夹', { description: updated.projectRootPath })
      setPendingRestoreProjectRootId(null)
    } catch (error) {
      console.error('[侧边栏] 恢复本地项目根失败:', error)
      toast.error(error instanceof Error ? error.message : '恢复项目文件夹失败')
    } finally {
      setRestoringProjectRootId(null)
    }
  }, [pendingRestoreProjectRootId, setWorkspaces])

  /** 重命名 Agent 会话标题 */
  const handleAgentRename = React.useCallback(async (id: string, newTitle: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(id, newTitle)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
      // 同步更新标签页标题
      setTabs((prev) => updateTabTitle(prev, id, newTitle))
    } catch (error) {
      console.error('[侧边栏] 重命名 Agent 会话失败:', error)
    }
  }, [setAgentSessions, setTabs])

  const closeArchivedAgentTabs = React.useCallback((sessionIds: string[]): void => {
    const ids = new Set(sessionIds)
    const currentTabs = store.get(tabsAtom)
    const currentActiveTabId = store.get(activeTabIdAtom)
    const nextTabs = currentTabs.filter((tab) => (
      (tab.type !== 'agent' && tab.type !== 'preview') || !ids.has(tab.sessionId)
    ))
    const nextActiveTabId = currentActiveTabId && nextTabs.some((tab) => tab.id === currentActiveTabId)
      ? currentActiveTabId
      : nextTabs[0]?.id ?? null

    setTabs(nextTabs)
    setActiveTabId(nextActiveTabId)
    for (const sessionId of ids) cleanupMapAtoms(sessionId)
    syncActiveTabSideEffects(nextActiveTabId ? nextTabs.find((tab) => tab.id === nextActiveTabId) ?? null : null)
  }, [cleanupMapAtoms, setActiveTabId, setTabs, store, syncActiveTabSideEffects])

  /** 切换 Agent 会话置顶状态 */
  const handleTogglePinAgent = React.useCallback(async (
    id: string,
    cascade: boolean = true,
  ): Promise<void> => {
    const sessions = store.get(agentSessionsAtom)
    const original = sessions.find((s) => s.id === id)
    const delegatedChildren = cascade
      ? getSyncableDelegatedChildren(sessions, id, draftSessionIds)
      : []
    try {
      const updated = await window.electronAPI.togglePinAgentSession(id)
      const targetPinned = !!updated.pinned
      for (const child of delegatedChildren) {
        if (!!child.pinned !== targetPinned) {
          await window.electronAPI.togglePinAgentSession(child.id)
        }
      }
      await refreshAgentSidebarSessions(includeArchivedSessions)
      if (updated.pinned) {
        if (original?.archived && !updated.archived) {
          toast.success('已置顶', { description: '已自动取消归档' })
        } else if (delegatedChildren.length > 0) {
          toast.success('已置顶', { description: `已同步 ${delegatedChildren.length} 个子会话` })
        } else {
          toast.success('已置顶')
        }
      } else {
        toast.success(
          '已取消置顶',
          delegatedChildren.length > 0
            ? { description: `已同步 ${delegatedChildren.length} 个子会话` }
            : undefined,
        )
      }
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话置顶失败:', error)
      // 级联可能在中途失败，导致部分子会话已切换、部分未切换。
      // 重新拉取磁盘真实状态，避免侧边栏与磁盘不一致直到下次重载。
      if (delegatedChildren.length > 0) {
        try {
          await refreshAgentSidebarSessions(includeArchivedSessions)
        } catch (refreshError) {
          console.error('[侧边栏] 置顶失败后刷新会话列表失败:', refreshError)
        }
      }
    }
  }, [draftSessionIds, refreshAgentSidebarSessions, setAgentSessions, store, viewMode, includeArchivedSessions])

  /** 切换 Agent 会话星标状态 */
  const handleToggleStarAgent = React.useCallback(async (id: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.toggleStarAgentSession(id)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updated))
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话星标失败:', error)
    }
  }, [setAgentSessions])

  /** 切换 Agent 会话归档状态 */
  const handleToggleArchiveAgent = React.useCallback(async (id: string): Promise<void> => {
    const sessions = store.get(agentSessionsAtom)
    // 在 try 外追踪级联状态，便于失败时重新同步与关闭已归档子会话的标签页。
    let cascaded = false
    const changedChildIds: string[] = []
    try {
      const updated = await window.electronAPI.toggleArchiveAgentSession(id)
      const targetArchived = !!updated.archived
      // 归档：同步未归档的子会话一起进归档
      // 解归档：同步已归档的子会话一起恢复（修复"归档是单向级联"问题）
      const delegatedChildren = targetArchived
        ? getSyncableDelegatedChildren(sessions, id, draftSessionIds)
        : getArchivedDelegatedChildren(sessions, id, draftSessionIds)
      cascaded = delegatedChildren.length > 0
      const failedChildIds: string[] = []
      for (const child of delegatedChildren) {
        if (!!child.archived !== targetArchived) {
          try {
            const childUpdated = await window.electronAPI.toggleArchiveAgentSession(child.id)
            changedChildIds.push(childUpdated.id)
          } catch (childError) {
            console.error(`[侧边栏] 级联归档子会话失败 (${child.id}):`, childError)
            failedChildIds.push(child.id)
          }
        }
      }
      await refreshAgentSidebarSessions(includeArchivedSessions)
      // 归档时自动关闭该会话的标签页，并同步新激活标签的副作用，
      // 否则 RightSidePanel（依赖 currentAgentSessionIdAtom）会因为
      // 指针被错误置 null 而消失。
      if (updated.archived) {
        closeArchivedAgentTabs([updated.id, ...changedChildIds])
      }
      if (failedChildIds.length > 0) {
        toast.error(`部分子会话${updated.archived ? '归档' : '解归档'}失败（${failedChildIds.length} 个）`)
      } else {
        toast.success(
          updated.archived ? '已归档' : '已取消归档',
          delegatedChildren.length > 0
            ? { description: `已同步 ${delegatedChildren.length} 个子会话` }
            : undefined,
        )
      }
    } catch (error) {
      console.error('[侧边栏] 切换 Agent 会话归档失败:', error)
      // 父会话操作本身失败。已成功归档的子会话仍需关闭标签并全量刷新。
      if (cascaded) {
        if (changedChildIds.length > 0) {
          closeArchivedAgentTabs(changedChildIds)
        }
        try {
          await refreshAgentSidebarSessions(includeArchivedSessions)
        } catch (refreshError) {
          console.error('[侧边栏] 归档失败后刷新会话列表失败:', refreshError)
        }
      }
    }
  }, [closeArchivedAgentTabs, draftSessionIds, refreshAgentSidebarSessions, setAgentSessions, store, viewMode, includeArchivedSessions])

  /** 请求迁移会话到其他项目（弹出迁移对话框） */
  const handleRequestMove = React.useCallback((id: string): void => {
    setMoveTargetId(id)
    // 查找被迁移会话所属的工作区——排除分区应基于此而非当前 UI 工作区
    const session = agentSessions.find((s) => s.id === id)
    setMoveSourceWorkspaceId(session?.workspaceId)
  }, [agentSessions])

  /** 迁移会话到另一个项目后的回调 */
  const handleSessionMoved = async (updatedSession: AgentSessionMeta, targetWorkspaceName: string): Promise<void> => {
    const movedSessionIds = collectDelegatedSessionTreeIds(store.get(agentSessionsAtom), updatedSession.id)
    try {
      await refreshAgentSidebarSessions(includeArchivedSessions)
    } catch (error) {
      console.error('[侧边栏] 迁移后刷新 Agent 会话列表失败:', error)
      setAgentSessions((prev) => replaceAgentSessionInFreshnessOrder(prev, updatedSession))
    }
    const hasMovedOpenTab = tabs.some((tab) => (
      (tab.type === 'agent' || tab.type === 'preview')
      && movedSessionIds.has(tab.sessionId)
    ))
    if (hasMovedOpenTab) {
      let tabResult = { tabs, activeTabId }
      for (const sessionId of movedSessionIds) {
        tabResult = closeTab(tabResult.tabs, tabResult.activeTabId, sessionId)
        cleanupMapAtoms(sessionId)
      }
      setTabs(tabResult.tabs)
      setActiveTabId(tabResult.activeTabId)
      const nextActiveTab = tabResult.activeTabId
        ? tabResult.tabs.find((tab) => tab.id === tabResult.activeTabId) ?? null
        : null
      syncActiveTabSideEffects(nextActiveTab)
    }
    if (currentAgentSessionId && movedSessionIds.has(currentAgentSessionId)) {
      setCurrentAgentSessionId(null)
    }
    setMoveTargetId(null)
    toast.success('会话已迁移', {
      description: `已迁移到「${targetWorkspaceName}」，子会话会一起移动`,
    })
  }

  /** Agent 普通历史按项目分组（排除置顶 / 归档 / draft） */
  const agentProjectGroups = React.useMemo<AgentProjectGroup[]>(
    () => {
      const sessionsByWorkspaceId = new Map<string, AgentSessionMeta[]>()
      for (const workspace of workspaces) {
        sessionsByWorkspaceId.set(workspace.id, [])
      }

      const visibleHistory = sortAgentSessionsByActivityDesc(
        agentSessions.filter((session) =>
          !session.archived
          && !session.pinned
          && !session.isDraft
          && !draftSessionIds.has(session.id)
          // 自动任务会话不进入项目列表，统一归到「自动任务」视图
          && !isHiddenAutomationSession(session)
          // 已被置顶母会话收纳的子会话留在置顶区的母会话下面，避免重复显示为项目根会话
          && !hasPinnedVisibleParent(session, agentSessions)
        )
      )

      const defaultWsId = workspaces.find((ws) => ws.slug === 'default')?.id ?? workspaces[0]?.id
      for (const session of visibleHistory) {
        const targetId = session.workspaceId && sessionsByWorkspaceId.has(session.workspaceId)
          ? session.workspaceId
          : defaultWsId
        if (!targetId) continue
        sessionsByWorkspaceId.get(targetId)!.push(session)
      }

      return workspaces.map((workspace) => ({
        workspace,
        sessions: sessionsByWorkspaceId.get(workspace.id) ?? [],
      }))
    },
    [agentSessions, draftSessionIds, workspaces],
  )

  /** Agent 归档会话按项目分组；归档列表仍只在进入该视图后按需加载。 */
  const archivedAgentSessionProjectGroups = React.useMemo(() => {
    if (viewMode !== 'archived') return []
    return groupArchivedAgentSessionsByProject({
      sessions: agentSessions,
      workspaces,
      excludedSessionIds: draftSessionIds,
    }).map((group) => ({
      ...group,
      trees: buildAgentSessionTrees(group.sessions),
    }))
  }, [agentSessions, draftSessionIds, viewMode, workspaces])

  const railRecentItems = React.useMemo<RailRecentItem[]>(() => {
    const eligibleSessions = agentSessions.filter((session) => (
      !session.archived
      && !session.isDraft
      && !draftSessionIds.has(session.id)
      // 自动任务会话不出现在收起态 Rail，与展开态列表保持一致
      && !isHiddenAutomationSession(session)
    ))
    const railTrees = getCollapsedAgentRailTrees({
      sessions: eligibleSessions,
      workspaceId: currentWorkspaceId,
      activeSessionId,
      agentIndicatorMap,
      unviewedCompletedSessionIds,
      // CollapsedSessionRail 自己截取 5 个可见根；Popover 打开后它需要完整候选集，
      // 才能用快照 id 取回可能已被动态排序挤出前五的 Anchor。
      limit: Number.POSITIVE_INFINITY,
    })

    return railTrees.map((tree) => ({
      id: tree.session.id,
      title: tree.session.title,
      type: 'agent' as const,
      initial: getRailInitial(tree.session.title),
      active: tree.session.id === activeSessionId,
      // 色条与展开态行共用会话树聚合状态：父会话空闲时也跟随子会话的运行/阻塞/完成态。
      status: getCollapsedAgentRailTreeStatus(tree, agentIndicatorMap, unviewedCompletedSessionIds),
      pinned: !!tree.session.pinned,
      workspaceName: tree.session.workspaceId ? workspaceNameMap.get(tree.session.workspaceId) : undefined,
      isAutomation: !!tree.session.sourceAutomationId,
      // 正常 child 收纳进父 Popover；仅父不在当前 workspace 的 moved/orphan child
      // 复用展开态策略成为可达根条目，并以 delegation 图标区分。
      isDelegation: isDelegatedChildSession(tree.session),
      childSessions: tree.childSessions,
    }))
  }, [
    agentSessions,
    draftSessionIds,
    currentWorkspaceId,
    activeSessionId,
    agentIndicatorMap,
    unviewedCompletedSessionIds,
    workspaceNameMap,
  ])

  const handleSelectRailChild = React.useCallback((session: AgentSessionMeta): void => {
    handleSelectAgentSession(session.id, session.title)
  }, [handleSelectAgentSession])

  // 删除确认弹窗（collapsed/expanded 共享）
  const deleteDialog = (
    <AlertDialog
      open={pendingDeleteId !== null}
      onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}
    >
      <AlertDialogContent
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          // 若焦点已在某个 Action 按钮上，让按钮自身的 onClick 处理（避免重复触发）
          const target = e.target as HTMLElement
          if (target.closest('button[role="menuitem"], button[data-radix-dialog-action], button')) return
          e.preventDefault()
          // 有子会话时默认不级联，避免 Enter 误删子会话
          void handleConfirmDelete(false)
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除会话</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingDeleteChildCount > 0
              ? `此会话下还有 ${pendingDeleteChildCount} 个子会话。删除后将无法恢复，请选择是否一并删除子会话。`
              : '删除后将无法恢复，确定要删除这个对话吗？'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          {pendingDeleteChildCount > 0 ? (
            <>
              <AlertDialogAction
                onClick={() => { void handleConfirmDelete(false) }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                只删这个
              </AlertDialogAction>
              <AlertDialogAction
                onClick={() => { void handleConfirmDelete(true) }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                连子会话一起删
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction
              onClick={() => { void handleConfirmDelete(false) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // 项目删除确认弹窗（会同时删除项目下的会话与工作区资源）
  const projectDeleteDialog = (
    <AlertDialog
      open={pendingDeleteWorkspaceId !== null}
      onOpenChange={(open) => {
        if (!open && !deletingWorkspaceId) setPendingDeleteWorkspaceId(null)
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !deletingWorkspaceId) {
            e.preventDefault()
            void handleConfirmDeleteWorkspace()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>确认删除项目</AlertDialogTitle>
          <AlertDialogDescription>
            将删除「{pendingDeleteWorkspace?.name ?? '该项目'}」在 Proma 中保存的会话、自动任务、MCP、Skills 与 Proma 工作区配置；空白项目的 Proma 托管项目文件也会被删除。本地项目根目录、附加目录和附加文件只会移除关联，不会删除原始文件。删除后无法恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!deletingWorkspaceId}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={!!deletingWorkspaceId}
            onClick={handleConfirmDeleteWorkspace}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deletingWorkspaceId ? '删除中...' : '删除项目'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  const restoreProjectRootDialog = (
    <AlertDialog
      open={pendingRestoreProjectRootId !== null}
      onOpenChange={(open) => {
        if (!open && !restoringProjectRootId) setPendingRestoreProjectRootId(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>在原路径新建空文件夹？</AlertDialogTitle>
          <AlertDialogDescription>
            将为「{pendingRestoreProjectRootWorkspace?.name ?? '该项目'}」在原路径创建一个空文件夹：
            <span className="mt-2 block break-all font-mono text-xs text-foreground">
              {pendingRestoreProjectRootWorkspace?.projectRootPath}
            </span>
            此操作不会恢复原来的文件，仅用于继续使用该项目关联。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={!!restoringProjectRootId}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={!!restoringProjectRootId}
            onClick={() => void handleConfirmRestoreProjectRoot()}
          >
            {restoringProjectRootId ? '创建中...' : '新建空文件夹'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // 迁移会话对话框（collapsed/expanded 共享）
  const moveDialog = (
    <MoveSessionDialog
      open={moveTargetId !== null}
      onOpenChange={(open) => { if (!open) setMoveTargetId(null) }}
      sessionId={moveTargetId ?? ''}
      sourceWorkspaceId={moveSourceWorkspaceId ?? undefined}
      workspaces={workspaces}
      onMoved={handleSessionMoved}
    />
  )

  const agentArchivedVirtualRows = React.useMemo<VirtualSidebarRow[]>(() => {
    const rows: VirtualSidebarRow[] = []
    for (const group of archivedAgentSessionProjectGroups) {
      const collapsed = !expandedArchivedProjectIds.has(group.id)
      const isCurrentProject = group.kind === 'workspace' && group.id === currentWorkspaceId
      rows.push({
        id: `agent-archived-project-${group.id}`,
        estimateSize: 42,
        content: (
          <div className="pl-1 pr-3">
            <section className="relative py-0.5 rounded-md">
              <div className="group/project relative flex items-center">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => handleToggleArchivedProject(group.id)}
                  className={cn(
                    'relative flex-1 min-w-0 flex h-[var(--sidebar-project-row-height,38px)] items-center gap-2 pl-[10px] pr-1 py-1.5 rounded-md text-left transition-[color,background-color] titlebar-no-drag hover:bg-foreground/[0.025]',
                    'text-[hsl(var(--sidebar-primary-foreground))] hover:text-[hsl(var(--sidebar-primary-foreground))]',
                  )}
                >
                  {group.kind === 'automation' ? (
                    <Clock size={16} className="flex-shrink-0 text-foreground/40" />
                  ) : (
                    <FolderOpen size={16} className="flex-shrink-0 text-[hsl(var(--sidebar-primary-foreground)/0.78)] dark:text-[hsl(var(--sidebar-primary-foreground)/0.65)]" />
                  )}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-[length:calc(14px+var(--reading-font-size-offset,0px))] font-medium leading-5">{group.label}</span>
                    <LocalProjectBadge
                      projectRootPath={group.workspace?.projectRootPath}
                      projectRootStatus={group.workspace?.projectRootStatus}
                    />
                    {isCurrentProject && (
                      <span className="workspace-selected-triangle flex-shrink-0" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-[4px] flex-1" aria-hidden="true" />
                  {group.kind === 'automation' && (
                    <ChevronRight
                      size={12}
                      className={cn(
                        'flex-shrink-0 text-foreground/30 transition-transform duration-150',
                        collapsed ? '-rotate-90' : 'rotate-90',
                      )}
                    />
                  )}
                </button>
              </div>
            </section>
          </div>
        ),
      })
      if (collapsed) continue
      for (const item of group.trees) {
        const childCount = item.childSessions.length
        const rowStatus = getSessionTreeStatus(item, agentIndicatorMap)
        const treeActive = treeContainsSessionId(item, activeSessionId)
        const activeChildVisible = item.childSessions.some((child) => child.id === activeSessionId)
        const expandedChildren = expandedDelegationParentIds.has(item.session.id)
          || (activeChildVisible && !collapsedDelegationParentIds.has(item.session.id))
        rows.push({
          id: `agent-archived-${item.session.id}`,
          estimateSize: 38,
          content: (
            <div className="px-3">
              <AgentSessionItem
                session={item.session}
                active={treeActive}
                indicatorStatus={rowStatus}
                showPinIcon={!!item.session.pinned}
                disableMiniMap={!sessionHoverPreviewEnabled}
                delegationSummary={childCount > 0
                  ? {
                    total: childCount,
                    settled: countSettledDelegatedChildren(item.childSessions, agentIndicatorMap),
                    expanded: expandedChildren,
                    onToggle: () => handleToggleDelegationParent(item.session.id, expandedChildren),
                  }
                  : undefined}
                leftAccent={getSessionLeftAccent(rowStatus)}
                relativeTimeNow={relativeTimeNow}
                onSelect={handleSelectAgentSession}
                onRequestDelete={handleRequestDelete}
                onRequestMove={handleRequestMove}
                onRename={handleAgentRename}
                onTogglePin={handleTogglePinAgent}
                onToggleStar={handleToggleStarAgent}
                onToggleArchive={handleToggleArchiveAgent}
              />
            </div>
          ),
        })
        if (expandedChildren) {
          for (const [childIndex, childSession] of item.childSessions.entries()) {
            rows.push({
              id: `agent-archived-child-${childSession.id}`,
              estimateSize: childIndex === 0 ? 40 : 38,
              content: (
                <div className={cn(
                  'ml-6 border-l border-foreground/10 pl-2 pr-3',
                  childIndex === 0 && 'pt-0.5',
                )}>
                  <DelegatedChildSessionItem
                    session={childSession}
                    activeSessionId={activeSessionId}
                    activeDelegationSessionId={activeDelegationSessionId}
                    agentIndicatorMap={agentIndicatorMap}
                    relativeTimeNow={relativeTimeNow}
                    onSelect={handleSelectAgentSession}
                    onRequestDelete={handleRequestDelete}
                    onRequestMove={handleRequestMove}
                    onRename={handleAgentRename}
                    onTogglePin={handleTogglePinAgent}
                    onToggleStar={handleToggleStarAgent}
                    onToggleArchive={handleToggleArchiveAgent}
                  />
                </div>
              ),
            })
          }
        }
      }
    }
    return rows
  }, [activeDelegationSessionId, activeSessionId, agentIndicatorMap, archivedAgentSessionProjectGroups, collapsedDelegationParentIds, currentWorkspaceId, expandedArchivedProjectIds, expandedDelegationParentIds, handleAgentRename, handleRequestDelete, handleRequestMove, handleSelectAgentSession, handleToggleArchiveAgent, handleToggleArchivedProject, handleToggleDelegationParent, handleTogglePinAgent, handleToggleStarAgent, relativeTimeNow, sessionHoverPreviewEnabled])

  const agentActiveRows = React.useMemo<VirtualSidebarRow[]>(() => {
    if (viewMode !== 'active') return []
    const rows: VirtualSidebarRow[] = []

    const pushSessionTreeRows = (
      item: AgentSessionTreeItem,
      showPinIcon: boolean,
      projectWorkspaceId?: string,
    ): void => {
      const childCount = item.childSessions.length
      const rowStatus = getSessionTreeStatus(item, agentIndicatorMap)
      const treeActive = treeContainsSessionId(item, activeSessionId)
      const activeChildVisible = item.childSessions.some((child) => child.id === activeSessionId)
      const expandedChildren = expandedDelegationParentIds.has(item.session.id)
        || (activeChildVisible && !collapsedDelegationParentIds.has(item.session.id))

      rows.push({
        id: `agent-${item.session.id}`,
        estimateSize: 38,
        content: (
          <div
            className="ml-7"
            onDragOver={projectWorkspaceId ? (event) => handleProjectDragOver(event, projectWorkspaceId) : undefined}
            onDragLeave={projectWorkspaceId ? handleProjectDragLeave : undefined}
            onDrop={projectWorkspaceId ? (event) => handleProjectDrop(event, projectWorkspaceId) : undefined}
          >
            <AgentSessionItem
              session={item.session}
              active={treeActive}
              indicatorStatus={rowStatus}
              showPinIcon={showPinIcon && !!item.session.pinned}
              disableMiniMap={!sessionHoverPreviewEnabled}
              delegationSummary={childCount > 0
                ? {
                  total: childCount,
                  settled: countSettledDelegatedChildren(item.childSessions, agentIndicatorMap),
                  expanded: expandedChildren,
                  onToggle: () => handleToggleDelegationParent(item.session.id, expandedChildren),
                }
                : undefined}
              leftAccent={getSessionLeftAccent(rowStatus)}
              relativeTimeNow={relativeTimeNow}
              onSelect={handleSelectAgentSession}
              onRequestDelete={handleRequestDelete}
              onRequestMove={handleRequestMove}
              onRename={handleAgentRename}
              onTogglePin={handleTogglePinAgent}
              onToggleStar={handleToggleStarAgent}
              onToggleArchive={handleToggleArchiveAgent}
            />
          </div>
        ),
      })

      if (childCount > 0 && expandedChildren) {
        for (const [childIndex, childSession] of item.childSessions.entries()) {
          rows.push({
            id: `agent-child-${childSession.id}`,
            estimateSize: childIndex === 0 ? 40 : 38,
            content: (
              <div
                className={cn(
                  'ml-7 border-l border-foreground/10 pl-2',
                  childIndex === 0 && 'pt-0.5',
                )}
                onDragOver={projectWorkspaceId ? (event) => handleProjectDragOver(event, projectWorkspaceId) : undefined}
                onDragLeave={projectWorkspaceId ? handleProjectDragLeave : undefined}
                onDrop={projectWorkspaceId ? (event) => handleProjectDrop(event, projectWorkspaceId) : undefined}
              >
                <DelegatedChildSessionItem
                  session={childSession}
                  activeSessionId={activeSessionId}
                  activeDelegationSessionId={activeDelegationSessionId}
                  agentIndicatorMap={agentIndicatorMap}
                  relativeTimeNow={relativeTimeNow}
                  onSelect={handleSelectAgentSession}
                  onRequestDelete={handleRequestDelete}
                  onRequestMove={handleRequestMove}
                  onRename={handleAgentRename}
                  onTogglePin={handleTogglePinAgent}
                  onToggleStar={handleToggleStarAgent}
                  onToggleArchive={handleToggleArchiveAgent}
                />
              </div>
            ),
          })
        }
      }
    }

    if (pinnedAgentSessionTrees.length > 0) {
      rows.push({
        id: 'agent-pinned-heading',
        estimateSize: 32,
        content: <div className="pl-2 pr-3.5 pt-2 pb-1 text-[length:calc(13px+var(--reading-font-size-offset,0px))] font-semibold leading-5 text-foreground/45 select-none">置顶</div>,
      })
      for (const item of pinnedAgentSessionTrees) {
        pushSessionTreeRows(item, false)
      }
    }

    const hasExpandedProject = agentProjectGroups.some((group) => !collapsedWorkspaceIds.has(group.workspace.id))

    rows.push({
      id: 'agent-project-heading',
      estimateSize: 40,
      content: (
        <div className="px-0 pt-2 pb-1 flex items-center justify-between">
          <span className="px-2 text-[length:calc(13px+var(--reading-font-size-offset,0px))] font-semibold leading-5 text-foreground/45 select-none">项目</span>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!hasExpandedProject}
                  onClick={() => {
                    setCollapsedWorkspaceIds((prev) => {
                      const next = new Set(prev)
                      for (const group of agentProjectGroups) next.add(group.workspace.id)
                      return next
                    })
                  }}
                  className="size-7 flex items-center justify-center rounded-md text-[hsl(var(--sidebar-primary-foreground)/0.65)] hover:bg-foreground/[0.06] hover:text-[hsl(var(--sidebar-primary-foreground))] transition-colors titlebar-no-drag disabled:opacity-30 disabled:pointer-events-none"
                  aria-label="折叠所有项目"
                >
                  <ChevronsDownUp size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">折叠所有项目</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void handleCreateProjectFromFolder()}
                  className="size-7 flex items-center justify-center rounded-md text-[hsl(var(--sidebar-primary-foreground)/0.65)] hover:bg-foreground/[0.06] hover:text-[hsl(var(--sidebar-primary-foreground))] transition-colors titlebar-no-drag"
                  aria-label="从本地文件夹创建项目"
                >
                  <FolderInput size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">从本地文件夹创建项目</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleStartCreateProject}
                  className="size-7 flex items-center justify-center rounded-md text-[hsl(var(--sidebar-primary-foreground)/0.65)] hover:bg-foreground/[0.06] hover:text-[hsl(var(--sidebar-primary-foreground))] transition-colors titlebar-no-drag"
                  aria-label="新建空白项目"
                >
                  <Plus size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">新建空白项目</TooltipContent>
            </Tooltip>
          </div>
        </div>
      ),
    })

    if (creatingProject) {
      rows.push({
        id: 'agent-project-create',
        estimateSize: 36,
        content: (
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded-md bg-foreground/[0.04]">
            <FolderOpen size={16} className="flex-shrink-0 text-foreground/40" />
            <input
              ref={newProjectInputRef}
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={handleCreateProjectKeyDown}
              onBlur={() => {
                setCreatingProject(false)
                setNewProjectName('')
              }}
              placeholder="项目名称..."
              className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground border-b border-primary/50 outline-none px-0.5"
              maxLength={50}
            />
          </div>
        ),
      })
    }

    for (const group of agentProjectGroups) {
      const collapsed = collapsedWorkspaceIds.has(group.workspace.id)
      const extraCount = expandedExtraCountMap.get(group.workspace.id) ?? 0
      const visible = getVisibleAgentProjectSessions({
        group,
        activeSessionId,
        agentIndicatorMap,
        relativeTimeNow,
        extraCount,
      })

      rows.push({
        id: `agent-project-${group.workspace.id}`,
        estimateSize: 42,
        content: (
          <div className="pl-0">
            <AgentProjectGroupItem
              group={group}
              currentWorkspaceId={currentWorkspaceId}
              expanded={extraCount > 0}
              extraCount={extraCount}
              collapsed={collapsed}
              activeSessionId={activeSessionId}
              activeDelegationSessionId={activeDelegationSessionId}
              agentIndicatorMap={agentIndicatorMap}
              expandedDelegationParentIds={expandedDelegationParentIds}
              collapsedDelegationParentIds={collapsedDelegationParentIds}
              relativeTimeNow={relativeTimeNow}
              dragging={dragProjectId === group.workspace.id}
              dropPosition={projectDropIndicator?.id === group.workspace.id ? projectDropIndicator.position : null}
              onShowMore={handleShowMoreSessions}
              onCollapseExtra={handleCollapseExtraSessions}
              onSelectProject={handleSelectProject}
              onNewSession={createAgentSessionInWorkspace}
              onDragStart={handleProjectDragStart}
              onDragOver={handleProjectDragOver}
              onDragLeave={handleProjectDragLeave}
              onDrop={handleProjectDrop}
              onDragEnd={handleProjectDragEnd}
              onConfigureProject={handleConfigureProject}
              onRenameWorkspace={handleWorkspaceRename}
              onRelinkProjectRoot={handleRelinkProjectRoot}
              onRequestRestoreProjectRoot={setPendingRestoreProjectRootId}
              onRequestDeleteWorkspace={handleRequestDeleteWorkspace}
              canDeleteWorkspace={canDeleteWorkspace(group.workspace)}
              onSelectSession={handleSelectAgentSession}
              onRequestDelete={handleRequestDelete}
              onRequestMove={handleRequestMove}
              onRename={handleAgentRename}
              onTogglePin={handleTogglePinAgent}
              onToggleStar={handleToggleStarAgent}
              onToggleArchive={handleToggleArchiveAgent}
              onToggleDelegationParent={handleToggleDelegationParent}
              hideSessions
            />
          </div>
        ),
      })

      if (!collapsed) {
        if (visible.treeItems.length === 0) {
          rows.push({
            id: `agent-project-empty-${group.workspace.id}`,
            estimateSize: 28,
            content: <div className="ml-[38px] py-0.5 text-[12px] text-muted-foreground/75 select-none">暂无会话</div>,
          })
        } else {
          for (const item of visible.sessions) pushSessionTreeRows(item, true, group.workspace.id)
          if (visible.hiddenCount > 0 || extraCount > 0) {
            rows.push({
              id: `agent-project-controls-${group.workspace.id}`,
              estimateSize: 34,
              content: (
                <div className="ml-7 flex items-center gap-0.5 pt-0.5">
                  {visible.hiddenCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`显示更多会话，还有 ${visible.hiddenCount} 个`}
                          onClick={() => handleShowMoreSessions(group.workspace.id)}
                          className="flex size-7 items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.04] hover:text-foreground/65 transition-colors titlebar-no-drag"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{`显示更多会话（还有 ${visible.hiddenCount} 个）`}</TooltipContent>
                    </Tooltip>
                  )}
                  {extraCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="收起额外会话"
                          onClick={() => handleCollapseExtraSessions(group.workspace.id)}
                          className="flex size-7 items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.04] hover:text-foreground/65 transition-colors titlebar-no-drag"
                        >
                          <ChevronUp size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">收起额外会话</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ),
            })
          }
        }
      }
    }

    return rows
  }, [
    activeDelegationSessionId,
    activeSessionId,
    agentIndicatorMap,
    agentProjectGroups,
    canDeleteWorkspace,
    collapsedDelegationParentIds,
    collapsedWorkspaceIds,
    creatingProject,
    createAgentSessionInWorkspace,
    dragProjectId,
    expandedDelegationParentIds,
    expandedExtraCountMap,
    handleAgentRename,
    handleCollapseExtraSessions,
    handleConfigureProject,
    handleCreateProjectFromFolder,
    handleCreateProjectKeyDown,
    handleProjectDragEnd,
    handleProjectDragLeave,
    handleProjectDragOver,
    handleProjectDragStart,
    handleProjectDrop,
    handleRelinkProjectRoot,
    handleRequestDelete,
    handleRequestDeleteWorkspace,
    handleRequestMove,
    handleSelectAgentSession,
    handleSelectProject,
    handleShowMoreSessions,
    handleStartCreateProject,
    handleToggleArchiveAgent,
    handleToggleDelegationParent,
    handleTogglePinAgent,
    handleToggleStarAgent,
    handleWorkspaceRename,
    newProjectName,
    pinnedAgentSessionTrees,
    projectDropIndicator,
    relativeTimeNow,
    sessionHoverPreviewEnabled,
    setPendingRestoreProjectRootId,
    currentWorkspaceId,
    viewMode,
  ])

  // ===== 收藏面板（商业版 wMt 内 _0 / Pa） =====
  const archivedFavoriteCount = React.useMemo(
    () => listFavoriteSessions({ sessions: agentSessions, workspaces, archiveFilter: 'archived' }).length,
    [agentSessions, workspaces],
  )

  const favoriteRows = React.useMemo<VirtualSidebarRow[]>(() => {
    if (activeView !== 'favorites') return []
    const entries = listFavoriteSessions({
      sessions: agentSessions,
      workspaces,
      query: favoriteQuery,
      sort: favoriteSort,
      archiveFilter: favoriteArchiveFilter,
    })
    const rows: VirtualSidebarRow[] = []
    const headingClassName = 'px-2 pt-2 pb-1 text-[length:calc(13px+var(--reading-font-size-offset,0px))] font-semibold leading-5 text-foreground/45 select-none'
    const pushEntries = (section: string, list: typeof entries): void => {
      let lastProjectId: string | null = null
      for (const entry of list) {
        const projectName = entry.workspace?.name ?? '未归属项目'
        const projectId = entry.workspace?.id ?? 'unassigned'
        if (favoriteSort === 'project' && projectId !== lastProjectId) {
          lastProjectId = projectId
          rows.push({
            id: `favorites-${section}-project-${projectId}`,
            estimateSize: 32,
            content: (
              <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[length:calc(13px+var(--reading-font-size-offset,0px))] font-semibold leading-5 text-foreground/45 select-none">
                <span className="truncate">{projectName}</span>
              </div>
            ),
          })
        }
        const status = agentIndicatorMap.get(entry.session.id) ?? 'idle'
        rows.push({
          id: `favorite-${entry.session.id}`,
          estimateSize: FAVORITE_ROW_ESTIMATE_SIZE,
          content: (
            <div>
              <AgentSessionItem
                layout="favorite"
                session={entry.session}
                active={entry.session.id === activeSessionId || entry.session.id === activeDelegationSessionId}
                indicatorStatus={status}
                disableMiniMap={!sessionHoverPreviewEnabled}
                leftAccent={getSessionLeftAccent(status)}
                workspaceName={favoriteSort === 'project' ? undefined : `${projectName}${entry.archived ? ' · 已归档' : ''}`}
                relativeTimeNow={relativeTimeNow}
                onSelect={handleSelectAgentSession}
                onRequestDelete={handleRequestDelete}
                onRequestMove={handleRequestMove}
                onRename={handleAgentRename}
                onTogglePin={handleTogglePinAgent}
                onToggleStar={handleToggleStarAgent}
                onToggleArchive={handleToggleArchiveAgent}
              />
            </div>
          ),
        })
      }
    }

    if (entries.length === 0) {
      rows.push({
        id: `favorites-${favoriteArchiveFilter}-empty`,
        estimateSize: 68,
        content: (
          <div className="px-4 py-6 text-center text-[12px] leading-5 text-muted-foreground">
            {favoriteQuery ? '没有匹配的收藏' : favoriteArchiveFilter === 'archived' ? '还没有已归档的收藏' : '还没有收藏会话'}
          </div>
        ),
      })
    } else if (favoriteArchiveFilter === 'active') {
      const pinnedEntries = entries.filter((entry) => entry.session.pinned)
      const regularEntries = entries.filter((entry) => !entry.session.pinned)
      if (pinnedEntries.length > 0) {
        rows.push({ id: 'favorites-pinned-heading', estimateSize: 32, content: <div className={headingClassName}>置顶</div> })
        pushEntries('pinned', pinnedEntries)
      }
      if (pinnedEntries.length > 0 && regularEntries.length > 0) {
        rows.push({ id: 'favorites-regular-heading', estimateSize: 32, content: <div className={headingClassName}>收藏会话</div> })
      }
      pushEntries('regular', regularEntries)
    } else {
      pushEntries('archived', entries)
    }
    return rows
  }, [activeDelegationSessionId, activeSessionId, activeView, agentIndicatorMap, agentSessions, favoriteArchiveFilter, favoriteQuery, favoriteSort, handleAgentRename, handleRequestDelete, handleRequestMove, handleSelectAgentSession, handleToggleArchiveAgent, handleTogglePinAgent, handleToggleStarAgent, relativeTimeNow, sessionHoverPreviewEnabled, workspaces])

  /** 从 rail 进入收藏且没有当前会话时，自动打开第一条收藏（商业版 wMt 内 useEffect + ZPt）。 */
  React.useEffect(() => {
    if (activeView !== 'favorites' || !autoOpenFavoriteRef.current) return
    if (currentAgentSessionId) {
      autoOpenFavoriteRef.current = false
      return
    }
    const initial = pickInitialFavoriteSession({
      sessions: agentSessions,
      workspaces,
      sort: favoriteSort,
      archiveFilter: favoriteArchiveFilter,
    })
    if (!initial) return
    autoOpenFavoriteRef.current = false
    if (initial.archived) setFavoriteArchiveFilter('archived')
    handleSelectAgentSession(initial.session.id, initial.session.title)
  }, [activeView, agentSessions, currentAgentSessionId, favoriteArchiveFilter, favoriteSort, handleSelectAgentSession, workspaces])

  /** 「查看项目」：回到会话面板并打开当前会话或最近的普通会话（商业版 mo）。 */
  const handleViewProjects = React.useCallback((): void => {
    setViewMode('active')
    setActiveView('conversations')
    const target = agentSessions.find((session) => session.id === currentAgentSessionId && !session.archived && !session.isDraft)
      ?? agentSessions.find((session) => !session.archived && !session.isDraft && !draftSessionIds.has(session.id))
    if (target) openSession('agent', target.id, target.title)
  }, [agentSessions, currentAgentSessionId, draftSessionIds, openSession, setActiveView, setViewMode])

  /** 定时任务 rail badge：运行产生且尚未查看的完成会话数（商业版 Rt）。 */
  const unviewedAutomationRunCount = React.useMemo(() => {
    const runSessionIds = new Set(
      automations
        .flatMap((automation) => automation.runHistory)
        .filter((run) => run.status !== 'skipped')
        .map((run) => run.sessionId),
    )
    return [...unviewedCompletedSessionIds].filter((id) => runSessionIds.has(id)).length
  }, [automations, unviewedCompletedSessionIds])

  const skillUpdateCount = capabilities?.skills.filter((skill) => skill.hasUpdate).length ?? 0
  const vaultActive = productivityTools.obsidianEnabled && activeView === 'vault'

  const settingsRailButton = (
    <SidebarRailButton
      aria-label="打开设置"
      onClick={handleOpenSettings}
      icon={<UserAvatar avatar={userProfile.avatar} size={28} />}
      badge={hasEnvironmentIssues ? <span className="absolute right-1 top-1 size-2 rounded-full bg-red-500" /> : undefined}
    />
  )

  // ===== 折叠状态：只保留 rail（商业版 wMt：fr && !n7） =====
  if (sidebarCollapsed && !utilityRailOnly) {
    const anyToolActive = vaultActive
      || (activeView === 'planning' && (
        (productivityTools.todosEnabled && planningTab === 'todos')
        || (productivityTools.calendarEnabled && planningTab === 'calendar')
        || planningTab === 'automations'
      ))
      || isMcpSkillsActive
      || activeView === 'memory'
      || activeView === 'favorites'
      || activeView === 'automations'

    const collapsedToolItems: CollapsedToolItem[] = [
      ...(productivityTools.todosEnabled ? [{
        label: 'Todo',
        icon: <ListTodo size={18} />,
        active: isPlanningRailActive('todos'),
        onClick: () => handleOpenPlanningView('todos'),
      }] : []),
      ...(productivityTools.calendarEnabled ? [{
        label: '日程',
        icon: <CalendarDays size={18} />,
        active: isPlanningRailActive('calendar'),
        onClick: () => handleOpenPlanningView('calendar'),
      }] : []),
      ...(productivityTools.obsidianEnabled ? [{
        label: 'Obsidian',
        icon: <ObsidianIcon size={16} />,
        active: vaultActive,
        onClick: handleOpenVault,
      }] : []),
      {
        label: '收藏',
        icon: <Bookmark size={18} />,
        active: activeView === 'favorites',
        onClick: handleOpenFavorites,
      },
      {
        label: '记忆',
        icon: <LibraryBig size={18} />,
        active: activeView === 'memory',
        onClick: handleOpenMemory,
      },
      {
        label: '定时任务',
        icon: <Clock size={18} />,
        active: isPlanningRailActive('automations'),
        badge: unviewedAutomationRunCount > 0 ? formatAutomationCount(unviewedAutomationRunCount) : undefined,
        onClick: () => handleOpenPlanningView('automations'),
      },
      {
        label: 'MCP/Skills',
        icon: <Plug size={18} className="-rotate-45" />,
        active: isMcpSkillsActive,
        showUpdate: skillUpdateCount > 0,
        onClick: handleOpenMcpSkills,
      },
    ]

    return (
      <div
        ref={sidebarRootRef}
        data-session-switch-hints={quickSwitchHintsVisible ? 'true' : undefined}
        className={cn('sidebar-rail relative px-2', !noTransition && 'transition-[width] duration-300', 'proma-chrome-surface')}
        style={{ width: SIDEBAR_RAIL_WIDTH }}
      >
        <SidebarWindowDragStrip height={SIDEBAR_RAIL_DRAG_STRIP_HEIGHT} />
        <div className="sidebar-rail-top-inset w-full titlebar-drag-region" />

        <div className="sidebar-rail-group shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarRailButton aria-label="展开侧边栏" onClick={() => setSidebarCollapsed(false)} icon={<PanelRight size={18} />} />
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="flex items-center gap-2">
                <span>展开侧边栏</span>
                <ShortcutKeycaps shortcutId="toggle-sidebar" keycapClassName="h-5 min-w-5 px-1 text-[11px]" separatorClassName="text-[10px]" />
              </span>
            </TooltipContent>
          </Tooltip>
          <div className="my-0.5 h-px w-6 shrink-0 bg-border/70" />
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarRailButton aria-label="新建任务" onClick={() => { void createAgentSessionInWorkspace() }} icon={<Plus size={18} />} />
            </TooltipTrigger>
            <TooltipContent side="right">
              <span className="flex items-center gap-2">
                新建任务
                <ShortcutKeycaps shortcutId="new-session" keycapClassName="h-5 min-w-5 px-1 text-[11px]" />
              </span>
            </TooltipContent>
          </Tooltip>
          <CollapsedWorkspacePopover>
            <SidebarRailButton aria-label="查看项目" onClick={handleViewProjects} icon={<FolderClosed size={18} />} />
          </CollapsedWorkspacePopover>
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarRailButton aria-label="搜索" onClick={() => setSearchDialogOpen(true)} icon={<Search size={18} />} />
            </TooltipTrigger>
            <TooltipContent side="right">搜索</TooltipContent>
          </Tooltip>
          <CollapsedToolsPopover items={collapsedToolItems}>
            <SidebarRailButton
              aria-label="工作区工具"
              active={anyToolActive}
              icon={<Plug size={18} className="-rotate-45" />}
              badge={anyToolActive ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" /> : undefined}
            />
          </CollapsedToolsPopover>
          <div className="my-0.5 h-px w-6 shrink-0 bg-border/70" />
        </div>

        {/* Rail 的面板开合与顺序冻结都在组件内部，hover 不会重渲染整个侧栏。 */}
        <CollapsedSessionRail
          items={railRecentItems}
          activeSessionId={activeSessionId}
          activeDelegationSessionId={activeDelegationSessionId}
          agentIndicatorMap={agentIndicatorMap}
          miniMapDisabled={!sessionHoverPreviewEnabled}
          onSelectChild={handleSelectRailChild}
          onSelect={(selected) => {
            handleSelectAgentSession(selected.id, selected.title)
          }}
        />

        <div className="sidebar-rail-group shrink-0 py-2">
          {hasUpdate && <SidebarRailUpdateButton status={updateStatus} onClick={handleUpdateButtonClick} />}
          <Tooltip>
            <TooltipTrigger asChild>{settingsRailButton}</TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
        </div>

        {deleteDialog}
        {projectDeleteDialog}
        {restoreProjectRootDialog}
        {moveDialog}
        <SearchDialog />
      </div>
    )
  }

  // ===== 展开态 rail（商业版 $m）：收藏 / 定时任务 / 整页视图时顶部按钮变为「返回首页」 =====
  const showReturnHome = utilityRailOnly || activeView === 'favorites' || activeView === 'automations'
  const expandedRail = (
    <div className="sidebar-rail proma-chrome-surface" style={{ width: SIDEBAR_RAIL_WIDTH }}>
      <SidebarWindowDragStrip height={SIDEBAR_RAIL_DRAG_STRIP_HEIGHT} />
      <div className="sidebar-rail-top-inset w-full titlebar-drag-region" />
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarRailButton
            aria-label={showReturnHome ? '返回 Proma Agent 首页' : '收起侧边栏'}
            onClick={() => {
              if (showReturnHome) {
                setActiveView('conversations')
                return
              }
              setSidebarCollapsed(true)
            }}
            icon={showReturnHome ? <House size={18} /> : <PanelLeft size={18} />}
          />
        </TooltipTrigger>
        <TooltipContent side="right">{showReturnHome ? '返回 Proma Agent 首页' : '收起侧边栏'}</TooltipContent>
      </Tooltip>
      <div className="my-1.5 h-px w-6 shrink-0 bg-border/70" />
      <div className="sidebar-rail-group shrink-0">
        {productivityTools.todosEnabled && (
          <SidebarRailEntry label="Todo" icon={<ListTodo size={18} />} active={isPlanningRailActive('todos')} onClick={() => handleOpenPlanningView('todos')} />
        )}
        {productivityTools.calendarEnabled && (
          <SidebarRailEntry label="日程" icon={<CalendarDays size={18} />} active={isPlanningRailActive('calendar')} onClick={() => handleOpenPlanningView('calendar')} />
        )}
        {productivityTools.obsidianEnabled && (
          <SidebarRailEntry label="Obsidian" icon={<ObsidianIcon size={16} className="sidebar-rail-obsidian-icon" />} active={vaultActive} onClick={handleOpenVault} />
        )}
        <SidebarRailEntry
          label="收藏"
          icon={<Bookmark size={18} fill={favoriteDropActive ? 'currentColor' : 'none'} />}
          active={activeView === 'favorites'}
          onClick={handleOpenFavorites}
          tooltipLabel="收藏会话"
          dropActive={favoriteDropActive}
          onDragEnter={handleFavoriteDragOver}
          onDragOver={handleFavoriteDragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFavoriteDropActive(false)
          }}
          onDrop={(event) => { void handleFavoriteDrop(event) }}
        />
        <SidebarRailEntry label="记忆" icon={<LibraryBig size={18} />} active={activeView === 'memory'} onClick={handleOpenMemory} />
        <SidebarRailEntry
          label="定时任务"
          icon={<Clock size={18} />}
          active={isPlanningRailActive('automations')}
          onClick={() => handleOpenPlanningView('automations')}
          badge={unviewedAutomationRunCount > 0 ? (
            <span className="absolute right-1 top-1 min-w-3 rounded-full bg-primary px-0.5 text-center text-[8px] font-semibold leading-3 text-primary-foreground tabular-nums">
              {formatAutomationCount(unviewedAutomationRunCount)}
            </span>
          ) : undefined}
        />
        <SidebarRailEntry
          label="MCP/Skills"
          icon={<Plug size={18} className="-rotate-45" />}
          active={isMcpSkillsActive}
          onClick={handleOpenMcpSkills}
          badge={skillUpdateCount > 0 ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-blue-500" /> : undefined}
        />
      </div>
      <div className="flex-1" />
      <div className="sidebar-rail-group shrink-0 py-2">
        {hasUpdate && <SidebarRailUpdateButton status={updateStatus} onClick={handleUpdateButtonClick} />}
        {settingsRailButton}
      </div>
    </div>
  )

  // ===== 收藏面板（商业版 wMt：!n7 && r === 'favorites'） =====
  if (!utilityRailOnly && activeView === 'favorites') {
    const sortLabel = favoriteSort === 'collected' ? '收藏时间' : favoriteSort === 'updated' ? '最新活跃' : '项目'
    const panelTitle = favoriteArchiveFilter === 'archived' ? '已归档收藏' : '收藏会话'
    const panelIntro = favoriteArchiveFilter === 'archived'
      ? '已归档的收藏会话会保留在这里，随时可以恢复处理'
      : '点击星标即可收藏会话，方便回顾和后续处理重要事务'
    return (
      <div
        ref={sidebarRootRef}
        data-session-switch-hints={quickSwitchHintsVisible ? 'true' : undefined}
        className={cn('relative flex h-full', !noTransition && 'transition-[width] duration-300', 'proma-chrome-surface')}
        style={{ width: width ?? 300, minWidth: 200, flexShrink: 0 }}
      >
        {expandedRail}
        <div className="favorite-sidebar-panel relative isolate flex min-w-0 flex-1 flex-col">
          <div className={cn('titlebar-drag-region flex h-10 shrink-0 items-center proma-chrome-surface', isMac ? 'px-5 sm:px-6 xl:px-8' : 'px-3')}>
            <span className="pointer-events-none text-[13px] font-semibold tracking-tight text-[hsl(var(--sidebar-primary-foreground))]">{panelTitle}</span>
          </div>
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 top-10 -z-10 rounded-tl-2xl proma-sidebar-list-surface" />
          <div className="px-4 pb-2 pt-3">
            <p className="text-[13px] leading-5 text-foreground/60">{panelIntro}</p>
          </div>
          <div className="px-2 pb-2">
            <div className="flex h-9 items-center gap-2 rounded-lg bg-foreground/[0.045] px-2 focus-within:ring-1 focus-within:ring-primary/30 titlebar-no-drag">
              <span aria-hidden="true" className="favorite-list-icon text-foreground/40"><Search size={14} /></span>
              <input
                value={favoriteQuery}
                onChange={(event) => setFavoriteQuery(event.target.value)}
                placeholder={favoriteArchiveFilter === 'archived' ? '搜索已归档收藏' : '搜索收藏'}
                aria-label={favoriteArchiveFilter === 'archived' ? '搜索已归档收藏' : '搜索收藏'}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/35"
              />
            </div>
          </div>
          <div className="px-2 pb-2 titlebar-no-drag">
            <Popover open={favoriteSortOpen} onOpenChange={setFavoriteSortOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`排序方式：${sortLabel}`}
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-[13px] text-foreground/70 transition-[background-color,color] hover:bg-foreground/[0.055] hover:text-foreground"
                >
                  排序：{sortLabel}
                  <ChevronDown size={13} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" sideOffset={6} className="w-36 p-1">
                {FAVORITE_SORT_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={favoriteSort === value}
                    onClick={() => {
                      setFavoriteSort(value)
                      setFavoriteSortOpen(false)
                    }}
                    className={cn(
                      'flex h-10 w-full items-center rounded-md px-2 text-left text-[13px] transition-colors',
                      favoriteSort === value
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
          <SidebarScrollBoundary key={`favorites-${favoriteArchiveFilter}-${favoriteSort}`}>
            <VirtualSidebarList
              key={`favorites-list-${favoriteArchiveFilter}-${favoriteSort}-${favoriteScrollResetKey}`}
              className="favorite-sidebar-list flex-1 px-2 pb-3"
              rows={favoriteRows}
              // 商业版收藏列表关闭 autoScrollToActive：不随当前会话自动滚动。
              activeRowId={null}
            />
          </SidebarScrollBoundary>
          <div className="shrink-0 px-2 py-2">
            {favoriteArchiveFilter === 'active' ? (
              <button
                type="button"
                onClick={() => {
                  setFavoriteQuery('')
                  setFavoriteArchiveFilter('archived')
                }}
                aria-label={archivedFavoriteCount > 0 ? `查看已归档收藏（${archivedFavoriteCount}）` : '查看已归档收藏'}
                className="favorite-sidebar-footer group flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] font-medium leading-5 text-foreground/60 transition-[background-color,color] hover:bg-foreground/[0.04] hover:text-foreground/65 titlebar-no-drag"
              >
                <span aria-hidden="true" className="favorite-list-icon text-foreground/45"><Archive size={14} /></span>
                <span className="min-w-0 flex-1 truncate">已归档</span>
                {archivedFavoriteCount > 0 && (
                  <span className="shrink-0 text-[11px] font-medium text-foreground/35 group-hover:text-foreground/50 tabular-nums">{archivedFavoriteCount}</span>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setFavoriteQuery('')
                  setFavoriteArchiveFilter('active')
                }}
                className="favorite-sidebar-footer flex h-10 w-full items-center gap-2 rounded-lg px-2 text-[14px] text-foreground/65 transition-colors hover:bg-foreground/[0.07] hover:text-foreground/80 titlebar-no-drag"
              >
                <span aria-hidden="true" className="favorite-list-icon text-foreground/50"><ArchiveRestore size={14} /></span>
                <span className="min-w-0 flex-1 truncate">返回收藏会话</span>
              </button>
            )}
          </div>
          {deleteDialog}
          {projectDeleteDialog}
          {restoreProjectRootDialog}
          {moveDialog}
          <SearchDialog />
        </div>
      </div>
    )
  }

  // ===== 定时任务面板（商业版 wMt：!n7 && r === 'automations'，面板本体由 AutomationSidebarPanel 提供） =====
  if (!utilityRailOnly && activeView === 'automations') {
    return (
      <div
        ref={sidebarRootRef}
        data-session-switch-hints={quickSwitchHintsVisible ? 'true' : undefined}
        className={cn('relative flex h-full', !noTransition && 'transition-[width] duration-300', 'proma-chrome-surface')}
        style={{ width: width ?? 300, minWidth: 200, flexShrink: 0 }}
      >
        {expandedRail}
        <AutomationSidebarPanel />
        <SearchDialog />
      </div>
    )
  }

  // ===== 默认：rail + Agent 会话面板；整页视图（utilityRailOnly）只保留 rail =====
  return (
    <div
      ref={sidebarRootRef}
      data-session-switch-hints={quickSwitchHintsVisible ? 'true' : undefined}
      className={cn('relative flex h-full', !noTransition && 'transition-[width] duration-300', 'proma-chrome-surface')}
      style={{
        width: utilityRailOnly ? SIDEBAR_RAIL_WIDTH : width ?? 300,
        minWidth: utilityRailOnly ? SIDEBAR_RAIL_WIDTH : 200,
        flexShrink: 0,
      }}
    >
      {expandedRail}
      {/* 整页视图下面板不渲染；保留全局搜索弹窗，使搜索快捷键在这些页面仍可用。 */}
      {utilityRailOnly && <SearchDialog />}
      {!utilityRailOnly && (
        <div className="relative isolate flex min-w-0 flex-1 flex-col">
          {isWindows ? (
            <div className="titlebar-drag-region flex h-10 shrink-0 items-center px-3 proma-chrome-surface">
              <div className="pointer-events-none flex min-w-0 items-center gap-2">
                <span className="text-[13px] font-semibold tracking-tight text-[hsl(var(--sidebar-primary-foreground))]">Agent 会话</span>
              </div>
            </div>
          ) : (
            <div className="titlebar-drag-region h-10 shrink-0 proma-chrome-surface" />
          )}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 top-10 -z-10 rounded-tl-2xl proma-sidebar-list-surface" />

          {/* 新建任务与搜索 */}
          <div className="px-3 pb-3 pt-4">
            <div className="flex items-center gap-2">
              <SidebarNewTaskButton onClick={() => { void createAgentSessionInWorkspace() }} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSearchDialogOpen(true)}
                    aria-label="搜索"
                    className={cn(SIDEBAR_ACTION_SURFACE_CLASS, 'titlebar-no-drag inline-flex size-10 shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40')}
                  >
                    <Search size={18} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <span className="flex items-center gap-2">
                    搜索
                    <ShortcutKeycaps shortcutId="global-search" keycapClassName="h-5 min-w-5 px-1 text-[11px]" />
                  </span>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* 原生与虚拟列表共享顶部反馈，切换视图时不沿用上一列表的滚动状态。 */}
          {viewMode === 'active' ? (
            <SidebarScrollBoundary key="agent-active-boundary">
              <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin titlebar-no-drag px-2 pb-3">
                {agentActiveRows.map((row) => (
                  <React.Fragment key={row.id}>{row.content}</React.Fragment>
                ))}
              </div>
            </SidebarScrollBoundary>
          ) : (
            <>
              <div className="px-2 pt-2 pb-1">
                <div className="text-[13px] font-semibold leading-5 text-foreground/45 select-none">已归档会话</div>
              </div>
              <SidebarScrollBoundary key="agent-archived-boundary">
                <VirtualSidebarList
                  key="agent-archived-list"
                  className="flex-1 px-3 pt-2 pb-3"
                  rows={agentArchivedVirtualRows}
                  activeRowId={activeSessionId ? `agent-archived-${activeSessionId}` : null}
                />
              </SidebarScrollBoundary>
            </>
          )}

          {/* 已归档入口 / 返回活跃会话 */}
          <div className="px-2 pb-1">
            {viewMode === 'active' ? (
              archivedAgentSessionCount > 0 && (
                <button
                  onClick={() => setViewMode('archived')}
                  aria-label={`查看已归档会话（${archivedAgentSessionCount}）`}
                  className="group flex h-9 w-full items-center gap-2 px-2 text-left text-[13px] font-semibold leading-5 text-foreground/45 transition-[background-color,color] hover:bg-foreground/[0.04] hover:text-foreground/65 titlebar-no-drag"
                >
                  <Archive size={16} className="shrink-0 text-foreground/45" aria-hidden="true" />
                  <span>已归档</span>
                  <span className="text-[11px] font-medium text-foreground/35 group-hover:text-foreground/50 tabular-nums">{archivedAgentSessionCount}</span>
                </button>
              )
            ) : (
              <button
                onClick={() => setViewMode('active')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] text-foreground/60 bg-foreground/[0.04] hover:bg-foreground/[0.07] hover:text-foreground/80 transition-colors titlebar-no-drag"
              >
                <ArrowLeft size={13} className="text-foreground/50" />
                <span>返回活跃会话</span>
              </button>
            )}
          </div>

          {deleteDialog}
          {projectDeleteDialog}
          {restoreProjectRootDialog}
          {moveDialog}
          <SearchDialog />
        </div>
      )}
    </div>
  )
}

// ===== 列表项操作按钮（相对时间 / 更多菜单，商业版 kMt） =====

interface SessionItemActionsProps {
  /** 会话的最后活跃时间（lastActivityAt，旧数据回退 updatedAt）。 */
  activityAt: number
  relativeTimeNow: number
  menuItems: (
    MenuItem: typeof DropdownMenuItem,
    MenuSeparator: typeof DropdownMenuSeparator,
  ) => React.ReactNode
  onMenuOpenChange?: (open: boolean) => void
}

/**
 * 安全 Tooltip：延迟渲染 Content，避开 Popper 初始定位 (0,0) 的闪现。
 *
 * 左侧列表项的操作按钮默认 hidden，hover 时才显示。Radix Popper 在 Content 首次挂载
 * 时若 trigger 尚未完成布局，会先把浮层放到视口左上角 (0,0)，再跳到正确位置。这里
 * 在 Radix 进入打开状态后，先让 Popper 有一小段时间完成定位，再真正渲染 Content；
 * 同时 trigger rect 为 0 时直接不打开。
 */
interface SafeTooltipProps {
  children: React.ReactElement
  content: React.ReactNode
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>['side']
}

function SafeTooltip({ children, content, side = 'top' }: SafeTooltipProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [showContent, setShowContent] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const getUsableTriggerRect = React.useCallback((): DOMRect | null => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    if (rect.right <= 0 || rect.bottom <= 0) return null
    if (rect.left >= window.innerWidth || rect.top >= window.innerHeight) return null
    return rect
  }, [])

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const handleOpenChange = React.useCallback((nextOpen: boolean): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (!nextOpen) {
      setOpen(false)
      setShowContent(false)
      return
    }

    // trigger 还没完成布局或已经离开视口时不打开。
    if (!getUsableTriggerRect()) return

    setOpen(true)
    // 先让 Radix 完成 Popper 定位，再渲染 Content，避免看到 (0,0) 初始位置。
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!getUsableTriggerRect()) {
        setOpen(false)
        setShowContent(false)
        return
      }
      setShowContent(true)
    }, 60)
  }, [getUsableTriggerRect])

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild ref={triggerRef}>
        {children}
      </TooltipTrigger>
      {showContent && <TooltipContent side={side} hideWhenDetached>{content}</TooltipContent>}
    </Tooltip>
  )
}

/**
 * 列表项右侧默认显示相对活跃时间，hover / 聚焦时替换为「更多会话操作」菜单（商业版 kMt）。
 */
function SessionItemActions({
  activityAt,
  relativeTimeNow,
  menuItems,
  onMenuOpenChange,
}: SessionItemActionsProps): React.ReactElement {
  // 菜单打开时强制保持按钮可见：按钮始终保留布局，只切换透明度和 pointer-events。
  // 这样 Radix Popper 不会在 hover 切换瞬间读到 display:none 的 0 尺寸 trigger。
  const [menuOpen, setMenuOpen] = React.useState(false)
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMenuOpenChange = (open: boolean): void => {
    if (open) {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setMenuOpen(true)
    } else {
      // Delay hiding the trigger so Radix Popper can still read its rect during the close animation (~150ms).
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        setMenuOpen(false)
      }, 200)
    }
    onMenuOpenChange?.(open)
  }

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    }
  }, [])

  return (
    <div
      className="session-item-actions relative flex-shrink-0 h-[22px] min-w-[22px]"
      onClick={(e) => e.stopPropagation()}
    >
      <span
        title={`最后活跃：${new Date(activityAt).toLocaleString('zh-CN')}`}
        className={cn(
          'block whitespace-nowrap text-right text-[12px] leading-[22px] tabular-nums text-foreground/35 transition-opacity duration-100',
          menuOpen ? 'opacity-0' : 'opacity-100 group-hover:opacity-0 group-focus-within:opacity-0',
        )}
      >
        {formatRelativeActivityAt(activityAt, relativeTimeNow)}
      </span>
      <div
        className={cn(
          'absolute right-0 top-0 flex items-center transition-opacity duration-100',
          menuOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
        )}
      >
        <DropdownMenu onOpenChange={handleMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="更多会话操作"
              title="更多会话操作"
              className={cn(
                'flex size-[22px] items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.08] hover:text-foreground/70',
                'data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground/70',
              )}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40 z-[9999] min-w-0 p-0.5">
            {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ===== Agent 会话列表项 =====

/** 会话行左侧状态条的颜色 — 与 SessionIndicatorStatus 呼应 */
type SessionLeftAccent = 'orange' | 'blue' | 'green'
const SESSION_ACCENT_ROW_CLASS: Record<SessionLeftAccent, string> = {
  orange: 'bg-orange-500/[0.08] text-foreground font-medium',
  blue: 'text-foreground font-medium hover:bg-foreground/[0.03]',
  green: 'text-foreground font-medium hover:bg-foreground/[0.03]',
}

const SESSION_ACCENT_INDICATOR_CLASS: Record<SessionLeftAccent, string> = {
  orange: 'bg-orange-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
}

/**
 * 标题前的运行状态点：只有非 idle 状态才渲染。
 * 与左侧 accent 并存，accent 表达整行的状态底色，状态点负责在标题行首给出即时可读的指示。
 */
const SESSION_STATUS_DOT_CLASS: Record<SessionIndicatorStatus, string> = {
  idle: 'hidden',
  running: 'bg-blue-500 animate-pulse',
  blocked: 'bg-orange-500',
  completed: 'bg-green-500',
}

/** 状态点的可访问名称；idle 不渲染，占位为空串。 */
const SESSION_STATUS_DOT_LABEL: Record<SessionIndicatorStatus, string> = {
  idle: '',
  running: '会话运行中',
  blocked: '需要确认',
  completed: '已完成',
}

function getSessionLeftAccent(status: SessionIndicatorStatus): SessionLeftAccent | undefined {
  if (status === 'blocked') return 'orange'
  if (status === 'running') return 'blue'
  if (status === 'completed') return 'green'
  return undefined
}

interface AgentSessionItemProps {
  session: AgentSessionMeta
  /** favorite：收藏面板的两行布局（标题 + 项目名，右侧星标） */
  layout?: 'default' | 'favorite'
  active: boolean
  indicatorStatus: SessionIndicatorStatus
  showPinIcon?: boolean
  delegationSummary?: {
    total: number
    settled: number
    expanded: boolean
    onToggle: () => void
  }
  /** 行左侧状态色块；未传则不显示 */
  leftAccent?: SessionLeftAccent
  /** 是否禁用悬浮 Mini 地图 */
  disableMiniMap?: boolean
  /** 定时任务合成项目内已由项目标题表达来源，隐藏行内重复时钟。 */
  suppressAutomationIcon?: boolean
  /** 项目名称 Badge（跨项目列表时显示） */
  workspaceName?: string
  /** 用同一个时间戳刷新相对时间，避免每行独立计时 */
  relativeTimeNow: number
  onSelect: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string, cascade: boolean) => Promise<void>
  onToggleStar: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

const AgentSessionItem = React.memo(function AgentSessionItem({
  session,
  layout = 'default',
  active,
  indicatorStatus,
  showPinIcon,
  delegationSummary,
  leftAccent,
  disableMiniMap,
  suppressAutomationIcon,
  workspaceName,
  relativeTimeNow,
  onSelect,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleStar,
  onToggleArchive,
}: AgentSessionItemProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [rowHovered, setRowHovered] = React.useState(false)
  const store = useStore()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const justStartedEditing = React.useRef(false)
  // 菜单打开时关闭迷你地图预览，避免预览面板盖住菜单项导致点不动
  const preview = useSessionMiniMapHover(600, disableMiniMap || menuOpen)

  const startEdit = (): void => {
    setEditTitle(session.title)
    setEditing(true)
    justStartedEditing.current = true
    setTimeout(() => {
      justStartedEditing.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 300)
  }

  const saveTitle = async (): Promise<void> => {
    if (justStartedEditing.current) return
    const trimmed = editTitle.trim()
    if (!trimmed || trimmed === session.title) {
      setEditing(false)
      return
    }
    await onRename(session.id, trimmed)
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveTitle()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  const handleReferenceSession = (): void => {
    const targetSessionId = store.get(currentAgentSessionIdAtom)
    if (!targetSessionId) {
      toast.info('请先打开一个 Agent 会话', {
        description: '会话引用会插入当前 Agent 输入框。',
      })
      return
    }
    if (targetSessionId === session.id) {
      toast.warning('不能引用当前会话')
      return
    }
    const inserted = insertSessionReferenceMention(targetSessionId, {
      sessionId: session.id,
      title: session.title,
    })
    if (!inserted) {
      toast.warning('当前输入框不可编辑')
      return
    }
    toast.success('已插入会话引用')
  }

  const canMove = indicatorStatus === 'idle' || indicatorStatus === 'completed'

  const childCount = delegationSummary?.total ?? 0
  const hasChildren = childCount > 0
  const pinLabel = session.pinned ? '取消置顶' : '置顶会话'
  const cascadePinLabel = session.pinned
    ? `取消置顶(含 ${childCount} 个子会话)`
    : `置顶会话(含 ${childCount} 个子会话)`

  const menuItems = (
    MenuItem: typeof ContextMenuItem | typeof DropdownMenuItem,
    MenuSeparator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <MenuItem
        className="text-xs py-1 [&>svg]:size-3.5"
        onSelect={handleReferenceSession}
      >
        <MessageSquare size={14} />
        <span className="min-w-0 flex-1">引用此会话</span>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label="引用此会话说明"
              className="inline-flex size-5 items-center justify-center rounded text-foreground/40 hover:bg-foreground/[0.08] hover:text-foreground/70"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
            >
              <Info size={13} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-64">
            将此会话插入当前 Agent 输入框作为引用；也可以直接把会话拖到输入框中。
          </TooltipContent>
        </Tooltip>
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      {hasChildren ? (
        <>
          <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(session.id, false)}>
            {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            仅{pinLabel}
          </MenuItem>
          <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(session.id, true)}>
            {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {cascadePinLabel}
          </MenuItem>
        </>
      ) : (
        <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onTogglePin(session.id, true)}>
          {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinLabel}
        </MenuItem>
      )}
      {canMove && (
        <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onRequestMove(session.id)}>
          <ArrowRightLeft size={14} />
          迁移到其他项目
        </MenuItem>
      )}
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => startEdit()}>
        <Pencil size={14} />
        重命名
      </MenuItem>
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5" onSelect={() => onToggleArchive(session.id)}>
        {session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {session.archived ? '取消归档' : '归档'}
      </MenuItem>
      <MenuSeparator className="my-0.5" />
      <MenuItem className="text-xs py-1 [&>svg]:size-3.5 text-destructive" onSelect={() => onRequestDelete(session.id)}>
        <Trash2 size={14} />
        删除会话
      </MenuItem>
    </>
  )

  const titleNode = editing ? (
    <input
      ref={inputRef}
      value={editTitle}
      onChange={(e) => setEditTitle(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={saveTitle}
      onClick={(e) => e.stopPropagation()}
      className="w-full bg-transparent text-[length:calc(15px+var(--reading-font-size-offset,0px))] font-medium leading-5 text-foreground border-b border-primary/50 outline-none px-0 py-0"
      maxLength={100}
    />
  ) : (
    <span
      className="truncate"
      onDoubleClick={(event) => {
        event.stopPropagation()
        startEdit()
      }}
    >
      {session.title}
    </span>
  )

  const leadingIcons = (
    <>
      {showPinIcon && <Pin size={13} className="flex-shrink-0 text-foreground/45" />}
      {!suppressAutomationIcon && session.sourceAutomationId && !session.sourceDelegationId && (
        <span
          title={session.automationGraduated ? '来自定时任务 · 已接管' : '来自定时任务'}
          aria-label={session.automationGraduated ? '来自定时任务 · 已接管' : '来自定时任务'}
        >
          <Clock size={13} className="flex-shrink-0 text-foreground/40" />
        </span>
      )}
      {session.sourceDelegationId && (
        <GitBranch size={13} className={cn('flex-shrink-0', getDelegationStatusIconClass(indicatorStatus))} />
      )}
    </>
  )

  // 标题行首的运行状态点：idle 不渲染，running 用 animate-pulse 表达进行中
  const statusDot = indicatorStatus === 'idle' ? null : (
    <span
      role="img"
      aria-label={SESSION_STATUS_DOT_LABEL[indicatorStatus]}
      title={SESSION_STATUS_DOT_LABEL[indicatorStatus]}
      className={cn('flex-shrink-0 size-1.5 rounded-full', SESSION_STATUS_DOT_CLASS[indicatorStatus])}
    />
  )

  const starButton = (
    <SafeTooltip content={session.starred ? '取消收藏' : '收藏会话（不会被自动归档）'} side="top">
      <button
        type="button"
        aria-label={session.starred ? '取消收藏' : '收藏会话'}
        aria-pressed={!!session.starred}
        onMouseEnter={preview.closeNow}
        onFocus={preview.closeNow}
        onMouseDown={(event) => {
          event.stopPropagation()
          preview.closeNow()
        }}
        onClick={(event) => {
          event.stopPropagation()
          preview.closeNow()
          if (event.detail > 1) return
          void onToggleStar(session.id)
        }}
        onDoubleClick={(event) => {
          event.stopPropagation()
          preview.closeNow()
        }}
        className={cn(
          'flex-shrink-0 inline-flex size-6 -my-1 items-center justify-center rounded transition-colors',
          session.starred
            ? 'text-amber-500 hover:text-amber-500'
            : cn('text-foreground/45 hover:bg-foreground/[0.055] hover:text-foreground/70', rowHovered ? 'opacity-100' : 'opacity-0'),
        )}
      >
        <Star size={15} fill={session.starred ? 'currentColor' : 'none'} />
      </button>
    </SafeTooltip>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={preview.setAnchorRef}
          role="button"
          tabIndex={0}
          data-session-switch-id={session.id}
          data-session-switch-title={session.title}
          data-session-switch-type="agent"
          draggable={!editing}
          onDragStart={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('button, input')) {
              event.preventDefault()
              clearSessionReferenceDragState()
              return
            }
            preview.closeNow()
            setSessionReferenceDragData(event.dataTransfer, {
              sessionId: session.id,
              title: session.title,
            })
          }}
          onDragEnd={clearSessionReferenceDragState}
          onClick={() => onSelect(session.id, session.title)}
          onMouseEnter={() => { setRowHovered(true); preview.handleMouseEnter() }}
          onMouseLeave={() => { setRowHovered(false); preview.handleMouseLeave() }}
          style={active ? undefined : {
            contentVisibility: 'auto',
            containIntrinsicSize: layout === 'favorite' ? 'auto var(--sidebar-favorite-content-height,40px)' : 'auto 22px',
          }}
          className={cn(
            'session-quick-switch-row group relative w-full min-h-[var(--sidebar-session-row-height,38px)] flex items-center gap-1.5 rounded-md py-[var(--sidebar-row-padding,8px)] pl-2.5 pr-1.5 transition-colors duration-100 titlebar-no-drag text-left',
            layout === 'favorite' && 'favorite-session-row',
            !editing && 'cursor-grab active:cursor-grabbing',
            active && 'agent-session-item-active',
            leftAccent
              ? SESSION_ACCENT_ROW_CLASS[leftAccent]
              : 'hover:bg-foreground/[0.03]',
            // 选中态背景：浅色叠加深色变深、深色叠加浅色变浅，自动适配主题。
            // orange accent 自带橙色底色，不再叠加，避免视觉过重。
            active && leftAccent !== 'orange' && 'bg-foreground/[0.08]',
          )}
        >
          {/* 左侧状态竖条只在 blocked 时上色：running/completed 的配色交给标题前的状态点，避免重复提示 */}
          {leftAccent === 'orange' && (
            <span
              className={cn(
                'absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none',
                SESSION_ACCENT_INDICATOR_CLASS.orange,
              )}
            />
          )}
          <div className="flex-1 min-w-0">
            {layout === 'favorite' ? (
              <div className="favorite-session-content">
                <div className="favorite-session-copy">
                  <div className={cn('favorite-session-title', statusDot ? 'gap-1.5' : undefined, active ? 'text-foreground' : 'text-foreground/90')}>{statusDot}{titleNode}</div>
                  {workspaceName && (
                    <div title={workspaceName} className="favorite-session-context truncate text-[length:calc(13px+var(--reading-font-size-offset,0px))] leading-5 text-foreground/60">
                      {workspaceName}
                    </div>
                  )}
                </div>
                <div className="favorite-session-star">{editing ? undefined : starButton}</div>
              </div>
            ) : editing ? titleNode : (
              <div className={cn(
                'flex items-center gap-1.5 truncate text-[length:calc(15px+var(--reading-font-size-offset,0px))] font-medium leading-5',
                active ? 'text-foreground' : 'text-foreground/90',
              )}>
                {statusDot}
                {leadingIcons}
                {titleNode}
                {starButton}
                {workspaceName && (
                  <span className="flex-shrink-0 max-w-[80px] truncate rounded-full bg-foreground/[0.06] px-1.5 py-0 text-[10px] font-medium leading-4 text-foreground/45 workspace-badge">
                    {workspaceName}
                  </span>
                )}
              </div>
            )}
          </div>

          {!editing && (
            <>
              {delegationSummary && (
                <div
                  className="flex shrink-0 items-center justify-end gap-1 text-[11px] leading-4 text-foreground/55"
                  aria-label={`子会话：${delegationSummary.settled}/${delegationSummary.total}`}
                >
                  <span className="shrink-0 tabular-nums">
                    {delegationSummary.settled}/{delegationSummary.total}
                  </span>
                  <SafeTooltip content={delegationSummary.expanded ? '收起子会话' : '展开子会话'} side="top">
                    <button
                      type="button"
                      aria-label={`${delegationSummary.expanded ? '收起' : '展开'}子会话`}
                      onMouseEnter={preview.closeNow}
                      onFocus={preview.closeNow}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        preview.closeNow()
                      }}
                      onClick={(event) => {
                        event.stopPropagation()
                        preview.closeNow()
                        delegationSummary.onToggle()
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation()
                        preview.closeNow()
                      }}
                      className="session-delegation-toggle inline-flex size-6 -my-1 items-center justify-center rounded text-foreground/45 hover:bg-foreground/[0.055] hover:text-foreground/70 transition-colors"
                    >
                      <ChevronRight
                        size={11}
                        className={cn(
                          'transition-transform duration-150',
                          delegationSummary.expanded && 'rotate-90',
                        )}
                      />
                    </button>
                  </SafeTooltip>
                </div>
              )}
              <SessionItemActions
                activityAt={getAgentSessionActivityAt(session)}
                relativeTimeNow={relativeTimeNow}
                onMenuOpenChange={setMenuOpen}
                menuItems={menuItems}
              />
              <SessionQuickSwitchKeycap />
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40 z-[9999] min-w-0 p-0.5">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
      {!disableMiniMap && (
        <SessionMiniMapPopover
          target={{
            type: 'agent',
            sessionId: session.id,
            title: session.title,
            workspaceName,
          }}
          anchorRef={preview.anchorRef}
          open={preview.isOpen}
          isLeaving={preview.isLeaving}
          onMouseEnter={preview.handlePanelMouseEnter}
          onMouseLeave={preview.handlePanelMouseLeave}
        />
      )}
    </ContextMenu>
  )
})

interface DelegatedChildSessionItemProps {
  session: AgentSessionMeta
  activeSessionId: string | null
  activeDelegationSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  relativeTimeNow: number
  /** 定时任务合成项目内隐藏行级时钟。 */
  suppressAutomationIcon?: boolean
  workspaceName?: string
  onSelect: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string, cascade: boolean) => Promise<void>
  onToggleStar: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
}

const DelegatedChildSessionItem = React.memo(function DelegatedChildSessionItem({
  session,
  activeSessionId,
  activeDelegationSessionId,
  agentIndicatorMap,
  relativeTimeNow,
  suppressAutomationIcon,
  workspaceName,
  onSelect,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleStar,
  onToggleArchive,
}: DelegatedChildSessionItemProps): React.ReactElement {
  const sessionHoverPreviewEnabled = useAtomValue(sessionHoverPreviewEnabledAtom)
  const status = getDelegatedChildStatus(session, agentIndicatorMap)
  const highlighted = session.id === activeSessionId
    || (session.parentSessionId === activeSessionId && session.id === activeDelegationSessionId)

  return (
    <AgentSessionItem
      session={session}
      active={highlighted}
      indicatorStatus={status}
      disableMiniMap={!sessionHoverPreviewEnabled}
      relativeTimeNow={relativeTimeNow}
      suppressAutomationIcon={suppressAutomationIcon}
      workspaceName={workspaceName}
      onSelect={onSelect}
      onRequestDelete={onRequestDelete}
      onRequestMove={onRequestMove}
      onRename={onRename}
      onTogglePin={onTogglePin}
      onToggleStar={onToggleStar}
      onToggleArchive={onToggleArchive}
    />
  )
})

interface VisibleAgentProjectSessions {
  treeItems: AgentSessionTreeItem[]
  sessions: AgentSessionTreeItem[]
  hiddenCount: number
  activeIds: Set<string>
}

function getVisibleAgentProjectSessions({
  group,
  activeSessionId,
  agentIndicatorMap,
  relativeTimeNow,
  extraCount,
  previousActiveIds = new Set<string>(),
}: {
  group: AgentProjectGroup
  activeSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  relativeTimeNow: number
  extraCount: number
  previousActiveIds?: ReadonlySet<string>
}): VisibleAgentProjectSessions {
  const recentCutoff = relativeTimeNow - PROJECT_SESSION_RECENT_WINDOW_MS
  const treeItems = buildAgentSessionTrees(group.sessions, agentIndicatorMap)
  const activeSessions = treeItems
    .filter((item) => (
      ACTIVE_SESSION_STATUSES.has(getSessionTreeStatus(item, agentIndicatorMap))
      || (item.session.id === activeSessionId && previousActiveIds.has(item.session.id))
    ))
    .slice()
    .sort((a, b) => {
      const delta = ACTIVE_SESSION_STATUS_PRIORITY[getSessionTreeStatus(a, agentIndicatorMap)]
        - ACTIVE_SESSION_STATUS_PRIORITY[getSessionTreeStatus(b, agentIndicatorMap)]
      if (delta !== 0) return delta
      // 同一状态内按最后活跃时间排：元数据变更不应改变折叠区的展开顺序。
      return getAgentSessionActivityAt(b.session) - getAgentSessionActivityAt(a.session)
    })
  const activeIds = collectAgentSessionTreeIds(activeSessions)
  const fillSessions = treeItems
    .filter((item) => !activeIds.has(item.session.id) && getAgentSessionActivityAt(item.session) >= recentCutoff)
    .slice(0, PROJECT_SESSION_PREVIEW_LIMIT)
  const collapsedSessions = [...activeSessions, ...fillSessions]
  const collapsedIds = new Set(collapsedSessions.map((item) => item.session.id))
  const remainingSessions = treeItems.filter((item) => !collapsedIds.has(item.session.id))
  const extraSessions = remainingSessions.slice(0, extraCount)
  const sessionsWithoutPinned = [...collapsedSessions, ...extraSessions]
  const currentSession = activeSessionId && !isAgentSessionVisibleInTrees(sessionsWithoutPinned, activeSessionId)
    ? treeItems.find((item) => treeContainsSessionId(item, activeSessionId)) ?? null
    : null
  const sessions = currentSession
    ? [...activeSessions, currentSession, ...fillSessions, ...extraSessions]
    : sessionsWithoutPinned

  return {
    treeItems,
    sessions,
    hiddenCount: Math.max(0, treeItems.length - sessions.length),
    activeIds,
  }
}

/** 项目分组历史 */
interface AgentProjectGroupItemProps {
  group: AgentProjectGroup
  currentWorkspaceId: string | null
  /** 合成「自动任务」只读组：隐藏拖拽 / 新建会话 / 项目菜单等 workspace 专属操作，会话显示来源工作区角标 */
  isAutomationGroup?: boolean
  /** 工作区 ID → 名称映射，仅合成组用来给跨工作区会话渲染角标 */
  workspaceNameMap?: Map<string, string>
  expanded: boolean
  collapsed: boolean
  /** 用户已点击"显示更多"额外展开的会话数量（基于 collapsedSessions 之上累加） */
  extraCount: number
  activeSessionId: string | null
  activeDelegationSessionId: string | null
  agentIndicatorMap: Map<string, SessionIndicatorStatus>
  expandedDelegationParentIds: Set<string>
  collapsedDelegationParentIds: Set<string>
  relativeTimeNow: number
  dragging: boolean
  dropPosition: 'before' | 'after' | null
  onShowMore: (workspaceId: string) => void
  onCollapseExtra: (workspaceId: string) => void
  onSelectProject: (workspaceId: string) => void
  onNewSession: (workspaceId: string) => Promise<void>
  onDragStart: (e: React.DragEvent, workspaceId: string) => void
  onDragOver: (e: React.DragEvent, workspaceId: string) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, workspaceId: string) => void
  onDragEnd: () => void
  onConfigureProject: (workspaceId: string) => void
  onRenameWorkspace: (workspaceId: string, newName: string) => Promise<void>
  onRelinkProjectRoot: (workspaceId: string) => Promise<void>
  onRequestRestoreProjectRoot: (workspaceId: string) => void
  onRequestDeleteWorkspace: (workspaceId: string) => void
  canDeleteWorkspace: boolean
  onSelectSession: (id: string, title: string) => void
  onRequestDelete: (id: string) => void
  onRequestMove: (id: string) => void
  onRename: (id: string, newTitle: string) => Promise<void>
  onTogglePin: (id: string, cascade: boolean) => Promise<void>
  onToggleStar: (id: string) => Promise<void>
  onToggleArchive: (id: string) => Promise<void>
  onToggleDelegationParent: (id: string, expanded: boolean) => void
  /** 虚拟侧栏只复用项目头部，项目会话行由外层 VirtualSidebarList 单独挂载。 */
  hideSessions?: boolean
}

const AgentProjectGroupItem = React.memo(function AgentProjectGroupItem({
  group,
  currentWorkspaceId,
  isAutomationGroup = false,
  workspaceNameMap,
  expanded,
  collapsed,
  extraCount,
  activeSessionId,
  activeDelegationSessionId,
  agentIndicatorMap,
  expandedDelegationParentIds,
  collapsedDelegationParentIds,
  relativeTimeNow,
  dragging,
  dropPosition,
  onShowMore,
  onCollapseExtra,
  onSelectProject,
  onNewSession,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onConfigureProject,
  onRenameWorkspace,
  onRelinkProjectRoot,
  onRequestRestoreProjectRoot,
  onRequestDeleteWorkspace,
  canDeleteWorkspace,
  onSelectSession,
  onRequestDelete,
  onRequestMove,
  onRename,
  onTogglePin,
  onToggleStar,
  onToggleArchive,
  onToggleDelegationParent,
  hideSessions = false,
}: AgentProjectGroupItemProps): React.ReactElement {
  const isCurrent = group.workspace.id === currentWorkspaceId
  const sessionHoverPreviewEnabled = useAtomValue(sessionHoverPreviewEnabledAtom)
  const hasUnavailableProjectRoot = Boolean(
    group.workspace.projectRootPath
    && group.workspace.projectRootStatus
    && group.workspace.projectRootStatus !== 'available',
  )

  const [renamingWorkspace, setRenamingWorkspace] = React.useState(false)
  const [workspaceEditName, setWorkspaceEditName] = React.useState('')
  const workspaceEditRef = React.useRef<HTMLInputElement>(null)
  const justStartedRenamingRef = React.useRef(false)

  const handleStartWorkspaceRename = (): void => {
    setWorkspaceEditName(group.workspace.name)
    setRenamingWorkspace(true)
    justStartedRenamingRef.current = true
    setTimeout(() => {
      justStartedRenamingRef.current = false
      workspaceEditRef.current?.focus()
      workspaceEditRef.current?.select()
    }, 300)
  }

  const handleWorkspaceRenameCommit = async (): Promise<void> => {
    if (justStartedRenamingRef.current) return
    const trimmed = workspaceEditName.trim()
    if (!trimmed || trimmed === group.workspace.name) {
      setRenamingWorkspace(false)
      return
    }
    await onRenameWorkspace(group.workspace.id, trimmed)
    setRenamingWorkspace(false)
  }

  const handleWorkspaceRenameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      e.preventDefault()
      void handleWorkspaceRenameCommit()
    } else if (e.key === 'Escape') {
      setRenamingWorkspace(false)
    }
  }
  const prevActiveIdsRef = React.useRef<Set<string>>(new Set())
  const { treeItems, sessions, hiddenCount, activeIds } = getVisibleAgentProjectSessions({
    group,
    activeSessionId,
    agentIndicatorMap,
    relativeTimeNow,
    extraCount,
    previousActiveIds: prevActiveIdsRef.current,
  })
  React.useEffect(() => { prevActiveIdsRef.current = activeIds })

  return (
    <section
      onDragOver={(e) => onDragOver(e, group.workspace.id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, group.workspace.id)}
      onDragEnd={onDragEnd}
      className={cn('relative py-0.5 rounded-md transition-opacity', dragging && 'opacity-45')}
    >
      {dropPosition === 'before' && (
        <div className="absolute -top-0.5 left-3 right-3 h-0.5 translate-x-[2px] rounded-full bg-primary z-10" />
      )}

      <div className="group/project relative flex items-center">
        {renamingWorkspace ? (
          <div
            className={cn(
              'relative flex-1 min-w-0 flex h-[var(--sidebar-project-row-height,38px)] items-center gap-2 pl-2 pr-1 py-1.5 rounded-md text-left titlebar-no-drag',
              'text-[hsl(var(--sidebar-primary-foreground))]',
            )}
          >
            <FolderOpen size={16} className="flex-shrink-0 text-[hsl(var(--sidebar-primary-foreground)/0.78)] dark:text-[hsl(var(--sidebar-primary-foreground)/0.65)]" />
            <input
              ref={workspaceEditRef}
              value={workspaceEditName}
              onChange={(e) => setWorkspaceEditName(e.target.value)}
              onKeyDown={handleWorkspaceRenameKeyDown}
              onBlur={() => void handleWorkspaceRenameCommit()}
              className="flex-1 min-w-0 bg-transparent text-[length:calc(14px+var(--reading-font-size-offset,0px))] font-medium text-foreground border-b border-primary/50 outline-none px-0.5 leading-5"
              maxLength={50}
            />
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={hideSessions ? undefined : `project-sessions-${group.workspace.id}`}
            draggable={!renamingWorkspace}
            onDragStart={(e) => onDragStart(e, group.workspace.id)}
            onClick={(e) => {
              e.stopPropagation()
              onSelectProject(group.workspace.id)
            }}
            className={cn(
              'relative flex-1 min-w-0 flex h-[var(--sidebar-project-row-height,38px)] items-center gap-2 pl-2 py-1.5 rounded-md text-left transition-[color,background-color] titlebar-no-drag hover:bg-foreground/[0.025]',
              'cursor-grab active:cursor-grabbing',
              isAutomationGroup ? 'pr-1' : 'pr-12',
              'text-[hsl(var(--sidebar-primary-foreground))] hover:text-[hsl(var(--sidebar-primary-foreground))]',
            )}
          >
            {isAutomationGroup ? (
              <Clock size={16} className="flex-shrink-0 text-foreground/40" />
            ) : collapsed ? (
              <FolderClosed size={16} className="flex-shrink-0 text-foreground/55" />
            ) : (
              <FolderOpen size={16} className="flex-shrink-0 text-foreground/55" />
            )}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[length:calc(14px+var(--reading-font-size-offset,0px))] font-medium leading-5">
                {group.workspace.name}
              </span>
              <LocalProjectBadge
                projectRootPath={group.workspace.projectRootPath}
                projectRootStatus={group.workspace.projectRootStatus}
              />
              {isCurrent && (
                <span className="workspace-selected-triangle flex-shrink-0" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-[4px] flex-1" aria-hidden="true" />
            {isAutomationGroup && (
              <ChevronRight
                size={12}
                className={cn(
                  'flex-shrink-0 text-foreground/30 transition-transform duration-150',
                  collapsed ? '-rotate-90' : 'rotate-90',
                )}
              />
            )}
          </button>
        )}


        {!isAutomationGroup && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`在「${group.workspace.name}」中新建会话`}
              onClick={(e) => {
                e.stopPropagation()
                void onNewSession(group.workspace.id)
              }}
              className="absolute right-0 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/65 titlebar-no-drag"
            >
              <Plus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span className="flex items-center gap-2">
              <span>新建会话</span>
              <ShortcutKeycaps shortcutId="new-session" keycapClassName="h-5 min-w-5 px-1 text-[11px]" separatorClassName="text-[10px]" />
            </span>
          </TooltipContent>
        </Tooltip>
        )}

        {!isAutomationGroup && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="项目菜单"
              className="absolute right-5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 opacity-0 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/60 group-hover/project:opacity-100 data-[state=open]:opacity-100 titlebar-no-drag"
            >
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 z-[9999] min-w-0 p-0.5">
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={() => onSelectProject(group.workspace.id)}
            >
              <FolderOpen size={14} />
              设为当前项目
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={handleStartWorkspaceRename}
            >
              <Pencil size={14} />
              重命名
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-xs py-1 [&>svg]:size-3.5"
              onSelect={() => onConfigureProject(group.workspace.id)}
            >
              <Settings size={14} />
              配置 MCP 与 Skills
            </DropdownMenuItem>
            {hasUnavailableProjectRoot && (
              <>
                <DropdownMenuSeparator className="my-0.5" />
                <DropdownMenuItem
                  className="text-xs py-1 [&>svg]:size-3.5"
                  onSelect={() => void onRelinkProjectRoot(group.workspace.id)}
                >
                  <FolderInput size={14} />
                  重新选择文件夹
                </DropdownMenuItem>
                {group.workspace.projectRootStatus === 'missing' && (
                  <DropdownMenuItem
                    className="text-xs py-1 [&>svg]:size-3.5"
                    onSelect={() => onRequestRestoreProjectRoot(group.workspace.id)}
                  >
                    <FolderPlus size={14} />
                    在原路径新建空文件夹
                  </DropdownMenuItem>
                )}
              </>
            )}
            <DropdownMenuSeparator className="my-0.5" />
            <DropdownMenuItem
              disabled={!canDeleteWorkspace}
              className={cn(
                'text-xs py-1 [&>svg]:size-3.5',
                canDeleteWorkspace && 'text-destructive focus:text-destructive',
              )}
              onSelect={() => onRequestDeleteWorkspace(group.workspace.id)}
            >
              <Trash2 size={14} />
              删除项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>

      {!hideSessions && (
        <div id={`project-sessions-${group.workspace.id}`} className="ml-5 mt-px">
        {!collapsed ? (
          treeItems.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {sessions.map((item) => {
                const childCount = item.childSessions.length
                const rowStatus = getSessionTreeStatus(item, agentIndicatorMap)
                const treeActive = treeContainsSessionId(item, activeSessionId)
                const activeChildVisible = item.childSessions.some((child) => child.id === activeSessionId)
                const expandedChildren = expandedDelegationParentIds.has(item.session.id)
                  || (activeChildVisible && !collapsedDelegationParentIds.has(item.session.id))

                return (
                  <div key={item.session.id} className="flex flex-col gap-0.5">
                    <AgentSessionItem
                      session={item.session}
                      active={treeActive}
                      indicatorStatus={rowStatus}
                      showPinIcon={!!item.session.pinned}
                      disableMiniMap={!sessionHoverPreviewEnabled}
                      suppressAutomationIcon={isAutomationGroup}
                      delegationSummary={childCount > 0
                        ? {
                          total: childCount,
                          settled: countSettledDelegatedChildren(item.childSessions, agentIndicatorMap),
                          expanded: expandedChildren,
                          onToggle: () => onToggleDelegationParent(item.session.id, expandedChildren),
                        }
                        : undefined}
                      leftAccent={getSessionLeftAccent(rowStatus)}
                      relativeTimeNow={relativeTimeNow}
                      workspaceName={isAutomationGroup && item.session.workspaceId ? workspaceNameMap?.get(item.session.workspaceId) : undefined}
                      onSelect={onSelectSession}
                      onRequestDelete={onRequestDelete}
                      onRequestMove={onRequestMove}
                      onRename={onRename}
                      onTogglePin={onTogglePin}
                      onToggleStar={onToggleStar}
                      onToggleArchive={onToggleArchive}
                    />

                    {childCount > 0 && expandedChildren && (
                      <div className="ml-3 border-l border-foreground/10 pl-2 flex flex-col gap-0.5">
                        {item.childSessions.map((childSession) => (
                          <DelegatedChildSessionItem
                            key={childSession.id}
                            session={childSession}
                            activeSessionId={activeSessionId}
                            activeDelegationSessionId={activeDelegationSessionId}
                            agentIndicatorMap={agentIndicatorMap}
                            relativeTimeNow={relativeTimeNow}
                            suppressAutomationIcon={isAutomationGroup}
                            workspaceName={isAutomationGroup && childSession.workspaceId ? workspaceNameMap?.get(childSession.workspaceId) : undefined}
                            onSelect={onSelectSession}
                            onRequestDelete={onRequestDelete}
                            onRequestMove={onRequestMove}
                            onRename={onRename}
                            onTogglePin={onTogglePin}
                            onToggleStar={onToggleStar}
                            onToggleArchive={onToggleArchive}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {(hiddenCount > 0 || expanded) && (
                <div className="flex items-center gap-0.5 pt-0.5">
                  {hiddenCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`显示更多会话，还有 ${hiddenCount} 个`}
                          onClick={() => onShowMore(group.workspace.id)}
                          className="flex size-7 items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.04] hover:text-foreground/65 transition-colors titlebar-no-drag"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">{`显示更多会话（还有 ${hiddenCount} 个）`}</TooltipContent>
                    </Tooltip>
                  )}

                  {expanded && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="收起额外会话"
                          onClick={() => onCollapseExtra(group.workspace.id)}
                          className="flex size-7 items-center justify-center rounded-md text-foreground/35 hover:bg-foreground/[0.04] hover:text-foreground/65 transition-colors titlebar-no-drag"
                        >
                          <ChevronUp size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">收起额外会话</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="pl-2.5 py-0.5 text-[12px] text-muted-foreground/75 select-none">
              暂无会话
            </div>
          )
        ) : null}
        </div>
      )}
      {dropPosition === 'after' && (
        <div className="absolute -bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-primary z-10" />
      )}
    </section>
  )
})
