/**
 * TurnDeliverables — 轮末交付物卡片
 *
 * Agent 调用 `Present` 声明本轮要交给用户的文件后，回合结束时在这里渲染成卡片：
 * 整卡点击在右侧工作区打开预览，右侧两个图标按钮分别用系统默认应用打开、
 * 在访达（文件管理器）中显示。
 *
 * 数据只来自本轮已成功返回的 `Present` 调用（收集逻辑在 `turn-deliverables.ts`）；
 * 声明本身不复制文件，因此卡片打开的永远是当前最新版本。声明数量超过折叠阈值时
 * 默认只显示前几个。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, ChevronUp, ExternalLink, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { SDKMessage } from '@proma/shared'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { useMessagePathResolution } from '@/components/ai-elements/message'
import {
  collectPresentedFiles,
  fileExtensionLabel,
  stripTrailingParenthetical,
  type PresentedFileEntry,
} from './turn-deliverables'

/** 超过该数量时折叠，与商业版阈值一致。 */
const COLLAPSE_THRESHOLD = 4

const ICON_BUTTON_CLASS = 'grid size-7 flex-none place-items-center rounded-md text-muted-foreground/80 transition-colors hover:bg-background/80 hover:text-foreground focus-visible:outline-none focus-visible:bg-background/80 disabled:opacity-50'

interface PresentedFileCardProps {
  file: PresentedFileEntry
  sessionId?: string
  basePaths: string[]
  onPreview: () => void
}

type CardBusyState = 'opening' | 'revealing' | undefined

/** 单个交付物卡片：整卡点击预览，右侧保留默认应用打开与在访达中显示。 */
function PresentedFileCard({ file, sessionId, basePaths, onPreview }: PresentedFileCardProps): React.ReactElement {
  const [busy, setBusy] = React.useState<CardBusyState>(undefined)
  const access = React.useMemo(
    () => ({ sessionId, candidateBasePaths: basePaths.length > 0 ? basePaths : undefined }),
    [sessionId, basePaths],
  )

  const handleOpenWithDefaultApp = React.useCallback(() => {
    setBusy('opening')
    window.electronAPI.systemOpenFile(file.path, undefined, access)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : '无法用默认应用打开')
      })
      .finally(() => setBusy(undefined))
  }, [access, file.path])

  const handleReveal = React.useCallback(() => {
    setBusy('revealing')
    window.electronAPI.showItemInFolder(file.path, basePaths.length > 0 ? basePaths : undefined)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : '无法在文件管理器中显示')
      })
      .finally(() => setBusy(undefined))
  }, [basePaths, file.path])

  const subtitle = stripTrailingParenthetical(file.description, fileExtensionLabel(file.name))
  const statusText = busy === 'opening' ? '正在打开…' : busy === 'revealing' ? '正在文件管理器中显示…' : subtitle

  return (
    <div
      className="group relative flex h-[60px] min-w-0 items-center gap-2.5 overflow-hidden rounded-[14px] border border-border/60 bg-muted/35 px-2.5 py-2 transition-colors hover:bg-muted/65 dark:bg-muted/25 dark:hover:bg-muted/45"
      data-presented-file
    >
      <button
        type="button"
        onClick={onPreview}
        title={file.path}
        aria-label={`在侧边栏预览 ${file.name}`}
        className="peer absolute inset-0 z-[1] cursor-pointer rounded-[inherit] border-0 bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <span className="pointer-events-none relative z-[2] grid size-10 flex-none place-items-center rounded-[10px] border border-border/60 bg-background/60 dark:bg-white/[0.05]">
        <FileTypeIcon name={file.name} isDirectory={false} size={20} />
      </span>
      <div className="pointer-events-none relative z-[2] flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="truncate text-[13px] font-medium leading-[20px] text-foreground">{file.name}</span>
          <span
            className="truncate text-[11px] leading-[16px] text-muted-foreground"
            data-presented-description
            role={busy === undefined ? undefined : 'status'}
          >
            {busy === undefined ? (
              <>
                <span className="group-hover:hidden peer-focus-visible:hidden">{subtitle}</span>
                <span className="hidden group-hover:inline peer-focus-visible:inline">在侧边栏预览</span>
              </>
            ) : (
              <span>{statusText}</span>
            )}
          </span>
        </div>
        <div className="pointer-events-auto flex flex-none items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                disabled={busy !== undefined}
                onClick={handleOpenWithDefaultApp}
                aria-label={`用默认应用打开 ${file.name}`}
              >
                <ExternalLink size={14} strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>用默认应用打开</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                disabled={busy !== undefined}
                onClick={handleReveal}
                aria-label={`在文件管理器中显示 ${file.name}`}
              >
                <FolderOpen size={14} strokeWidth={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>在访达中显示</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export interface TurnDeliverablesProps {
  turnMessages: SDKMessage[]
  /** 单个候选根（会话工作目录），用于补全相对路径与预览定位。 */
  basePath?: string
  /** 会话级候选根；优先于 basePath，包含附加目录。 */
  basePaths?: string[]
  /** 消息所属会话；嵌入子会话时不得回退为父会话的授权边界。 */
  sessionId?: string
}

/**
 * 轮末交付物列表。没有交付物时不渲染任何容器，避免留下空白间距。
 */
export function TurnDeliverables({
  turnMessages,
  basePath,
  basePaths,
  sessionId,
}: TurnDeliverablesProps): React.ReactElement | null {
  const context = useMessagePathResolution()
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const openPreview = useOpenPreview()
  const [expanded, setExpanded] = React.useState(false)

  const resolvedBasePaths = React.useMemo(() => {
    const candidates = [
      ...(basePaths ?? []),
      ...(context?.basePaths ?? []),
      ...(basePath ? [basePath] : []),
    ].filter((path): path is string => typeof path === 'string' && path.length > 0)
    return [...new Set(candidates)]
  }, [basePath, basePaths, context?.basePaths])

  const effectiveSessionId = sessionId ?? context?.sessionId ?? currentSessionId ?? undefined
  const files = React.useMemo(
    () => collectPresentedFiles(turnMessages, resolvedBasePaths),
    [turnMessages, resolvedBasePaths],
  )

  const handlePreview = React.useCallback((file: PresentedFileEntry) => {
    if (!effectiveSessionId) return
    openPreview(effectiveSessionId, {
      filePath: file.path,
      dirPath: basePath,
      basePaths: resolvedBasePaths.length > 0 ? resolvedBasePaths : undefined,
      previewOnly: true,
    })
  }, [basePath, effectiveSessionId, openPreview, resolvedBasePaths])

  if (files.length === 0) return null

  const collapsible = files.length > COLLAPSE_THRESHOLD
  const visibleFiles = collapsible && !expanded ? files.slice(0, COLLAPSE_THRESHOLD) : files
  const isSingle = files.length === 1

  return (
    <div className="mt-2.5 flex min-w-0 flex-col gap-2.5" data-turn-deliverables>
      <div
        className={cn('grid min-w-0 grid-cols-1 gap-2.5', !isSingle && 'sm:grid-cols-2')}
        data-presented-files-row
        data-single={isSingle || undefined}
      >
        {visibleFiles.map((file) => (
          <PresentedFileCard
            key={file.path}
            file={file}
            sessionId={effectiveSessionId}
            basePaths={resolvedBasePaths}
            onPreview={() => handlePreview(file)}
          />
        ))}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? '收起交付文件列表' : `展开全部 ${files.length} 个交付文件`}
          className="inline-flex items-center gap-1 self-center rounded-md px-2.5 py-0.5 text-[12px] leading-[18px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:bg-accent/50"
        >
          <span>{expanded ? '收起' : `全部 ${files.length} 个文件`}</span>
          {expanded
            ? <ChevronUp className="size-3.5 flex-none" />
            : <ChevronDown className="size-3.5 flex-none" />}
        </button>
      )}
    </div>
  )
}
