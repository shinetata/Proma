/**
 * Present 工具：声明本轮交付物
 *
 * 模型在成品定稿后调用一次，声明 1–8 个要交给用户的文件（Office 文档、表格、
 * 幻灯片、报告、图片、打包产物等）。工具只做校验并返回文件指针，不复制、不修改
 * 文件；渲染层在轮次末尾收集成功的调用，渲染成交付物卡片。
 *
 * 路径约定：
 * - 相对路径一律按 Agent 工作目录解析；
 * - realpath 规范化后必须落在授权根（Agent 工作目录 + 会话附加授权目录）内，
 *   越界路径直接报错，避免把会话外的文件暴露给用户；
 * - 只接受普通文件，目录与特殊文件拒绝；
 * - 同一路径重复声明时按首次出现的位置去重，后出现的描述覆盖前者。
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Type } from 'typebox'
import { normalizePathForCompare } from '@proma/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { serializePiToolResultPayload } from './pi-tool-result-json'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 一次最多声明的交付物数量；与商业版保持一致。 */
export const MAX_PRESENTED_FILES = 8

/** 声明交付物时的路径解析上下文。 */
export interface PresentToolsContext {
  sessionId?: string
  /** Agent 工作目录；相对路径的解析基准，同时是默认授权根。 */
  agentCwd?: string
  /** 会话附加授权目录（用户加入工作区的其他本地目录）。 */
  allowedRoots?: string[]
}

/** 交付物条目：绝对路径、文件名与可选的一句说明。 */
export interface PresentedFile {
  path: string
  name: string
  description?: string
}

/** 工具返回给渲染层与模型的载荷。 */
export interface PresentedFilesPayload {
  files: PresentedFile[]
}

function realPathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return filePath
  }
}

/**
 * 计算本会话的有效授权根：Agent 工作目录加上附加授权目录，逐个 realpath 后
 * 统一成可比较格式。不存在的根会退化为原字符串，不因此中断整轮。
 */
export function authorizedRoots(ctx: PresentToolsContext): string[] {
  return [ctx.agentCwd, ...(ctx.allowedRoots ?? [])]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => normalizePathForCompare(realPathOrSelf(root)))
    .filter((root) => root !== '')
}

function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}

/**
 * 把模型给出的路径解析成可交付的绝对路径。
 *
 * 失败语义：路径为空、越出授权根、不是普通文件都会抛错，错误文案直接面向模型，
 * 让它在下一轮修正参数而不是换个方式绕过校验。
 */
export function resolvePresentedPath(rawPath: string, ctx: PresentToolsContext): string {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0) throw new Error('文件路径不能为空')

  const absolute = isAbsolute(trimmed)
    ? trimmed
    : resolve(ctx.agentCwd ?? process.cwd(), trimmed)
  const canonical = normalizePathForCompare(realPathOrSelf(absolute))

  const roots = authorizedRoots(ctx)
  if (roots.length > 0 && !roots.some((root) => isWithinRoot(canonical, root))) {
    throw new Error(`文件超出当前会话的授权范围：${rawPath}`)
  }

  const info = statSync(canonical)
  if (!info.isFile()) throw new Error(`${rawPath} 不是普通文件，不能作为交付物`)
  return canonical
}

function fileNameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

/**
 * 收集并校验声明列表。重复路径按首次出现顺序保留位置，描述以最后一次为准。
 */
export function collectPresentedFiles(
  input: ReadonlyArray<{ path?: unknown; description?: unknown }>,
  ctx: PresentToolsContext,
): PresentedFile[] {
  const presented = new Map<string, PresentedFile>()
  for (const file of input) {
    const rawPath = typeof file?.path === 'string' ? file.path : ''
    const resolved = resolvePresentedPath(rawPath, ctx)
    const description = typeof file?.description === 'string' ? file.description.trim() : ''
    presented.set(resolved, {
      path: resolved,
      name: fileNameOf(resolved),
      ...(description.length > 0 ? { description } : {}),
    })
  }
  return [...presented.values()]
}

const PRESENT_DESCRIPTION = 'Declare finished files as this turn\'s deliverables for the user: documents, spreadsheets, slide decks, reports, images, or anything they should open or hand off. Call it once the file is final, and normally at the end of your work on it. It does not copy or change the file; the user opens the current file. Do not present source code you merely edited, and do not use it when your reply already carries what the user needs.'

const PRESENT_PROMPT_SNIPPET = 'Use Present only for files the user should take away as a result (Office documents, spreadsheets, slides, reports, images). Skip it for code edits and scratch notes, and skip it when the final reply already says what the user needs.'

/**
 * 构造 Present 工具。所有运行场景（用户会话、自动任务、委派子会话）都注册：
 * 交付物声明的语义与谁触发无关，越权与不存在仍由路径校验拦下。
 */
export function buildPresentTools(sdk: PiSdk, ctx: PresentToolsContext): ToolDefinition[] {
  return [
    sdk.defineTool({
      name: 'Present',
      label: '声明交付物',
      description: PRESENT_DESCRIPTION,
      promptSnippet: PRESENT_PROMPT_SNIPPET,
      parameters: Type.Object({
        files: Type.Array(
          Type.Object({
            path: Type.String({
              description: 'Path of an existing regular file. Relative paths resolve against the Agent working directory.',
            }),
            description: Type.Optional(Type.String({
              description: 'One short line telling the user what this file is, in their language.',
            })),
          }, { additionalProperties: false }),
          {
            minItems: 1,
            maxItems: MAX_PRESENTED_FILES,
            description: 'Usually the 1-2 most important deliverables; never everything a turn touched.',
          },
        ),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const input = params as { files?: Array<{ path?: unknown; description?: unknown }> }
        const files = Array.isArray(input.files) ? input.files : []
        if (files.length === 0) throw new Error('至少要声明一个交付物文件')
        if (files.length > MAX_PRESENTED_FILES) {
          throw new Error(`一次最多声明 ${MAX_PRESENTED_FILES} 个交付物`)
        }

        const payload: PresentedFilesPayload = { files: collectPresentedFiles(files, ctx) }
        const serialized = serializePiToolResultPayload(payload)
        return {
          content: [{ type: 'text', text: serialized.text }],
          details: serialized.details,
        } as AgentToolResult<unknown>
      },
    }),
  ]
}
