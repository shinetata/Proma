/**
 * Cursor Plan 模式 — CreatePlan 工具内容提取与计划落盘
 *
 * Cursor CLI 在 plan 模式下使用原生 CreatePlan 工具（非 Write .md），
 * 本模块负责从消息流提取计划内容并持久化到 .context/plan/。
 */

import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'

const PLAN_DIR = '.context/plan'
const EXCERPT_MAX_CHARS = 2000

export interface CursorPlanArtifact {
  planPath: string
  excerpt: string
  mtimeMs: number
}

export interface CreatePlanContent {
  plan: string
  name?: string
  overview?: string
}

/** 将计划标题转为安全文件名 */
export function slugifyPlanFilename(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w一-鿿-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'plan'
}

/** 从 SDK 消息流中提取最近一次 CreatePlan 工具内容 */
export function extractCreatePlanFromMessages(messages: SDKMessage[]): CreatePlanContent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const assistant = msg as SDKAssistantMessage
    for (const block of assistant.message?.content ?? []) {
      if (block.type !== 'tool_use' || !('name' in block) || block.name !== 'CreatePlan') continue
      const input = ('input' in block && block.input && typeof block.input === 'object'
        ? block.input
        : {}) as Record<string, unknown>
      const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
      if (!plan) continue
      return {
        plan,
        name: typeof input.name === 'string' ? input.name : undefined,
        overview: typeof input.overview === 'string' ? input.overview : undefined,
      }
    }
  }
  return null
}

/** 将计划 markdown 写入 .context/plan/ 并返回 artifact */
export function persistPlanMarkdown(cwd: string, content: string, basename?: string): CursorPlanArtifact {
  const planDir = join(cwd, PLAN_DIR)
  mkdirSync(planDir, { recursive: true })
  const filename = `${slugifyPlanFilename(basename ?? 'plan')}.md`
  const planPath = join(planDir, filename)
  writeFileSync(planPath, content, 'utf8')
  const stat = statSync(planPath)
  return {
    planPath,
    excerpt: content.slice(0, EXCERPT_MAX_CHARS),
    mtimeMs: stat.mtimeMs,
  }
}
