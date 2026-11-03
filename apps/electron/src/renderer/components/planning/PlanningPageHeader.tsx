import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { detectIsMac, detectIsWindows } from '@/lib/platform'
import { shortcutOverridesAtom } from '@/atoms/shortcut-atoms'
import { getActiveAccelerator } from '@/lib/shortcut-registry'
import { ShortcutKeycaps } from '@/components/shortcuts/ShortcutKeycaps'

const IS_MAC = detectIsMac()

/** Electron accelerator → aria-keyshortcuts（商业版 vrt）。 */
function toAriaKeyShortcuts(accelerator: string | null): string | undefined {
  if (!accelerator) return undefined
  const keys = accelerator.split('+').map((part) => {
    const key = part.trim().toLowerCase()
    if (['cmd', 'command', 'meta', 'super'].includes(key)) return 'Meta'
    if (['ctrl', 'control'].includes(key)) return 'Control'
    if (['cmdorctrl', 'commandorcontrol'].includes(key)) return IS_MAC ? 'Meta' : 'Control'
    if (key === 'shift') return 'Shift'
    if (['alt', 'option'].includes(key)) return 'Alt'
    if (key === 'return') return 'Enter'
    if (key === 'esc') return 'Escape'
    if (key === 'space') return 'Space'
    return part.trim()
  }).filter(Boolean)
  return keys.length > 0 ? keys.join('+') : undefined
}

interface PlanningCreateButtonProps {
  label: string
  onClick: () => void
  /** 默认展示「新建会话」快捷键；传 null 隐藏快捷键。 */
  shortcutId?: string | null
  ariaKeyShortcuts?: string
  title?: string
  disabled?: boolean
}

/** 页头主操作按钮：黑底「+ 新建 X ⌘ + N」（对齐商业版 Hw）。 */
export function PlanningCreateButton({ label, onClick, shortcutId, ariaKeyShortcuts, title, disabled = false }: PlanningCreateButtonProps): React.ReactElement {
  useAtomValue(shortcutOverridesAtom)
  const resolvedShortcutId = shortcutId === undefined ? 'new-session' : shortcutId
  const accelerator = resolvedShortcutId ? getActiveAccelerator(resolvedShortcutId) : null
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      aria-keyshortcuts={ariaKeyShortcuts ?? toAriaKeyShortcuts(accelerator)}
      title={title}
      disabled={disabled}
      className="relative inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-sm transition-[transform,background-color] hover:bg-primary/90 active:scale-[0.96] disabled:cursor-wait disabled:opacity-60 after:absolute after:-inset-1 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <Plus size={14} /> {label}
      {resolvedShortcutId && (
        <ShortcutKeycaps
          shortcutId={resolvedShortcutId}
          className="ml-1"
          keycapClassName="h-5 min-w-5 rounded-[3px] border-primary-foreground/30 bg-primary-foreground/10 px-1 text-[10px] text-primary-foreground shadow-none"
          separatorClassName="text-primary-foreground/70"
        />
      )}
    </button>
  )
}

interface PlanningPageHeaderProps {
  icon?: React.ReactNode
  title: React.ReactNode
  titleClassName?: string
  subtitle?: React.ReactNode
  context?: React.ReactNode
  actions?: React.ReactNode
  /** 独立页面的页头作为窗口拖拽区；嵌入右侧面板时关闭。 */
  draggable?: boolean
  className?: string
}

/** 整页视图顶部 h-10 chrome 条：标题紧贴红绿灯右侧，右侧放主操作（对齐商业版 B9）。 */
export function PlanningPageHeader({ icon, title, titleClassName, subtitle, context, actions, draggable = false, className }: PlanningPageHeaderProps): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  return (
    <header className={cn('flex h-10 shrink-0 items-center gap-2.5 proma-chrome-surface', isWindows ? 'px-3' : 'px-5 sm:px-6 xl:px-8', draggable ? 'titlebar-drag-region' : 'titlebar-no-drag', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {!isWindows && icon && <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.045] text-foreground/70">{icon}</span>}
        <div className="min-w-0">
          <div className={cn('truncate text-[15px] font-semibold tracking-tight text-foreground', titleClassName)}>{title}</div>
          {subtitle && <div className="hidden">{subtitle}</div>}
        </div>
      </div>
      {context && <div className="hidden min-w-0 flex-1 items-center gap-2 lg:flex">{context}</div>}
      {actions && <div className="titlebar-no-drag ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
