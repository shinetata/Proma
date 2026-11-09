/**
 * AI Elements - 对话容器原语
 *
 * 基于 use-stick-to-bottom 实现自动滚动到底部的对话容器。
 * 移植自 proma-frontend 的 ai-elements/conversation.tsx。
 *
 * 包含：
 * - Conversation — 根容器（StickToBottom）
 * - ConversationContent — 内容区域
 * - ConversationEmptyState — 空状态
 * - ConversationScrollButton — 滚动到底部按钮
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { StickToBottom, useStickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import { computeFollowLocked, type FollowState } from '@/components/agent/scroll-follow'

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<typeof StickToBottom>

export function Conversation({ className, ...props }: ConversationProps): React.ReactElement {
  return (
    <StickToBottom
      className={cn('relative min-h-0 flex-1 overflow-y-hidden scrollbar-none', className)}
      initial="instant"
      resize="smooth"
      role="log"
      {...props}
    />
  )
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export function ConversationContent({ className, ...props }: ConversationContentProps): React.ReactElement {
  return (
    <StickToBottom.Content
      className={cn('flex flex-col gap-1 py-4 px-8', className)}
      {...props}
    />
  )
}

// ===== ConversationEmptyState 空状态 =====

export interface ConversationEmptyStateProps extends ComponentProps<'div'> {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description = '在下方输入框开始对话',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title}</h3>
            {description && (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ===== ConversationScrollButton 滚动到底部 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactElement | null {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  if (isAtBottom) return null

  return (
    <Button
      className={cn(
        'absolute bottom-[26px] left-1/2 -translate-x-1/2 rounded-[17px] size-9',
        'bg-card shadow-sm hover:bg-accent/80',
        className
      )}
      onClick={handleScrollToBottom}
      type="button"
      variant="ghost"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}

// ===== ConversationFollowController 受控滚动跟随 =====

interface ConversationFollowControllerProps {
  sessionId: string
  /** 当前会话是否正在运行 */
  streaming: boolean
  /** 当前 run 的起始时间（新一轮开始时解除锁定） */
  runStartedAt?: number
  /** 当前 run 的实时消息里是否已出现最终回复 */
  hasFinalOutput: boolean
  className?: string
  children: React.ReactNode
}

/**
 * 受控滚动跟随容器（对应商业版 F8t）。
 *
 * 运行中且最终回复未出现时自动跟随滚动；最终回复开始输出后锁定当前位置，
 * 用户可以从回复开头读起；点击「回到底部」仍可直接跳到底部；
 * 同一会话新一轮开始且用户此前在底部时，立即回到底部。
 */
export function ConversationFollowController({
  sessionId,
  streaming,
  runStartedAt,
  hasFinalOutput,
  className,
  children,
}: ConversationFollowControllerProps): React.ReactElement {
  const nextState = useRef<FollowState>({ sessionId, streaming, runStartedAt, hasFinalOutput })
  nextState.current = { sessionId, streaming, runStartedAt, hasFinalOutput }
  const lockedRef = useRef(computeFollowLocked(undefined, nextState.current, false))
  const previousStateRef = useRef<FollowState | undefined>(undefined)

  // 锁定时保持当前 scrollTop 不变（不跟随内容增长）
  const targetScrollTop = useCallback((target: number, { scrollElement }: { scrollElement: HTMLElement }): number => (
    lockedRef.current ? scrollElement.scrollTop : target
  ), [])

  const instance = useStickToBottom({ initial: 'instant', resize: 'instant', targetScrollTop })
  const { scrollRef, contentRef, stopScroll, scrollToBottom } = instance
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)

  useLayoutEffect(() => {
    const previous = previousStateRef.current
    const previousLocked = lockedRef.current
    const next = nextState.current
    const locked = computeFollowLocked(previous, next, previousLocked)
    lockedRef.current = locked
    previousStateRef.current = next
    // 由未锁变为锁定：停止进行中的跟随动画
    if (locked && !previousLocked) stopScroll()
    // 同一会话由锁定变为未锁（新一轮开始）且用户此前在底部时，立即回到底部
    if (previous?.sessionId === sessionId && previousLocked && !locked && isAtBottomRef.current) {
      scrollToBottom('instant')
    }
  }, [sessionId, streaming, runStartedAt, hasFinalOutput, stopScroll, scrollToBottom])

  // 自行维护 isAtBottom：锁定时库的判断不再可靠，用容差直接测量
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    const contentElement = contentRef.current
    if (!scrollElement || !contentElement) return
    const measure = (): void => {
      const atBottom = scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop <= 2
      isAtBottomRef.current = atBottom
      setIsAtBottom(atBottom)
    }
    measure()
    scrollElement.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scrollElement)
    observer.observe(contentElement)
    return () => {
      scrollElement.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [sessionId, scrollRef, contentRef])

  // 锁定时点击「回到底部」直接跳到底部，不恢复跟随
  const controlledScrollToBottom = useCallback((options?: Parameters<typeof scrollToBottom>[0]) => {
    if (!lockedRef.current) return scrollToBottom(options)
    const scrollElement = scrollRef.current
    if (!scrollElement) return false
    stopScroll()
    scrollElement.scrollTo({ top: scrollElement.scrollHeight, behavior: 'instant' })
    return true
  }, [scrollRef, scrollToBottom, stopScroll])

  return (
    <StickToBottom
      className={cn('relative min-h-0 flex-1 overflow-y-hidden scrollbar-none', className)}
      role="log"
      instance={{ ...instance, isAtBottom, scrollToBottom: controlledScrollToBottom }}
    >
      {children}
    </StickToBottom>
  )
}
