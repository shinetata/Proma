/**
 * 项目记忆（对齐商业版 0.21.88 jtn / Ptn / U9e）。
 *
 * - 记忆整页「当前项目」：fullScreen，标题 + 刷新 + 两栏卡片（记忆文件 / 编辑器）。
 * - Agent 右侧工作区：embedded，只看当前项目，不提供搜索，可展示本次运行的记忆 Diff。
 * - WorkspaceMemoryTab 保留给能力中心的旧调用（关于你 / 当前项目两段 Tab）。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, FileText, FolderOpen, LibraryBig, RefreshCw, TriangleAlert } from 'lucide-react'
import type { SkillFileNode, WorkspaceMemorySummary } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/components/settings/primitives'
import { AgentActionHint } from '@/components/agent/AgentActionHint'
import { WorkspaceMemoryChangeShelf } from './WorkspaceMemoryChangeShelf'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { memoryFileNavigationAtom, workspaceMemoryChangesAtom } from '@/atoms/memory-change-atoms'
import { cn } from '@/lib/utils'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GlobalProfilePanel } from './GlobalProfilePanel'

type SelectedMemoryFile =
  | { kind: 'agents'; relativePath: 'AGENTS.md'; title: string; absolutePath: string }
  | { kind: 'auto'; relativePath: string; title: string; absolutePath: string }

export interface ProjectMemoryPanelProps {
  workspaceSlug: string
  /** 记忆整页显示的项目名。 */
  projectName?: string
  /** 仅嵌入 Agent 右侧工作区时传入，用于展示当前会话的记忆变更 Diff。 */
  sessionId?: string
  /** 记忆 Diff 查看结束或失效时关闭当前会话的项目记忆 Tab，避免回退到完整记忆。 */
  onCloseChangeView?: () => void
  /** 能力中心传入的统一搜索词；嵌入组件不提供搜索。 */
  search?: string
  embedded?: boolean
  /** 记忆整页「当前项目」：放大标题、卡片与编辑器排版。 */
  fullScreen?: boolean
}

type WorkspaceMemoryTabProps = Omit<ProjectMemoryPanelProps, 'fullScreen' | 'projectName'>

const AGENTS_TITLE = '项目 AGENTS.md'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function autoMemoryPath(summary: WorkspaceMemorySummary, relativePath: string): string {
  const directory = summary.autoMemory.directory
  // directory 由主进程 join() 生成，Windows 上使用反斜杠；沿用其分隔符风格，
  // 并把 relativePath 里的正斜杠归一化，避免拼出 C:\...\memory/MEMORY.md 这类混合路径。
  const sep = directory.includes('\\') && !directory.includes('/') ? '\\' : '/'
  const normalizedRelative = relativePath.replace(/[\\/]/g, sep)
  const trimmedDir = directory.replace(/[\\/]+$/, '')
  return `${trimmedDir}${sep}${normalizedRelative}`
}

function filterNodes(nodes: SkillFileNode[], query: string, contentMatchPaths = new Set<string>()): SkillFileNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const result: SkillFileNode[] = []
  for (const node of nodes) {
    const children = node.children ? filterNodes(node.children, query, contentMatchPaths) : undefined
    const selfMatch =
      node.name.toLowerCase().includes(q) ||
      node.relativePath.toLowerCase().includes(q) ||
      contentMatchPaths.has(node.relativePath)
    if (selfMatch || (children && children.length > 0)) {
      result.push({ ...node, children })
    }
  }
  return result
}

export function ProjectMemoryPanel({
  workspaceSlug,
  projectName,
  sessionId,
  search,
  embedded = false,
  fullScreen = false,
  onCloseChangeView,
}: ProjectMemoryPanelProps): React.ReactElement {
  const [memoryNavigationRequest, setMemoryNavigationRequest] = useAtom(memoryFileNavigationAtom)
  const workspaceMemoryChanges = useAtomValue(workspaceMemoryChangesAtom)
  const memoryChanges = workspaceMemoryChanges.get(workspaceSlug) ?? []
  const latestMemoryChange = memoryChanges[0]
  const [activeChangeId, setActiveChangeId] = React.useState<string | null>(null)
  const activeMemoryChange = activeChangeId
    ? memoryChanges.find((change) => `${change.relativePath}:${change.changedAt}` === activeChangeId)
    : undefined
  const [summary, setSummary] = React.useState<WorkspaceMemorySummary | null>(null)
  const [autoFiles, setAutoFiles] = React.useState<SkillFileNode[]>([])
  const [selected, setSelected] = React.useState<SelectedMemoryFile | null>(null)
  const [editText, setEditText] = React.useState('')
  const [editBaseText, setEditBaseText] = React.useState('')
  const [saveConflict, setSaveConflict] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [isDirty, setIsDirty] = React.useState(false)
  const [contentMatches, setContentMatches] = React.useState<Map<string, string>>(new Map())
  // 右侧项目记忆 Tab 不提供搜索；能力中心仍复用其顶部搜索框。
  const effectiveSearch = embedded ? '' : (search ?? '')

  // 自动保存：用 ref 持有最新的编辑状态，供防抖定时器与"切换文件前 flush"复用。
  const saveStateRef = React.useRef<{ selected: SelectedMemoryFile | null; editText: string; editBaseText: string; isDirty: boolean; saveConflict: boolean }>({
    selected: null,
    editText: '',
    editBaseText: '',
    isDirty: false,
    saveConflict: false,
  })
  React.useEffect(() => {
    saveStateRef.current = { selected, editText, editBaseText, isDirty, saveConflict }
  }, [selected, editText, editBaseText, isDirty, saveConflict])
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = React.useRef<Promise<void> | null>(null)

  const refreshSummaryAndTree = React.useCallback(async (): Promise<WorkspaceMemorySummary> => {
    const [nextSummary, files] = await Promise.all([
      window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
      window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
    ])
    setSummary(nextSummary)
    setAutoFiles(files)
    return nextSummary
  }, [workspaceSlug])

  /** 底层写入：先核验磁盘仍是打开时的基线，避免自动保存覆盖外部更新。 */
  const persistTarget = React.useCallback(async (target: SelectedMemoryFile, text: string, baseText: string): Promise<void> => {
    if (target.kind === 'agents') {
      await window.electronAPI.writeWorkspaceAgentsMd(workspaceSlug, text, baseText)
    } else {
      await window.electronAPI.writeWorkspaceAutoMemoryFile(workspaceSlug, target.relativePath, text, baseText)
    }
    const nextSummary = await refreshSummaryAndTree()
    const nextAbsolute = target.kind === 'agents'
      ? nextSummary.agentsMd.path
      : autoMemoryPath(nextSummary, target.relativePath)
    // 仅当用户仍停留在同一文件时才回写 absolutePath，避免覆盖已切换到别处的 selected
    setSelected((prev) => (prev && prev.kind === target.kind && prev.relativePath === target.relativePath
      ? { ...prev, absolutePath: nextAbsolute }
      : prev))
    setEditBaseText(text)
    setSaveConflict(false)
  }, [workspaceSlug, refreshSummaryAndTree])

  /** 把待保存的脏内容立即刷盘（静默，失败才提示）。切换文件、刷新、卸载和 Cmd/Ctrl+S 复用本入口。 */
  const flushPendingSave = React.useCallback(async (): Promise<void> => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }
    if (persistInFlightRef.current) {
      await persistInFlightRef.current.catch(() => {})
    }
    const { selected: curSelected, editText: curText, editBaseText: curBaseText, isDirty: curDirty, saveConflict: curSaveConflict } = saveStateRef.current
    if (!curSelected || !curDirty || curSaveConflict) return
    setIsDirty(false)
    try {
      const p = persistTarget(curSelected, curText, curBaseText)
      persistInFlightRef.current = p
      await p
    } catch (err) {
      console.error('[工作区记忆] 自动保存失败:', err)
      const message = err instanceof Error ? err.message : '自动保存失败'
      toast.error(message)
      if (message.startsWith('文件已被外部更新')) setSaveConflict(true)
      setIsDirty(true)
    } finally {
      persistInFlightRef.current = null
    }
  }, [persistTarget])

  const openAgents = React.useCallback(async (knownSummary?: WorkspaceMemorySummary): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      toast.error('当前文件有外部更新，请先刷新或复制修改后再切换。')
      return
    }
    await flushPendingSave()
    setLoadingFile(true)
    try {
      const currentSummary = knownSummary ?? summary ?? await window.electronAPI.getWorkspaceMemorySummary(workspaceSlug)
      const file = await window.electronAPI.readWorkspaceAgentsMd(workspaceSlug)
      setSelected({ kind: 'agents', relativePath: 'AGENTS.md', title: AGENTS_TITLE, absolutePath: currentSummary.agentsMd.path })
      setEditText(file.content ?? '')
      setEditBaseText(file.content ?? '')
      setSaveConflict(false)
      setIsDirty(false)
    } catch (err) {
      console.error('[工作区记忆] 读取 AGENTS.md 失败:', err)
      toast.error(err instanceof Error ? err.message : '读取 AGENTS.md 失败')
    } finally {
      setLoadingFile(false)
    }
  }, [summary, workspaceSlug, flushPendingSave])

  const openAutoFile = React.useCallback(async (relativePath: string, knownSummary?: WorkspaceMemorySummary): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      toast.error('当前文件有外部更新，请先刷新或复制修改后再切换。')
      return
    }
    await flushPendingSave()
    setLoadingFile(true)
    try {
      const currentSummary = knownSummary ?? summary ?? await window.electronAPI.getWorkspaceMemorySummary(workspaceSlug)
      const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, relativePath)
      setSelected({
        kind: 'auto',
        relativePath: file.relativePath,
        title: file.relativePath,
        absolutePath: autoMemoryPath(currentSummary, file.relativePath),
      })
      setEditText(file.content ?? '')
      setEditBaseText(file.content ?? '')
      setSaveConflict(false)
      setIsDirty(false)
    } catch (err) {
      console.error('[工作区记忆] 读取长期记忆文件失败:', err)
      toast.error(err instanceof Error ? err.message : '读取长期记忆文件失败')
    } finally {
      setLoadingFile(false)
    }
  }, [summary, workspaceSlug, flushPendingSave])

  React.useEffect(() => {
    if (!memoryNavigationRequest || memoryNavigationRequest.workspaceSlug !== workspaceSlug) return
    if (memoryNavigationRequest.mode === 'change') {
      const change = memoryChanges.find((item) => item.relativePath === memoryNavigationRequest.relativePath)
      if (change && sessionId) setActiveChangeId(`${change.relativePath}:${change.changedAt}`)
      setMemoryNavigationRequest(null)
      return
    }
    void (async () => {
      await openAutoFile(memoryNavigationRequest.relativePath)
      setMemoryNavigationRequest(null)
    })()
  }, [memoryChanges, memoryNavigationRequest, openAutoFile, sessionId, setMemoryNavigationRequest, workspaceSlug])

  React.useEffect(() => {
    if (!embedded || !activeChangeId || activeMemoryChange) return
    // Diff 对应的临时变更已经被消费或被新变更替换时，不能落回完整记忆列表。
    onCloseChangeView?.()
  }, [activeChangeId, activeMemoryChange, embedded, onCloseChangeView])

  React.useEffect(() => {
    if (!latestMemoryChange) return
    void refreshSummaryAndTree().catch((error) => console.error('[工作区记忆] 刷新全局变更失败:', error))
  }, [latestMemoryChange?.changedAt, refreshSummaryAndTree])

  const refresh = React.useCallback(async (): Promise<void> => {
    if (saveStateRef.current.saveConflict) {
      saveStateRef.current = { ...saveStateRef.current, saveConflict: false, isDirty: false }
      setSaveConflict(false)
      setIsDirty(false)
    } else {
      await flushPendingSave()
    }
    setLoading(true)
    try {
      const nextSummary = await refreshSummaryAndTree()
      if (selected?.kind === 'auto') {
        await openAutoFile(selected.relativePath, nextSummary)
      } else {
        await openAgents(nextSummary)
      }
    } catch (err) {
      console.error('[工作区记忆] 刷新失败:', err)
      toast.error('刷新协作知识失败')
    } finally {
      setLoading(false)
    }
  }, [openAutoFile, openAgents, refreshSummaryAndTree, selected, flushPendingSave])

  React.useEffect(() => {
    let cancelled = false
    setSelected(null)
    setEditText('')
    setEditBaseText('')
    setSaveConflict(false)
    setIsDirty(false)
    setExpanded(new Set())
    setLoading(true)
    void (async () => {
      try {
        const [nextSummary, files, agentsFile] = await Promise.all([
          window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
          window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
          window.electronAPI.readWorkspaceAgentsMd(workspaceSlug),
        ])
        if (cancelled) return
        setSummary(nextSummary)
        setAutoFiles(files)
        setSelected({ kind: 'agents', relativePath: 'AGENTS.md', title: AGENTS_TITLE, absolutePath: nextSummary.agentsMd.path })
        setEditText(agentsFile.content ?? '')
        setEditBaseText(agentsFile.content ?? '')
        setSaveConflict(false)
        setIsDirty(false)
      } catch (err) {
        console.error('[工作区记忆] 加载失败:', err)
        toast.error('加载协作知识失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceSlug])

  // 窗口重新聚焦或 Agent 一轮结束时静默刷新文件树；AGENTS.md 未编辑时同步外部改动（商业版 jtn 同款）。
  React.useEffect(() => {
    let cancelled = false
    let running = false
    const silentRefresh = async (): Promise<void> => {
      if (running) return
      running = true
      const before = saveStateRef.current
      try {
        const [nextSummary, files, agentsFile] = await Promise.all([
          window.electronAPI.getWorkspaceMemorySummary(workspaceSlug),
          window.electronAPI.listWorkspaceAutoMemoryFiles(workspaceSlug),
          before.selected?.kind === 'agents' ? window.electronAPI.readWorkspaceAgentsMd(workspaceSlug) : Promise.resolve(null),
        ])
        if (cancelled) return
        setSummary(nextSummary)
        setAutoFiles(files)
        const now = saveStateRef.current
        if (
          agentsFile &&
          !before.isDirty &&
          !now.isDirty &&
          !now.saveConflict &&
          now.selected === before.selected &&
          now.editText === before.editText
        ) {
          setEditText(agentsFile.content ?? '')
          setEditBaseText(agentsFile.content ?? '')
        }
      } catch (err) {
        if (!cancelled) console.warn('[工作区记忆] 自动刷新失败:', err)
      } finally {
        running = false
      }
    }
    const onRefresh = (): void => { void silentRefresh() }
    window.addEventListener('focus', onRefresh)
    const unsubscribe = window.electronAPI.onAgentStreamComplete(onRefresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onRefresh)
      unsubscribe()
    }
  }, [workspaceSlug])

  // 防抖自动保存：编辑内容变脏后 800ms 内无新输入则自动保存。
  React.useEffect(() => {
    if (!selected || !isDirty || loadingFile) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      void flushPendingSave()
    }, 800)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [editText, selected, isDirty, loadingFile, flushPendingSave])

  // 组件卸载（如切走 Tab）时，把未保存内容刷盘，防止编辑丢失
  React.useEffect(() => {
    return () => {
      void flushPendingSave()
    }
  }, [flushPendingSave])

  // 文件名之外也可按正文内容检索：180ms 防抖、忽略大文件并限制候选数。
  React.useEffect(() => {
    const query = effectiveSearch.trim().toLowerCase()
    if (!query) {
      setContentMatches(new Map())
      return
    }
    const candidates: SkillFileNode[] = []
    const collect = (nodes: SkillFileNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'directory') collect(node.children ?? [])
        else if (node.isText !== false && (node.size ?? 0) <= 512 * 1024) candidates.push(node)
      }
    }
    collect(autoFiles)
    let cancelled = false
    const timer = window.setTimeout(() => {
      void Promise.all(candidates.slice(0, 60).map(async (node) => {
        try {
          const file = await window.electronAPI.readWorkspaceAutoMemoryFile(workspaceSlug, node.relativePath)
          const line = (file.content ?? '').split(/\r?\n/).find((item) => item.toLowerCase().includes(query))
          return line ? [node.relativePath, line.trim().slice(0, 160)] as const : null
        } catch {
          return null
        }
      })).then((results) => {
        if (cancelled) return
        setContentMatches(new Map(results.filter((result): result is readonly [string, string] => result !== null)))
      })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [autoFiles, effectiveSearch, workspaceSlug])

  const visibleAutoFiles = React.useMemo(
    () => filterNodes(autoFiles, effectiveSearch, new Set(contentMatches.keys())),
    [autoFiles, contentMatches, effectiveSearch],
  )
  const migrationIssues = [
    summary?.legacyAutoMemory ? '长期记忆迁移' : null,
    summary?.instructionConflict ? '工作区规则迁移' : null,
  ].filter((issue): issue is string => issue !== null)
  const migrationReminderTitle = [
    summary?.legacyAutoMemory ? `长期记忆：${summary.legacyAutoMemory.directory}` : null,
    summary?.instructionConflict ? `工作区规则：${summary.instructionConflict.legacyPath}` : null,
  ].filter((detail): detail is string => detail !== null).join('\n')

  if (activeMemoryChange && sessionId) {
    return (
      <WorkspaceMemoryChangeShelf
        changes={memoryChanges}
        onOpenFile={(change) => {
          setActiveChangeId(null)
          const label = change.relativePath
          if (label.startsWith('项目记忆/')) {
            void openAutoFile(label.slice('项目记忆/'.length))
            return
          }
          if (label.startsWith('项目规则/')) {
            void openAgents()
            return
          }
          if (change.absolutePath) window.electronAPI.showItemInFolder(change.absolutePath)
        }}
        onDismissChanges={embedded ? onCloseChangeView : undefined}
        className="h-full min-h-0 overflow-auto bg-content-area p-3"
      />
    )
  }

  if (loading || !summary) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载协作知识中...</div>
  }

  const instructionMigration = summary.instructionMigration

  return (
    <div className={cn('flex flex-col gap-5', (embedded || fullScreen) && 'h-full min-h-0', embedded && 'gap-3', fullScreen && 'memory-project-fullscreen gap-5')}>
      {fullScreen && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-semibold tracking-tight">{projectName ?? '当前项目'}</h2>
            <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
              项目规则、协作知识与专属偏好 · {summary.autoMemory.fileCount} 个记忆文件
            </p>
          </div>
          <Button variant="outline" className="h-11 gap-2 rounded-lg px-5 text-[15px]" onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      )}
      {embedded && (
        <div className="flex shrink-0 items-center gap-2 rounded-xl bg-muted/45 px-3 py-2">
          <LibraryBig className="size-4 shrink-0 text-foreground/65" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">项目记忆</div>
            <div className="text-[11px] text-muted-foreground">{summary.autoMemory.fileCount} 个记忆文件</div>
          </div>
        </div>
      )}
      {embedded && <AgentActionHint action="查找、补充或整理项目记忆" />}

      <div
        className={cn(
          'grid min-h-[520px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]',
          embedded && 'min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)] gap-3',
          fullScreen && 'min-h-0 flex-1 grid-rows-[240px_minmax(320px,1fr)] overflow-y-auto md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]',
        )}
      >
        <SettingsCard divided={false} className={cn('min-h-0 overflow-hidden', fullScreen && 'border border-border/60')}>
          <div className="flex h-full min-h-0 flex-col">
            <div className={cn('flex shrink-0 items-center justify-between border-b border-border/50 px-3 py-2', fullScreen && 'min-h-20 px-5 py-4')}>
              <div className={cn('text-[13px] font-medium text-foreground/75', fullScreen && 'text-base font-semibold text-foreground')}>记忆文件</div>
              <button
                type="button"
                title="刷新"
                aria-label="刷新记忆文件"
                onClick={() => void refresh()}
                className={cn('rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', fullScreen && 'hidden')}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {migrationIssues.length > 0 && (
              <div
                role="status"
                title={migrationReminderTitle}
                className="mx-2 mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300"
              >
                <TriangleAlert size={13} className="shrink-0" />
                <span>待处理：{migrationIssues.join('、')}，请检查旧文件。</span>
              </div>
            )}
            {instructionMigration && (
              <div role="status" className="mx-2 mt-2 space-y-2 rounded-md bg-amber-500/10 px-2 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                <div className="flex gap-1.5">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  <span>{instructionMigration.message}</span>
                </div>
                {instructionMigration.sourcePaths.map((sourcePath, index) => (
                  <button
                    key={sourcePath}
                    type="button"
                    title={sourcePath}
                    className="block text-left underline underline-offset-2 hover:text-foreground"
                    onClick={() => void window.electronAPI.showItemInFolder(sourcePath)}
                  >
                    定位旧规则{instructionMigration.sourcePaths.length > 1 ? ` ${index + 1}` : ''}
                  </button>
                ))}
              </div>
            )}
            <div className={cn('min-h-0 flex-1 overflow-y-auto p-2', fullScreen && 'p-3')}>
              <MemoryFileButton
                active={selected?.kind === 'agents'}
                icon={<FileText size={14} />}
                label={AGENTS_TITLE}
                meta={summary.agentsMd.exists ? '项目规则 · 与 Agent 使用同一文件' : '待建立 · 项目根目录'}
                onClick={() => void openAgents(summary)}
                onReveal={() => window.electronAPI.showItemInFolder(summary.agentsMd.path)}
              />
              <div className={cn('mt-3 px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70', fullScreen && 'mt-5 pb-2 text-sm text-muted-foreground')}>
                长期记忆
              </div>
              <div className="space-y-0.5">
                {visibleAutoFiles.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {effectiveSearch.trim() ? '没有匹配的记忆文件' : '暂无协作记忆，后续按任务证据逐步建立。'}
                  </div>
                ) : (
                  visibleAutoFiles.map((node) => (
                    <MemoryTreeNode
                      key={node.relativePath}
                      node={node}
                      level={0}
                      selectedPath={selected?.kind === 'auto' ? selected.relativePath : null}
                      expanded={expanded}
                      contentMatches={contentMatches}
                      onToggle={(path) => {
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(path)) next.delete(path)
                          else next.add(path)
                          return next
                        })
                      }}
                      onOpen={(path) => void openAutoFile(path, summary)}
                      onReveal={(path) => window.electronAPI.showItemInFolder(autoMemoryPath(summary, path))}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard divided={false} className={cn('min-h-0 overflow-hidden', fullScreen && 'border border-border/60')}>
          <div className="flex h-full min-h-0 flex-col">
            <div className={cn('flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-3', fullScreen && 'min-h-20 px-6 py-4')}>
              <div className="min-w-0">
                <div className={cn('truncate text-sm font-medium text-foreground', fullScreen && 'text-lg font-semibold')}>
                  {selected?.title ?? '未选择文件'}
                </div>
                <div className={cn('mt-0.5 truncate font-mono text-[11px] text-muted-foreground', fullScreen && 'mt-1 text-[13px]')}>
                  {selected?.absolutePath ?? '从左侧选择一个记忆文件'}
                </div>
              </div>
              {fullScreen && (
                <span role="status" className="shrink-0 text-sm text-muted-foreground">
                  {saveConflict ? '需要合并修改' : isDirty ? '等待保存' : '自动保存'}
                </span>
              )}
            </div>
            {saveConflict && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span>文件已被外部更新，已停止保存以避免覆盖。请复制你的修改后刷新文件。</span>
                <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => void refresh()}>刷新文件</Button>
              </div>
            )}
            {loadingFile ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">读取文件中...</div>
            ) : selected ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <LiveMarkdownEditor
                  value={editText}
                  onChange={(value) => {
                    setIsDirty(true)
                    setEditText(value)
                  }}
                  onSave={() => { void flushPendingSave() }}
                  readOnly={saveConflict}
                  className={cn('live-markdown-external-scroll', fullScreen && 'memory-page-editor')}
                />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">从左侧选择一个记忆文件</div>
            )}
          </div>
        </SettingsCard>
      </div>
    </div>
  )
}

/**
 * 能力中心沿用的记忆 Tab：关于你（全局画像）/ 当前项目（项目规则与项目记忆）。
 * 嵌入右侧工作区时只显示当前项目，避免在会话里误改跨项目画像。
 */
export function WorkspaceMemoryTab(props: WorkspaceMemoryTabProps): React.ReactElement {
  const [tab, setTab] = React.useState<'global' | 'project'>('global')

  if (props.embedded) return <ProjectMemoryPanel {...props} />

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as 'global' | 'project')}
      className="flex h-full min-h-0 w-full flex-col gap-5"
    >
      <TabsList className="h-12 shrink-0 self-start rounded-xl p-1">
        <TabsTrigger value="global" className="h-10 min-w-32 rounded-lg px-7 text-base">关于你</TabsTrigger>
        <TabsTrigger value="project" className="h-10 min-w-32 rounded-lg px-7 text-base">当前项目</TabsTrigger>
      </TabsList>
      <TabsContent value="global" forceMount className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        <GlobalProfilePanel workspaceSlug={props.workspaceSlug} />
      </TabsContent>
      <TabsContent value="project" className="m-0 min-h-0 flex-1 overflow-hidden">
        <ProjectMemoryPanel {...props} />
      </TabsContent>
    </Tabs>
  )
}

/** 商业版 Ptn：AGENTS.md 行，名称与说明上下排列。 */
function MemoryFileButton({
  active,
  icon,
  label,
  meta,
  onClick,
  onReveal,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  meta?: string
  onClick: () => void
  onReveal: () => void
}): React.ReactElement {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'memory-file-row flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {meta && <span className="memory-file-meta block text-[11px] text-muted-foreground">{meta}</span>}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onReveal}
            className="memory-file-reveal flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`打开 ${label} 所在位置`}
          >
            <FolderOpen size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">打开文件所在位置</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** 商业版 U9e：长期记忆文件树节点。 */
function MemoryTreeNode({
  node,
  level,
  selectedPath,
  expanded,
  contentMatches,
  onToggle,
  onOpen,
  onReveal,
}: {
  node: SkillFileNode
  level: number
  selectedPath: string | null
  expanded: Set<string>
  contentMatches: Map<string, string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onReveal: (path: string) => void
}): React.ReactElement {
  const isDirectory = node.type === 'directory'
  const isExpanded = expanded.has(node.relativePath)
  const isActive = selectedPath === node.relativePath
  const contentExcerpt = contentMatches.get(node.relativePath)
  const paddingLeft = 8 + level * 14

  return (
    <div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => isDirectory ? onToggle(node.relativePath) : onOpen(node.relativePath)}
          title={node.relativePath}
          className={cn(
            'memory-file-row flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors',
            isActive ? 'bg-accent text-accent-foreground' : 'text-foreground/80 hover:bg-accent/60',
          )}
          style={{ paddingLeft }}
        >
          {isDirectory ? (
            isExpanded ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
          ) : (
            <FileText size={13} className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate">{node.name}</span>
            {contentExcerpt && <span className="block truncate text-[10px] text-muted-foreground" title={contentExcerpt}>{contentExcerpt}</span>}
          </span>
          {!isDirectory && node.size != null && (
            <span className="memory-file-meta shrink-0 text-[10px] text-muted-foreground/75">{formatBytes(node.size)}</span>
          )}
        </button>
        {!isDirectory && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onReveal(node.relativePath)}
                className="memory-file-reveal flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`打开 ${node.name} 所在位置`}
              >
                <FolderOpen size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">打开文件所在位置</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isDirectory && isExpanded && node.children && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <MemoryTreeNode
              key={child.relativePath}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              contentMatches={contentMatches}
              onToggle={onToggle}
              onOpen={onOpen}
              onReveal={onReveal}
            />
          ))}
        </div>
      )}
    </div>
  )
}
