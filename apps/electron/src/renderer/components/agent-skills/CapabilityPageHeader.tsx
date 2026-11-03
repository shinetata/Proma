/**
 * CapabilityPageHeader — 能力中心主区顶部的 h-10 chrome 条。
 *
 * 对应商业版页面头部组件 B9：灰色 chrome 表面上放页面图标、标题、上下文标签与右侧操作；
 * subtitle 仅保留给无障碍与后续复用，视觉上隐藏。Windows 下不显示图标并收窄内边距。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@/lib/platform'

interface CapabilityPageHeaderProps {
  icon?: React.ReactNode
  title: React.ReactNode
  titleClassName?: string
  subtitle?: React.ReactNode
  context?: React.ReactNode
  actions?: React.ReactNode
  draggable?: boolean
  className?: string
}

export function CapabilityPageHeader({
  icon,
  title,
  titleClassName,
  subtitle,
  context,
  actions,
  draggable = false,
  className,
}: CapabilityPageHeaderProps): React.ReactElement {
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  return (
    <header
      className={cn(
        'flex h-10 shrink-0 items-center gap-2.5 proma-chrome-surface',
        isWindows ? 'px-3' : 'px-5 sm:px-6 xl:px-8',
        draggable ? 'titlebar-drag-region' : 'titlebar-no-drag',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {!isWindows && icon && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.045] text-foreground/70">
            {icon}
          </span>
        )}
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
