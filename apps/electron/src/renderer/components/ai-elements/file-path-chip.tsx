/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击后按用户偏好（标签页 / 侧边分屏）打开文件预览。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  getFileName,
  getFilePathDisplayPath,
  isAbsoluteFilePath,
  isAsyncResultCurrent,
  isImageFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  stripLineCol,
} from './file-path-chip-utils'

interface FileResolutionCacheEntry {
  exists: boolean
  resolvedPath?: string
  /** 相对会话检出根的路径；worktree 换位置后仍能据此重新打开。 */
  relPath?: string
}

/** 文件存在性缓存（模块级共享，避免重复 IPC）。key 包含会话授权上下文。 */
const fileExistsCache = new Map<string, FileResolutionCacheEntry>()
const fileResolutionRequests = new Map<string, Promise<FileResolutionCacheEntry>>()
function existsCacheKey(filePath: string, bases: string[], sessionId?: string): string {
  return `${sessionId ?? ''}\0${filePath}\0${bases.join('\0')}`
}

/**
 * 解析文件路径并写入模块级缓存。
 *
 * `bypassCache` 为 true 时跳过缓存读取（用于点击等需要拿到最新结果的场景），
 * 但请求结束后仍会刷新缓存，避免把过期结果留在缓存里。
 */
function resolveFilePathEntry(
  filePath: string,
  bases: string[],
  sessionId?: string,
  bypassCache = false,
): Promise<FileResolutionCacheEntry> {
  const key = existsCacheKey(filePath, bases, sessionId)
  if (!bypassCache) {
    const cached = fileExistsCache.get(key)
    if (cached) return Promise.resolve(cached)
  }

  const inFlight = fileResolutionRequests.get(key)
  if (inFlight) return inFlight

  const promise = window.electronAPI.resolveFilePath(filePath, {
    sessionId,
    candidateBasePaths: bases.length > 0 ? bases : undefined,
  }).then((resolved) => {
    const entry: FileResolutionCacheEntry = {
      exists: resolved !== null,
      ...(resolved?.resolvedPath ? { resolvedPath: resolved.resolvedPath } : {}),
      ...(resolved?.relPath ? { relPath: resolved.relPath } : {}),
    }
    fileExistsCache.set(key, entry)
    return entry
  }).finally(() => {
    fileResolutionRequests.delete(key)
  })
  fileResolutionRequests.set(key, promise)
  return promise
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  /** 消息所属会话；嵌入子会话时不得回退为父会话的授权边界。 */
  sessionId?: string
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, sessionId, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const filename = getFileName(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const requestGenerationRef = React.useRef(0)
  const resolutionRequestRef = React.useRef<{ key: string; promise: Promise<FileResolutionCacheEntry | null> } | null>(null)
  const mountedRef = React.useRef(true)
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'broken'>('idle')
  const [resolvedPath, setResolvedPath] = React.useState<string | undefined>()
  const store = useStore()
  const openPreview = useOpenPreview()

  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])

  const displayPath = React.useMemo(() => getFilePathDisplayPath({
    originalPath: trimmedPath,
    resolvedPath,
    lineColSuffix: resolvedPath ? lineColSuffix : '',
  }), [trimmedPath, resolvedPath, lineColSuffix])

  const getSessionId = React.useCallback(() => sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined, [sessionId, store])

  /**
   * 解析当前路径并同步到组件状态，同时把解析结果返回给调用方。
   *
   * `bypassCache` 为 true 时强制走一次主进程解析（点击打开预览前使用），
   * 且不参与 in-flight 去重，避免复用旧代次的结果。
   * 返回值恒为本次解析结果；只有状态回写受代次守卫约束。
   */
  const resolveCurrentPath = React.useCallback((bypassCache = false): Promise<FileResolutionCacheEntry | null> => {
    const resolvedSessionId = getSessionId()
    const key = existsCacheKey(cleanPath, candidateBases, resolvedSessionId)
    const inFlight = resolutionRequestRef.current
    if (!bypassCache && inFlight?.key === key) return inFlight.promise

    const generation = ++requestGenerationRef.current
    let promise: Promise<FileResolutionCacheEntry | null>
    promise = resolveFilePathEntry(cleanPath, candidateBases, resolvedSessionId, bypassCache)
      .then((entry) => {
        if (isAsyncResultCurrent(generation, requestGenerationRef.current, mountedRef.current)) {
          setFileStatus(entry.exists ? 'resolved' : 'broken')
          setResolvedPath(entry.resolvedPath)
        }
        return entry
      })
      .catch(() => null)
      .finally(() => {
        if (resolutionRequestRef.current?.promise === promise) {
          resolutionRequestRef.current = null
        }
      })
    resolutionRequestRef.current = { key, promise }
    return promise
  }, [cleanPath, candidateBases, getSessionId])

  // IntersectionObserver 首次懒检查可使用缓存；Tooltip 打开时会绕过缓存重新解析。
  React.useEffect(() => {
    const el = chipRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    requestGenerationRef.current += 1
    mountedRef.current = true
    // 缓存命中时直接落定状态，不经过 idle 重置，避免流式重渲染期间先回到未解析外观。
    const key = existsCacheKey(cleanPath, candidateBases, getSessionId())
    const cached = fileExistsCache.get(key)
    if (cached) {
      setFileStatus(cached.exists ? 'resolved' : 'broken')
      setResolvedPath(cached.resolvedPath)
      return () => {
        mountedRef.current = false
        requestGenerationRef.current += 1
      }
    }

    setFileStatus('idle')
    setResolvedPath(undefined)

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        void resolveCurrentPath()
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      observer.disconnect()
    }
  }, [cleanPath, candidateBases, getSessionId, resolveCurrentPath])

  const handleTooltipOpenChange = React.useCallback((open: boolean) => {
    if (open) void resolveCurrentPath()
  }, [resolveCurrentPath])

  const handleClick = React.useCallback(async (): Promise<void> => {
    const resolvedSessionId = getSessionId()
    if (!resolvedSessionId) return

    // 点击时强制重新解析：缓存里的路径可能已被移动或删除，直接打开会失败。
    const entry = await resolveCurrentPath(true)
    if (!mountedRef.current) return
    // 解析期间会话可能已切换，切换后不再按旧会话的授权范围打开预览。
    if (getSessionId() !== resolvedSessionId) return

    openPreview(resolvedSessionId, {
      filePath: entry?.resolvedPath ?? cleanPath,
      previewOnly: true,
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
      // 主进程已给出相对检出根的路径时登记成可迁移引用，避免 worktree 重建后绝对路径失效。
      ...(entry?.relPath ? { sessionFileRef: { sessionId: resolvedSessionId, path: entry.relPath } } : {}),
    })
  }, [getSessionId, resolveCurrentPath, openPreview, cleanPath, candidateBases])

  const handleShowInFolder = React.useCallback(() => {
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    window.electronAPI.showItemInFolder(cleanPath, bases)
      .then((ok) => { if (!ok) toast.error(`无法访问文件（不存在或不在当前会话可预览范围内）: ${displayPath}`) })
      .catch(() => toast.error(`无法访问文件（不存在或不在当前会话可预览范围内）: ${displayPath}`))
  }, [cleanPath, candidateBases, displayPath])

  return (
    <ContextMenu>
      <Tooltip onOpenChange={handleTooltipOpenChange}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              ref={chipRef}
              type="button"
              onClick={handleClick}
              className={cn(
                'inline-flex items-center gap-[0.25em] rounded px-[0.35em] py-[0.15em] text-[0.875em] font-medium leading-none',
                'cursor-pointer transition-colors duration-150',
                'align-baseline not-prose',
                fileStatus === 'broken'
                  ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
                className,
              )}
            >
              <FileTypeIcon name={filename} isDirectory={false} size={12} />
              <span className="truncate max-w-[240px] leading-none">{filename}{lineColSuffix}</span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all font-mono text-[11px]">
          {fileStatus === 'broken' ? `文件不存在: ${displayPath}` : displayPath}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-48 z-[9999]">
        <ContextMenuItem onClick={handleClick}>
          打开预览
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface ResolvableFilePathChipProps extends FilePathChipProps {
  /** 路径未通过主进程解析时显示的原始 Markdown 节点，避免制造不可用 Chip。 */
  fallback: React.ReactElement
}

/**
 * 用于模型自由文本中的路径候选。只有文件存在且位于当前会话授权范围内时才升级为 Chip；
 * 解析期间和失败后都保留调用方提供的原始 Markdown 外观。
 */
export function ResolvableFilePathChip({ fallback, filePath, basePath, basePaths, sessionId, className }: ResolvableFilePathChipProps): React.ReactElement {
  const store = useStore()
  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])
  const cleanPath = React.useMemo(() => stripLineCol(filePath.trim()).path, [filePath])
  const resolvedSessionId = sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined
  const resolutionKey = React.useMemo(
    () => existsCacheKey(cleanPath, candidateBases, resolvedSessionId),
    [candidateBases, cleanPath, resolvedSessionId],
  )
  const [resolvedKey, setResolvedKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    // 同步缓存命中路径：命中即落定，不经过 fallback 中间态。
    // 流式输出期间本组件会随 Markdown 树频繁重建，若每次回到 fallback 再异步回填，
    // 正文里的路径就会在「原始文本」与「chip」之间逐帧跳变。
    const cached = fileExistsCache.get(resolutionKey)
    if (cached != null && cached.exists) {
      setResolvedKey(resolutionKey)
      return
    }

    let cancelled = false
    void resolveFilePathEntry(cleanPath, candidateBases, resolvedSessionId)
      .then((entry) => {
        if (!cancelled && entry.exists) setResolvedKey(resolutionKey)
      })
      .catch(() => { /* 解析失败时保持原状，渲染层继续使用 fallback */ })
    return () => { cancelled = true }
  }, [candidateBases, cleanPath, resolvedSessionId, resolutionKey])

  if (resolvedKey !== resolutionKey) return fallback
  return <FilePathChip filePath={filePath} basePath={basePath} basePaths={basePaths} sessionId={sessionId} className={className} />
}

export { isAbsoluteFilePath, isImageFilePath, isLocalFileReference, isRelativeFilePath }
