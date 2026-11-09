/**
 * ModelSelector - 模型选择器（锚定 Popover + 搜索 + 推理深度子视图）
 *
 * 现代化设计：
 * - 非模态 Popover 锚定触发按钮，向上展开（右对齐），避免 Dialog 全屏遮罩
 * - 按渠道分组，标题与模型项使用统一栅格对齐
 * - 选中项使用柔和底色与右侧勾选标记
 * - 触发按钮：模型 logo + 模型名 + 推理深度 + Chevron
 * - 推理深度（旧的「思考深度」按钮）并入本选择器：root 视图顶部一行入口，
 *   点开后进入 effort 子视图，用单选组切换档位；该档位只作用于当前会话。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Circle, Cpu, Search, Zap } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  channelsAtom,
  channelsLoadedAtom,
} from '@/atoms/channel-atoms'
import { modelSelectorOpenAtom } from '@/atoms/model-selector-atoms'
import { inputToolbarControlHeightClass } from '@/components/ai-elements/input-toolbar-styles'
import { getModelLogo, getChannelLogo, DefaultLogo } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { AgentThinkingLevel, Channel, ModelOption, ProviderType } from '@proma/shared'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'
import { getModelSelectorOptionVisualState } from './model-selector-visual-state'

/** 渠道标题与模型项共享的三列栅格，确保左右边距和文字起点一致。 */
const MODEL_SELECTOR_ROW_LAYOUT =
  'mx-1 grid w-[calc(100%-0.5rem)] grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3'

interface ModelSelectorListIconProps {
  src: string
}

/** 使用固定外框吸收不同 Logo 素材的透明留白差异，保持列表中的视觉尺寸稳定。 */
function ModelSelectorListIcon({ src }: ModelSelectorListIconProps): React.ReactElement {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center justify-self-center overflow-hidden rounded-md bg-muted/50"
      aria-hidden="true"
    >
      <img src={src} alt="" className="size-5 rounded-md object-contain" />
    </span>
  )
}

/** Codex 响应速度档位；Dev 后端目前支持标准与快速两档。 */
export type CodexSpeed = 'standard' | 'fast'

const CODEX_SPEED_LABELS: Record<CodexSpeed, string> = { standard: '标准', fast: '快速' }

/** Codex 速度配置：由会话视图传入，仅在 Codex 渠道且模型支持多档速度时显示。 */
export interface ModelSelectorCodexSpeed {
  speed: CodexSpeed
  speeds: CodexSpeed[]
  disabled?: boolean
  onChange: (speed: CodexSpeed) => void
}

/** 触发按钮内的速度徽标 */
function CodexSpeedBadge({ speed }: { speed: CodexSpeed }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none',
        speed !== 'standard' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}
      aria-label={`Codex 速度：${CODEX_SPEED_LABELS[speed]}`}
    >
      {speed !== 'standard' && <Zap className="size-3" aria-hidden="true" />}
      {CODEX_SPEED_LABELS[speed]}
    </span>
  )
}

/** 模型列表底部的「响应速度」单选组 */
function CodexSpeedPicker({ speed, speeds, disabled, onChange }: ModelSelectorCodexSpeed): React.ReactElement {
  const id = React.useId()
  return (
    <div className="mx-4 mb-2 mt-2 border-t border-border/50 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span id={`${id}-label`} className="text-xs font-medium text-foreground">响应速度</span>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          aria-orientation="horizontal"
          className="flex gap-1 rounded-lg bg-muted/60 p-1"
        >
          {speeds.map((item) => {
            const checked = speed === item
            return (
              <label
                key={item}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
                  checked && 'bg-background text-foreground shadow-sm',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={CODEX_SPEED_LABELS[item]}
                  disabled={disabled}
                  onClick={() => { if (!checked) onChange(item) }}
                  className={cn('aspect-square h-4 w-4 rounded-full border border-primary text-primary shadow focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', 'size-3')}
                >
                  {checked && (
                    <span className="flex items-center justify-center">
                      <Circle className="h-3.5 w-3.5 fill-primary" />
                    </span>
                  )}
                </button>
                {CODEX_SPEED_LABELS[item]}
              </label>
            )
          })}
        </div>
      </div>
      <p id={`${id}-hint`} className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        快速模式优先响应，消耗更多额度。{disabled ? '当前暂不可切换。' : '仅应用于当前会话，不改变思考强度。'}
      </p>
    </div>
  )
}

/** 从渠道列表构建扁平化的模型选项 */
export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
): ModelOption[] {
  const options: ModelOption[] = []

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (filterChannelIds && !filterChannelIds.includes(channel.id)) continue
    if (excludedProviders?.includes(channel.provider)) continue

    for (const model of channel.models) {
      if (!model.enabled) continue

      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      })
    }
  }

  return options
}

/** 按渠道分组模型选项 */
function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>()

  for (const option of options) {
    const key = option.channelId
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }

  return groups
}

/** 推理档位（旧「思考深度」）配置：由会话视图传入，仅当模型具备推理能力时提供。 */
export interface ModelSelectorThinking {
  /** 当前生效档位 */
  level: AgentThinkingLevel
  /** 该模型可选的档位，顺序由浅到深 */
  levels: readonly AgentThinkingLevel[]
  /** 档位变更回调 */
  onChange: (level: AgentThinkingLevel) => void
  /** 会话元数据未就绪时禁止切换 */
  disabled?: boolean
}

/** 档位显示名，与商业版保持一致。 */
const THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/** 档位说明，单选组内以第二行小字展示。 */
const THINKING_LEVEL_HINTS: Record<AgentThinkingLevel, string> = {
  off: '不进行扩展思考',
  minimal: '极少思考，最快响应',
  low: '轻量思考，响应较快',
  medium: '在速度与深度之间平衡',
  high: '深度推理，默认档位',
  xhigh: '更长时间的推理',
  max: '最大思考预算，最慢',
}

/** 推理深度单选组的一项。 */
interface ThinkingLevelOption {
  level: AgentThinkingLevel
  label: string
  hint?: string
  selected: boolean
}

/** 把档位列表展开为单选组选项，供 effort 子视图渲染。 */
function buildThinkingLevelOptions(
  levels: readonly AgentThinkingLevel[],
  selected: AgentThinkingLevel,
): ThinkingLevelOption[] {
  return levels.map((level) => ({
    level,
    label: THINKING_LEVEL_LABELS[level] ?? level,
    hint: THINKING_LEVEL_HINTS[level],
    selected: level === selected,
  }))
}

/** 档位显示名；未设置档位时返回 undefined，由调用方决定占位文案。 */
function getThinkingLevelLabel(level: AgentThinkingLevel | undefined): string | undefined {
  if (level === undefined) return undefined
  return THINKING_LEVEL_LABELS[level] ?? level
}

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 当前选中模型 */
  externalSelectedModel: { channelId: string; modelId: string } | null
  /** 选择回调 */
  onModelSelect: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 不在此选择器中显示的供应商 */
  excludedProviders?: readonly ProviderType[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
  /** 触发按钮文字的宽度约束，默认 max-w-[200px] */
  triggerLabelClassName?: string
  /** Codex 响应速度（仅 Codex 渠道支持多档速度的模型显示） */
  codexSpeed?: ModelSelectorCodexSpeed
  /** 推理档位（推理深度）；未提供或不支持推理的模型不显示该入口 */
  thinking?: ModelSelectorThinking
}

export function ModelSelector({
  filterChannelId,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  excludedProviders,
  useSharedOpenState = false,
  triggerLabelClassName,
  codexSpeed,
  thinking,
}: ModelSelectorProps): React.ReactElement {
  const setChannels = useSetAtom(channelsAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const selectedModel = externalSelectedModel

  // 推理深度子视图：root 为模型列表，effort 为档位单选组。
  const [view, setView] = React.useState<'root' | 'effort'>('root')
  const [effortHighlight, setEffortHighlight] = React.useState(-1)
  const effortItemRefs = React.useRef<HTMLButtonElement[]>([])
  const effortOptions = React.useMemo(
    () => (thinking ? buildThinkingLevelOptions(thinking.levels, thinking.level) : []),
    [thinking],
  )
  const effortLabel = getThinkingLevelLabel(thinking?.level)
  const showEffort = thinking !== undefined && effortOptions.length > 0

  // 每次打开 Popover 时刷新渠道列表，确保最新
  React.useEffect(() => {
    if (open) {
      window.electronAPI.listChannels().then(setChannels).catch(console.error)
      setSearch('')
    }
  }, [open, setChannels])

  // 关闭面板时回到 root 视图，避免下次打开残留上次的档位子视图。
  React.useEffect(() => {
    if (open) return
    setView('root')
    setEffortHighlight(-1)
  }, [open])

  // 进入 effort 子视图时把焦点落到当前档位，方便直接上下键调整。
  React.useEffect(() => {
    if (view !== 'effort') return
    const index = Math.max(0, effortOptions.findIndex((option) => option.selected))
    effortItemRefs.current[index]?.focus()
    setEffortHighlight(index)
  }, [view, effortOptions])

  const modelOptions = React.useMemo(
    () => buildModelOptions(channels, filterChannelId, filterChannelIds, excludedProviders),
    [channels, filterChannelId, filterChannelIds, excludedProviders],
  )
  const grouped = React.useMemo(() => groupByChannel(modelOptions), [modelOptions])

  // 搜索过滤
  const filteredGrouped = React.useMemo(() => {
    if (!search.trim()) return grouped

    const query = search.toLowerCase()
    const filtered = new Map<string, ModelOption[]>()

    for (const [channelId, options] of grouped.entries()) {
      const matchedOptions = options.filter(
        (o) =>
          o.modelName.toLowerCase().includes(query) ||
          o.channelName.toLowerCase().includes(query)
      )
      if (matchedOptions.length > 0) {
        filtered.set(channelId, matchedOptions)
      }
    }

    return filtered
  }, [grouped, search])

  // 扁平化过滤后的模型列表，用于键盘导航
  const flatOptions = React.useMemo(() => {
    const result: ModelOption[] = []
    for (const options of filteredGrouped.values()) {
      result.push(...options)
    }
    return result
  }, [filteredGrouped])

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 搜索变化时重置高亮
  React.useEffect(() => {
    setHighlightIndex(-1)
  }, [search])

  // 高亮项变化时滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex < 0) return
    const el = itemRefs.current.get(highlightIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  // 查找当前选中的模型信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    return modelOptions.find(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    ) ?? null
  }, [selectedModel, modelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current
  const showCodexSpeed = !!(codexSpeed && currentModelInfo?.provider === 'openai-codex' && codexSpeed.speeds.length > 1)

  // Tooltip 必须始终保持 controlled 或 uncontrolled 之一。此前在 Popover 打开时传 false、关闭时传
  // undefined，Radix 会发出 controlled/uncontrolled 告警，且与模型 Popover 的 trigger 竞争焦点。
  React.useEffect(() => {
    if (open || !displayModelInfo) setTooltipOpen(false)
  }, [displayModelInfo, open])

  /** 选择模型后交由调用方处理 */
  const handleSelect = (option: ModelOption): void => {
    onModelSelect(option)
    setOpen(false)
  }

  /** 搜索框键盘导航 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (flatOptions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev < flatOptions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : flatOptions.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatOptions[highlightIndex >= 0 ? highlightIndex : 0]
      if (target) handleSelect(target)
    }
  }

  /** 计算档位单选组的下一个高亮位置（首尾循环，与模型列表一致）。 */
  const resolveNextEffortIndex = (delta: 1 | -1): number => {
    const count = effortOptions.length
    if (count === 0) return -1
    if (effortHighlight < 0) return delta > 0 ? 0 : count - 1
    return Math.min(count - 1, Math.max(0, effortHighlight + delta))
  }

  /** 档位单选组上下键导航 */
  const handleEffortKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const nextIndex = resolveNextEffortIndex(e.key === 'ArrowDown' ? 1 : -1)
    if (nextIndex < 0) return
    effortItemRefs.current[nextIndex]?.focus()
    setEffortHighlight(nextIndex)
  }

  /** 选择推理档位：档位属于当前会话配置，切换后关闭面板。 */
  const handleEffortSelect = (level: AgentThinkingLevel): void => {
    if (!thinking || thinking.disabled) return
    if (level !== thinking.level) thinking.onChange(level)
    setOpen(false)
  }

  if (channelsLoaded && modelOptions.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
        <Cpu className="size-3.5" />
        <span>暂无可用模型</span>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* 触发按钮 */}
      <Tooltip
        open={tooltipOpen}
        onOpenChange={(nextOpen) => setTooltipOpen(nextOpen && !open && Boolean(displayModelInfo))}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'model-selector-trigger flex items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-foreground focus:outline-none focus-visible:bg-accent focus-visible:text-foreground',
                inputToolbarControlHeightClass,
              )}
            >
              {displayModelInfo ? (
                <img
                  src={getModelLogo(displayModelInfo.modelId, displayModelInfo.provider)}
                  alt={displayModelInfo.modelName}
                  className="size-4 rounded object-cover"
                />
              ) : (
                <Cpu className="size-3.5" />
              )}
              <span className={cn('truncate', triggerLabelClassName ?? 'max-w-[200px]')}>
                {displayModelInfo
                  ? (showChannelInTrigger ? `${displayModelInfo.channelName} · ${displayModelInfo.modelName}` : displayModelInfo.modelName)
                  : '选择模型'}
              </span>
              {showEffort && effortLabel ? (
                <span className="shrink-0 whitespace-nowrap text-muted-foreground/70">· {effortLabel}</span>
              ) : null}
              {showCodexSpeed && codexSpeed && <CodexSpeedBadge speed={codexSpeed.speed} />}
              <ChevronDown className="size-3 shrink-0" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          渠道：{displayModelInfo?.channelName}
          {showEffort && effortLabel ? ` · 推理深度：${effortLabel}` : ''}
        </TooltipContent>
      </Tooltip>

      {/* 模型选择 Popover — 锚定触发按钮，向上展开（end 对齐，内容向左上延伸）。
          宽度优先让模型名称完整显示，并在窄窗口内保留 12px 的安全边距。 */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(480px,calc(100vw-24px))] p-0"
        aria-label="选择模型"
      >
        {view === 'effort' && showEffort ? (
          // 推理深度子视图：顶部返回按钮 + 右上「仅作用于当前会话」说明，下方为档位单选组。
          <div className="flex flex-col">
            <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setView('root')}
                className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:bg-accent focus-visible:text-foreground"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                推理深度
              </button>
              <span className="ml-auto shrink-0 pr-1.5 text-[10px] text-muted-foreground/70">
                仅作用于当前会话
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="推理深度"
              onKeyDown={handleEffortKeyDown}
              className="max-h-[min(360px,55vh)] overflow-y-auto p-1 scrollbar-thin"
            >
              {effortOptions.map((option, index) => (
                <button
                  key={option.level}
                  ref={(el) => {
                    if (el) effortItemRefs.current[index] = el
                    else delete effortItemRefs.current[index]
                  }}
                  type="button"
                  role="radio"
                  aria-checked={option.selected}
                  disabled={thinking?.disabled === true}
                  onClick={() => handleEffortSelect(option.level)}
                  onFocus={() => setEffortHighlight(index)}
                  onMouseEnter={() => setEffortHighlight(index)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                    'hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/70 disabled:opacity-50',
                    option.selected && 'bg-accent',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm',
                        option.selected ? 'font-medium text-foreground' : 'text-foreground/80',
                      )}
                    >
                      {option.label}
                    </span>
                    {option.hint ? (
                      <span className="block truncate text-xs text-muted-foreground">{option.hint}</span>
                    ) : null}
                  </span>
                  {option.selected ? (
                    <Check className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* 推理深度入口：点击进入档位子视图 */}
            {showEffort ? (
              <>
                <button
                  type="button"
                  aria-haspopup="menu"
                  onClick={() => setView('effort')}
                  className={cn(
                    'mx-1 mt-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                    'hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/70',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">推理深度</span>
                  <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs text-muted-foreground">
                    {effortLabel ?? '未设置'}
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </span>
                </button>
                <div className="mx-3 border-b border-border/60" />
              </>
            ) : null}

            {/* 搜索栏 */}
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border/60">
              <Search className="size-4 text-muted-foreground/60 flex-shrink-0" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                autoFocus
              />
            </div>

            {/* 模型列表 */}
            <div className="max-h-[min(360px,55vh)] overflow-y-auto scrollbar-thin">
              {filteredGrouped.size === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  未找到模型
                </div>
              ) : (
                (() => {
                  let flatIndex = 0
                  return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                    const first = options[0]
                    if (!first) return null
                    const channel = channels.find((c) => c.id === channelId)

                    return (
                      <div
                        key={channelId}
                        role="group"
                        aria-label={first.channelName}
                        className="border-b border-border/40 py-1 last:border-b-0"
                      >
                        {/* 渠道标题与模型行共用栅格，仅通过字号和色阶区分层级。 */}
                        <div className={cn(MODEL_SELECTOR_ROW_LAYOUT, 'min-h-7 py-0.5')}>
                          <ModelSelectorListIcon
                            src={channel ? getChannelLogo(channel) : DefaultLogo}
                          />
                          <span className="min-w-0 truncate text-xs font-medium text-muted-foreground/80">
                            {first.channelName}
                          </span>
                          {channel ? <ChannelPlanQuotaBadge channel={channel} /> : null}
                        </div>

                        {/* 该渠道下的模型列表 */}
                        {options.map((option) => {
                          const isSelected =
                            selectedModel?.channelId === option.channelId &&
                            selectedModel?.modelId === option.modelId
                          const currentFlatIndex = flatIndex++
                          const isHighlighted = currentFlatIndex === highlightIndex
                          const visualState = getModelSelectorOptionVisualState(isSelected, isHighlighted)

                          return (
                            <button
                              key={`${option.channelId}:${option.modelId}`}
                              ref={(el) => {
                                if (el) itemRefs.current.set(currentFlatIndex, el)
                                else itemRefs.current.delete(currentFlatIndex)
                              }}
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => handleSelect(option)}
                              onMouseEnter={() => setHighlightIndex(currentFlatIndex)}
                              className={cn(
                                'group',
                                MODEL_SELECTOR_ROW_LAYOUT,
                                'min-h-9 rounded-lg py-1.5 text-left transition-colors',
                                'hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/70',
                                visualState === 'highlighted' && 'bg-accent/60',
                                visualState === 'selected' && 'bg-accent',
                              )}
                            >
                              <ModelSelectorListIcon
                                src={getModelLogo(option.modelId, option.provider)}
                              />
                              <span className="min-w-0 overflow-hidden block">
                                <span
                                  className={cn(
                                    'block min-w-0 truncate text-sm',
                                    isSelected ? 'font-medium text-foreground' : 'text-foreground/80',
                                  )}
                                  title={option.modelName}
                                >
                                  {option.modelName}
                                </span>
                              </span>
                              <span className="relative flex size-5 items-center justify-center justify-self-end" aria-hidden="true">
                                {isSelected ? <Check className="size-4 text-primary" strokeWidth={2.5} /> : null}
                              </span>
                            </button>
                          )
                        })}
                        {showCodexSpeed && codexSpeed && channelId === currentModelInfo?.channelId && (
                          <CodexSpeedPicker {...codexSpeed} />
                        )}
                      </div>
                    )
                  })
                })()
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
