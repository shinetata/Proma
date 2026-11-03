import * as React from 'react'
import { Bell, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { PlanningReminder, PlanningReminderTargetType } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

function toLocalInputValue(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseLocalInputValue(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined
  const timestamp = new Date(value).getTime()
  return timestamp > 0 && toLocalInputValue(timestamp) === value ? timestamp : undefined
}

function effectiveTriggerAt(reminder: PlanningReminder): number {
  return reminder.snoozedUntil ?? reminder.triggerAt
}

function reminderStatusLabel(reminder: PlanningReminder, now: number): string {
  if (reminder.status === 'acknowledged') return '已关闭'
  if (reminder.status === 'completed') return '任务已完成'
  if (effectiveTriggerAt(reminder) <= now) return '已到期'
  if (reminder.snoozedUntil !== undefined) return '已推迟'
  return '待提醒'
}

function relativePresets(referenceAt: number | undefined): Array<{ minutesBefore: number; label: string; triggerAt: number }> {
  if (referenceAt === undefined) return []
  return [0, 5, 15, 30, 60, 1440].map((minutesBefore) => ({
    minutesBefore,
    label: minutesBefore === 0 ? '准时' : minutesBefore === 1440 ? '提前 1 天' : minutesBefore === 60 ? '提前 1 小时' : `提前 ${minutesBefore} 分钟`,
    triggerAt: referenceAt - minutesBefore * 60_000,
  }))
}

const reminderTimeFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

interface PlanningReminderSectionProps {
  targetType: PlanningReminderTargetType
  targetId: string
  reminders: PlanningReminder[]
  /** Todo 截止时间或日程开始时间，用于相对时间快捷项。 */
  referenceAt?: number
  completed?: boolean
}

/** Todo / 日程详情中的 Proma 提醒管理（对齐商业版 Mee）。 */
export function PlanningReminderSection({ targetType, targetId, reminders, referenceAt, completed = false }: PlanningReminderSectionProps): React.ReactElement {
  const [editing, setEditing] = React.useState<PlanningReminder | 'new' | null>(null)
  const [inputValue, setInputValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pendingDeletion, setPendingDeletion] = React.useState<PlanningReminder | null>(null)
  const [now, setNow] = React.useState(Date.now)
  const inputId = React.useId()
  const restoreFocusRef = React.useRef(false)
  const addButtonRef = React.useRef<HTMLButtonElement>(null)
  const pending = reminders.filter((reminder) => reminder.status === 'pending').sort((a, b) => effectiveTriggerAt(a) - effectiveTriggerAt(b))
  const handled = reminders.filter((reminder) => reminder.status !== 'pending').sort((a, b) => b.updatedAt - a.updatedAt)
  const parsedValue = parseLocalInputValue(inputValue)

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  React.useEffect(() => {
    if (restoreFocusRef.current && editing === null && !busy) {
      restoreFocusRef.current = false
      addButtonRef.current?.focus()
    }
  }, [busy, editing])

  const startEditing = (target: PlanningReminder | 'new'): void => {
    setEditing(target)
    setError(null)
    const fallback = referenceAt !== undefined && referenceAt > Date.now() ? referenceAt : Date.now() + 15 * 60_000
    setInputValue(toLocalInputValue(target === 'new' ? fallback : effectiveTriggerAt(target)))
  }
  const stopEditing = (): void => {
    restoreFocusRef.current = true
    setEditing(null)
    setError(null)
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      console.error('[提醒] 操作失败:', caught)
      const message = caught instanceof Error ? caught.message : '操作失败，请重试'
      setError(message)
      toast.error(message)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const save = (): void => {
    const triggerAt = parseLocalInputValue(inputValue)
    if (triggerAt === undefined || !editing || completed) return
    void run(async () => {
      if (editing === 'new') {
        await window.electronAPI.createPlanningReminder({ targetType, targetId, triggerAt })
      } else if (!await window.electronAPI.updatePlanningReminder({ id: editing.id, triggerAt })) {
        throw new Error('这条提醒已关闭或被删除，请重新选择')
      }
      stopEditing()
      toast.success('提醒已保存')
    })
  }

  const renderReminder = (reminder: PlanningReminder): React.ReactElement => {
    const isPending = reminder.status === 'pending'
    const at = effectiveTriggerAt(reminder)
    return (
      <li key={reminder.id} className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg bg-muted/35 p-2">
        <div className="min-w-0 flex-1 basis-36 pl-1">
          <time dateTime={new Date(at).toISOString()} className="text-xs font-medium tabular-nums">{reminderTimeFormat.format(at)}</time>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            <span className={isPending && at <= now ? 'text-amber-700 dark:text-amber-400' : undefined}>{reminderStatusLabel(reminder, now)}</span>
            {' · '}{reminder.origin === 'todo_due_at' ? '跟随 Todo 截止时间' : '手动提醒'}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          {isPending && at <= now && (
            <Button type="button" variant="ghost" size="icon" className="size-10" aria-label={`关闭提醒 ${reminderTimeFormat.format(at)}`} title="关闭提醒，不完成任务" disabled={busy} onClick={() => void run(async () => {
              if (!await window.electronAPI.acknowledgePlanningReminder(reminder.id)) throw new Error('这条提醒已关闭或被删除')
              if (editing !== 'new' && editing?.id === reminder.id) stopEditing()
            })}>
              <Check size={14} />
            </Button>
          )}
          {isPending && !completed && (
            <Button type="button" variant="ghost" size="icon" className="size-10" aria-label={`编辑提醒 ${reminderTimeFormat.format(at)}`} title="修改提醒时间" disabled={busy} onClick={() => startEditing(reminder)}>
              <Pencil size={14} />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="size-10 text-muted-foreground hover:text-destructive" aria-label={`删除提醒 ${reminderTimeFormat.format(at)}`} title="删除提醒" disabled={busy} onClick={() => { setError(null); setPendingDeletion(reminder) }}>
            <Trash2 size={14} />
          </Button>
        </div>
      </li>
    )
  }

  return (
    <section className="space-y-3 border-t border-border/60 pt-4" aria-label="Proma 提醒">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Bell size={15} className="text-muted-foreground" />提醒
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{pending.length}</span>
        </h4>
        <Button ref={addButtonRef} type="button" variant="ghost" size="sm" className="h-10 px-2 text-xs" disabled={busy || completed || editing !== null} onClick={() => startEditing('new')}>
          <Plus size={14} />添加提醒
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        由 Proma 在运行时提醒，不修改系统日历通知。{completed ? '任务已完成，恢复后可添加提醒。' : '手动提醒不会随任务或日程改期。'}
      </p>
      {pending.length > 0
        ? <ul className="space-y-2" aria-label="待处理提醒">{pending.map(renderReminder)}</ul>
        : <p className="rounded-lg bg-muted/25 px-3 py-3 text-xs text-muted-foreground">暂无待处理提醒{completed ? '。' : '，添加一个时间，避免错过安排。'}</p>}
      {editing && (
        <form
          className="space-y-3 rounded-xl bg-muted/40 p-3"
          aria-label={editing === 'new' ? '添加提醒' : '编辑提醒'}
          onSubmit={(event) => { event.preventDefault(); save() }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            if (!busy) stopEditing()
          }}
        >
          <label htmlFor={inputId} className="block text-xs font-medium">{editing === 'new' ? '提醒时间' : '修改提醒时间'}（本地时间）</label>
          <Input id={inputId} autoFocus type="datetime-local" required value={inputValue} disabled={busy || completed} onChange={(event) => setInputValue(event.target.value)} className="h-10 min-w-0 text-xs tabular-nums dark:[color-scheme:dark]" />
          {referenceAt !== undefined && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">相对于已保存的{targetType === 'todo' ? '截止' : '开始'}时间</p>
              <div className="flex flex-wrap gap-1">
                {relativePresets(referenceAt).map((preset) => (
                  <Button key={preset.minutesBefore} type="button" variant="ghost" size="sm" className="h-10 px-2 text-xs" disabled={busy || completed} onClick={() => setInputValue(toLocalInputValue(preset.triggerAt))}>{preset.label}</Button>
                ))}
              </div>
            </div>
          )}
          {parsedValue !== undefined && parsedValue <= now && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">此时间已过去，保存后会尽快触发提醒。</p>}
          {editing !== 'new' && (editing.origin === 'todo_due_at' || editing.snoozedUntil !== undefined) && <p className="text-xs leading-5 text-muted-foreground">保存后转为手动提醒，并清除原来的推迟时间。</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-10" disabled={busy} onClick={stopEditing}>取消</Button>
            <Button type="submit" size="sm" className="h-10" disabled={busy || completed || parsedValue === undefined}>{busy ? '保存中…' : '保存提醒'}</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {handled.length > 0 && (
        <details className="text-xs">
          <summary className="min-h-10 cursor-pointer py-3 text-muted-foreground">已处理记录（{handled.length}）</summary>
          <ul className="space-y-2" aria-label="已处理提醒">{handled.map(renderReminder)}</ul>
        </details>
      )}
      <AlertDialog open={pendingDeletion !== null} onOpenChange={(open) => { if (!open && !busy) setPendingDeletion(null) }}>
        <AlertDialogContent onEscapeKeyDown={(event) => { event.stopPropagation(); if (busy) event.preventDefault() }}>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条提醒？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeletion && reminderTimeFormat.format(effectiveTriggerAt(pendingDeletion))} 的提醒将被永久删除，Todo 或日程本身不受影响。
              {pendingDeletion?.origin === 'todo_due_at' && ' 之后修改 Todo 截止时间时，可能重新生成到期提醒。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                if (!pendingDeletion) return
                const id = pendingDeletion.id
                void run(async () => {
                  if (!await window.electronAPI.deletePlanningReminder(id)) throw new Error('这条提醒已被删除，请重新打开详情')
                  setPendingDeletion(null)
                  if (editing !== 'new' && editing?.id === id) stopEditing()
                  toast.success('提醒已删除')
                })
              }}
            >
              {busy ? '删除中…' : '删除提醒'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
