/**
 * WorkspaceLauncher — 右侧工作区「新建标签页」。
 *
 * 对齐商业版 0.22.0 的 `iYt` / `xge`：所有入口都是居中的单列卡片，
 * 每张卡片由图标、标题和一句说明组成，点开即进入对应面板。
 * 网页地址栏在浏览器标签页顶部，启动器本身不再承担输入地址的职责。
 */

import * as React from 'react'
import { atom, useAtomValue } from 'jotai'
import { Compass, FileText, Globe, SquareTerminal } from 'lucide-react'
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

/** 推荐网站卡片最多展示 3 个，避免启动器在纵向滚动里淹没常用工具。 */
const LAUNCHER_SITE_LIMIT = 3

const LAUNCHER_CARD_CLASS = 'group flex min-h-14 w-full max-w-[380px] items-center gap-3.5 rounded-2xl bg-background px-5 py-3 text-left shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)] outline-none transition-[background-color,box-shadow] duration-150 hover:bg-muted/40 hover:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.12)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-content-area active:scale-[0.995]'

function getSiteHostname(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return origin
  }
}

/** 启动器卡片：图标 + 标题 + 可选说明，整块可点。 */
function LauncherCard({ icon, title, description, onClick }: {
  icon: React.ReactNode
  title: string
  description?: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={LAUNCHER_CARD_CLASS} title={title}>
      <span className="flex size-[26px] shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-medium text-foreground">{title}</span>
        {description !== undefined && (
          <span className="truncate text-[12px] leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
    </button>
  )
}

export function WorkspaceLauncher({ onOpenBrowser, onOpenFiles, onOpenTerminal, onOpenVault }: WorkspaceLauncherProps): React.ReactElement {
  const storedSites = useAtomValue(browserFrequentSitesAtom)
  const sites = React.useMemo(() => getFrequentSites(storedSites).slice(0, LAUNCHER_SITE_LIMIT), [storedSites])

  return (
    <div className="workspace-launcher min-h-0 flex-1 overflow-y-auto bg-content-area">
      <section
        aria-label="新建标签页"
        className="mx-auto flex min-h-full w-full max-w-[420px] flex-col items-center justify-center gap-3.5 px-6 py-10"
      >
        <Compass
          className="mb-4 size-14 text-foreground/[0.12]"
          strokeWidth={1.25}
          aria-hidden="true"
        />
        <LauncherCard
          icon={<FileText className="size-5 text-amber-500" />}
          title="文件"
          description="浏览项目与会话中的文件"
          onClick={onOpenFiles}
        />
        <LauncherCard
          icon={<SquareTerminal className="size-5 text-blue-500" />}
          title="终端"
          description="在当前会话目录中运行命令"
          onClick={onOpenTerminal}
        />
        <LauncherCard
          icon={<Globe className="size-5 text-blue-500" />}
          title="浏览器"
          description="打开网页，地址栏在页面顶部"
          onClick={() => onOpenBrowser()}
        />
        {onOpenVault && (
          <LauncherCard
            icon={<ObsidianIcon className="size-5 text-violet-500" />}
            title={OBSIDIAN_NAME}
            description="浏览与编辑 Obsidian 笔记"
            onClick={onOpenVault}
          />
        )}
        {sites.map((site) => (
          <LauncherCard
            key={site.origin}
            icon={<Globe className="size-5 text-muted-foreground" />}
            title={getSiteHostname(site.origin)}
            onClick={() => onOpenBrowser(site.origin)}
          />
        ))}
      </section>
    </div>
  )
}