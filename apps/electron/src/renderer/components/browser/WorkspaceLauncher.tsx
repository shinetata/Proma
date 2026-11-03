/**
 * WorkspaceLauncher — 右侧工作区「新建标签页」。
 *
 * 对齐商业版 0.21.88 的 `vZt`：顶部地址/搜索框直接在受管浏览器中打开；
 * 「工具」区打开文件、终端与 Obsidian；「推荐」区展示最近 30 天常访问的网站。
 */

import * as React from 'react'
import { atom, useAtomValue } from 'jotai'
import { ArrowRight, FileText, Globe, Search, SquareTerminal } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { OBSIDIAN_NAME, ObsidianIcon } from '@/components/obsidian/obsidian-brand'
import type { AgentSidePanelTab } from '@/atoms/agent-atoms'
import { browserFrequentSitesAtom, getFrequentSites } from './browser-frequent-sites'

/** 每个会话当前打开的「新建标签页」ID 列表；仅存在于内存，与商业版一致。 */
export const workspaceLauncherTabsMapAtom = atom<Map<string, string[]>>(new Map())

export function getLauncherSidePanelTab(launcherId: string): AgentSidePanelTab {
  return `launcher:${launcherId}`
}

export function getLauncherIdFromSidePanelTab(tab: AgentSidePanelTab | 'browser' | 'preview'): string | null {
  return tab.startsWith('launcher:') ? tab.slice('launcher:'.length) : null
}

interface WorkspaceLauncherProps {
  onOpenBrowser: (url?: string) => void
  onOpenFiles: () => void
  onOpenTerminal: () => void
  onOpenVault?: () => void
}

const TOOL_BUTTON_CLASS = 'group flex min-h-24 min-w-0 items-center gap-4 rounded-2xl bg-background px-5 text-left shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)] outline-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-muted/55 hover:shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.4),0_5px_14px_rgba(0,0,0,0.06)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96]'
const TOOL_ICON_CLASS = 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-[color,transform] duration-150 group-hover:scale-105 group-hover:text-foreground'

function getSiteHostname(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

function LauncherTool({ icon, title, description, onClick }: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={TOOL_BUTTON_CLASS}>
      <span className={TOOL_ICON_CLASS}>{icon}</span>
      <span>
        <span className="block text-[15px] font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

export function WorkspaceLauncher({ onOpenBrowser, onOpenFiles, onOpenTerminal, onOpenVault }: WorkspaceLauncherProps): React.ReactElement {
  const storedSites = useAtomValue(browserFrequentSitesAtom)
  const sites = React.useMemo(() => getFrequentSites(storedSites), [storedSites])
  const [query, setQuery] = React.useState('')

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault()
    const value = query.trim()
    if (value) onOpenBrowser(value)
  }, [onOpenBrowser, query])

  return (
    <div className="workspace-launcher min-h-0 flex-1 overflow-y-auto bg-content-area p-4">
      <section className="mx-auto w-full max-w-5xl space-y-6" aria-label="新建标签页">
        <form onSubmit={handleSubmit} className="relative mx-auto max-w-3xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索或输入网址"
            aria-label="搜索或输入网址"
            className="h-12 rounded-2xl border-border/70 bg-background pl-11 pr-12 text-[15px] shadow-sm transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/75 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={!query.trim()}
            className="absolute right-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground transition-[background-color,color,transform,opacity] duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 active:scale-[0.96]"
            aria-label="打开地址"
          >
            <ArrowRight className="size-4" />
          </button>
        </form>

        <section aria-labelledby="launcher-tools-title">
          <h2 id="launcher-tools-title" className="mb-3 text-[15px] font-semibold text-foreground">工具</h2>
          <div className="workspace-launcher-tools grid gap-3">
            <LauncherTool icon={<FileText className="size-5" />} title="文件" description="浏览项目与会话中的文件" onClick={onOpenFiles} />
            <LauncherTool icon={<SquareTerminal className="size-5" />} title="终端" description="在当前会话目录中运行命令" onClick={onOpenTerminal} />
            {onOpenVault && (
              <LauncherTool icon={<ObsidianIcon className="size-5" />} title={OBSIDIAN_NAME} description="浏览与编辑 Obsidian 笔记" onClick={onOpenVault} />
            )}
          </div>
        </section>

        <section aria-labelledby="launcher-recommendations-title">
          <h2 id="launcher-recommendations-title" className="mb-3 text-[15px] font-semibold text-foreground">推荐</h2>
          {sites.length > 0 ? (
            <div className="workspace-launcher-sites grid gap-3">
              {sites.slice(0, 6).map((site) => {
                const hostname = getSiteHostname(site.origin)
                return (
                  <button
                    key={site.origin}
                    type="button"
                    onClick={() => onOpenBrowser(site.origin)}
                    className="group flex min-h-28 min-w-0 flex-col items-center rounded-2xl bg-transparent px-3 py-4 text-center outline-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96]"
                    title={hostname}
                  >
                    <span className={TOOL_ICON_CLASS}><Globe className="size-5" /></span>
                    <span className="mt-3 w-full truncate text-[15px] font-medium text-foreground">{hostname}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-28 items-center justify-center rounded-2xl bg-muted/25 px-5 text-center text-[13px] leading-5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]">
              浏览网页后，常访问的网站会显示在这里。
            </div>
          )}
        </section>
      </section>
    </div>
  )
}
