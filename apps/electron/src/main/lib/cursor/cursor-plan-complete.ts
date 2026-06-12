/**
 * Cursor Plan 模式 — 计划完成检测与合成审批输入
 *
 * Cursor CLI 在 plan 模式下使用原生 CreatePlan 工具（非 Write .md），
 * 本模块负责从消息流提取计划内容并同步落盘到 .context/plan/。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'

const PLAN_DIR = '.context/plan'
const EXCERPT_MAX_CHARS = 2000

export interface CursorPlanArtifact {
  planPath: string
  excerpt: string
  mtimeMs: number
}

/** 扫描 cwd 下最新的计划 markdown 文件 */
export function findLatestPlanFile(cwd: string): CursorPlanArtifact | null {
  const planDir = join(cwd, PLAN_DIR)
  if (!existsSync(planDir)) return null

  let latest: CursorPlanArtifact | null = null

  for (const name of readdirSync(planDir)) {
    if (!name.endsWith('.md')) continue
    const planPath = join(planDir, name)
    try {
      const stat = statSync(planPath)
      if (!stat.isFile()) continue
      if (latest && stat.mtimeMs <= latest.mtimeMs) continue
      const raw = readFileSync(planPath, 'utf8')
      latest = {
        planPath,
        excerpt: raw.slice(0, EXCERPT_MAX_CHARS),
        mtimeMs: stat.mtimeMs,
      }
    } catch {
      /* 跳过不可读文件 */
    }
  }

  return latest
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
    .replace(/[^\w\u4e00-\u9fff-]+/gu, '-')
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

/**
 * 解析 Cursor 计划产物：优先已有 .md，其次从 CreatePlan 工具提取并落盘。
 */
export function resolveCursorPlanArtifact(
  cwd: string,
  messages: SDKMessage[],
): CursorPlanArtifact | null {
  const existing = findLatestPlanFile(cwd)
  if (existing) return existing

  const createPlan = extractCreatePlanFromMessages(messages)
  if (!createPlan) return null

  return persistPlanMarkdown(cwd, createPlan.plan, createPlan.name)
}

/** 构建合成 ExitPlanMode 工具输入（Cursor 渠道专用） */
export function buildSyntheticExitPlanInput(
  artifact: CursorPlanArtifact | null,
  assistantSummary?: string,
): Record<string, unknown> {
  const summary = assistantSummary?.trim() || artifact?.excerpt?.trim() || '计划已完成，请在 Proma UI 中审批。'
  const planPath = artifact?.planPath

  return {
    source: 'cursor_synthetic',
    planSummary: summary,
    ...(planPath ? { planPath } : {}),
    allowedPrompts: [],
  }
}
