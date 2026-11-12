/**
 * ContinuousChangesView — 「改动」Tab 的连续 diff 视图
 *
 * 与旧的「文件列表 → 点开单个文件」不同，这里把所有改动文件的 diff 在同一个滚动区里连续排列：
 * 未改动的行段折叠成「N 行未更改」，点击后才读取完整内容就地展开。
 * 宽屏时文件树固定在左侧，窄屏时改为浮层；点击文件头可在右侧工作区标签中打开预览。
 */

import * as React from 'react'
import { toast } from 'sonner'
import {
  Columns2,
  ChevronsUpDown,
  Loader2,
  PanelLeft,
  RefreshCw,
  Rows3,
  Search,
  WrapText,
  X,
} from 'lucide-react'
import type { WorktreeInfo } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionFileChange } from '@/lib/session-file-changes'
import { useAtomValue } from 'jotai'
import { workspaceGitDiffRefreshVersionAtom } from '@/atoms/agent-atoms'
import { ChangesFileTree } from './ChangesFileTree'
import { ContinuousDiffFile, type ExpandedFileText } from './ContinuousDiffFile'
import {
  computeDefaultExpandedPaths,
  LARGE_FILE_LINE_THRESHOLD,
  type ChangesFile,
} from './continuous-diff-rows'
import { useChangesSnapshot } from './use-changes-snapshot'
import { useChangesWorktree } from './use-changes-worktree'
import { NonGitChangesSection } from './NonGitChangesSection'
import { WorktreeSelector } from './WorktreeSelector'
import '@/styles/changes-diff-view.css'

/** 宽度达到该值后文件树固定在左侧，否则改为浮层 */
const FIXED_VIEW_WIDTH = 720

export interface ContinuousChangesViewProps {
  sessionId: string
  /** 会话目录或项目根目录 */
  dirPath: string
  sessionPath?: string
  workspaceFilesPath?: string
  extraPaths?: string[]
  /** 自动刷新信号 */
  refreshVersion?: number
  /** 工作区 slug，用于 WorktreeSelector 拉取 worktree 列表 */
  workspaceSlug?: string
  /** 用于自动发现 worktree 的仓库候选路径 */
  worktreeRepoPaths?: string[]
  /** 在指定 Worktree 根目录打开右侧终端 */
  onOpenWorktreeTerminal?: (worktree: WorktreeInfo) => void
  /** 在右侧工作区中以 Git 目录为 cwd 打开终端 */
  onOpenDirectoryTerminal?: (directoryPath: string, directoryName: string) => void
  /** 本会话在非 Git 目录中成功写入的文件 */
  nonGitChanges?: SessionFileChange[]
  /** 当前 Agent run ID，用于把非 Git 文件变更按轮次排序 */
  currentFileChangeRunId?: string
  /** 外部定位请求：文件绝对路径 */
  focusPath?: string
  /** 定位完成（或定位失败）后清除请求 */
  onFocused?: () => void
  /** 定位目标不在改动列表中：改为打开该文件的预览 */
  onFocusMissing?: (filePath: string) => void
  /** 在右侧工作区标签中打开文件预览 */
  onOpenFile: (filePath: string, gitRoot?: string) => void
  /** 打开非 Git 文件的纯文件预览 */
  onOpenNonGitFile?: (filePath: string) => void
}

export function ContinuousChangesView({
  sessionId,
  dirPath,
  sessionPath,
  workspaceFilesPath,
  extraPaths,
  refreshVersion,
  workspaceSlug,
  worktreeRepoPaths,
  onOpenWorktreeTerminal,
  onOpenDirectoryTerminal,
  nonGitChanges,
  currentFileChangeRunId,
  focusPath,
  onFocused,
  onFocusMissing,
  onOpenFile,
  onOpenNonGitFile,
}: ContinuousChangesViewProps): React.ReactElement {
  const { selectedPath: selectedWorktreePath, worktree, onSelect: onSelectWorktree } = useChangesWorktree(sessionId)
  // 窗口重新聚焦等全局信号也要触发重读，否则页签长时间打开会显示旧改动。
  const workspaceRefreshVersion = useAtomValue(workspaceGitDiffRefreshVersionAtom)
  const { snapshot, ready, reading, failed, refresh, readFileLines } = useChangesSnapshot({
    sessionId,
    dirPath,
    sessionPath,
    workspaceFilesPath,
    extraPaths,
    worktree,
    nonGitChanges,
    refreshVersion: (refreshVersion ?? 0) + workspaceRefreshVersion,
  })

  /** 并排视图：默认统一视图 */
  const [split, setSplit] = React.useState(false)
  /** 自动换行：默认开启 */
  const [wrap, setWrap] = React.useState(true)
  /** 文件树浮层开关（仅窄屏生效） */
  const [treeOverlayOpen, setTreeOverlayOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [collapsedDirs, setCollapsedDirs] = React.useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null)
  /** 用户手动展开的大文件 */
  const [revealedFiles, setRevealedFiles] = React.useState<Set<string>>(new Set())
  /** 用户手动切换过的展开状态；未出现的文件走默认策略 */
  const [chosenExpanded, setChosenExpanded] = React.useState<Map<string, boolean>>(new Map())
  const [openGaps, setOpenGaps] = React.useState<Map<string, Set<number>>>(new Map())
  const [expandedTexts, setExpandedTexts] = React.useState<Map<string, ExpandedFileText>>(new Map())
  const [viewportWidth, setViewportWidth] = React.useState(0)

  const containerRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const fileSectionRefs = React.useRef<Map<string, HTMLElement>>(new Map())

  const query = searchQuery.trim().toLowerCase()
  const filteredRepos = React.useMemo(
    () => snapshot.repos.map((repo) => ({
      ...repo,
      files: query ? repo.files.filter((file) => file.path.toLowerCase().includes(query)) : repo.files,
    })),
    [snapshot.repos, query],
  )
  const visibleFiles = React.useMemo(() => filteredRepos.flatMap((repo) => repo.files), [filteredRepos])
  const defaultExpanded = React.useMemo(() => computeDefaultExpandedPaths(visibleFiles), [visibleFiles])
  /** 文件集合签名：集合变化时重置展开与 gap 状态 */
  const filesSignature = visibleFiles.map((file) => file.path).join('|')

  React.useEffect(() => {
    setChosenExpanded(new Map())
    setOpenGaps(new Map())
    setExpandedTexts(new Map())
    setRevealedFiles(new Set())
  }, [filesSignature, worktree?.path])

  // 文件树在宽屏固定、窄屏浮层，靠容器实际宽度判断。
  React.useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth))
    observer.observe(element)
    setViewportWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const fixedTree = viewportWidth >= FIXED_VIEW_WIDTH
  const treeVisible = fixedTree || treeOverlayOpen

  const scrollToFile = React.useCallback((filePath: string) => {
    setSelectedFile(filePath)
    const section = fileSectionRefs.current.get(filePath)
    if (section !== undefined) section.scrollIntoView({ block: 'start' })
  }, [])

  // 外部（轮次改动卡等）要求定位某个文件：滚动过去并清除请求；找不到时交给调用方打开预览。
  React.useEffect(() => {
    if (!focusPath || !ready) return
    const normalized = focusPath.replace(/\\/g, '/')
    const target = visibleFiles.find((file) => file.path === normalized || normalized.endsWith(`/${file.path}`))
    if (!target) {
      onFocusMissing?.(focusPath)
      onFocused?.()
      return
    }
    scrollToFile(target.path)
    onFocused?.()
  }, [focusPath, ready, onFocusMissing, onFocused, scrollToFile, visibleFiles])

  const isExpanded = React.useCallback((filePath: string): boolean => {
    const chosen = chosenExpanded.get(filePath)
    if (chosen !== undefined) return chosen
    return defaultExpanded.has(filePath) || revealedFiles.has(filePath)
  }, [chosenExpanded, defaultExpanded, revealedFiles])

  const toggleExpanded = React.useCallback((filePath: string) => {
    setChosenExpanded((prev) => {
      const next = new Map(prev)
      const current = prev.get(filePath) ?? (defaultExpanded.has(filePath) || revealedFiles.has(filePath))
      next.set(filePath, !current)
      return next
    })
  }, [defaultExpanded, revealedFiles])

  /** 展开一段未改动行：先标记 gap，再按需读取完整文件内容 */
  const expandGap = React.useCallback((file: ChangesFile, gapIndex: number) => {
    setOpenGaps((prev) => {
      const next = new Map(prev)
      next.set(file.path, new Set([...(prev.get(file.path) ?? []), gapIndex]))
      return next
    })
    if (expandedTexts.has(file.path)) return
    setExpandedTexts((prev) => {
      const next = new Map(prev)
      next.set(file.path, 'loading')
      return next
    })
    void readFileLines(file).then((lines) => {
      setExpandedTexts((prev) => {
        const next = new Map(prev)
        if (lines === null) next.delete(file.path)
        else next.set(file.path, lines)
        return next
      })
      // 上下文行与 patch 对不上（文件又被改过）时收回刚展开的 gap，避免展示错位内容。
      if (lines === null) {
        setOpenGaps((prev) => {
          const current = prev.get(file.path)
          if (!current) return prev
          const next = new Map(prev)
          const remaining = new Set(current)
          remaining.delete(gapIndex)
          next.set(file.path, remaining)
          return next
        })
      }
    })
  }, [expandedTexts, readFileLines])

  /** 当前滚动位置对应的文件序号，用于 ArrowLeft / ArrowRight 跳文件 */
  const getCurrentFileIndex = React.useCallback((): number => {
    const scrollElement = scrollRef.current
    if (scrollElement === null) return 0
    const top = scrollElement.getBoundingClientRect().top
    let index = 0
    for (const [fileIndex, file] of visibleFiles.entries()) {
      const section = fileSectionRefs.current.get(file.path)
      if (section !== undefined && section.getBoundingClientRect().top <= top + 2) index = fileIndex
    }
    return index
  }, [visibleFiles])

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented
      || event.nativeEvent.isComposing
      || event.altKey
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    ) return
    // 输入框、可编辑区域和文本选区内的方向键仍然是原生行为。
    const target = event.target
    if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null) return
    const selection = window.getSelection()
    if (selection !== null && !selection.isCollapsed) return

    const nextFile = visibleFiles[getCurrentFileIndex() + (event.key === 'ArrowRight' ? 1 : -1)]
    if (nextFile === undefined) return
    event.preventDefault()
    event.stopPropagation()
    scrollRef.current?.focus({ preventScroll: true })
    scrollToFile(nextFile.path)
  }, [getCurrentFileIndex, scrollToFile, visibleFiles])

  const totals = React.useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of visibleFiles) {
      additions += file.additions
      deletions += file.deletions
    }
    return { files: visibleFiles.length, additions, deletions }
  }, [visibleFiles])

  const allExpanded = visibleFiles.length > 0 && visibleFiles.every((file) => isExpanded(file.path))
  const truncated = snapshot.repos.some((repo) => repo.truncated)
  const anyFailed = snapshot.repos.some((repo) => repo.failed)

  const toggleAll = React.useCallback(() => {
    setRevealedFiles(new Set())
    setChosenExpanded(() => {
      const next = new Map<string, boolean>()
      for (const file of visibleFiles) next.set(file.path, !allExpanded)
      return next
    })
  }, [allExpanded, visibleFiles])

  const toggleDirectory = React.useCallback((key: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const showDirectoryInFolder = React.useCallback((directoryPath: string) => {
    void window.electronAPI.showInFolder(directoryPath, { sessionId, unrestricted: true }).catch((error) => {
      console.error('[changes] 在文件夹中显示目录失败:', error)
      toast.error('无法在文件夹中显示该目录')
    })
  }, [sessionId])

  const handleRevert = React.useCallback((file: ChangesFile, gitRoot: string | undefined) => {
    if (!window.confirm(`确定要还原 ${file.path} 的所有变更吗？此操作不可撤销。`)) return
    void window.electronAPI
      .revertFile({ dirPath, filePath: file.path, gitRoot, sessionId })
      .then(refresh)
      .catch((error: unknown) => {
        toast.error(`还原失败：${error instanceof Error ? error.message : '未知错误'}`)
      })
  }, [dirPath, refresh, sessionId])

  // 首次数据未就绪时按乐观判断显示，避免选择器读取中出现/消失造成跳动。
  const shouldShowWorktreeSelector = (!ready || snapshot.isGit)
    && Boolean(workspaceSlug || (worktreeRepoPaths?.length ?? 0) > 0)

  const renderBody = (): React.ReactElement => {
    if (!ready) {
      return (
        <div className="cdv-empty">
          <Loader2 className="size-4 animate-spin" aria-label="正在读取改动" />
        </div>
      )
    }
    if (visibleFiles.length === 0 && snapshot.nonGit.length === 0) {
      return (
        <div className="cdv-empty">
          {query ? '没有匹配的文件改动' : snapshot.isGit ? '没有文件改动' : '当前目录不是 Git 仓库，或暂无文件改动'}
        </div>
      )
    }
    return (
      <>
        {filteredRepos.map((repo) => repo.files.length === 0 ? null : (
          <div key={repo.gitRoot}>
            {filteredRepos.length > 1 && <div className="cdv-notice">{repo.name}</div>}
            {repo.files.map((file) => (
              <ContinuousDiffFile
                key={file.path}
                file={file}
                text={expandedTexts.get(file.path)}
                openGaps={openGaps.get(file.path) ?? EMPTY_GAPS}
                onExpandGap={(gapIndex) => expandGap(file, gapIndex)}
                expanded={isExpanded(file.path)}
                onToggle={() => toggleExpanded(file.path)}
                large={file.metadata.unifiedLineCount > LARGE_FILE_LINE_THRESHOLD}
                revealed={revealedFiles.has(file.path)}
                onReveal={() => {
                  setRevealedFiles((prev) => new Set([...prev, file.path]))
                  setChosenExpanded((prev) => {
                    const next = new Map(prev)
                    next.set(file.path, true)
                    return next
                  })
                }}
                split={split}
                wrap={wrap}
                sectionRef={(element) => {
                  if (element === null) fileSectionRefs.current.delete(file.path)
                  else fileSectionRefs.current.set(file.path, element)
                }}
                onOpenFile={() => onOpenFile(file.path, repo.gitRoot)}
                onRevert={file.status === 'new' ? undefined : () => handleRevert(file, repo.gitRoot)}
              />
            ))}
          </div>
        ))}
        {snapshot.nonGit.length > 0 && (
          <NonGitChangesSection
            changes={snapshot.nonGit}
            sessionId={sessionId}
            currentRunId={currentFileChangeRunId}
            onOpenFile={onOpenNonGitFile}
          />
        )}
      </>
    )
  }

  return (
    <div ref={containerRef} className="cdv-root">
      {shouldShowWorktreeSelector && (
        <WorktreeSelector
          sessionId={sessionId}
          workspaceSlug={workspaceSlug}
          repoPaths={worktreeRepoPaths}
          selectedPath={selectedWorktreePath}
          onSelect={onSelectWorktree}
          onOpenTerminal={onOpenWorktreeTerminal}
        />
      )}

      <div className="cdv-toolbar">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cdv-tool"
              aria-pressed={treeVisible}
              aria-label={fixedTree ? '文件列表已固定在左侧' : treeOverlayOpen ? '隐藏文件列表' : '显示文件列表'}
              disabled={fixedTree}
              onClick={() => setTreeOverlayOpen((open) => !open)}
            >
              <PanelLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{fixedTree ? '文件列表已固定在左侧' : treeVisible ? '隐藏文件列表' : '显示文件列表'}</TooltipContent>
        </Tooltip>
        <span className="ml-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="tabular-nums">{totals.files} 个文件</span>
          <span className="tabular-nums text-emerald-600 dark:text-emerald-400">+{totals.additions}</span>
          <span className="tabular-nums text-red-600 dark:text-red-400">−{totals.deletions}</span>
        </span>
        <span className="cdv-toolbar-spacer" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cdv-tool"
              aria-pressed={allExpanded}
              aria-label={allExpanded ? '全部收起' : '全部展开'}
              disabled={visibleFiles.length === 0}
              onClick={toggleAll}
            >
              <ChevronsUpDown className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{allExpanded ? '全部收起' : '全部展开'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cdv-tool"
              aria-pressed={split}
              aria-label="切换并排/统一视图"
              onClick={() => setSplit((value) => !value)}
            >
              {split ? <Rows3 className="size-3.5" /> : <Columns2 className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{split ? '切换为统一视图' : '切换为并排视图'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cdv-tool"
              aria-pressed={wrap}
              aria-label="切换自动换行"
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{wrap ? '关闭自动换行' : '自动换行'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="cdv-tool" aria-label="刷新改动" onClick={refresh}>
              <RefreshCw className={cn('size-3.5', (reading || !ready) && 'animate-spin')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">刷新改动</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-shrink-0 bg-content-area px-2 pb-1">
        <div className="flex h-8 items-center gap-1.5 rounded-md border border-transparent bg-muted/50 px-2 transition-colors focus-within:border-primary/40 focus-within:bg-muted/70">
          <Search className="size-4 flex-shrink-0 text-muted-foreground" />
          <input
            type="text"
            aria-label="搜索改动文件"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
            placeholder="搜索改动文件..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && (
            <>
              <span className="flex-shrink-0 text-[12px] tabular-nums text-muted-foreground/50">{visibleFiles.length}</span>
              <button
                type="button"
                aria-label="清除搜索"
                className="flex-shrink-0 rounded-sm p-0.5 text-muted-foreground/50 transition-colors hover:bg-foreground/[0.08] hover:text-muted-foreground"
                onClick={() => setSearchQuery('')}
              >
                <X className="size-3" />
              </button>
            </>
          )}
        </div>
      </div>

      {truncated && (
        <div className="cdv-notice">改动过大，仅展示前面一部分文件；完整内容请用文件列表逐个查看。</div>
      )}
      {(failed || anyFailed) && (
        <div className="cdv-notice">部分改动读取失败，可点刷新重试。</div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {treeVisible && (
          <aside
            className={cn(
              'flex min-h-0 flex-col border-r border-border/60',
              fixedTree
                ? 'w-[272px] shrink-0'
                : 'absolute inset-y-0 left-0 z-20 w-[280px] bg-content-area shadow-lg',
            )}
          >
            <ChangesFileTree
              repos={filteredRepos}
              selectedPath={selectedFile}
              collapsedDirs={collapsedDirs}
              onToggleDirectory={toggleDirectory}
              onSelect={(filePath) => {
                scrollToFile(filePath)
                if (!fixedTree) setTreeOverlayOpen(false)
              }}
              searchQuery={searchQuery}
              onOpenDirectoryTerminal={onOpenDirectoryTerminal}
              onShowDirectoryInFolder={showDirectoryInFolder}
            />
          </aside>
        )}
        <div
          ref={scrollRef}
          className="cdv-scroll scrollbar-thin"
          role="region"
          aria-label={`连续查看 ${visibleFiles.length} 个改动文件`}
          aria-keyshortcuts="ArrowLeft ArrowRight"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          {renderBody()}
        </div>
      </div>
    </div>
  )
}

/** 稳定引用，避免每次渲染新建空集合触发子组件重算 */
const EMPTY_GAPS: ReadonlySet<number> = new Set()