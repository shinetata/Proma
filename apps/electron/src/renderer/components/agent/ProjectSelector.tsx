/**
 * ProjectSelector — 空会话输入区上方的当前项目切换器
 *
 * 对齐商业版 Proma 0.22.0：胶囊触发器 + 顶部弹出项目列表，支持切换、
 * 新建空白项目、从本地文件夹添加。切换到目标项目时，若该项目下已有
 * 未归档的 draft 会话（排除当前会话本身）则直接复用，避免每次切换
 * 都堆一个空会话。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Check, ChevronDown, FolderInput, FolderOpen, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { useProjectActions } from '@/hooks/useProjectActions'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import { LocalProjectBadge } from './LocalProjectBadge'

interface ProjectSelectorProps {
  sessionId: string
}

export function ProjectSelector({ sessionId }: ProjectSelectorProps): React.ReactElement {
  const { workspaces, currentWorkspaceId, selectProject, createProject, createProjectFromFolder } = useProjectActions()
  const sessions = useAtomValue(agentSessionsAtom)
  const { createAgent } = useCreateSession()
  const openSession = useOpenSession()

  const [open, setOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [newName, setNewName] = React.useState('')
  const [creatingFromFolder, setCreatingFromFolder] = React.useState(false)
  const createInputRef = React.useRef<HTMLInputElement>(null)
  const currentItemRef = React.useRef<HTMLButtonElement>(null)

  const current = workspaces.find((w) => w.id === currentWorkspaceId)

  // 打开时把当前项目滚入视野
  React.useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => currentItemRef.current?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(raf)
  }, [open])

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setCreating(false)
      setNewName('')
    }
  }, [])

  const handleSelect = React.useCallback(
    (workspaceId: string) => {
      setOpen(false)
      if (!workspaceId || workspaceId === currentWorkspaceId) return
      // 该项目下已有 draft 会话就复用，避免每切一次项目留下一个空会话
      const existingDraft = sessions.find(
        (s) => !s.archived && s.isDraft === true && s.workspaceId === workspaceId && s.id !== sessionId,
      )
      selectProject(workspaceId)
      if (existingDraft) {
        openSession('agent', existingDraft.id, existingDraft.title, { onOpened: () => undefined })
        return
      }
      void createAgent({ draft: true, workspaceId })
    },
    [currentWorkspaceId, createAgent, openSession, selectProject, sessionId, sessions],
  )

  const handleCreate = React.useCallback(async () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    const created = await createProject(trimmed)
    if (created) {
      setCreating(false)
      setNewName('')
      setOpen(false)
    }
  }, [createProject, newName])

  const handleCreateFromFolder = React.useCallback(async () => {
    if (creatingFromFolder) return
    setCreatingFromFolder(true)
    try {
      await createProjectFromFolder()
      setOpen(false)
    } finally {
      setCreatingFromFolder(false)
    }
  }, [createProjectFromFolder, creatingFromFolder])

  if (!current) return <React.Fragment />

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={`当前项目：${current.name}，点击切换`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'group inline-flex max-w-full items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-2 text-[13px] text-foreground/75 transition-colors hover:bg-foreground/[0.045] hover:text-foreground',
          open && 'bg-foreground/[0.045] text-foreground',
        )}
      >
        <FolderOpen size={14} className="shrink-0 text-foreground/55" strokeWidth={1.6} aria-hidden="true" />
        <span className="max-w-[16rem] truncate">{current.name}</span>
        <LocalProjectBadge projectRootPath={current.projectRootPath} projectRootStatus={current.projectRootStatus} />
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-foreground/35 transition-transform duration-150', open && 'rotate-180')}
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))] p-1.5">
        <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-foreground/40">项目</div>
        <div className="max-h-64 overflow-y-auto scrollbar-thin">
          {workspaces.map((ws) => {
            const isCurrent = ws.id === currentWorkspaceId
            return (
              <button
                key={ws.id}
                type="button"
                ref={isCurrent ? currentItemRef : undefined}
                onClick={() => handleSelect(ws.id)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  isCurrent
                    ? 'bg-foreground/[0.06] text-foreground'
                    : 'text-foreground/70 hover:bg-foreground/[0.04]',
                )}
              >
                <FolderOpen size={13} className="shrink-0 text-foreground/45" strokeWidth={1.6} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                <LocalProjectBadge projectRootPath={ws.projectRootPath} projectRootStatus={ws.projectRootStatus} />
                {isCurrent && <Check size={13} className="shrink-0 text-foreground/55" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
        <div className="my-1 h-px bg-border/50" />
        {creating ? (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <FolderOpen size={13} className="shrink-0 text-foreground/40" aria-hidden="true" />
            <input
              ref={createInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (e.nativeEvent.isComposing) return
                  e.preventDefault()
                  void handleCreate()
                } else if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              placeholder="项目名称..."
              maxLength={50}
              className="min-w-0 flex-1 border-b border-primary/50 bg-transparent px-0.5 text-[13px] text-foreground outline-none"
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setCreating(true)
                requestAnimationFrame(() => createInputRef.current?.focus())
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
            >
              <Plus size={13} className="shrink-0 text-foreground/40" aria-hidden="true" />
              新建空白项目
            </button>
            <button
              type="button"
              onClick={() => void handleCreateFromFolder()}
              disabled={creatingFromFolder}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/70 transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              <FolderInput size={13} className="shrink-0 text-foreground/40" aria-hidden="true" />
              从本地文件夹添加
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
