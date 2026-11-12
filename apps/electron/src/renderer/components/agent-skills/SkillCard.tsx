/**
 * SkillCard — Agent 技能视图中的 Skill 卡片（0.22.28 排版）
 *
 * 整卡可点击在当前 Skills 视图中打开详情；右上角开关与「可更新」按钮独立响应（阻止冒泡）。
 * 排版要点（对齐商业版）：
 * - 左上角图标块用 slug 哈希取色，内容是 SKILL.md 的 emoji 图标或名称首字母；
 * - 名称行右侧是内置徽标（悬停提示「Proma 内置 Skill」）与「可更新」按钮；
 * - 底部一行是来源、版本号，以及靠右的使用时间短语（悬停显示会话数与最近一次时间）。
 */

import * as React from 'react'
import { RefreshCw, ShieldCheck, ArrowDownToLine } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SkillMeta, SkillUsageEntry } from '@proma/shared'
import { describeSkillUsage, formatSkillUsageAge } from './skillUsage'
import { getSkillAccent, getSkillIconText } from './skillVisual'

interface SkillCardProps {
  skill: SkillMeta
  isBuiltin: boolean
  updating: boolean
  /** 该 Skill 在当前工作区的使用统计；没有记录时显示「未使用」 */
  usage?: SkillUsageEntry
  /** 嵌入右侧面板时的紧凑尺寸 */
  embedded?: boolean
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onUpdate: () => void
}

export function SkillCard({ skill, isBuiltin, updating, usage, embedded = false, onOpen, onToggle, onUpdate }: SkillCardProps): React.ReactElement {
  const accent = getSkillAccent(skill)
  const iconText = getSkillIconText(skill)
  const sourceLabel = isBuiltin ? '内置' : skill.importSource?.sourceWorkspaceName ?? null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      title={skill.slug}
      className={cn(
        'group relative flex h-full cursor-pointer flex-col rounded-xl border border-border/75 bg-background text-left',
        'transition-[border-color,box-shadow] hover:border-border hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        embedded ? 'gap-2.5 p-3.5' : 'gap-3 p-4',
        !skill.enabled && 'opacity-60',
      )}
    >
      <div className={cn('flex items-start', embedded ? 'gap-2.5' : 'gap-3.5')}>
        <div
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg font-semibold leading-none',
            embedded ? 'size-8 text-[13px]' : 'size-9 text-[15px]',
            accent.surface,
          )}
        >
          {iconText}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={cn('truncate font-medium text-foreground', embedded ? 'text-sm' : 'text-[15px]')}>
              {skill.name}
            </span>
            {isBuiltin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ShieldCheck size={embedded ? 12 : 14} className="shrink-0 text-blue-500/70" />
                </TooltipTrigger>
                <TooltipContent side="top">Proma 内置 Skill</TooltipContent>
              </Tooltip>
            )}
            {skill.hasUpdate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onUpdate() }}
                    disabled={updating}
                    aria-label="同步来源最新版本"
                    className="ml-auto flex shrink-0 items-center gap-1 rounded-md bg-blue-500/10 px-2 py-1 text-[12px] font-medium text-blue-600 transition-colors hover:bg-blue-500/20 disabled:opacity-60 dark:text-blue-400"
                  >
                    <RefreshCw size={12} className={cn(updating && 'animate-spin')} />
                    {updating ? '更新中' : '可更新'}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">点击同步来源最新版本</TooltipContent>
              </Tooltip>
            )}
          </div>
          <span className="truncate font-mono text-[11px] text-foreground/35">{skill.slug}</span>
        </div>
        <Switch
          checked={skill.enabled}
          onCheckedChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={skill.enabled ? `关闭 ${skill.name}` : `启用 ${skill.name}`}
          className="shrink-0"
        />
      </div>

      <p
        className={cn(
          'line-clamp-2 text-foreground/55',
          embedded ? 'min-h-[40px] text-[13px] leading-5' : 'min-h-[44px] text-[13px] leading-[22px]',
        )}
      >
        {skill.description || '暂无描述'}
      </p>

      <div className={cn('mt-auto flex min-w-0 items-center gap-2.5 text-foreground/45', embedded ? 'text-[11px]' : 'text-[12px]')}>
        {sourceLabel && (
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{sourceLabel}</span>
          </span>
        )}
        {skill.version && (
          <span className="shrink-0 tabular-nums">v{skill.version}</span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-auto shrink-0 cursor-default tabular-nums text-foreground/35">
              {formatSkillUsageAge(usage)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{describeSkillUsage(usage)}</TooltipContent>
        </Tooltip>
        {!skill.hasUpdate && skill.importSource && (
          <ArrowDownToLine size={12} className="shrink-0 text-muted-foreground/30" />
        )}
      </div>
    </div>
  )
}
