/**
 * Bash 工具结果渲染器 — 终端风格
 *
 * 深色背景、等宽字体、stderr 红色高亮
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CollapsibleResult } from './collapsible-result'

interface BashResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
}

/** 简单检测 stderr 行（常见模式） */
function classifyLine(line: string): 'stderr' | 'normal' {
  const lower = line.toLowerCase()
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.startsWith('fatal:') ||
    lower.startsWith('warning:') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.startsWith('stderr:')
  ) {
    return 'stderr'
  }
  return 'normal'
}

export function BashResultRenderer({ result, isError, input }: BashResultRendererProps): React.ReactElement {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined

  const renderOutput = React.useCallback((text: string): React.ReactNode => {
    const lines = text.split('\n')
    return (
      <div className="overflow-x-auto scrollbar-thin">
        {lines.map((line, i) => {
          const type = isError ? 'stderr' : classifyLine(line)
          return (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all min-h-[1.25em]',
                type === 'stderr' && 'text-red-400',
              )}
            >
              {line || '\u200B'}
            </div>
          )
        })}
      </div>
    )
  }, [isError])

  return (
    <div className={cn(
      'min-w-0 rounded-md font-mono text-[12px] leading-relaxed',
      'bg-zinc-900 text-zinc-100 dark:bg-zinc-950 p-3',
    )}>
      {/* 命令：执行中也可展开查看 */}
      {command && (
        <div>
          <div className="mb-1 text-[11px] text-zinc-400">命令</div>
          <pre className="m-0 max-h-80 overflow-auto scrollbar-thin whitespace-pre select-text" tabIndex={0} aria-label="Bash 命令">
            <code>{command}</code>
          </pre>
        </div>
      )}
      {result && (
        <div className={command ? 'mt-3 border-t border-zinc-700/60 pt-3' : undefined}>
          <CollapsibleResult content={result} renderContent={renderOutput} />
        </div>
      )}
    </div>
  )
}
