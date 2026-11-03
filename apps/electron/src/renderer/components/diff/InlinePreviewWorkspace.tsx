/**
 * InlinePreviewWorkspace — 「文件 / 文件改动」页签内的内联预览布局。
 *
 * 对齐商业版 0.21.88 的 `YYt`：左侧为文件预览，原列表收进右侧 300px 可折叠栏；
 * 宽度不足 800px 时列表改为工具栏按钮弹出的抽屉。
 */

import * as React from 'react'
import { PanelRight } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PreviewPanel } from './PreviewPanel'
import { getInlinePreviewLayout, type InlinePreviewState } from './inline-preview'

interface InlinePreviewWorkspaceProps {
  sessionId: string
  preview: InlinePreviewState
  width: number
  onClose: () => void
  renderList: (listWidth: number) => React.ReactNode
}

export function InlinePreviewWorkspace({ sessionId, preview, width, onClose, renderList }: InlinePreviewWorkspaceProps): React.ReactElement {
  const { drawer, listWidth } = getInlinePreviewLayout(width)
  const [listOpen, setListOpen] = React.useState(true)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const listLabel = preview.source === 'changes' ? '文件改动列表' : '文件列表'

  React.useEffect(() => {
    setDrawerOpen(false)
  }, [drawer])

  const expanded = drawer ? drawerOpen : listOpen
  const toggleButton = (
    <button
      type="button"
      aria-label={listLabel}
      aria-expanded={expanded}
      onClick={drawer ? undefined : () => setListOpen((open) => !open)}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
    >
      <PanelRight className="size-4" />
    </button>
  )
  const toggleWithTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>
        {drawer ? <PopoverTrigger asChild>{toggleButton}</PopoverTrigger> : toggleButton}
      </TooltipTrigger>
      <TooltipContent side="bottom">{expanded ? '收起' : '展开'}{listLabel}</TooltipContent>
    </Tooltip>
  )
  const toolbarActions = drawer ? (
    <Popover open={drawerOpen} onOpenChange={setDrawerOpen}>
      {toggleWithTooltip}
      <PopoverContent
        align="end"
        aria-label={listLabel}
        style={{ width: listWidth }}
        className="flex h-[min(560px,var(--radix-popover-content-available-height))] max-w-[calc(100vw-24px)] flex-col overflow-hidden p-0"
      >
        {renderList(listWidth)}
      </PopoverContent>
    </Popover>
  ) : toggleWithTooltip

  return (
    <div
      className="flex h-full min-h-0 min-w-0 overflow-hidden bg-content-area"
      aria-label={`${preview.source === 'changes' ? '文件改动' : '文件'}内联预览`}
    >
      <section className="min-h-0 min-w-0 flex-1" aria-label={`预览：${preview.file.filePath}`}>
        <PreviewPanel sessionId={sessionId} file={preview.file} onClose={onClose} compact toolbarActions={toolbarActions} />
      </section>
      {!drawer && (
        <aside
          style={{ width: listWidth }}
          className={cn('flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/70 bg-muted/[0.12]', !listOpen && 'hidden')}
          aria-label={listLabel}
        >
          {renderList(listWidth)}
        </aside>
      )}
    </div>
  )
}
