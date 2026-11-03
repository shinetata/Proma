/**
 * 定时任务列表视图（codex Automations 风格）
 *
 * 由侧边栏 Automations 入口触发显示，全屏占据中间内容区（隐藏 TabBar）。
 *
 * 结构：
 * - 顶部：标题 "定时任务" + 「+ 新建」按钮
 * - 内容：分组列表
 *   - Current（启用中）：active=true
 *   - Paused（已暂停 / 草稿）：active=false
 * - 每行：名称 + prompt 摘要 + 调度文案
 * - 点击行 → 通过 automationFormAtom 打开编辑表单 overlay
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Clock, Pause, Play, Power, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import {
  automationsAtom,
  automationFormAtom,
  automationToDraft,
  createNamedDraft,
} from '@/atoms/automation-atoms'
import type { Automation } from '@proma/shared'
import { formatAutomationNextRun, formatAutomationSchedule } from './automation-format'

/** 定时任务列表嵌入统一的任务/日程页，页头由父级提供。 */
export function AutomationsListView(): React.ReactElement {
  const automations = useAtomValue(automationsAtom)
  const [pendingDeletion, setPendingDeletion] = React.useState<Automation | null>(null)
  const setAutomations = useSetAtom(automationsAtom)
  const setForm = useSetAtom(automationFormAtom)

  const refreshList = React.useCallback(async () => {
    const list = await window.electronAPI.listAutomations()
    setAutomations(list)
  }, [setAutomations])

  const current = automations.filter((a) => a.active)
  // 已完成（once 跑完 / 跑满 maxRuns 自动停用，带 completedAt）单独成组，区别于用户手动暂停 / 草稿
  const completed = automations.filter((a) => !a.active && a.completedAt)
  const paused = automations.filter((a) => !a.active && !a.completedAt)

  const handleCreate = (): void => {
    // 自动命名「定时任务 N」：取现有最大 X + 1（商业版 mJt）
    setForm({ open: true, draft: createNamedDraft(automations) })
  }

  const handleEdit = (a: Automation): void => {
    setForm({ open: true, draft: automationToDraft(a) })
  }
  const confirmDelete = async (): Promise<void> => {
    const automation = pendingDeletion
    if (!automation) return
    try {
      const deleted = await window.electronAPI.deleteAutomation(automation.id)
      await refreshList()
      setPendingDeletion(null)
      if (deleted) toast.success('已删除')
      else toast.error('定时任务不存在或已被删除')
    } catch (error) {
      console.error('[定时任务] 删除失败:', error)
      toast.error('删除失败')
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 列表内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {automations.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : (
          <div className="flex w-full flex-col gap-8 pb-8">
            {current.length > 0 && (
              <Section title="启用中" automations={current} onEdit={handleEdit} onRefresh={refreshList} onDelete={setPendingDeletion} />
            )}
            {paused.length > 0 && (
              <Section title="已暂停" automations={paused} onEdit={handleEdit} onRefresh={refreshList} onDelete={setPendingDeletion} />
            )}
            {completed.length > 0 && (
              <Section title="已完成" automations={completed} onEdit={handleEdit} onRefresh={refreshList} onDelete={setPendingDeletion} />
            )}
          </div>
        )}
      </div>
      <AlertDialog open={pendingDeletion !== null} onOpenChange={(open) => { if (!open) setPendingDeletion(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认删除定时任务</AlertDialogTitle><AlertDialogDescription>删除「{pendingDeletion?.name}」后无法恢复。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">删除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface SectionProps {
  title: string
  automations: Automation[]
  onEdit: (a: Automation) => void
  onRefresh: () => Promise<void>
  onDelete: (a: Automation) => void
}

function Section({ title, automations, onEdit, onRefresh, onDelete }: SectionProps): React.ReactElement {
  /** 列表上的任务是否具备运行 / 启用所需的最小完整度 */
  const isRunnable = (a: Automation): boolean => !!a.channelId && !!a.workspaceId

  const handleRunNow = async (e: React.MouseEvent, a: Automation): Promise<void> => {
    e.stopPropagation()
    if (!isRunnable(a)) {
      toast.error('请先为该任务配置模型与项目')
      onEdit(a)
      return
    }
    toast.success(`已开始运行「${a.name}」`, {
      description: '本次任务会创建新的 Agent 会话，可在左侧会话列表查看',
    })
    try {
      await window.electronAPI.runAutomationNow(a.id)
    } catch (err) {
      toast.error('运行失败')
      console.error('[定时任务] 立即运行失败:', err)
    }
  }

  const handleToggle = async (e: React.MouseEvent, a: Automation): Promise<void> => {
    e.stopPropagation()
    // 启用前必须配齐模型与项目，否则打开编辑面板让用户补全
    if (!a.active && !isRunnable(a)) {
      toast.error('请先为该任务配置模型与项目')
      onEdit(a)
      return
    }
    try {
      await window.electronAPI.toggleAutomation(a.id, !a.active)
      await onRefresh()
      toast.success(a.active ? '已暂停' : '已启用')
    } catch (err) {
      toast.error('操作失败')
      console.error('[定时任务] 切换状态失败:', err)
    }
  }

  const handleDelete = (event: React.MouseEvent, automation: Automation): void => {
    event.stopPropagation()
    onDelete(automation)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-medium text-foreground/55 px-1">{title}</div>
      <div className="overflow-hidden rounded-none border border-border/60 bg-card">
        {automations.map((a, i) => (
          // 行容器：用 div + role=button，避免与内部 button（立即运行/删除/暂停）
          // 形成嵌套 button 的非法 HTML，同时通过 keyDown 维持键盘可达。
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            onClick={() => onEdit(a)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onEdit(a)
              }
            }}
            className={cn(
              'group w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 cursor-pointer focus:outline-none focus-visible:bg-muted/50',
              i > 0 && 'border-t border-border/60',
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[14px] font-medium text-foreground truncate">{a.name}</span>
                <span className="text-[12px] text-foreground/45 truncate">
                  {a.prompt.slice(0, 60)}{a.prompt.length > 60 ? '…' : ''}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Clock className="size-3" />{formatAutomationSchedule(a)}</span>
                <span className="tabular-nums">{formatAutomationNextRun(a)}</span>
              </div>
            </div>
            {/* 右侧槽位固定宽度，只在悬浮时显示行操作，避免改变列表布局。 */}
            <div className="relative h-7 w-16 shrink-0">
              <div className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`立即运行 ${a.name}`}
                      onClick={(e) => { void handleRunNow(e, a) }}
                      className="p-1.5 rounded-md text-foreground/50 hover:text-foreground/85 hover:bg-foreground/[0.08] transition-colors"
                    >
                      <Play className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">立即运行一次</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`删除 ${a.name}`}
                      onClick={(e) => handleDelete(e, a)}
                      className="p-1.5 rounded-md text-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">删除任务</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={a.active ? `暂停 ${a.name}` : `启用 ${a.name}`}
                  onClick={(e) => { void handleToggle(e, a) }}
                  className={cn(
                    'p-1.5 -m-1.5 shrink-0 flex items-center justify-center rounded-md transition-colors',
                    a.active
                      ? 'text-foreground/35 hover:bg-foreground/[0.06] hover:text-foreground/70 group-hover:text-foreground/55'
                      : 'text-foreground/30 hover:bg-emerald-500/10 hover:text-emerald-500 group-hover:text-foreground/45',
                  )}
                >
                  {a.active ? <Pause className="size-3.5" /> : <Power className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {a.active ? '暂停任务：从当前开始不再继续后续自动处理' : '启用任务'}
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.ReactElement {
  return (
    <div className="max-w-2xl mx-auto pt-24 flex flex-col items-center text-center gap-4">
      <div className="size-16 rounded-2xl bg-foreground/[0.04] flex items-center justify-center">
        <Clock className="size-8 text-foreground/30" />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[16px] font-medium text-foreground/85">暂无定时任务</div>
        <div className="text-[13px] text-foreground/50 leading-relaxed max-w-md">
          定时任务可以让 AI 周期性地执行某项任务，如每天总结新邮件、每小时检查 GitHub 仓库等。
          也可以在对话中用「以后每隔 X 分钟…」让 Proma 自动识别并创建。
        </div>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
      >
        <Plus size={14} />
        <span>新建定时任务</span>
      </button>
    </div>
  )
}
