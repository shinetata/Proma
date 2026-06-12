/**
 * CreatePlan 工具结果渲染器
 *
 * Cursor CLI 的 CreatePlan 常在 tool_result 中返回 "{}"，
 * 实际计划正文在 tool_use.input.plan 中。本渲染器在 result 为空时回退展示 input。
 */

import * as React from 'react'
import { CollapsibleResult } from './collapsible-result'
import { MessageResponse } from '@/components/ai-elements/message'

interface CreatePlanTodo {
  id?: string
  content?: string
  status?: string
}

export interface CreatePlanResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
}

export function isCreatePlanResultEmpty(result: string): boolean {
  const trimmed = result.trim()
  if (!trimmed) return true
  if (trimmed === '{}') return true
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).length === 0
    }
  } catch {
    /* 非 JSON，视为有内容 */
  }
  return false
}

function parseTodos(value: unknown): CreatePlanTodo[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : undefined,
      content: typeof item.content === 'string' ? item.content : undefined,
      status: typeof item.status === 'string' ? item.status : undefined,
    }))
    .filter((item) => item.content)
}

export function resolveCreatePlanBody(result: string, input: Record<string, unknown>): string {
  if (!isCreatePlanResultEmpty(result)) return result
  const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
  return plan
}

export function parseCreatePlanInput(input: Record<string, unknown>): {
  overview: string
  todos: CreatePlanTodo[]
} {
  const overview = typeof input.overview === 'string' ? input.overview.trim() : ''
  const todos = parseTodos(input.todos)
  return { overview, todos }
}

export function CreatePlanResultRenderer({
  result,
  isError,
  input,
}: CreatePlanResultRendererProps): React.ReactElement {
  if (isError) {
    return (
      <pre className="rounded-md p-3 text-[12px] font-mono text-destructive/80 bg-destructive/5 whitespace-pre-wrap break-all overflow-x-auto">
        {result}
      </pre>
    )
  }

  const planBody = resolveCreatePlanBody(result, input)
  const { overview, todos } = parseCreatePlanInput(input)

  if (!planBody && !overview && todos.length === 0) {
    return (
      <p className="text-[12px] text-muted-foreground/70 px-1">计划已创建，暂无详细内容。</p>
    )
  }

  return (
    <div className="space-y-2">
      {overview && (
        <p className="text-[13px] text-foreground/75 leading-relaxed px-1">{overview}</p>
      )}

      {todos.length > 0 && (
        <ul className="rounded-md bg-muted/20 px-3 py-2 space-y-1 text-[12px] text-foreground/70">
          {todos.map((todo, index) => (
            <li key={todo.id ?? `todo-${index}`} className="flex items-start gap-2">
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {todo.status?.replace(/^TODO_STATUS_/i, '').toLowerCase() || 'todo'}
              </span>
              <span className="min-w-0 break-words">{todo.content}</span>
            </li>
          ))}
        </ul>
      )}

      {planBody && (
        <CollapsibleResult
          content={planBody}
          threshold={1200}
          previewLines={8}
          renderContent={(text) => (
            <div className="rounded-md bg-muted/30 px-3 py-2 max-h-[480px] overflow-y-auto">
              <MessageResponse>{text}</MessageResponse>
            </div>
          )}
        />
      )}
    </div>
  )
}
