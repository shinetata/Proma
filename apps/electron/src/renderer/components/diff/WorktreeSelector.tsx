import * as React from 'react'
import { Check, ChevronDown, GitBranch, Loader2, RotateCw, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorktreeInfo, WorkspaceWorktreeRepo } from '@proma/shared'
import { normalizePathForCompare } from '@proma/shared'

interface WorktreeSelectorProps {
  sessionId: string
  workspaceSlug?: string
  repoPaths?: string[]
  selectedPath: string | null
  onSelect: (worktree: WorktreeInfo | null) => void
  onOpenTerminal?: (worktree: WorktreeInfo) => void
}

interface RepoWorktrees {
  repo: WorkspaceWorktreeRepo
  worktrees: WorktreeInfo[]
}

function normalizePathKey(filePath: string): string {
  return normalizePathForCompare(filePath)
}

function getPathBasename(filePath: string): string {
  return normalizePathKey(filePath).split('/').filter(Boolean).pop() || filePath
}

export function WorktreeSelector({
  sessionId,
  workspaceSlug,
  repoPaths,
  selectedPath,
  onSelect,
  onOpenTerminal,
}: WorktreeSelectorProps): React.ReactElement {
  const [repoWorktrees, setRepoWorktrees] = React.useState<RepoWorktrees[]>([])
  const [isOpen, setIsOpen] = React.useState(false)
  // 初次挂载即保留工具栏高度，避免切回「改动」Tab 后选择器异步出现而推挤文件列表。
  const [isLoading, setIsLoading] = React.useState(true)
  const [hasFetchedOnce, setHasFetchedOnce] = React.useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)
  /** 丢弃较早请求的迟到响应，避免手动刷新后回滚到旧 Worktree 列表。 */
  const fetchSequenceRef = React.useRef(0)

  const fetchWorktrees = React.useCallback(async () => {
    const requestId = ++fetchSequenceRef.current
    setIsLoading(true)
    try {
      const repoMap = new Map<string, WorkspaceWorktreeRepo>()

      if (workspaceSlug) {
        const repos = await window.electronAPI.getWorktreeRepos(workspaceSlug)
        for (const repo of repos) {
          repoMap.set(normalizePathKey(repo.repoPath), repo)
        }
      }

      for (const repoPath of repoPaths ?? []) {
        if (!repoPath) continue
        const key = normalizePathKey(repoPath)
        if (repoMap.has(key)) continue
        repoMap.set(key, {
          name: getPathBasename(repoPath),
          repoPath,
          worktreesPath: '',
          priority: 0,
        })
      }

      const repos = Array.from(repoMap.values())
      if (repos.length === 0) {
        if (requestId === fetchSequenceRef.current) setRepoWorktrees([])
        return
      }

      const results: RepoWorktrees[] = []
      for (const repo of repos) {
        try {
          const list = await window.electronAPI.listWorktrees(repo.repoPath, sessionId)
          const nonMain = list.filter((wt) => !wt.isMain)
          if (nonMain.length > 0) {
            results.push({ repo, worktrees: nonMain })
          }
        } catch {
          // 跳过当前会话无权读取或已失效的仓库。
        }
      }
      if (requestId === fetchSequenceRef.current) setRepoWorktrees(results)
    } catch {
      if (requestId === fetchSequenceRef.current) setRepoWorktrees([])
    } finally {
      if (requestId === fetchSequenceRef.current) {
        setIsLoading(false)
        setHasFetchedOnce(true)
      }
    }
  }, [workspaceSlug, repoPaths, sessionId])

  React.useEffect(() => {
    fetchWorktrees()
  }, [fetchWorktrees])

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const allWorktrees = repoWorktrees.flatMap((rw) => rw.worktrees)
  const selectedWorktree = allWorktrees.find((wt) => normalizePathKey(wt.path) === normalizePathKey(selectedPath ?? ''))
  const hasMultipleRepos = repoWorktrees.length > 1
  const listId = React.useId()

  if (allWorktrees.length === 0 && !isLoading) return <></>

  // 商业版 mRt：在选择器第二行说明当前工作目录状态。
  const statusText = !hasFetchedOnce
    ? '正在检查 Worktree…'
    : selectedWorktree
      ? `Worktree · ${getPathBasename(selectedWorktree.path)}`
      : allWorktrees.length > 0 ? '使用会话原有工作目录' : '暂无可切换的 Worktree'

  return (
    <div ref={dropdownRef} className="relative shrink-0 border-b border-border/50 bg-content-area pb-2 pt-1">
      <div className="mx-2 flex min-h-8 items-center gap-1">
        <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[14px] font-medium text-foreground/80">
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
            <GitBranch className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate" title="工作目录">工作目录</span>
        </div>
        <div className="flex shrink-0 items-center">
          {onOpenTerminal && !selectedWorktree && <span className="size-8 shrink-0" aria-hidden="true" />}
          {selectedWorktree && onOpenTerminal && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onOpenTerminal(selectedWorktree)}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.96]"
                  title={`在 ${selectedWorktree.branch} 打开终端`}
                  aria-label={`在 ${selectedWorktree.branch} 打开终端`}
                >
                  <Terminal className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">在右侧标签中打开终端</TooltipContent>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={() => void fetchWorktrees()}
            disabled={isLoading}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.96]"
            title="刷新 Worktree 列表"
            aria-label="刷新 Worktree 列表"
            aria-busy={isLoading}
          >
            <RotateCw className={cn('size-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="mx-2 mt-1">
        <button
          type="button"
          onClick={() => {
            const nextOpen = !isOpen
            setIsOpen(nextOpen)
            if (nextOpen) void fetchWorktrees()
          }}
          title={selectedWorktree?.path ?? selectedPath ?? '使用会话原有工作目录'}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md bg-foreground/[0.025] px-2 text-left transition-[background-color,color] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-busy={isLoading}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium leading-4 text-foreground/80">
              {selectedWorktree?.branch ?? (selectedPath ? getPathBasename(selectedPath) : '会话默认目录')}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
              <span className="min-w-0 truncate" role="status" aria-live="polite">{statusText}</span>
              <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                {isLoading && <Loader2 className="size-3 motion-safe:animate-spin" />}
              </span>
            </span>
          </span>
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-180')} />
        </button>
      </div>

      {isOpen && (
        <div
          id={listId}
          role="region"
          className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
          aria-label="选择工作目录"
        >
          <button
            type="button"
            aria-pressed={!selectedPath}
            onClick={() => {
              onSelect(null)
              setIsOpen(false)
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[14px] transition-colors hover:bg-accent/60',
              !selectedPath && 'bg-accent/45 font-medium',
            )}
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block leading-4">会话默认目录</span>
              <span className="block truncate text-[12px] leading-3 text-muted-foreground">查看会话与项目目录中的改动</span>
            </span>
          </button>
          <div className="my-1 h-px bg-border/70" />
          <div className="flex h-6 items-center justify-between gap-2 px-2.5 text-[12px] text-muted-foreground" role="status">
            <span className="min-w-0 truncate">{isLoading ? '正在查找 Worktree…' : `${allWorktrees.length} 个 Worktree`}</span>
            <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
              {isLoading && <Loader2 className="size-3 motion-safe:animate-spin" />}
            </span>
          </div>
          <div className="max-h-56 overflow-y-auto" aria-busy={isLoading}>
            {allWorktrees.length === 0 && (isLoading ? (
              <WorktreeListSkeleton />
            ) : (
              <p className="px-2.5 py-3 text-[13px] text-muted-foreground">这些目录暂未发现 linked Worktree。</p>
            ))}
            {repoWorktrees.map((rw) => (
              <React.Fragment key={rw.repo.repoPath}>
                {hasMultipleRepos && (
                  <div className="px-2.5 pb-1 pt-2 truncate text-[13px] font-medium text-muted-foreground/70">
                    {rw.repo.name}
                  </div>
                )}
                {rw.worktrees.map((wt) => {
                  const selected = normalizePathKey(wt.path) === normalizePathKey(selectedPath ?? '')
                  return (
                    <div
                      key={wt.path}
                      className={cn('flex items-center gap-0.5 rounded-md pr-1 transition-[background-color]', selected && 'bg-primary/10')}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(wt)
                          setIsOpen(false)
                        }}
                        aria-pressed={selected}
                        aria-label={selected ? `${wt.branch}，当前激活的 Worktree` : `${wt.branch} Worktree`}
                        title={wt.path}
                        className={cn(
                          'flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-[background-color,color] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                          selected && 'hover:bg-primary/10',
                        )}
                      >
                        <GitBranch className={cn('size-3.5 shrink-0 text-muted-foreground', selected && 'text-primary')} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5 leading-4">
                            <span className={cn('truncate text-xs font-medium text-foreground/80', selected && 'text-foreground')}>{wt.branch}</span>
                            {selected && (
                              <span className="shrink-0 rounded-sm bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">已激活</span>
                            )}
                          </span>
                          <span className="flex min-w-0 items-center gap-2 text-[10px] leading-4 text-muted-foreground/75">
                            <span className="min-w-0 flex-1 truncate">{wt.path}</span>
                            <span className="shrink-0 font-mono tabular-nums">{wt.head.slice(0, 7)}</span>
                          </span>
                        </span>
                        {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                      </button>
                      {onOpenTerminal && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => onOpenTerminal(wt)}
                              className={cn(WORKTREE_ACTION_CLASS, 'hover:text-foreground')}
                              title={`在 ${wt.branch} 打开终端`}
                              aria-label={`在 ${wt.branch} 打开终端`}
                            >
                              <span className="inline-flex size-7 items-center justify-center rounded-md transition-[background-color] group-hover/action:bg-background/80">
                                <Terminal className="size-4" />
                              </span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left">在右侧标签中打开终端</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const WORKTREE_ACTION_CLASS = 'group/action inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.96]'

/** Worktree 列表首次加载的骨架（商业版 _Rt）。 */
function WorktreeListSkeleton(): React.ReactElement {
  return (
    <div className="space-y-1 px-2.5 py-1" aria-label="正在加载 Worktree 列表">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex h-12 items-center gap-2 motion-safe:animate-pulse" aria-hidden="true">
          <div className="size-3.5 shrink-0 rounded bg-muted-foreground/15" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className={cn('h-2.5 rounded bg-muted-foreground/15', index === 1 ? 'w-3/5' : 'w-4/5')} />
            <div className="h-2 w-2/5 rounded bg-muted-foreground/10" />
          </div>
          <div className="size-5 shrink-0 rounded bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  )
}
