/**
 * AskUserAnswerCard — 历史消息中「你的回答」回显卡片
 *
 * 与商业版 0.22.0 一致：同一轮内连续的已答 AskUserQuestion 聚合成一张卡片，
 * 右对齐排在用户消息一侧，右上角标注「你的回答」，多组时补一个「N 组」计数，
 * 底部提供整段纯文本的复制按钮。
 *
 * 数据解析全部在 ask-user-answers.ts 里完成；本组件只负责渲染，
 * 解析不到有效问答（全部跳过、工具结果报错、JSON 损坏）时直接返回 null。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import type { SDKMessage } from '@proma/shared'
import { CopyButton } from '@/components/common/CopyButton'
import { MessageActions } from '@/components/ai-elements/message'
import {
  buildAskUserAnswerCardData,
  type AskUserAnswerCardBlock,
  type AskUserAnswerItem,
} from './ask-user-answers'

export interface AskUserAnswerCardProps {
  /** 同一组内的已答 AskUserQuestion 工具块（连续调用才合并到一张卡片） */
  blocks: readonly AskUserAnswerCardBlock[]
  /** 全部消息，用于按 tool_use_id 查找工具结果 */
  allMessages: readonly SDKMessage[]
  className?: string
}

function AskUserAnswerRow({ item }: { item: AskUserAnswerItem }): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] leading-5 text-muted-foreground">
        {item.header && <span className="mr-1.5 text-muted-foreground/75">{item.header}</span>}
        <span className="whitespace-pre-wrap break-words">{item.question}</span>
      </dt>
      <dd
        className={cn(
          'mt-0.5 whitespace-pre-wrap break-words text-[length:var(--chat-body-font-size,16px)] leading-[1.55]',
          item.skipped ? 'text-muted-foreground/70' : 'font-medium text-foreground',
        )}
      >
        {item.skipped ? '已跳过' : item.answers.join('、')}
      </dd>
    </div>
  )
}

export function AskUserAnswerCard({ blocks, allMessages, className }: AskUserAnswerCardProps): React.ReactElement | null {
  const data = React.useMemo(
    () => buildAskUserAnswerCardData(blocks, allMessages),
    [blocks, allMessages],
  )
  if (!data) return null

  const { groups, plainText } = data

  return (
    <div className={cn('flex w-full justify-end', className)}>
      <div className="w-fit min-w-0 max-w-[min(46rem,82%)]">
        <div className="rounded-[16px] border-[0.5px] border-border bg-foreground/[0.035] px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-[11px] leading-4 tracking-wide text-muted-foreground/70">你的回答</span>
            {groups.length > 1 && (
              <span className="text-[11px] leading-4 tabular-nums text-muted-foreground/50">{groups.length} 组</span>
            )}
          </div>
          {/* 问答较多时在卡片内部滚动，避免长列表把整轮正文顶走 */}
          <div className="max-h-[min(46vh,360px)] overflow-y-auto overscroll-contain">
            {groups.map((group, groupIndex) => (
              <dl
                key={`batch-${groupIndex}`}
                className={cn('space-y-2.5', groupIndex > 0 && 'mt-2.5 border-t border-border/50 pt-2.5')}
              >
                {group.items.map((item, itemIndex) => (
                  <AskUserAnswerRow key={`${item.question}-${itemIndex}`} item={item} />
                ))}
              </dl>
            ))}
          </div>
        </div>
        {/* 用消息操作栏包一层，复制图标与其它消息操作保持同样的低调色 */}
        <MessageActions className="mt-1 justify-end gap-2 pr-1">
          <CopyButton content={plainText} />
        </MessageActions>
      </div>
    </div>
  )
}