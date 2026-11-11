/**
 * 过程表述模式选择器
 *
 * 仅在空会话（尚未发送首条消息）时挂载于输入框上方；切换后写入会话级
 * narrationMode，下一轮系统提示词生效。运行中的 Agent 也允许切换，
 * 与商业版一致：乐观更新 atom，IPC 返回的 meta 再覆盖，失败回滚。
 */

import React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronDown, MessageSquareText, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { migrateNarrationMode, type PromaNarrationMode } from '@proma/shared'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const NARRATION_MODE_META: Record<PromaNarrationMode, { label: string; description: string }> = {
  efficiency: { label: '效率模式', description: '运行过程中不阶段性解释，省 token、速度更快' },
  explain: { label: '解释模式', description: '在重要阶段前说明要做什么，并解释关键决策' },
}

const NARRATION_MODE_ICON: Record<PromaNarrationMode, typeof Zap> = {
  efficiency: Zap,
  explain: MessageSquareText,
}

function getNarrationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface NarrationModeSelectorProps {
  sessionId: string
}

export function NarrationModeSelector({ sessionId }: NarrationModeSelectorProps): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const setSessions = useSetAtom(agentSessionsAtom)
  const [open, setOpen] = React.useState(false)
  // IPC 往返期间防重入：乐观写入后再次切换要等上一次落地或回滚。
  const saveInFlightRef = React.useRef(false)

  const session = sessions.find((item) => item.id === sessionId)
  const currentMode = migrateNarrationMode(session?.narrationMode)
  const currentMeta = NARRATION_MODE_META[currentMode]
  const CurrentIcon = NARRATION_MODE_ICON[currentMode]

  const handleSelect = React.useCallback(async (mode: PromaNarrationMode): Promise<void> => {
    if (mode === currentMode || saveInFlightRef.current) return
    saveInFlightRef.current = true
    setOpen(false)

    const previousSessions = sessions
    // 与相邻的推理档位切换一致：改会话元数据不算一次用户活动，不动 updatedAt。
    setSessions((prev) => prev.map((item) => (
      item.id === sessionId ? { ...item, narrationMode: mode } : item
    )))

    try {
      const updated = await window.electronAPI.updateSessionNarrationMode(sessionId, mode)
      setSessions((prev) => prev.map((item) => item.id === sessionId ? updated : item))
    } catch (error) {
      console.error('[NarrationModeSelector] 切换过程表述模式失败:', error)
      setSessions(previousSessions)
      toast.error('切换过程表述模式失败', { description: getNarrationErrorMessage(error) })
    } finally {
      saveInFlightRef.current = false
    }
  }, [currentMode, sessionId, sessions, setSessions])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`过程表述：${currentMeta.label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex max-w-full items-center gap-2 rounded-lg py-1.5 pl-2.5 pr-2 text-[13px] text-foreground/75 transition-colors hover:bg-foreground/[0.045] hover:text-foreground',
            open && 'bg-foreground/[0.045] text-foreground',
          )}
        >
          <CurrentIcon className="size-[14px] shrink-0 text-foreground/55" />
          <span className="max-w-[10rem] truncate">{currentMeta.label}</span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-foreground/35 transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 p-1.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-foreground/40">
          过程表述
        </div>
        <div className="flex flex-col">
          {(Object.keys(NARRATION_MODE_META) as PromaNarrationMode[]).map((mode) => {
            const meta = NARRATION_MODE_META[mode]
            const Icon = NARRATION_MODE_ICON[mode]
            const selected = mode === currentMode
            return (
              <button
                key={mode}
                type="button"
                onClick={() => { void handleSelect(mode) }}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  selected ? 'bg-foreground/[0.06] text-foreground' : 'text-foreground/70 hover:bg-foreground/[0.04]',
                )}
              >
                <Icon className="mt-0.5 size-3.5 shrink-0 text-foreground/45" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-5">{meta.label}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">{meta.description}</span>
                </span>
                {selected && <Check className="mt-0.5 size-3.5 shrink-0 text-foreground/55" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
