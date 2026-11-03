/**
 * AutomationSidebarPanel — 定时任务视图的左侧任务列表面板（对齐商业版 0.21.88）
 *
 * 由 LeftSidebar 在 activeView === 'automations' 时渲染在 rail 右侧，自行占满剩余宽度。
 * 对应商业版产物（/tmp/pcom/index-CWAszSPi.u.js）：
 * - Ost（25877）：面板整体、创建按钮、搜索 + 排序、分组列表、删除确认
 * - Git（25731）：顶部 h-10 chrome 标题条
 * - Qit（25726）：运行会话排序菜单
 * - vD（25998）：「启用中 / 已暂停 / 已完成」分组与任务行
 * - jst（26015）：任务展开后的运行会话列表
 * - Pst（26023）：无任务空态
 *
 * 点击运行会话：在主区打开该会话，并保持 activeView 为 'automations'。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Ellipsis,
  Pencil,
  Play,
  Plus,
  Power,
  Search,
  Trash2,
} from 'lucide-react'
import type { AgentSessionMeta, Automation, AutomationRun } from '@proma/shared'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  automationsAtom,
  automationFormAtom,
  automationFocusRequestAtom,
  automationSessionSortAtom,
  automationToDraft,
  createNamedDraft,
  AUTOMATION_SESSION_SORT_LABELS,
  type AutomationSessionSort,
} from '@/atoms/automation-atoms'
import {
  agentSessionsAtom,
  agentSessionIndicatorMapAtom,
  agentSidePanelOpenAtomFamily,
  currentAgentSessionIdAtom,
  unviewedCompletedSessionIdsAtom,
  type SessionIndicatorStatus,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { useOpenSession } from '@/hooks/useOpenSession'
import {
  collectAutomationsWithUnread,
  collectUnreadRunCounts,
  formatAutomationNextRun,
  formatAutomationSchedule,
  formatRunResult,
  formatRunTime,
  getRunKey,
  getSessionActivityTime,
  groupAutomations,
  listAutomationRuns,
} from './automation-format'

/** 展开后默认显示的运行会话数（商业版 Sst） */
const DEFAULT_VISIBLE_RUNS = 5
/** 每次「显示更多」追加的运行会话数（商业版 Cst） */
const SHOW_MORE_STEP = 10

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (typeof platform === 'string' && platform.toLowerCase().includes('mac')) return true
  return /mac/i.test(navigator.platform || '')
}

export function AutomationSidebarPanel(): React.ReactElement {
  const store = useStore()
  const [sessionSort, setSessionSort] = useAtom(automationSessionSortAtom)
  const [automations, setAutomations] = useAtom(automationsAtom)
  const [focusRequest, setFocusRequest] = useAtom(automationFocusRequestAtom)
  const activeSessionId = useAtomValue(currentAgentSessionIdAtom)
  const indicatorMap = useAtomValue(agentSessionIndicatorMapAtom)
  const unviewedSessionIds = useAtomValue(unviewedCompletedSessionIdsAtom)
  const [agentSessions, setAgentSessions] = useAtom(agentSessionsAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)
  const openSession = useOpenSession()

  const [query, setQuery] = React.useState('')
  const openRequestRef = React.useRef(0)
  const isMac = React.useMemo(() => isMacPlatform(), [])
  const [pendingDeletion, setPendingDeletion] = React.useState<Automation | null>(null)
  const [extraRunCounts, setExtraRunCounts] = React.useState<Map<string, number>>(() => new Map())
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set(automations.map((a) => a.id)))
  const [collapsedIds, setCollapsedIds] = React.useState<Set<string>>(() => new Set())
  const [runningIds, setRunningIds] = React.useState<Set<string>>(() => new Set())
  const [unavailableRunKeys, setUnavailableRunKeys] = React.useState<Set<string>>(() => new Set())

  const automationsWithUnread = React.useMemo(
    () => collectAutomationsWithUnread(automations, agentSessions, unviewedSessionIds),
    [automations, agentSessions, unviewedSessionIds],
  )
  const unreadRunCounts = React.useMemo(
    () => collectUnreadRunCounts(automations, unviewedSessionIds, agentSessions),
    [automations, agentSessions, unviewedSessionIds],
  )
  const totalUnread = React.useMemo(
    () => [...unreadRunCounts.values()].reduce((sum, count) => sum + count, 0),
    [unreadRunCounts],
  )
  const groups = React.useMemo(() => groupAutomations(automations, query), [automations, query])
  const sessionTitleById = React.useMemo(
    () => new Map(agentSessions.map((session) => [session.id, session.title])),
    [agentSessions],
  )

  // 默认全部展开；用户手动收起的任务记录在 collapsedIds 中
  React.useEffect(() => {
    setExpandedIds(new Set(automations.filter((a) => !collapsedIds.has(a.id)).map((a) => a.id)))
  }, [automations, collapsedIds])

  // 外部请求聚焦某个任务：展开它并取消手动收起
  React.useEffect(() => {
    if (!focusRequest) return
    if (!automations.some((a) => a.id === focusRequest)) {
      setFocusRequest(null)
      return
    }
    setExpandedIds((previous) => new Set(previous).add(focusRequest))
    setCollapsedIds((previous) => {
      if (!previous.has(focusRequest)) return previous
      const next = new Set(previous)
      next.delete(focusRequest)
      return next
    })
    setFocusRequest(null)
  }, [automations, focusRequest, setFocusRequest])

  // 有待查看结果的任务自动展开（用户手动收起的除外）
  React.useEffect(() => {
    setExpandedIds((previous) => {
      const next = new Set(previous)
      let changed = false
      for (const id of automationsWithUnread) {
        if (!collapsedIds.has(id) && !next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [collapsedIds, automationsWithUnread])

  // 面板卸载后丢弃仍在进行的「打开运行会话」请求
  React.useEffect(() => () => { openRequestRef.current += 1 }, [])

  const refreshAutomations = React.useCallback(async () => {
    const list = await window.electronAPI.listAutomations()
    setAutomations(list)
  }, [setAutomations])

  const handleCreate = (): void => {
    setAutomationForm({ open: true, draft: createNamedDraft(automations) })
  }

  const handleEdit = (automation: Automation): void => {
    setAutomationForm({ open: true, draft: automationToDraft(automation) })
  }

  const handleRunNow = async (automation: Automation): Promise<void> => {
    if (runningIds.has(automation.id)) return
    if (!automation.channelId || !automation.workspaceId) {
      toast.error('请先为该任务配置模型与项目')
      handleEdit(automation)
      return
    }
    setRunningIds((previous) => new Set(previous).add(automation.id))
    toast.message(`正在运行「${automation.name}」`)
    try {
      await window.electronAPI.runAutomationNow(automation.id)
      const [list, sessions] = await Promise.all([
        window.electronAPI.listAutomations(),
        window.electronAPI.listAgentSessions(),
      ])
      setAutomations(list)
      setAgentSessions(sessions)
      toast.success(`「${automation.name}」运行结束`, { description: '结果已添加到该任务的运行会话。' })
    } catch (error) {
      console.error('[定时任务] 立即运行失败:', error)
      toast.error('运行失败')
    } finally {
      setRunningIds((previous) => {
        const next = new Set(previous)
        next.delete(automation.id)
        return next
      })
    }
  }

  const handleToggle = async (automation: Automation): Promise<void> => {
    if (!automation.active && (!automation.channelId || !automation.workspaceId)) {
      toast.error('请先为该任务配置模型与项目')
      handleEdit(automation)
      return
    }
    try {
      await window.electronAPI.toggleAutomation(automation.id, !automation.active)
      await refreshAutomations()
      toast.success(automation.active ? '已暂停' : '已启用')
    } catch (error) {
      console.error('[定时任务] 切换状态失败:', error)
      toast.error('操作失败')
    }
  }

  const handleToggleExpansion = (id: string): void => {
    const wasExpanded = expandedIds.has(id)
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setCollapsedIds((previous) => {
      const next = new Set(previous)
      if (wasExpanded) next.add(id)
      else next.delete(id)
      return next
    })
    setUnavailableRunKeys(new Set())
  }

  const handleShowMore = (id: string): void => {
    setExtraRunCounts((previous) => {
      const next = new Map(previous)
      next.set(id, (next.get(id) ?? 0) + SHOW_MORE_STEP)
      return next
    })
  }

  const handleCollapseExtra = (id: string): void => {
    setExtraRunCounts((previous) => {
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }

  const handleOpenRun = (run: AutomationRun): void => {
    const requestId = ++openRequestRef.current
    void (async () => {
      let session: AgentSessionMeta | undefined = agentSessions.find((item) => item.id === run.sessionId)
      if (!session) {
        const sessions = await window.electronAPI.listAgentSessions()
        setAgentSessions(sessions)
        session = sessions.find((item) => item.id === run.sessionId)
      }
      // 期间用户已切走或发起了新的打开请求时放弃
      if (requestId !== openRequestRef.current || store.get(activeViewAtom) !== 'automations') return
      if (!session) {
        const key = getRunKey(run)
        setUnavailableRunKeys((previous) => new Set(previous).add(key))
        toast.error('会话已清理，运行摘要仍可查看')
        return
      }
      const sessionId = session.id
      // 运行会话在定时任务视图的主区打开（商业版 view: 'automations'）
      openSession('agent', sessionId, session.title, {
        view: 'automations',
        onOpened: () => {
          store.set(agentSidePanelOpenAtomFamily(sessionId), false)
        },
      })
    })().catch((error: unknown) => {
      console.error('[定时任务] 打开运行会话失败:', error)
      toast.error('打开运行会话失败')
    })
  }

  const confirmDelete = async (): Promise<void> => {
    const automation = pendingDeletion
    if (!automation) return
    try {
      const deleted = await window.electronAPI.deleteAutomation(automation.id)
      await refreshAutomations()
      if (focusRequest === automation.id) setFocusRequest(null)
      setExpandedIds((previous) => {
        const next = new Set(previous)
        next.delete(automation.id)
        return next
      })
      setCollapsedIds((previous) => {
        const next = new Set(previous)
        next.delete(automation.id)
        return next
      })
      setPendingDeletion(null)
      if (deleted) toast.success('已删除')
      else toast.error('定时任务不存在或已被删除')
    } catch (error) {
      console.error('[定时任务] 删除失败:', error)
      toast.error('删除失败')
    }
  }

  const hasAutomations = automations.length > 0
  const hasMatches = groups.active.length + groups.paused.length + groups.completed.length > 0
  const sectionProps = {
    expandedIds,
    unreadRunCounts,
    unviewedSessionIds,
    agentSessions,
    sessionTitleById,
    indicatorMap,
    activeSessionId,
    extraRunCounts,
    runningIds,
    unavailableRunKeys,
    onToggleExpansion: handleToggleExpansion,
    onShowMore: handleShowMore,
    onCollapseExtra: handleCollapseExtra,
    onOpenRun: handleOpenRun,
    onRunNow: (automation: Automation) => { void handleRunNow(automation) },
    onEdit: handleEdit,
    onToggle: (automation: Automation) => { void handleToggle(automation) },
    onDelete: setPendingDeletion,
  }

  return (
    <div className="relative isolate flex min-w-0 flex-1 flex-col">
      <AutomationPanelHeader unreadCount={totalUnread} isMac={isMac} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 top-10 -z-10 rounded-tl-2xl proma-sidebar-list-surface"
      />
      <div className="titlebar-no-drag px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={handleCreate}
          aria-label="新建定时任务"
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[14px] font-medium text-primary-foreground transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Plus size={16} />
          创建定时任务
        </button>
      </div>
      <div className="flex items-center gap-1 px-3 pb-2">
        <div className="flex min-w-0 flex-1 h-10 items-center gap-2 rounded-lg bg-foreground/[0.045] px-2 focus-within:ring-1 focus-within:ring-primary/30 titlebar-no-drag">
          <Search size={14} className="shrink-0 text-foreground/40" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
            aria-label="搜索定时任务"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/35"
          />
        </div>
        <SessionSortMenu value={sessionSort} onChange={setSessionSort} />
      </div>
      <div className="automation-sidebar-list min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin titlebar-no-drag">
        {hasAutomations ? (
          hasMatches ? (
            <div className="space-y-4">
              <AutomationSection title="启用中" automations={groups.active} showNextRun {...sectionProps} />
              <AutomationSection title="已暂停" automations={groups.paused} {...sectionProps} />
              <AutomationSection title="已完成" automations={groups.completed} {...sectionProps} />
            </div>
          ) : (
            <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">没有匹配的定时任务。</div>
          )
        ) : (
          <AutomationEmptyState onCreate={handleCreate} />
        )}
      </div>
      <AlertDialog open={pendingDeletion !== null} onOpenChange={(open) => { if (!open) setPendingDeletion(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除定时任务</AlertDialogTitle>
            <AlertDialogDescription>删除「{pendingDeletion?.name}」后无法恢复，已有的运行会话会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void confirmDelete() }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 顶部 chrome 标题条（商业版 Git） */
function AutomationPanelHeader({ unreadCount, isMac }: { unreadCount: number; isMac: boolean }): React.ReactElement {
  return (
    <div className={`titlebar-drag-region flex h-10 shrink-0 items-center gap-2 proma-chrome-surface ${isMac ? 'px-5 sm:px-6 xl:px-8' : 'px-3'}`}>
      <span className="pointer-events-none min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-[hsl(var(--sidebar-primary-foreground))]">
        定时任务
      </span>
      {unreadCount > 0 && (
        <span
          className="pointer-events-none shrink-0 text-[11px] font-medium tabular-nums text-primary/80"
          aria-label={`${unreadCount} 条待查看结果`}
        >
          {unreadCount} 条待查看
        </span>
      )}
    </div>
  )
}

/** 运行会话排序菜单（商业版 Qit） */
function SessionSortMenu({
  value,
  onChange,
}: {
  value: AutomationSessionSort
  onChange: (value: AutomationSessionSort) => void
}): React.ReactElement {
  const label = AUTOMATION_SESSION_SORT_LABELS[value]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`会话排序：${label}`}
          title={`会话排序：${label}`}
          className="titlebar-no-drag inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-foreground/60 transition-[background-color,color,transform] hover:bg-foreground/[0.055] hover:text-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <ArrowDownUp size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[9999] w-56">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === 'activity' || next === 'created-desc' || next === 'created-asc') onChange(next)
          }}
        >
          {(Object.entries(AUTOMATION_SESSION_SORT_LABELS) as Array<[AutomationSessionSort, string]>).map(([key, text]) => (
            <DropdownMenuRadioItem key={key} value={key} className="min-h-10 text-[13px]">
              {text}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AutomationSectionProps {
  title: string
  automations: Automation[]
  expandedIds: Set<string>
  unreadRunCounts: Map<string, number>
  unviewedSessionIds: Set<string>
  agentSessions: AgentSessionMeta[]
  sessionTitleById: Map<string, string>
  indicatorMap: Map<string, SessionIndicatorStatus>
  activeSessionId: string | null
  extraRunCounts: Map<string, number>
  runningIds: Set<string>
  unavailableRunKeys: Set<string>
  onToggleExpansion: (id: string) => void
  onShowMore: (id: string) => void
  onCollapseExtra: (id: string) => void
  onOpenRun: (run: AutomationRun) => void
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
  showNextRun?: boolean
}

/** 任务分组与任务行（商业版 vD） */
function AutomationSection({
  title,
  automations,
  expandedIds,
  unreadRunCounts,
  unviewedSessionIds,
  agentSessions,
  sessionTitleById,
  indicatorMap,
  activeSessionId,
  extraRunCounts,
  runningIds,
  unavailableRunKeys,
  onToggleExpansion,
  onShowMore,
  onCollapseExtra,
  onOpenRun,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  showNextRun = false,
}: AutomationSectionProps): React.ReactElement | null {
  const sessionSort = useAtomValue(automationSessionSortAtom)
  const sessionTimeById = React.useMemo(
    () => new Map(agentSessions.map((session) => [
      session.id,
      sessionSort === 'activity' ? getSessionActivityTime(session) : session.createdAt,
    ])),
    [agentSessions, sessionSort],
  )

  if (automations.length === 0) return null

  return (
    <section aria-label={title}>
      <div className="px-2 pt-2 pb-1 text-[13px] font-semibold leading-5 text-foreground/45 select-none">{title}</div>
      <div className="space-y-0.5">
        {automations.map((automation) => {
          const expanded = expandedIds.has(automation.id)
          const unreadCount = unreadRunCounts.get(automation.id) ?? 0
          const schedule = formatAutomationSchedule(automation)
          const running = runningIds.has(automation.id)
          const status = running ? '正在运行' : showNextRun ? formatAutomationNextRun(automation) : schedule
          const summary = [status, showNextRun ? schedule : null, unreadCount > 0 ? `待查看 ${unreadCount} 条` : null]
            .filter(Boolean)
            .join(' · ')
          const runs = listAutomationRuns(automation, agentSessions, unviewedSessionIds, sessionSort)
          const extra = extraRunCounts.get(automation.id) ?? 0
          const visibleRuns = runs.slice(0, DEFAULT_VISIBLE_RUNS + extra)
          const hiddenCount = Math.max(0, runs.length - visibleRuns.length)

          return (
            <section key={automation.id} className="relative py-0.5">
              <div className="group/project relative flex items-center">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`automation-sessions-${automation.id}`}
                  aria-label={`${automation.name}：${summary}`}
                  title={summary}
                  onClick={() => onToggleExpansion(automation.id)}
                  className={cn(
                    'relative flex min-h-[46px] min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 pr-10 text-left transition-[color,background-color] titlebar-no-drag hover:bg-foreground/[0.025]',
                    expanded && 'bg-foreground/[0.055]',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-[14px] font-medium leading-5 text-[hsl(var(--sidebar-primary-foreground))]">
                        {automation.name}
                      </span>
                      {unreadCount > 0 && (
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-primary/80">{unreadCount} 待查看</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] leading-4 text-foreground/50">{status}</span>
                  </span>
                  <ChevronRight
                    size={12}
                    className={cn('shrink-0 text-foreground/30 transition-transform duration-150', expanded && 'rotate-90')}
                  />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`更多操作：${automation.name}`}
                      onClick={(event) => event.stopPropagation()}
                      className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-foreground/30 transition-colors hover:bg-foreground/[0.055] hover:text-foreground/60 titlebar-no-drag focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      <Ellipsis size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" side="bottom" className="z-[9999] w-40 p-1">
                    <DropdownMenuItem onSelect={() => onEdit(automation)}>
                      <Pencil size={14} />
                      编辑任务
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onToggle(automation)}>
                      <Power size={14} />
                      {automation.active ? '暂停任务' : '启用任务'}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={running} onSelect={() => onRunNow(automation)}>
                      <Play size={14} />
                      {running ? '正在运行' : '立即运行'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                      onSelect={() => onDelete(automation)}
                    >
                      <Trash2 size={14} />
                      删除任务
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {expanded && (
                <div id={`automation-sessions-${automation.id}`} className="ml-5 mt-0.5 border-l border-foreground/[0.07] pl-1">
                  <AutomationRunList
                    runs={visibleRuns}
                    totalRunCount={runs.length}
                    hiddenCount={hiddenCount}
                    expandedExtra={extra > 0}
                    indicatorMap={indicatorMap}
                    activeSessionId={activeSessionId}
                    sessionTitleById={sessionTitleById}
                    sessionTimeById={sessionTimeById}
                    timeLabel={sessionSort === 'activity' ? '最近活动' : '创建时间'}
                    unavailableRunKeys={unavailableRunKeys}
                    onShowMore={() => onShowMore(automation.id)}
                    onCollapseExtra={() => onCollapseExtra(automation.id)}
                    onOpenRun={onOpenRun}
                  />
                </div>
              )}
            </section>
          )
        })}
      </div>
    </section>
  )
}

type IndicatorTone = 'orange' | 'blue' | 'green'

/** 运行会话行在不同指示状态下的样式（商业版 Est / Tst / Nst） */
const INDICATOR_ROW_CLASS: Record<IndicatorTone, string> = {
  orange: 'bg-orange-500/[0.08] text-foreground font-medium',
  blue: 'text-foreground font-medium hover:bg-foreground/[0.03]',
  green: 'text-foreground font-medium hover:bg-foreground/[0.03]',
}

const INDICATOR_BAR_CLASS: Record<IndicatorTone, string> = {
  orange: 'bg-orange-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
}

function getIndicatorTone(status: SessionIndicatorStatus): IndicatorTone | undefined {
  if (status === 'blocked') return 'orange'
  if (status === 'running') return 'blue'
  if (status === 'completed') return 'green'
  return undefined
}

interface AutomationRunListProps {
  runs: AutomationRun[]
  totalRunCount: number
  hiddenCount: number
  expandedExtra: boolean
  sessionTitleById: Map<string, string>
  sessionTimeById: Map<string, number>
  timeLabel: string
  indicatorMap: Map<string, SessionIndicatorStatus>
  activeSessionId: string | null
  unavailableRunKeys: Set<string>
  onShowMore: () => void
  onCollapseExtra: () => void
  onOpenRun: (run: AutomationRun) => void
}

/** 任务展开后的运行会话列表（商业版 jst） */
function AutomationRunList({
  runs,
  totalRunCount,
  hiddenCount,
  expandedExtra,
  sessionTitleById,
  sessionTimeById,
  timeLabel,
  indicatorMap,
  activeSessionId,
  unavailableRunKeys,
  onShowMore,
  onCollapseExtra,
  onOpenRun,
}: AutomationRunListProps): React.ReactElement {
  if (runs.length === 0) {
    return <div className="py-1 pl-2.5 text-[12px] text-muted-foreground/75 select-none">暂无运行会话</div>
  }

  return (
    <div className="flex flex-col gap-0.5">
      {runs.map((run) => {
        const key = getRunKey(run)
        const hasSession = !!run.sessionId
        const disabled = !hasSession || unavailableRunKeys.has(key)
        const tone = getIndicatorTone(indicatorMap.get(run.sessionId) ?? 'idle')
        const isActive = hasSession && activeSessionId === run.sessionId
        const failureLabel = run.status === 'skipped' ? `已跳过：${formatRunResult(run)}` : `运行失败：${formatRunResult(run)}`
        const title = hasSession ? sessionTitleById.get(run.sessionId) ?? `执行于 ${formatRunTime(run.runAt)}` : failureLabel
        const time = formatRunTime(sessionTimeById.get(run.sessionId) ?? run.runAt)

        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-current={isActive ? 'page' : undefined}
            aria-label={`${title}：${hasSession ? (disabled ? '会话已清理' : formatRunResult(run)) : '没有可打开的会话'}`}
            onClick={() => { if (!disabled) onOpenRun(run) }}
            className={cn(
              'session-quick-switch-row group relative flex w-full items-center gap-1.5 rounded-md py-[var(--sidebar-row-padding,8px)] pl-2.5 pr-1.5 text-left transition-colors duration-100 titlebar-no-drag',
              !disabled && 'cursor-pointer',
              disabled && 'cursor-not-allowed opacity-55',
              isActive && 'agent-session-item-active',
              tone ? INDICATOR_ROW_CLASS[tone] : 'hover:bg-foreground/[0.03]',
              isActive && tone !== 'orange' && 'bg-foreground/[0.08]',
            )}
          >
            {tone && (
              <span
                className={cn('absolute inset-y-0 left-0 w-[3px] rounded-l-md pointer-events-none', INDICATOR_BAR_CLASS[tone])}
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px] leading-5',
                !hasSession && run.status === 'error' ? 'text-destructive' : 'text-foreground/80',
              )}
            >
              {title}
            </span>
            <span
              title={`${timeLabel}：${time}；最近执行：${formatRunTime(run.runAt)}`}
              className="shrink-0 text-[12px] leading-4 tabular-nums text-foreground/45"
            >
              {time}
            </span>
          </button>
        )
      })}
      {(hiddenCount > 0 || expandedExtra) && (
        <div className="flex items-center gap-0.5 pt-0.5">
          {hiddenCount > 0 && (
            <button
              type="button"
              aria-label={`显示更多运行会话，还有 ${hiddenCount} 个`}
              onClick={onShowMore}
              className="flex size-7 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/65 titlebar-no-drag focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              title={`显示更多会话（还有 ${hiddenCount} 个）`}
            >
              <ChevronDown size={14} />
            </button>
          )}
          {expandedExtra && (
            <button
              type="button"
              aria-label={`收起额外运行会话，共 ${totalRunCount} 个`}
              onClick={onCollapseExtra}
              className="flex size-7 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/65 titlebar-no-drag focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              title="收起额外会话"
            >
              <ChevronUp size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 无任务空态（商业版 Pst） */
function AutomationEmptyState({ onCreate }: { onCreate: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-foreground/[0.05] text-foreground/40">
        <Clock size={18} />
      </span>
      <div className="mt-3 text-[14px] font-medium text-foreground/75">还没有定时任务</div>
      <p className="mt-1 text-[13px] leading-5 text-foreground/60">让 Proma 定期执行检查、汇总与跟进工作。</p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-3 flex h-10 items-center gap-2 rounded-lg bg-primary px-3 text-[14px] font-medium text-primary-foreground transition-[background-color,transform] hover:bg-primary/90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Plus size={13} />
        新建定时任务
      </button>
    </div>
  )
}
