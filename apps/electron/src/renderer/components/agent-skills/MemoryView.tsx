/**
 * MemoryView — 「记忆」独立整页（对齐商业版 0.21.88 Vtn）。
 *
 * 结构：h-10 chrome 标题条（MemoryPageHeader，商业版 B9）+ 下方 bg-content-area 内容表面；
 * 内容区是「关于你 / 当前项目」两段 Tab。左侧只有 rail，没有会话面板。
 */

import * as React from 'react'
import { atom, useAtom, useAtomValue } from 'jotai'
import { LibraryBig } from 'lucide-react'
import { agentWorkspacesAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { memoryFileNavigationAtom } from '@/atoms/memory-change-atoms'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { GlobalProfilePanel } from './GlobalProfilePanel'
import { ProjectMemoryPanel } from './WorkspaceMemoryTab'

/** 商业版 jR：整页内容区的水平内边距。 */
const PAGE_CONTENT_PADDING = 'px-5 sm:px-6 xl:px-8'

type MemoryViewTab = 'global' | 'project'

/** 商业版 Dtn：记忆页当前分段，离开页面后保留。 */
const memoryViewTabAtom = atom<MemoryViewTab>('global')

interface MemoryPageHeaderProps {
  icon?: React.ReactNode
  title: string
  titleClassName?: string
  subtitle?: string
  context?: React.ReactNode
  actions?: React.ReactNode
  draggable?: boolean
  className?: string
}

/** 商业版 B9：整页视图顶部的 h-10 chrome 条，标题紧贴在红绿灯右侧。 */
function MemoryPageHeader({
  icon,
  title,
  titleClassName,
  subtitle,
  context,
  actions,
  draggable = false,
  className,
}: MemoryPageHeaderProps): React.ReactElement {
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
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.045] text-foreground/70">{icon}</span>
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

export function MemoryView(): React.ReactElement {
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const navigationRequest = useAtomValue(memoryFileNavigationAtom)
  const [tab, setTab] = useAtom(memoryViewTabAtom)
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId)
  // Dev 的画像 IPC 需要项目上下文；未选项目时退回第一个项目。
  const profileWorkspaceSlug = workspace?.slug ?? workspaces[0]?.slug ?? ''

  // 从记忆变更等入口跳转到具体文件时，切到「当前项目」。
  React.useEffect(() => {
    if (navigationRequest) setTab('project')
  }, [navigationRequest, setTab])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden proma-chrome-surface">
      <MemoryPageHeader title="记忆" titleClassName="text-[15px]" subtitle="管理 Agent 对你的了解与项目知识" draggable />
      <main className={cn('min-h-0 flex-1 overflow-hidden bg-content-area py-4 sm:py-5', PAGE_CONTENT_PADDING)}>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as MemoryViewTab)}
          className="flex h-full min-h-0 w-full flex-col gap-5"
        >
          <TabsList className="h-12 shrink-0 self-start rounded-xl p-1">
            <TabsTrigger value="global" className="h-10 min-w-32 rounded-lg px-7 text-base">关于你</TabsTrigger>
            <TabsTrigger value="project" className="h-10 min-w-32 rounded-lg px-7 text-base">当前项目</TabsTrigger>
          </TabsList>
          <TabsContent value="global" forceMount className="m-0 min-h-0 flex-1 data-[state=inactive]:hidden">
            {profileWorkspaceSlug ? (
              <GlobalProfilePanel workspaceSlug={profileWorkspaceSlug} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">读取用户画像中…</div>
            )}
          </TabsContent>
          <TabsContent value="project" className="m-0 min-h-0 flex-1 overflow-hidden">
            {workspace ? (
              <ProjectMemoryPanel key={workspace.slug} workspaceSlug={workspace.slug} projectName={workspace.name} fullScreen />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-base text-muted-foreground">
                <LibraryBig className="size-10 opacity-40" />
                <p>请选择一个项目，查看它的协作知识与项目偏好。</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
