/**
 * 左侧 Rail 基础组件 — 复刻商业版 0.21.88
 *
 * - SidebarRailButton：rail 上的 40px 图标按钮（商业版 `Mu`）
 * - SidebarRailEntry：带右侧 Tooltip 的导航入口（商业版 `xv`）
 * - SidebarRailUpdateButton：rail 底部的更新状态入口（商业版 `poe`）
 * - SidebarNewTaskButton：会话面板顶部的「新建任务」按钮（商业版 `yrt`）
 */

import * as React from 'react'
import { ArrowDownToLine, Check, Clock3, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeycaps } from '@/components/shortcuts/ShortcutKeycaps'
import type { UpdateStatus } from '@/atoms/updater'

/** Rail 固定宽度（商业版 `j1`） */
export const SIDEBAR_RAIL_WIDTH = 60
/** 窗口拖拽条高度（商业版 `Zfe`） */
export const SIDEBAR_RAIL_DRAG_STRIP_HEIGHT = 54

/** 面板顶部「新建任务 / 搜索」按钮共享的表面样式（商业版 `Uwe`） */
export const SIDEBAR_ACTION_SURFACE_CLASS = 'rounded-xl border border-foreground/[0.08] bg-foreground/[0.06] text-foreground/85 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[background-color,border-color,box-shadow,color,transform] duration-150 hover:border-foreground/[0.14] hover:bg-foreground/[0.09] hover:text-foreground hover:shadow-[0_2px_4px_rgb(0_0_0/0.05)] active:scale-[0.96]'

export interface SidebarRailButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode
  active?: boolean
  attention?: boolean
  dropActive?: boolean
  badge?: React.ReactNode
}

export const SidebarRailButton = React.forwardRef<HTMLButtonElement, SidebarRailButtonProps>(
  function SidebarRailButton({ icon, active, attention, dropActive, badge, children, className, ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        data-active={active ? 'true' : undefined}
        className={cn(
          'sidebar-rail-button sidebar-rail-entry titlebar-no-drag',
          attention && 'sidebar-rail-entry-attention',
          dropActive && 'sidebar-rail-entry-drop-active',
          className,
        )}
      >
        <span className="sidebar-rail-content">
          {icon && <span className="sidebar-rail-icon" aria-hidden="true">{icon}</span>}
          {children}
        </span>
        {badge}
      </button>
    )
  },
)

export interface SidebarRailEntryProps {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  badge?: React.ReactNode
  tooltipLabel?: string
  dropActive?: boolean
  onDragEnter?: React.DragEventHandler<HTMLButtonElement>
  onDragLeave?: React.DragEventHandler<HTMLButtonElement>
  onDragOver?: React.DragEventHandler<HTMLButtonElement>
  onDrop?: React.DragEventHandler<HTMLButtonElement>
}

export function SidebarRailEntry({
  label,
  icon,
  active,
  onClick,
  badge,
  tooltipLabel,
  dropActive = false,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
}: SidebarRailEntryProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarRailButton
          aria-label={dropActive ? '收藏此会话' : label}
          onClick={onClick}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          active={active}
          dropActive={dropActive}
          icon={icon}
          badge={badge}
        />
      </TooltipTrigger>
      <TooltipContent side="right">{dropActive ? '收藏此会话' : tooltipLabel ?? label}</TooltipContent>
    </Tooltip>
  )
}

function getUpdatePercent(status: UpdateStatus): number | null {
  const percent = status.progress?.percent
  if (percent === undefined || !Number.isFinite(percent)) return null
  return Math.max(0, Math.min(100, percent))
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function getUpdateProgressText(status: UpdateStatus): { size: string; speed: string } {
  const progress = status.progress
  if (!progress) return { size: '正在准备下载', speed: '' }
  const size = Number.isFinite(progress.total) && progress.total > 0
    ? `${formatBytes(Math.min(Math.max(0, progress.transferred), progress.total))} / ${formatBytes(progress.total)}`
    : `已下载 ${formatBytes(progress.transferred)}`
  const speed = Number.isFinite(progress.bytesPerSecond) && progress.bytesPerSecond > 0
    ? `${formatBytes(progress.bytesPerSecond)}/s`
    : ''
  return { size, speed }
}

function formatUpdateVersion(version?: string): string | null {
  const trimmed = version?.trim()
  if (!trimmed) return null
  return /^v?\d/.test(trimmed) ? `v${trimmed.replace(/^v/, '')}` : trimmed
}

function getUpdateTitle(status: UpdateStatus): string {
  switch (status.status) {
    case 'downloading':
      return '正在下载更新'
    case 'downloaded':
      return status.installScheduled ? '已安排空闲时更新' : '更新已就绪'
    case 'available':
      return '发现新版本'
    case 'checking':
      return '正在检查更新'
    case 'not-available':
      return '已是最新版本'
    case 'error':
      return '更新暂时不可用'
    default:
      return '软件更新'
  }
}

export function SidebarRailUpdateButton({ status, onClick }: { status: UpdateStatus; onClick: () => void }): React.ReactElement {
  const downloading = status.status === 'downloading'
  const downloaded = status.status === 'downloaded'
  const percent = getUpdatePercent(status)
  const progressText = getUpdateProgressText(status)
  const title = getUpdateTitle(status)
  const version = formatUpdateVersion(status.version)
  const percentText = downloading && percent !== null ? ` ${Math.floor(percent)}%` : ''
  const label = `${title}${version ? ` ${version}` : ''}${percentText}，查看更新详情`
  const circumference = 2 * Math.PI * 12

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarRailButton
          aria-label={label}
          onClick={onClick}
          attention={downloaded && !status.installScheduled}
          icon={downloading ? (
            <span className="relative flex size-7 items-center justify-center text-foreground/70">
              <svg
                viewBox="0 0 28 28"
                className={cn('absolute inset-0 size-7 -rotate-90', percent === null && 'animate-spin motion-reduce:animate-none')}
                aria-hidden="true"
              >
                <circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" strokeWidth="1.7" opacity="0.12" />
                <circle
                  cx="14"
                  cy="14"
                  r="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - (percent ?? 22) / 100)}
                  className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
                />
              </svg>
            </span>
          ) : downloaded ? (
            status.installScheduled ? <Clock3 size={18} /> : <Check size={18} />
          ) : (
            <ArrowDownToLine size={18} />
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64 px-3 py-2">
        <div className="flex items-center justify-between gap-4 text-xs">
          <span>{title}</span>
          {percentText && <span className="tabular-nums">{percentText.trim()}</span>}
        </div>
        <div className="mt-1 text-[10px] opacity-70">
          {version ? `${version} · ` : ''}点击查看详情
        </div>
        {downloading && (
          <div className="mt-1.5 flex justify-between gap-4 text-[10px] tabular-nums opacity-70">
            <span>{progressText.size}</span>
            <span>{progressText.speed}</span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarNewTaskButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label="新建任务"
      onClick={onClick}
      className={cn(SIDEBAR_ACTION_SURFACE_CLASS, 'titlebar-no-drag h-10 min-w-0 flex-1 justify-start gap-2 px-2.5 text-[13px] font-semibold')}
    >
      <Plus size={16} className="opacity-80" aria-hidden="true" />
      <span className="min-w-0 truncate">新建任务</span>
      <ShortcutKeycaps
        shortcutId="new-session"
        className="ml-auto shrink-0 flex-nowrap gap-0.5"
        keycapClassName="h-5 min-w-4 border-foreground/[0.08] bg-background/60 px-1 text-[11px] text-foreground/60 shadow-none"
        separatorClassName="text-[10px] text-muted-foreground/50"
      />
    </Button>
  )
}

