/**
 * ProcessTimeline — 助手轮次的执行过程区
 *
 * 结构与商业版 0.22.0 一致：
 * - TurnProcessSummary：轮次顶部的一行过程摘要（带底边线），完成态可点击展开过程分区，
 *   运行中实时显示耗时，停止/失败保持收拢并标注状态；
 * - ProcessStepGroup：一行步骤组（图标 + 文案 + 摘要 + 步数），点击展开步骤明细，
 *   不再有左侧竖线时间轴；
 * - TurnLayoutTransition：轮次三种布局（运行中 / 停止失败 / 完成）切换时的高度过渡。
 */

import * as React from 'react'
import { BookOpen, ChevronRight, Server, Sparkles } from 'lucide-react'
import type { SDKContentBlock, SDKToolUseBlock } from '@proma/shared'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getToolIcon } from './tool-utils'
import {
  THINKING_STEP_CONTENT,
  countProcessBlocks,
  formatLiveElapsed,
  getProcessStepContent,
  type ProcessStepContent,
  type ToolReference,
} from './assistant-turn-sections'

const STEP_TRANSITION_MS = 420
const STEP_MIN_DWELL_MS = 900

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
        'inline-flex max-w-[min(18rem,60vw)] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium leading-none align-baseline',
        styleClassName,
        className,
      )}
      title={reference.title}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{reference.label}</span>
    </span>
  )
}

// ===== 步骤文案：切换时上下淡入淡出，并保证每条文案至少停留 900ms =====

/** 停留内容的类型：步骤文案 + 仅参与停留 key 的 suffix（步数） */
type DwellStepContent = ProcessStepContent & { suffix?: string }

function getStepContentKey(content: DwellStepContent): string {
  return `${content.label}|${content.reference?.kind ?? ''}|${content.reference?.label ?? ''}|${content.suffix ?? ''}|${content.markerTool ?? ''}`
}

function useDwellStepContent(content: DwellStepContent, initial?: ProcessStepContent): ProcessStepContent {
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
      <span className="shrink-0">{content.label}</span>
      {content.reference && <ToolReferenceChip reference={content.reference} />}
    </span>
  )
}

interface StepLabelState {
  current: ProcessStepContent
  previous: ProcessStepContent | null
  phase: 'idle' | 'enter' | 'active'
  generation: number
}

function StepLabel({ label, reference }: { label: string; reference?: ToolReference }): React.ReactElement {
  const key = `${label}|${reference?.kind ?? ''}|${reference?.label ?? ''}`
  const [state, setState] = React.useState<StepLabelState>({ current: { label, reference }, previous: null, phase: 'idle', generation: 0 })
  const latestRef = React.useRef({ key, content: { label, reference } })

  React.useEffect(() => {
    if (latestRef.current.key === key) return
    const previous = latestRef.current.content
    latestRef.current = { key, content: { label, reference } }
    setState((prev) => ({ current: { label, reference }, previous, phase: 'enter', generation: prev.generation + 1 }))
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
    // label/reference 由 key 唯一确定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const transitionStyle = { transitionDuration: `${STEP_TRANSITION_MS}ms` }
  const entering = state.previous !== null && state.phase === 'enter'
  const leaving = state.previous !== null && state.phase === 'active'

  return (
    <span className="inline-grid shrink-0 max-w-full font-normal text-foreground/60">
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

// ===== 步骤组行 =====

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

/** 一行步骤组：图标 + 文案（带切换动画）+ 摘要 + 步数，可展开步骤明细 */
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
  // 文案与图标参与 900ms 停留；summary 不参与停留，每次渲染直接取最新值
  const dwellContent = useDwellStepContent({
    ...stepContent,
    suffix: !isActive && steps > 1 ? `· ${steps} 步` : undefined,
    markerTool: stepContent.markerTool ?? (isActive ? (last?.type === 'tool_use' ? (last as SDKToolUseBlock).name : undefined) : lastTool?.name),
  }, startFromThinking ? THINKING_STEP_CONTENT : undefined)
  const summary = stepContent.summary
  const canExpand = blocks.length > 0 && !!renderChildren
  const Icon = dwellContent.reference?.kind === 'skill'
    ? BookOpen
    : dwellContent.markerTool
      ? getToolIcon(dwellContent.markerTool)
      : null

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        disabled={!canExpand}
        onClick={toggle}
        className={cn(
          'group -mx-1.5 flex h-[25px] max-w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left transition-colors',
          'text-[length:var(--chat-body-font-size,16px)]',
          canExpand && 'hover:bg-foreground/[0.05]',
          expanded && 'bg-foreground/[0.03]',
          !canExpand && 'cursor-default',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {Icon
            ? <Icon className={cn('size-4', isActive ? 'text-foreground/60' : 'text-foreground/40')} />
            : <Sparkles className={cn('size-4', isActive ? 'text-foreground/60' : 'text-foreground/40')} />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <StepLabel label={dwellContent.label} reference={dwellContent.reference} />
          {summary && (
            <>
              <span className="shrink-0 text-foreground/25">·</span>
              <span className={cn('min-w-0 truncate text-foreground/45', isActive && 'activity-summary-streaming')}>{summary}</span>
            </>
          )}
          {!isActive && steps > 1 && (
            <span className="shrink-0 tabular-nums text-foreground/30">· {steps} 步</span>
          )}
        </span>
        {canExpand && (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-foreground/30 opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
              expanded && 'rotate-90 opacity-100',
            )}
          />
        )}
      </button>
      {expanded && canExpand && (
        <div className="mb-1.5 ml-6 mt-1 space-y-2 rounded-lg bg-muted/25 px-3 py-2.5 animate-in fade-in duration-150">
          {renderChildren?.(true)}
        </div>
      )}
    </div>
  )
}

/** 运行占位：Sparkles 图标 +「正在思考...」（对应商业版 s9t） */
export function RunningStepPlaceholder(): React.ReactElement {
  return <ProcessStepGroup blocks={[]} isActive />
}

// ===== 轮次过程摘要行 =====

export type TurnOutcome = 'stopped' | 'failed' | 'completed'

interface TurnProcessSummaryProps {
  expandKey?: string
  /** 运行中：不可展开，显示实时耗时 */
  streaming?: boolean
  /** 运行结束后的结果状态，决定主文案与是否可展开 */
  outcome?: TurnOutcome
  /** 完成轮次的耗时文案（formatTurnDuration 的结果） */
  durationText?: string
  /** 运行中轮次的起始时间，用于实时耗时 */
  startedAt?: number
  /** 步数（所有活动分区的条目数之和） */
  steps: number
  /** 耗时与用量 tooltip（仅完成态传入） */
  tooltip?: string
  children?: React.ReactNode
}

/**
 * 轮次顶部的一行过程摘要（对应商业版 xj）。
 *
 * 运行中显示「正在执行任务 · 已完成 N 步 · 持续 X」；
 * 完成/停止/失败收拢为一行，仅完成态可点击展开下方的过程分区（children）。
 */
export function TurnProcessSummary({
  expandKey,
  streaming = false,
  outcome = 'completed',
  durationText,
  startedAt,
  steps,
  tooltip,
  children,
}: TurnProcessSummaryProps): React.ReactElement {
  const [expanded, toggle] = useProcessExpandState(expandKey)
  const elapsed = useElapsedSince(streaming ? startedAt : undefined)
  const liveElapsedText = formatLiveElapsed(elapsed)
  const canToggle = !streaming && outcome === 'completed'
  const label = streaming
    ? '正在执行任务'
    : outcome === 'stopped'
      ? '已停止'
      : outcome === 'failed'
        ? '运行失败'
        : durationText
          ? `已完成，用时 ${durationText}`
          : '已完成'
  const stepsText = streaming
    ? (steps > 0 ? `· 已完成 ${steps} 步` : undefined)
    : (steps > 1 ? `· ${steps} 步` : undefined)
  const liveText = streaming && startedAt != null && liveElapsedText
    ? `· 持续 ${liveElapsedText}`
    : undefined

  const mainText = (
    <span className="shrink-0 tabular-nums text-foreground/60">{label}</span>
  )

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={canToggle ? expanded : undefined}
        disabled={!canToggle}
        onClick={canToggle ? toggle : undefined}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 border-b border-border/50 pb-2 text-left transition-colors',
          'text-[length:var(--chat-body-font-size,16px)]',
          canToggle ? 'hover:text-foreground/75' : 'cursor-default text-foreground/55',
        )}
      >
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>{mainText}</TooltipTrigger>
            <TooltipContent side="top">
              <p className="whitespace-pre-line text-left">{tooltip}</p>
            </TooltipContent>
          </Tooltip>
        ) : mainText}
        {stepsText && <span className="shrink-0 tabular-nums text-foreground/35">{stepsText}</span>}
        {liveText && <span className="shrink-0 tabular-nums text-foreground/35">{liveText}</span>}
        {canToggle && (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-foreground/30 opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
              expanded && 'rotate-90 opacity-100',
            )}
          />
        )}
      </button>
      {expanded && children != null && (
        <div className="mb-1 mt-2 space-y-0.5 animate-in fade-in duration-150">
          {children}
        </div>
      )}
    </div>
  )
}

// ===== 轮次布局切换的高度过渡 =====

const LAYOUT_TRANSITION_DELAY_MS = 150
const LAYOUT_TRANSITION_DURATION_MS = 500
const LAYOUT_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

interface TurnLayoutTransitionProps {
  /** 是否启用高度过渡动画 */
  animate: boolean
  /** 布局标识：变化时触发高度过渡 */
  layoutKey: string
  className?: string
  children: React.ReactNode
}

/**
 * 轮次三种布局（运行中 / 停止失败 / 完成）切换时的高度过渡（对应商业版 X7t）。
 *
 * 提交前记下外层高度（getSnapshotBeforeUpdate），提交后对外层做
 * height: 旧 → 新 的 Web Animations 过渡（delay 150ms、duration 500ms、
 * cubic-bezier(0.22, 1, 0.36, 1)、fill: 'both'），过渡期间外层 overflow: clip；
 * 过渡未结束时内容高度再变化，用 ResizeObserver 以剩余时长重新定位目标高度。
 * prefers-reduced-motion 或 animate 为假时不做动画。
 */
class TurnLayoutTransition extends React.Component<TurnLayoutTransitionProps> {
  private outerRef = React.createRef<HTMLDivElement>()
  private innerRef = React.createRef<HTMLDivElement>()
  private animation: Animation | undefined
  private observer: ResizeObserver | undefined
  private deadline = 0
  private targetHeight = 0

  private observeContent(): void {
    if (typeof ResizeObserver === 'undefined') return
    this.observer ??= new ResizeObserver(() => {
      if (!this.animation) return
      const remaining = this.deadline - performance.now()
      const outer = this.outerRef.current
      const inner = this.innerRef.current
      if (!outer || !inner || remaining <= 0) return
      const height = inner.getBoundingClientRect().height
      if (Math.abs(height - this.targetHeight) < 1) return
      const current = outer.getBoundingClientRect().height
      this.transition(current, height, 0, remaining)
    })
    if (this.innerRef.current) this.observer.observe(this.innerRef.current)
  }

  private clearAnimation(): void {
    this.observer?.disconnect()
    this.animation?.cancel()
    this.animation = undefined
    if (this.outerRef.current) this.outerRef.current.style.overflow = ''
  }

  private transition(from: number, to: number, delay: number, duration: number): void {
    this.clearAnimation()
    const outer = this.outerRef.current
    if (!outer?.animate || Math.abs(from - to) < 1) return
    outer.style.overflow = 'clip'
    this.targetHeight = to
    this.deadline = performance.now() + delay + duration
    const animation = outer.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { delay, duration, easing: LAYOUT_TRANSITION_EASING, fill: 'both' },
    )
    this.animation = animation
    animation.onfinish = () => {
      if (this.animation === animation) this.clearAnimation()
    }
    this.observeContent()
  }

  override getSnapshotBeforeUpdate(previous: TurnLayoutTransitionProps): number | null {
    if (!this.props.animate || previous.layoutKey === this.props.layoutKey || prefersReducedMotion()) return null
    return this.outerRef.current?.getBoundingClientRect().height ?? null
  }

  override componentDidUpdate(previous: TurnLayoutTransitionProps, _state: Readonly<Record<string, never>>, snapshot: number | null): void {
    if (prefersReducedMotion() || !this.props.animate) {
      this.clearAnimation()
      return
    }
    if (snapshot == null || !this.innerRef.current) return
    this.transition(
      snapshot,
      this.innerRef.current.getBoundingClientRect().height,
      LAYOUT_TRANSITION_DELAY_MS,
      LAYOUT_TRANSITION_DURATION_MS,
    )
  }

  override componentWillUnmount(): void {
    this.clearAnimation()
  }

  override render(): React.ReactElement {
    return (
      <div ref={this.outerRef} data-completion-layout="">
        <div ref={this.innerRef} className={this.props.className} style={{ display: 'flow-root' }}>
          {this.props.children}
        </div>
      </div>
    )
  }
}

export { TurnLayoutTransition }

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
