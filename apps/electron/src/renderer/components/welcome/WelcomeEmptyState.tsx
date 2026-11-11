/**
 * WelcomeEmptyState — 会话空状态引导
 *
 * 在没有会话时展示：
 * 1. 个性化时段问候（衬线字体，时段短语后带 SVG 插画，夜间按月相变化）
 * 2. 平台感知的小 Tips
 *
 * `inline` 为空会话整栏布局：不占满高度，由父容器负责垂直居中。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Lightbulb } from 'lucide-react'
import { userProfileAtom } from '@/atoms/user-profile'
import { getRandomTip, getPlatform, type Tip } from '@/lib/tips'
import { GreetingArtwork, type GreetingPeriod } from './GreetingArtwork'

interface WelcomeEmptyStateProps {
  /** 空会话整栏布局：不占满高度，由父容器负责垂直居中。 */
  inline?: boolean
}

/** 根据小时返回时段问候 */
function getGreetingPeriod(hour: number): { period: GreetingPeriod; text: string } {
  if (hour < 6) return { period: 'night', text: '夜深了' }
  if (hour < 12) return { period: 'morning', text: '早上好' }
  if (hour < 18) return { period: 'afternoon', text: '下午好' }
  return { period: 'evening', text: '晚上好' }
}

export function WelcomeEmptyState({ inline = false }: WelcomeEmptyStateProps): React.ReactElement {
  const userProfile = useAtomValue(userProfileAtom)

  // 稳定的随机 Tip（组件挂载时选一条）
  const [tip] = React.useState<Tip>(() => getRandomTip(getPlatform()))
  const [now, setNow] = React.useState(() => new Date())

  // 每分钟在整分对齐刷新，用于跨时段/跨日切换问候与月相
  React.useEffect(() => {
    let timer: number | undefined
    const tick = (): void => {
      if (timer) window.clearTimeout(timer)
      if (document.hidden) return
      const next = new Date()
      setNow(next)
      const elapsed = next.getSeconds() * 1000 + next.getMilliseconds()
      timer = window.setTimeout(tick, 60000 - elapsed)
    }
    tick()
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  const { period, text } = getGreetingPeriod(now.getHours())
  const displayName = userProfile.userName || '用户'

  return (
    <div
      className={
        'welcome-empty-state flex w-full min-w-0 flex-col items-center gap-6 px-4 py-6 ' +
        (inline ? 'shrink-0' : 'h-full')
      }
    >
      {/* 问候语 */}
      <h1 className="welcome-greeting-title text-foreground">
        {displayName}，<span className="welcome-greeting-phrase">{text}<GreetingArtwork period={period} date={now} /></span>
      </h1>

      {/* Tips */}
      <div className="flex max-w-full shrink-0 items-center gap-2.5 rounded-full bg-muted/50 px-4 py-2 text-[13px] text-muted-foreground">
        <Lightbulb size={14} className="flex-shrink-0 text-amber-500/80" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{tip.text}</span>
      </div>
    </div>
  )
}
