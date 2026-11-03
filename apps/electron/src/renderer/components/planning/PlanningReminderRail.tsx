import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { BellRing, Check, ChevronDown, ListTodo, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ActivePlanningReminder } from '@proma/shared'
import { activePlanningRemindersAtom, planningSelectedCalendarEventIdAtom, planningSelectedTodoIdAtom, planningTabAtom } from '@/atoms/planning-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { notificationsEnabledAtom, notificationSoundEnabledAtom, notificationSoundsAtom, playNotificationSoundForType } from '@/atoms/notifications'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** 今天的提醒只显示时分，其余显示月日 + 时分（商业版 Pcn）。 */
function formatTriggerTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
  if (isToday) return `今天 ${time}`
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp)
}

function mergeReminders(current: ActivePlanningReminder[], incoming: ActivePlanningReminder[]): ActivePlanningReminder[] {
  const items = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) items.set(item.id, item)
  return [...items.values()].sort((a, b) => (a.snoozedUntil ?? a.triggerAt) - (b.snoozedUntil ?? b.triggerAt))
}

/** 全局常驻提醒条（对齐商业版 Rcn）。未确认提醒从 SQLite 恢复，不依赖一次性 toast 生命周期。 */
export function PlanningReminderRail({ playSound = true }: { playSound?: boolean } = {}): React.ReactElement | null {
  const [reminders, setReminders] = useAtom(activePlanningRemindersAtom)
  const [snoozeMenuId, setSnoozeMenuId] = React.useState<string | null>(null)
  const setActiveView = useSetAtom(activeViewAtom)
  const setPlanningTab = useSetAtom(planningTabAtom)
  const setSelectedTodoId = useSetAtom(planningSelectedTodoIdAtom)
  const setSelectedCalendarEventId = useSetAtom(planningSelectedCalendarEventIdAtom)
  const notificationsEnabled = useAtomValue(notificationsEnabledAtom)
  const soundEnabled = useAtomValue(notificationSoundEnabledAtom)
  const sounds = useAtomValue(notificationSoundsAtom)

  const load = React.useCallback(async () => {
    try {
      setReminders(await window.electronAPI.listActivePlanningReminders())
    } catch (error) {
      console.error('[任务/日程] 加载常驻提醒失败:', error)
    }
  }, [setReminders])

  React.useEffect(() => {
    void load()
    const unsubscribeDue = window.electronAPI.onPlanningRemindersDue((due) => {
      setReminders((current) => mergeReminders(current, due))
      if (playSound && notificationsEnabled && soundEnabled && due.length > 0) {
        void playNotificationSoundForType('planningReminder', sounds)
      }
    })
    const unsubscribeChanged = window.electronAPI.onPlanningChanged((change) => {
      if (change.resources.includes('reminders')) void load()
    })
    return () => { unsubscribeDue(); unsubscribeChanged() }
  }, [load, notificationsEnabled, playSound, setReminders, soundEnabled, sounds])

  const removeLocal = (id: string): void => setReminders((current) => current.filter((item) => item.id !== id))
  const acknowledge = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.acknowledgePlanningReminder(id)
      removeLocal(id)
    } catch (error) {
      console.error('[任务/日程] 确认提醒失败:', error)
      toast.error('确认提醒失败')
    }
  }
  const completeTodo = async (reminder: ActivePlanningReminder): Promise<void> => {
    try {
      await window.electronAPI.updateTodo({ id: reminder.targetId, status: 'completed' })
      removeLocal(reminder.id)
    } catch (error) {
      console.error('[任务/日程] 完成 Todo 失败:', error)
      toast.error('完成 Todo 失败')
    }
  }
  const openTarget = (reminder: ActivePlanningReminder): void => {
    if (reminder.targetType === 'todo') setSelectedTodoId(reminder.targetId)
    else setSelectedCalendarEventId(reminder.targetId)
    setPlanningTab(reminder.targetType === 'todo' ? 'todos' : 'calendar')
    setActiveView('planning')
  }
  const snooze = async (id: string, minutes: number): Promise<void> => {
    try {
      await window.electronAPI.snoozePlanningReminder({ id, minutes })
      setSnoozeMenuId(null)
      removeLocal(id)
    } catch (error) {
      console.error('[任务/日程] 推迟提醒失败:', error)
      toast.error('推迟提醒失败')
    }
  }

  if (reminders.length === 0) return null

  return (
    <aside className="fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col-reverse gap-2" aria-live="polite">
      {reminders.slice(0, 3).map((reminder) => (
        <section key={reminder.id} className="border border-border/70 bg-background">
          <div className="flex items-start gap-3 px-3 py-3">
            <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => openTarget(reminder)}
                className="block max-w-full truncate text-left text-sm font-medium underline-offset-4 hover:underline"
                title={`查看「${reminder.targetTitle}」`}
              >
                {reminder.targetTitle}
              </button>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                已到提醒时间 · {formatTriggerTime(reminder.snoozedUntil ?? reminder.triggerAt)}{reminder.group ? ` · ${reminder.group.name}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => void acknowledge(reminder.id)} aria-label="关闭提醒" title="关闭提醒">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/15 px-3 py-2">
            <div className="flex items-center gap-1">
              {reminder.targetType === 'todo' && (
                <Button size="sm" className="h-7" onClick={() => void completeTodo(reminder)}>
                  <Check className="mr-1 h-3.5 w-3.5" />完成 Todo
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openTarget(reminder)}>
                <ListTodo className="mr-1 h-3.5 w-3.5" />查看
              </Button>
            </div>
            <Popover open={snoozeMenuId === reminder.id} onOpenChange={(open) => setSnoozeMenuId(open ? reminder.id : null)}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  稍后提醒<ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-36 p-1">
                {[5, 10, 30, 60].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="flex h-8 w-full items-center rounded-sm px-2 text-left text-xs hover:bg-muted"
                    onClick={() => void snooze(reminder.id, minutes)}
                  >
                    {minutes} 分钟后
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </section>
      ))}
      {reminders.length > 3 && <p className="px-2 text-right text-xs text-muted-foreground">另有 {reminders.length - 3} 条待处理提醒</p>}
    </aside>
  )
}
