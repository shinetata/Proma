/**
 * ProcessTimeline — 助手轮次的执行过程区
 *
 * 结构与商业版 0.21.88 一致：
 * - ProcessSummary：「已思考 N 次、执行 N 次工具、耗时 Xs」摘要行，可折叠整个过程；
 * - PROCESS_TIMELINE_CLASS：摘要下方带左侧竖线的时间轴容器；
 * - ProcessStepGroup：时间轴上的一组连续 thinking / tool 步骤，折叠时只显示当前步骤文案，
 *   左侧节点显示最后一个工具的图标，点击展开后列出每一步详情。
 */

import * as React from 'react'
import { BookOpen, ChevronRight, ListTree, Server } from 'lucide-react'
import type { SDKContentBlock, SDKToolUseBlock } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getToolIcon } from './tool-utils'
import {
  THINKING_STEP_CONTENT,
  buildProcessSummary,
  countProcessBlocks,
  getProcessStepContent,
  type ProcessStepContent,
  type ToolReference,
} from './assistant-turn-sections'

/** 时间轴容器：左侧细竖线，步骤节点通过负偏移压在竖线上 */
export const PROCESS_TIMELINE_CLASS = 'ml-[7px] space-y-1 border-l border-border/70 py-0.5 pl-4'

const STEP_TRANSITION_MS = 420
const STEP_MIN_DWELL_MS = 900
const COLLAPSE_TRANSITION_MS = 420

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

// ===== 步骤组展开状态：同一会话列表内虚拟化重挂载后保持展开 =====

const ProcessExpandStateContext = React.createContext<Set<string> | null>(null)

export function ProcessExpandStateProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [expandedKeys] = React.useState(() => new Set<string>())
  return <ProcessExpandStateContext.Provider value={expandedKeys}>{children}</ProcessExpandStateContext.Provider>
}

function useProcessExpandState(key?: string): [boolean, () => void] {
  const expandedKeys = React.useContext(ProcessExpandStateContext)
  const [expanded, setExpanded] = React.useState(() => !!key && !!expandedKeys?.has(key))
  React.useEffect(() => {
    setExpanded(!!key && !!expandedKeys?.has(key))
  }, [expandedKeys, key])
  const toggle = React.useCallback(() => {
    const next = !expanded
    if (key && expandedKeys) {
      if (next) expandedKeys.add(key)
      else expandedKeys.delete(key)
    }
    setExpanded(next)
  }, [expanded, expandedKeys, key])
  return [expanded, toggle]
}

/** 运行中的已耗时（毫秒），每秒刷新 */
export function useElapsedSince(startedAt?: number): number | undefined {
  const read = React.useCallback(() => (startedAt == null ? undefined : Math.max(0, Date.now() - startedAt)), [startedAt])
  const [elapsed, setElapsed] = React.useState(read)
  React.useEffect(() => {
    setElapsed(read())
    if (startedAt == null) return
    const timer = window.setInterval(() => setElapsed(read()), 1000)
    return () => window.clearInterval(timer)
  }, [read, startedAt])
  return elapsed
}

// ===== Skill / MCP 引用徽标 =====

const REFERENCE_STYLES: Record<ToolReference['kind'], { icon: typeof Server; className: string }> = {
  mcp: { icon: Server, className: 'bg-[hsl(160_60%_45%/0.15)] text-[hsl(160_60%_35%)]' },
  skill: { icon: BookOpen, className: 'bg-[hsl(270_60%_60%/0.15)] text-[hsl(270_60%_50%)]' },
}

export function ToolReferenceChip({ reference, className }: { reference: ToolReference; className?: string }): React.ReactElement {
  const { icon: Icon, className: styleClassName } = REFERENCE_STYLES[reference.kind]
  return (
    <span
      className={cn(
        'inline-flex max-w-[min(18rem,60vw)] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[15px] font-medium leading-none align-baseline',
        styleClassName,
        className,
      )}
      title={reference.title}
    >
      <Icon className="size-[15px] shrink-0" />
      <span className="truncate">{reference.label}</span>
    </span>
  )
}

// ===== 步骤文案：切换时上下淡入淡出，并保证每条文案至少停留 900ms =====

function getStepContentKey(content: ProcessStepContent): string {
  return `${content.label}|${content.reference?.kind ?? ''}|${content.reference?.label ?? ''}|${content.suffix ?? ''}|${content.markerTool ?? ''}`
}

function useDwellStepContent(content: ProcessStepContent, initial?: ProcessStepContent): ProcessStepContent {
  const [shown, setShown] = React.useState(initial ?? content)
  const shownKeyRef = React.useRef(getStepContentKey(initial ?? content))
  const shownAtRef = React.useRef(0)
  const key = getStepContentKey(content)
  React.useEffect(() => {
    if (key === shownKeyRef.current) return
    const apply = (): void => {
      shownKeyRef.current = key
      shownAtRef.current = Date.now()
      setShown(content)
    }
    const remaining = STEP_MIN_DWELL_MS - (Date.now() - shownAtRef.current)
    if (remaining <= 0) {
      apply()
      return
    }
    const timer = window.setTimeout(apply, remaining)
    return () => window.clearTimeout(timer)
    // content 由 key 唯一确定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return shown
}

function StepLabelContent({ content }: { content: ProcessStepContent }): React.ReactElement {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <span className="truncate">{content.label}</span>
      {content.reference && <ToolReferenceChip reference={content.reference} />}
      {content.suffix && <span className="shrink-0 font-normal tabular-nums text-foreground/30">{content.suffix}</span>}
    </span>
  )
}

interface StepLabelState {
  current: ProcessStepContent
  previous: ProcessStepContent | null
  phase: 'idle' | 'enter' | 'active'
  generation: number
}

function StepLabel({ content }: { content: ProcessStepContent }): React.ReactElement {
  const key = `${content.label}|${content.reference?.kind ?? ''}|${content.reference?.label ?? ''}|${content.suffix ?? ''}`
  const [state, setState] = React.useState<StepLabelState>({ current: content, previous: null, phase: 'idle', generation: 0 })
  const latestRef = React.useRef({ key, content })

  React.useEffect(() => {
    if (latestRef.current.key === key) return
    const previous = latestRef.current.content
    latestRef.current = { key, content }
    setState((prev) => ({ current: content, previous, phase: 'enter', generation: prev.generation + 1 }))
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setState((prev) => ({ ...prev, phase: 'active' })))
    })
    const timer = window.setTimeout(() => {
      setState((prev) => ({ ...prev, previous: null, phase: 'idle' }))
    }, STEP_TRANSITION_MS + 60)
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
      window.clearTimeout(timer)
    }
    // content 由 key 唯一确定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const transitionStyle = { transitionDuration: `${STEP_TRANSITION_MS}ms` }
  const entering = state.previous !== null && state.phase === 'enter'
  const leaving = state.previous !== null && state.phase === 'active'

  return (
    <span className="inline-grid min-w-0 max-w-full text-[15px] font-medium text-foreground/45">
      {state.previous !== null && (
        <span
          key={`previous-${state.generation}`}
          aria-hidden
          className={cn(
            'min-w-0 truncate transition-[opacity,transform] ease-out [grid-area:1/1]',
            leaving ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
          )}
          style={transitionStyle}
        >
          <StepLabelContent content={state.previous} />
        </span>
      )}
      <span
        key={`current-${state.generation}`}
        className={cn(
          'min-w-0 truncate transition-[opacity,transform] ease-out [grid-area:1/1]',
          entering ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
        )}
        style={transitionStyle}
      >
        <StepLabelContent content={state.current} />
      </span>
    </span>
  )
}

/** 时间轴节点：最后一个工具的图标；纯思考时显示圆点 */
function StepMarker({ toolName, reference, active }: { toolName?: string; reference?: ToolReference; active: boolean }): React.ReactElement {
  const Icon = reference?.kind === 'skill' ? BookOpen : toolName ? getToolIcon(toolName) : null
  return (
    <span aria-hidden className="absolute -left-[24.5px] top-[3px] flex size-4 items-center justify-center rounded-full bg-background">
      <span
        key={reference?.kind ?? toolName ?? 'thinking'}
        className="flex animate-in fade-in"
        style={{ animationDuration: `${STEP_TRANSITION_MS}ms` }}
      >
        {Icon ? (
          <Icon className={cn('size-3.5', active ? 'text-foreground/55' : 'text-foreground/35')} />
        ) : (
          <span className={cn('size-1.5 rounded-full', active ? 'bg-foreground/45' : 'bg-foreground/25')} />
        )}
      </span>
    </span>
  )
}

interface ProcessStepGroupProps {
  blocks: SDKContentBlock[]
  isActive?: boolean
  completedToolIds?: ReadonlySet<string>
  failedToolIds?: ReadonlySet<string>
  /** 展开后渲染每一步详情；参数表示是否完整展示思考内容 */
  renderChildren?: (showFullThinking: boolean) => React.ReactNode
  /** 运行中的首个步骤组从「正在思考...」开始过渡 */
  startFromThinking?: boolean
  expandKey?: string
}

export function ProcessStepGroup({
  blocks,
  isActive = false,
  completedToolIds,
  failedToolIds,
  renderChildren,
  startFromThinking = false,
  expandKey,
}: ProcessStepGroupProps): React.ReactElement {
  const [expanded, toggle] = useProcessExpandState(expandKey)
  const { thinkingCount, toolCount, lastTool } = countProcessBlocks(blocks)
  const last = blocks[blocks.length - 1]
  const steps = thinkingCount + toolCount
  const stepContent = getProcessStepContent(blocks, isActive, completedToolIds, failedToolIds)
  const content = useDwellStepContent({
    ...stepContent,
    suffix: !isActive && steps > 1 ? `· ${steps} 步` : undefined,
    markerTool: stepContent.markerTool ?? (isActive ? (last?.type === 'tool_use' ? (last as SDKToolUseBlock).name : undefined) : lastTool?.name),
  }, startFromThinking ? THINKING_STEP_CONTENT : undefined)
  const canExpand = blocks.length > 0 && !!renderChildren

  return (
    <div className="relative min-w-0">
      <StepMarker toolName={content.markerTool} reference={content.reference} active={isActive} />
      <button
        type="button"
        aria-expanded={expanded}
        disabled={!canExpand}
        className="group flex min-h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-md text-left transition-opacity enabled:hover:opacity-75 disabled:cursor-default"
        onClick={toggle}
      >
        <StepLabel content={content} />
      </button>
      {expanded && canExpand && (
        <div className="mb-1.5 mt-1 space-y-2 rounded-lg bg-muted/35 px-3 py-2.5 animate-in fade-in duration-150">
          {renderChildren?.(true)}
        </div>
      )}
    </div>
  )
}

// ===== 过程摘要（可折叠整个过程区） =====

function ProcessSummaryRow({ summary, tooltip, expanded, interactive, onToggle }: {
  summary: string
  tooltip?: string
  expanded: boolean
  interactive: boolean
  onToggle: () => void
}): React.ReactElement {
  const text = (
    <span className="truncate text-[16px] font-semibold leading-[1.72] tabular-nums text-foreground/55 transition-colors group-data-[interactive]:group-hover:text-foreground/70">
      {summary}
    </span>
  )
  return (
    <button
      type="button"
      aria-expanded={interactive ? expanded : undefined}
      aria-disabled={!interactive || undefined}
      data-interactive={interactive || undefined}
      className={cn('group flex min-h-[24px] max-w-full min-w-0 items-center gap-2 rounded-md text-left', interactive ? 'cursor-pointer' : 'cursor-default')}
      onClick={interactive ? onToggle : undefined}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ListTree className="size-[18px] shrink-0 text-foreground/45" />
      </span>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{text}</TooltipTrigger>
          <TooltipContent side="top">
            <p className="whitespace-pre-line text-left">{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ) : text}
      {interactive && (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-foreground/40 opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
            expanded && 'rotate-90',
          )}
        />
      )}
    </button>
  )
}

interface ProcessSummaryProps {
  isStreaming: boolean
  /** 运行结束时立即同步折叠，避免与正文出现动画叠加 */
  coordinatedCompletion?: boolean
  summary: string
  tooltip?: string
  hasContent: boolean
  interactive?: boolean
  children?: React.ReactNode
}

/** 运行中默认展开过程，运行结束后自动收起，可再次点击展开 */
export function ProcessSummary({
  isStreaming,
  coordinatedCompletion = false,
  summary,
  tooltip,
  hasContent,
  interactive = hasContent,
  children,
}: ProcessSummaryProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(isStreaming)
  const [mounted, setMounted] = React.useState(isStreaming)
  const [height, setHeight] = React.useState<number | undefined>(isStreaming ? undefined : 0)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const frameRef = React.useRef<number | null>(null)
  const mountedRef = React.useRef(mounted)
  const initializedRef = React.useRef(false)
  mountedRef.current = mounted

  const [trackedStreaming, setTrackedStreaming] = React.useState(isStreaming)
  if (trackedStreaming !== isStreaming) {
    setTrackedStreaming(isStreaming)
    if (coordinatedCompletion) {
      setExpanded(isStreaming)
      setMounted(isStreaming)
    }
  }

  React.useLayoutEffect(() => {
    if (coordinatedCompletion) return
    if (isStreaming) {
      setExpanded(true)
      return
    }
    const element = contentRef.current
    if (element) setHeight(element.clientHeight)
    setExpanded(false)
  }, [isStreaming, coordinatedCompletion])

  React.useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      return
    }
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (expanded) {
      setMounted(true)
      setHeight(undefined)
      return
    }
    if (!mountedRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      setHeight(0)
    })
    const timer = window.setTimeout(() => setMounted(false), COLLAPSE_TRANSITION_MS)
    return () => {
      window.clearTimeout(timer)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [expanded])

  const toggle = (): void => {
    if (expanded && contentRef.current) setHeight(contentRef.current.clientHeight)
    setExpanded((prev) => !prev)
  }

  return (
    <div className="min-w-0 space-y-1">
      <ProcessSummaryRow summary={summary} tooltip={tooltip} expanded={expanded} interactive={interactive} onToggle={toggle} />
      {mounted && hasContent && (
        <div
          ref={contentRef}
          className="overflow-hidden transition-[height,opacity] ease-in-out"
          style={{
            height: expanded ? 'auto' : `${height ?? 0}px`,
            opacity: expanded ? 1 : 0,
            transitionDuration: `${COLLAPSE_TRANSITION_MS}ms`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** 首个助手内容到达前的占位过程：「耗时 Xs」+「正在思考...」 */
export function RunningProcessSummary({ startedAt }: { startedAt?: number }): React.ReactElement {
  const [mountedAt] = React.useState(() => Date.now())
  const elapsed = useElapsedSince(startedAt ?? mountedAt)
  const summary = buildProcessSummary([], elapsed ?? 0) ?? '耗时 0s'
  return (
    <div className="space-y-2">
      <ProcessSummary isStreaming summary={summary} hasContent interactive={false}>
        <div className={PROCESS_TIMELINE_CLASS}>
          <ProcessStepGroup blocks={[]} isActive />
        </div>
      </ProcessSummary>
    </div>
  )
}

// ===== 新步骤展开 / 最终输出显现动画 =====

const EXPAND_DURATION_MS = 320
const EXPAND_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const REVEAL_DELAY_MS = 150
const REVEAL_DURATION_MS = 500

function ExpandIn({ animate, className, children }: { animate: boolean; className?: string; children: React.ReactNode }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const [phase, setPhase] = React.useState<'measure' | 'expand' | 'idle'>(() => (animate && !prefersReducedMotion() ? 'measure' : 'idle'))
  const [height, setHeight] = React.useState(0)

  React.useLayoutEffect(() => {
    if (phase !== 'measure') return
    const element = ref.current
    if (!element) {
      setPhase('idle')
      return
    }
    const target = element.scrollHeight
    const frame = requestAnimationFrame(() => {
      setHeight(target)
      setPhase('expand')
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  React.useEffect(() => {
    if (phase !== 'expand') return
    const timer = window.setTimeout(() => setPhase('idle'), EXPAND_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  const style: React.CSSProperties | undefined = phase === 'idle'
    ? undefined
    : {
        height: phase === 'measure' ? 0 : height,
        opacity: phase === 'measure' ? 0 : 1,
        overflow: 'hidden',
        transition: `height ${EXPAND_DURATION_MS}ms ${EXPAND_EASING}, opacity ${EXPAND_DURATION_MS}ms ease-out`,
      }
  return <div ref={ref} className={className} style={style}>{children}</div>
}

function RevealIn({ animate, className, children }: { animate: boolean; className?: string; children: React.ReactNode }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const shouldAnimateRef = React.useRef(animate)
  React.useLayoutEffect(() => {
    if (!shouldAnimateRef.current || prefersReducedMotion()) return
    const animation = ref.current?.animate?.(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { delay: REVEAL_DELAY_MS, duration: REVEAL_DURATION_MS, easing: EXPAND_EASING, fill: 'backwards' },
    )
    return () => animation?.cancel()
  }, [])
  return <div ref={ref} className={className} data-answer-reveal="">{children}</div>
}

/** expand：新步骤高度展开；reveal：最终输出淡入上移 */
export function ProcessMotion({ mode = 'expand', ...props }: { mode?: 'expand' | 'reveal'; animate: boolean; className?: string; children: React.ReactNode }): React.ReactElement {
  return mode === 'reveal' ? <RevealIn {...props} /> : <ExpandIn {...props} />
}
