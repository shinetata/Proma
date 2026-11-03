/**
 * UpdateStatusCard - 软件更新状态卡
 *
 * 复刻商业版共享更新卡：图标 + 标题/版本徽标 + 说明，下载中显示进度条，
 * 底部操作区放「更新内容」与主操作（检查更新 / 前往下载 / 空闲时更新 / 取消安排）。
 */

import * as React from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DownloadProgress, UpdateStatus } from '@/atoms/updater'

/** 下载百分比（0-100），无效时返回 null */
export function getUpdateProgressPercent(progress?: DownloadProgress): number | null {
  if (!progress || !Number.isFinite(progress.percent)) return null
  return Math.max(0, Math.min(100, progress.percent))
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** 下载体积与速度文案 */
export function getUpdateProgressText(progress?: DownloadProgress): { size: string; speed: string } {
  if (!progress) return { size: '正在准备下载', speed: '' }
  const size = Number.isFinite(progress.total) && progress.total > 0
    ? `${formatBytes(Math.min(Math.max(0, progress.transferred), progress.total))} / ${formatBytes(progress.total)}`
    : `已下载 ${formatBytes(progress.transferred)}`
  const speed = Number.isFinite(progress.bytesPerSecond) && progress.bytesPerSecond > 0
    ? `${formatBytes(progress.bytesPerSecond)}/s`
    : ''
  return { size, speed }
}

/** 版本号徽标文案：数字开头统一补 v 前缀 */
export function formatUpdateVersion(version?: string): string | null {
  const trimmed = version?.trim()
  if (!trimmed) return null
  return /^v?\d/.test(trimmed) ? `v${trimmed.replace(/^v/, '')}` : trimmed
}

/** 各状态的标题与说明 */
export function getUpdateStatusCopy(status: UpdateStatus): { title: string; description: string } {
  switch (status.status) {
    case 'downloading':
      return { title: '正在下载更新', description: '下载在后台进行，你可以继续工作。' }
    case 'downloaded':
      return status.installScheduled
        ? { title: '已安排空闲时更新', description: '所有 Agent 完成后，将自动重启安装。' }
        : { title: '更新已就绪', description: '安装包已下载，空闲时即可重启更新。' }
    case 'available':
      return { title: '发现新版本', description: '正在准备更新，也可以前往官网下载。' }
    case 'checking':
      return { title: '正在检查更新', description: '正在获取最新版本信息…' }
    case 'not-available':
      return { title: '已是最新版本', description: '当前已安装最新版本的 Proma。' }
    case 'error':
      return { title: '更新暂时不可用', description: '请稍后重试，或检查网络连接。' }
    default:
      return { title: '软件更新', description: '检查是否有新版本可用。' }
  }
}

interface UpdateStatusCardProps {
  status: UpdateStatus
  /** 手动检查中（覆盖为 checking 展示） */
  checking?: boolean
  onCheck?: () => void
  onDownload?: () => void
  onInstall?: () => void
  onCancelInstall?: () => void
  onViewReleaseNotes?: () => void
  onDismiss?: () => void
}

export function UpdateStatusCard({
  status,
  checking = false,
  onCheck,
  onDownload,
  onInstall,
  onCancelInstall,
  onViewReleaseNotes,
  onDismiss,
}: UpdateStatusCardProps): React.ReactElement {
  const view: UpdateStatus = checking ? { ...status, status: 'checking' } : status
  const { title, description } = getUpdateStatusCopy(view)
  const versionLabel = formatUpdateVersion(status.version)
  const isDownloading = view.status === 'downloading'
  const isDownloaded = view.status === 'downloaded'
  const isScheduled = isDownloaded && status.installScheduled
  const percent = getUpdateProgressPercent(status.progress)
  const progressText = getUpdateProgressText(status.progress)

  const Icon: LucideIcon = view.status === 'checking'
    ? LoaderCircle
    : isScheduled
      ? Clock3
      : isDownloaded || view.status === 'not-available'
        ? Check
        : view.status === 'error'
          ? CircleAlert
          : ArrowDownToLine

  const primaryAction = isDownloaded
    ? isScheduled
      ? onCancelInstall && (
          <Button size="sm" variant="outline" className="rounded-lg" onClick={onCancelInstall}>
            取消安排
          </Button>
        )
      : onInstall && (
          <Button size="sm" className="rounded-lg" onClick={onInstall}>
            空闲时更新
          </Button>
        )
    : view.status === 'available'
      ? onDownload && (
          <Button size="sm" className="rounded-lg" onClick={onDownload}>
            前往下载
            <ArrowUpRight />
          </Button>
        )
      : !isDownloading && onCheck && (
          <Button
            size="sm"
            variant="outline"
            className="rounded-lg"
            disabled={view.status === 'checking'}
            onClick={onCheck}
          >
            <RefreshCw className={view.status === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined} />
            {view.status === 'checking' ? '检查中' : '检查更新'}
          </Button>
        )

  return (
    <section className="p-4" aria-label="软件更新">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.045] text-foreground/75',
            view.status === 'error' && 'text-destructive',
          )}
        >
          <Icon
            size={18}
            strokeWidth={1.7}
            className={view.status === 'checking' ? 'animate-spin motion-reduce:animate-none' : undefined}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[13px] font-semibold leading-5 tracking-tight">{title}</h3>
            {versionLabel && (
              <span className="rounded-md bg-foreground/[0.045] px-1.5 py-0.5 text-[10px] font-medium leading-4 tabular-nums text-muted-foreground">
                {versionLabel}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        {onDismiss && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="-mr-1 -mt-1 shrink-0 rounded-lg text-muted-foreground"
            aria-label="稍后提醒"
            onClick={onDismiss}
          >
            <X size={14} />
          </Button>
        )}
      </div>

      {isDownloading && (
        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {percent === null ? '正在连接下载' : percent === 100 ? '下载收尾中' : '下载进度'}
            </span>
            <span className="font-medium tabular-nums">{percent === null ? '—' : `${Math.floor(percent)}%`}</span>
          </div>
          <div
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
          >
            <div
              className={cn(
                'h-full rounded-full bg-foreground/75 transition-[width] duration-500 ease-out motion-reduce:transition-none',
                percent === null && 'animate-pulse motion-reduce:animate-none',
              )}
              style={{ width: percent === null ? '30%' : `${percent}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
            <span>{progressText.size}</span>
            <span>{progressText.speed}</span>
          </div>
        </div>
      )}

      {(primaryAction || onViewReleaseNotes) && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border/40 pt-3">
          {onViewReleaseNotes && (
            <Button
              size="sm"
              variant="ghost"
              className="mr-auto rounded-lg px-1 text-muted-foreground"
              onClick={onViewReleaseNotes}
            >
              更新内容
              <ArrowUpRight />
            </Button>
          )}
          {primaryAction}
        </div>
      )}
    </section>
  )
}
