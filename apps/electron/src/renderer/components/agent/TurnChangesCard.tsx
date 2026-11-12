/**
 * TurnChangesCard — 轮末「已编辑 N 个文件」改动卡
 *
 * 数据优先取该轮用户消息上持久化的 `turn_changes`（主进程录制器在轮末写入的
 * 真实改动）；没有时用 IPC 读主进程内存摘要；再没有才按本轮成功的
 * Edit / MultiEdit / Write 工具输入估算行数（此时不提供悬停 diff）。
 *
 * 点击行为：可直接预览的类型（图片、PDF、Office、HTML）在右侧打开预览；
 * 其余切到右侧面板的改动 Tab，并把文件绝对路径写入 `changesFocusPathMapAtom`
 * 交给连续改动视图滚动定位。
 */

import * as React from 'react'
import { useAtomValue, useStore } from 'jotai'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { SDKMessage, SDKUserMessage, TurnChangesSummary, TurnDiffHunk, TurnFileDiff } from '@proma/shared'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  agentDiffPanelTabAtom,
  agentSidePanelOpenAtomFamily,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { changesFocusPathMapAtom } from '@/atoms/changes-focus-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { useMessagePathResolution } from '@/components/ai-elements/message'
import { cn } from '@/lib/utils'
import {
  COLLAPSE_THRESHOLD,
  HOVER_HUNK_MAX_LINES,
  formatChangeCount,
  isDirectPreviewFile,
  mergeTurnChanges,
  type TurnChangeFileEntry,
} from './turn-change-files'

/** 悬停 500ms 后才请求并展示 diff，避免鼠标扫过列表时反复弹窗 */
const HOVER_OPEN_DELAY_MS = 500
const HOVER_CLOSE_DELAY_MS = 100

/** 摘要缓存：`sessionId\0turnKey` → 摘要（null 表示确认取不到） */
const summaryCache = new Map<string, TurnChangesSummary | null>()
/** 进行中的摘要请求，避免同一轮被多个组件实例重复拉取 */
const summaryInflight = new Map<string, Promise<TurnChangesSummary | null>>()
/** 单文件 diff 缓存：`sessionId\0turnKey\0path` → diff */
const diffCache = new Map<string, TurnFileDiff | null>()
const diffInflight = new Map<string, Promise<TurnFileDiff | null>>()

function summaryCacheKey(sessionId: string, turnKey: string): string {
  return `${sessionId}\0${turnKey}`
}

function diffCacheKey(sessionId: string, turnKey: string, path: string): string {
  return `${sessionId}\0${turnKey}\0${path}`
}

/** 取本轮改动摘要：持久化字段优先，其次内存缓存，最后 IPC 兜底。 */
function useTurnChangesSummary(
  sessionId: string | undefined,
  turnKey: string | undefined,
  persisted: TurnChangesSummary | undefined,
): TurnChangesSummary | null {
  const cacheKey = sessionId && turnKey ? summaryCacheKey(sessionId, turnKey) : undefined
  const [fetched, setFetched] = React.useState<TurnChangesSummary | null>(() => {
    if (persisted !== undefined) return persisted
    return cacheKey ? summaryCache.get(cacheKey) ?? null : null
  })

  React.useEffect(() => {
    if (persisted !== undefined) {
      if (cacheKey) summaryCache.set(cacheKey, persisted)
      setFetched(persisted)
      return
    }
    if (!cacheKey || !sessionId || !turnKey) {
      setFetched(null)
      return
    }
    const cached = summaryCache.get(cacheKey)
    if (cached !== undefined) {
      setFetched(cached)
      return
    }
    if (typeof window === 'undefined' || typeof window.electronAPI?.getTurnChanges !== 'function') {
      setFetched(null)
      return
    }

    let cancelled = false
    let request = summaryInflight.get(cacheKey)
    if (request === undefined) {
      request = window.electronAPI
        .getTurnChanges(sessionId, turnKey)
        .then((value) => {
          const summary = value ?? null
          summaryCache.set(cacheKey, summary)
          return summary
        })
        .catch(() => {
          summaryCache.set(cacheKey, null)
          return null
        })
        .finally(() => {
          summaryInflight.delete(cacheKey)
        })
      summaryInflight.set(cacheKey, request)
    }
    void request.then((summary) => {
      if (!cancelled) setFetched(summary)
    })
    return () => {
      cancelled = true
    }
  }, [cacheKey, sessionId, turnKey, persisted])

  return persisted ?? fetched
}

interface FileDiffState {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  diff?: TurnFileDiff
}

/** 悬停时才请求单文件 hunks，结果按轮次+路径缓存。 */
function useTurnFileDiff(
  sessionId: string | undefined,
  turnKey: string | undefined,
  path: string,
  enabled: boolean,
): FileDiffState {
  const cacheKey = sessionId && turnKey && path ? diffCacheKey(sessionId, turnKey, path) : undefined
  const [state, setState] = React.useState<FileDiffState>(() => {
    if (!cacheKey) return { status: 'idle' }
    const cached = diffCache.get(cacheKey)
    if (cached === undefined) return { status: 'idle' }
    return cached === null ? { status: 'missing' } : { status: 'ready', diff: cached }
  })

  const load = React.useCallback(() => {
    if (!cacheKey || !sessionId || !turnKey || !path) return
    if (typeof window === 'undefined' || typeof window.electronAPI?.getTurnFileDiff !== 'function') {
      setState({ status: 'missing' })
      return
    }

    setState({ status: 'loading' })
    let request = diffInflight.get(cacheKey)
    if (request === undefined) {
      request = window.electronAPI
        .getTurnFileDiff(sessionId, turnKey, path)
        .then((value) => {
          const diff = value ?? null
          diffCache.set(cacheKey, diff)
          return diff
        })
        .catch(() => null)
        .finally(() => {
          diffInflight.delete(cacheKey)
        })
      diffInflight.set(cacheKey, request)
    }
    void request.then((diff) => {
      setState(diff === null ? { status: 'missing' } : { status: 'ready', diff })
    })
  }, [cacheKey, path, sessionId, turnKey])

  React.useEffect(() => {
    if (!enabled || !cacheKey) return
    const cached = diffCache.get(cacheKey)
    if (cached !== undefined) {
      setState(cached === null ? { status: 'missing' } : { status: 'ready', diff: cached })
      return
    }
    load()
  }, [enabled, cacheKey, load])

  return state
}

/** 行数展示：二进制与过大给出文字说明，其余为等宽 +N -N。 */
function ChangeCounts({
  added,
  deleted,
  binary,
  oversized,
}: {
  added: number
  deleted: number
  binary?: boolean
  oversized?: boolean
}): React.ReactElement {
  if (binary) return <span>二进制</span>
  if (oversized) return <span>过大</span>
  return (
    <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">{formatChangeCount(added, '+')}</span>
      <span className="text-red-600 dark:text-red-400">{formatChangeCount(deleted, '-')}</span>
    </span>
  )
}

/** 单个 hunk 的行渲染：双列行号 + 增删底色。 */
function HunkLines({ hunk }: { hunk: TurnDiffHunk }): React.ReactElement {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart

  return (
    <>
      {hunk.lines.slice(0, HOVER_HUNK_MAX_LINES).map((line, index) => {
        const marker = line[0] ?? ' '
        const text = line.slice(1)
        const isAdd = marker === '+'
        const isDel = marker === '-'
        const oldNumber = isAdd ? '' : String(oldLine++)
        const newNumber = isDel ? '' : String(newLine++)

        return (
          <div
            // hunk 内行序固定，索引作为 key 足够稳定
            key={index}
            className={cn(
              'flex min-w-full text-[11.5px] leading-[18px]',
              isAdd && 'bg-emerald-500/10 text-foreground',
              isDel && 'bg-red-500/10 text-foreground',
              !isAdd && !isDel && 'text-muted-foreground',
            )}
          >
            <span className="w-8 flex-none select-none px-1.5 text-right text-[10.5px] tabular-nums opacity-55">{oldNumber}</span>
            <span className="w-8 flex-none select-none px-1.5 text-right text-[10.5px] tabular-nums opacity-55">{newNumber}</span>
            <span
              className={cn(
                'w-4 flex-none select-none text-center',
                isAdd && 'text-emerald-600 dark:text-emerald-400',
                isDel && 'text-red-600 dark:text-red-400',
                !isAdd && !isDel && 'opacity-40',
              )}
            >
              {marker}
            </span>
            <span className="whitespace-pre pr-3">{text || ' '}</span>
          </div>
        )
      })}
    </>
  )
}

/**
 * 悬停 diff 浮层。
 *
 * 只有录制结果、非二进制非过大时才启用；用 Popover 定位（Dev 未引入 radix hover-card），
 * 打开/关闭延迟由本地计时器控制。
 */
function ChangeHoverPreview({
  sessionId,
  turnKey,
  file,
  enabled,
  children,
}: {
  sessionId: string | undefined
  turnKey: string | undefined
  file: TurnChangeFileEntry
  enabled: boolean
  children: React.ReactElement
}): React.ReactElement {
  const hoverEnabled = enabled && !file.binary && !file.oversized && !!sessionId && !!turnKey
  const [open, setOpen] = React.useState(false)
  const diff = useTurnFileDiff(sessionId, turnKey, file.path, hoverEnabled && open)

  const openTimer = React.useRef<number | null>(null)
  const closeTimer = React.useRef<number | null>(null)

  const clearTimers = React.useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  React.useEffect(() => clearTimers, [clearTimers])

  if (!hoverEnabled) return children

  const handlePointerEnter = (): void => {
    clearTimers()
    if (open) return
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
  }
  const handlePointerLeave = (): void => {
    clearTimers()
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  const showContent = diff.status === 'ready' && diff.diff?.kind === 'text' && diff.diff.hunks.length > 0

  return (
    <Popover
      open={open && showContent}
      onOpenChange={(next) => {
        // Radix 只会因为点击外部/ESC 关闭；这里保持与本地计时器一致
        if (!next) {
          clearTimers()
          setOpen(false)
        }
      }}
    >
      <PopoverAnchor asChild>
        <div onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="center"
        sideOffset={6}
        className="z-[10050] w-[min(560px,calc(100vw-48px))] max-h-[360px] overflow-hidden rounded-[12px] border-border/70 p-0 shadow-lg"
        data-changes-hover-preview
        // 悬停预览不得抢焦点：否则滚动位置与输入焦点会被弹出层带走
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={clearTimers}
        onPointerLeave={handlePointerLeave}
      >
        <div className="truncate border-b border-border/60 bg-muted/35 px-3 py-1.5 font-mono text-[11.5px] leading-[18px] text-muted-foreground">
          {file.display}
        </div>
        <div className="max-h-[316px] overflow-auto py-1 font-mono">
          {diff.diff?.kind === 'text' && diff.diff.hunks.map((hunk, index) => (
            <HunkLines key={index} hunk={hunk} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export interface TurnChangesCardProps {
  turnMessages: SDKMessage[]
  inputMessage?: SDKUserMessage
  /** 相对路径解析基准（会话工作目录） */
  basePath?: string
}

export function TurnChangesCard({ turnMessages, inputMessage, basePath }: TurnChangesCardProps): React.ReactElement | null {
  const sessionId = useAtomValue(currentAgentSessionIdAtom) ?? undefined
  const store = useStore()
  const openPreview = useOpenPreview()
  const pathResolution = useMessagePathResolution()
  const [expanded, setExpanded] = React.useState(false)

  const turnKey = inputMessage?.uuid
  const summary = useTurnChangesSummary(sessionId, turnKey, inputMessage?.turn_changes)

  const basePaths = React.useMemo(() => (
    [...new Set([basePath, ...(pathResolution.basePaths ?? [])].filter((path): path is string => !!path))]
  ), [basePath, pathResolution.basePaths])

  const view = React.useMemo(
    () => mergeTurnChanges(summary, turnMessages, basePaths),
    [summary, turnMessages, basePaths],
  )

  const handleOpen = React.useCallback((file: TurnChangeFileEntry): void => {
    if (!sessionId) return
    if (isDirectPreviewFile(file.path)) {
      openPreview(sessionId, {
        filePath: file.path,
        dirPath: basePath,
        basePaths: basePaths.length > 0 ? basePaths : undefined,
        previewOnly: true,
      })
      return
    }
    store.set(agentSidePanelOpenAtomFamily(sessionId), true)
    store.set(agentDiffPanelTabAtom, (previous) => {
      if (previous.get(sessionId) === 'changes') return previous
      const next = new Map(previous)
      next.set(sessionId, 'changes')
      return next
    })
    store.set(changesFocusPathMapAtom, (previous) => {
      const next = new Map(previous)
      next.set(sessionId, file.path)
      return next
    })
  }, [basePath, basePaths, openPreview, sessionId, store])

  if (view.files.length === 0) return null

  const singleFile = view.total === 1 ? view.files[0] : undefined
  const collapsible = view.files.length > COLLAPSE_THRESHOLD
  const visibleFiles = collapsible && !expanded ? view.files.slice(0, COLLAPSE_THRESHOLD) : view.files

  const headerButton = (
    <button
      type="button"
      onClick={() => handleOpen(singleFile ?? (view.files[0] as TurnChangeFileEntry))}
      title={singleFile ? singleFile.path : undefined}
      aria-label={singleFile ? `查看 ${singleFile.display} 的改动` : '在侧边栏查看本轮改动'}
      className="group flex w-full min-w-0 items-center gap-2.5 bg-muted/35 px-2.5 py-2 text-left transition-colors hover:bg-muted/65 focus-visible:bg-muted/65 focus-visible:outline-none dark:bg-muted/25 dark:hover:bg-muted/45"
    >
      <span className="grid size-10 flex-none place-items-center rounded-[10px] border border-border/60 bg-background/60 dark:bg-white/[0.05]">
        <FileTypeIcon name={singleFile ? singleFile.name : 'index.ts'} isDirectory={false} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="truncate text-[13px] font-medium leading-[20px] text-foreground">
          {singleFile ? `已编辑 ${singleFile.name}` : `已编辑 ${view.total} 个文件`}
        </span>
        <span className="inline-flex items-center text-[11px] leading-[16px] text-muted-foreground">
          <span className="group-hover:hidden group-focus-visible:hidden">
            <ChangeCounts
              added={view.added}
              deleted={view.deleted}
              binary={singleFile?.binary}
              oversized={singleFile?.oversized}
            />
          </span>
          <span className="hidden group-hover:inline group-focus-visible:inline">在侧边栏预览</span>
        </span>
      </span>
    </button>
  )

  return (
    <div className="mt-3" data-turn-file-changes data-single={singleFile !== undefined || undefined}>
      <div className="flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-border/60 bg-card">
        {singleFile ? (
          <ChangeHoverPreview
            sessionId={sessionId}
            turnKey={turnKey}
            file={singleFile}
            enabled={view.fromRecorder}
          >
            {headerButton}
          </ChangeHoverPreview>
        ) : (
          <>
            {headerButton}
            <ul className="border-t border-border/60">
              {visibleFiles.map((file) => (
                <li key={file.path}>
                  <ChangeHoverPreview
                    sessionId={sessionId}
                    turnKey={turnKey}
                    file={file}
                    enabled={view.fromRecorder}
                  >
                    <button
                      type="button"
                      onClick={() => handleOpen(file)}
                      title={file.path}
                      aria-label={`查看 ${file.display} 的改动`}
                      className="flex min-h-[34px] w-full min-w-0 items-center justify-between gap-2.5 px-3.5 py-[7px] text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                    >
                      <span className="min-w-0 truncate text-[12px] leading-[18px] text-muted-foreground">{file.display}</span>
                      <span className="flex-none text-[11px] leading-[18px] text-muted-foreground">
                        <ChangeCounts added={file.added} deleted={file.deleted} binary={file.binary} oversized={file.oversized} />
                      </span>
                    </button>
                  </ChangeHoverPreview>
                </li>
              ))}
            </ul>
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((previous) => !previous)}
                aria-expanded={expanded}
                aria-label={expanded ? '收起改动文件列表' : `展开全部 ${view.files.length} 个改动文件`}
                className="inline-flex w-full items-center justify-start gap-1 border-t border-border/50 px-3.5 py-2 text-left text-[12px] leading-[18px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:outline-none"
              >
                <span>{expanded ? '收起' : `全部 ${view.files.length} 个文件`}</span>
                {expanded
                  ? <ChevronUp className="size-3.5 flex-none" />
                  : <ChevronDown className="size-3.5 flex-none" />}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}