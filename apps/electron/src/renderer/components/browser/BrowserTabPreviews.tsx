import * as React from 'react'
import type { BrowserTabSummary } from '@proma/shared'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 缩略图刷新间隔；主进程内部还有 700ms 缓存，实际抓取频率低于此值。 */
const PREVIEW_REFRESH_INTERVAL_MS = 2_500

interface BrowserTabPreviewsProps {
  sessionId: string
  tabs: BrowserTabSummary[]
  activeTabId: string
  onSelect: (tabId: string) => void
}

/**
 * 浏览器标签缩略图条
 *
 * 只抓取未挂载到 BrowserSlot 的标签：当前标签本身就在面板里可见，无需截图。
 * 抓取失败或页面尚未就绪时保留占位图标，不阻塞面板交互。
 */
export function BrowserTabPreviews({ sessionId, tabs, activeTabId, onSelect }: BrowserTabPreviewsProps): React.ReactElement | null {
  const [frames, setFrames] = React.useState<Record<string, string>>({})
  // 依赖签名只由真正影响缩略图的字段构成，避免 drag/scroll 等无关状态触发重抓。
  const targetsSignature = tabs.map((tab) => `${tab.tabId}:${tab.url}:${tab.loading ? 1 : 0}`).join('|')

  React.useEffect(() => {
    let cancelled = false
    const pending = new Set<string>()

    const capture = async (): Promise<void> => {
      const getPreview = (window.electronAPI as Partial<typeof window.electronAPI>).getAgentBrowserPreview
      if (typeof getPreview !== 'function') return
      for (const tab of tabs) {
        if (cancelled) return
        if (tab.tabId === activeTabId) continue
        if (!tab.url || tab.url === 'about:blank') continue
        if (pending.has(tab.tabId)) continue
        pending.add(tab.tabId)
        try {
          const frame = await getPreview({ sessionId, tabId: tab.tabId })
          if (cancelled || !frame) continue
          if (frame.url !== tab.url) continue
          setFrames((previous) => (previous[tab.tabId] === frame.imageDataUrl ? previous : { ...previous, [tab.tabId]: frame.imageDataUrl }))
        } catch {
          // 缩略图只是辅助信息，失败时保留上一帧。
        } finally {
          pending.delete(tab.tabId)
        }
      }
    }

    void capture()
    const timer = setInterval(() => void capture(), PREVIEW_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // targetsSignature 覆盖 url 与 loading 变化，是重新抓取的唯一触发条件。
  }, [activeTabId, sessionId, targetsSignature])

  if (tabs.length < 2) return null

  return (
    <div className="flex shrink-0 items-stretch gap-1.5 overflow-x-auto border-b border-border/40 bg-muted/10 px-2 py-1.5" aria-label="浏览器标签预览">
      {tabs.map((tab) => {
        const isActive = tab.tabId === activeTabId
        const preview = frames[tab.tabId]
        return (
          <button
            key={tab.tabId}
            type="button"
            onClick={() => { if (!isActive) onSelect(tab.tabId) }}
            title={tab.title || '新建标签页'}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'group flex w-[112px] shrink-0 flex-col gap-1 rounded-md border p-1 text-left transition-colors',
              isActive
                ? 'border-foreground/25 bg-background'
                : 'border-transparent bg-background/50 hover:border-border/70 hover:bg-background/80',
            )}
          >
            <div className="relative h-[62px] w-full overflow-hidden rounded-sm bg-muted/40 ring-1 ring-inset ring-border/30">
              {preview ? (
                <img src={preview} alt="" className="size-full object-cover object-top" />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground/35">
                  <Globe className="size-4" />
                </div>
              )}
              {tab.loading && <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-foreground/30" />}
            </div>
            <span className={cn('truncate px-0.5 text-[11px] leading-4', isActive ? 'text-foreground/80' : 'text-muted-foreground/80')}>
              {tab.title || '新建标签页'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
