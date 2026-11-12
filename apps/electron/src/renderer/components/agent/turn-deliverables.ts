/**
 * 交付物收集（纯逻辑）
 *
 * 从一轮消息里提取 Agent 通过 `Present` 工具声明的交付物，供轮末交付物卡渲染。
 * 与 UI 解耦，便于单测；不访问文件系统，路径补全只用传入的候选根做字符串拼接。
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
} from '@proma/shared'

export const PRESENT_TOOL_NAME = 'Present'

/** 交付物条目：绝对路径、文件名与可选说明。 */
export interface PresentedFileEntry {
  path: string
  name: string
  description?: string
}

function fileNameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)
}

/** 把相对路径补全到会话候选根；模型通常给绝对路径，兜底不打断渲染。 */
function resolveMessagePath(rawPath: string, basePaths: string[]): string {
  const trimmed = rawPath.trim()
  if (trimmed.length === 0 || isAbsolutePath(trimmed)) return trimmed
  const root = basePaths[0]
  return root ? `${root.replace(/[\\/]+$/, '')}/${trimmed}` : trimmed
}

/** 收集本轮已成功返回的 tool_use id。失败的工具调用不能作为可信证据。 */
function collectSucceededToolUseIds(turnMessages: SDKMessage[]): Set<string> {
  const succeeded = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue
      const result = block as SDKToolResultBlock
      if (result.is_error !== true) succeeded.add(result.tool_use_id)
    }
  }
  return succeeded
}

/**
 * 从本轮消息里收集已成功声明的交付物。
 *
 * 只认 tool_result 未报错的 `Present` 调用：调用失败说明路径校验没通过，不应该
 * 出现在交付区。同一路径重复声明时保留首次出现的位置，描述以最后一次为准。
 */
export function collectPresentedFiles(turnMessages: SDKMessage[], basePaths: string[] = []): PresentedFileEntry[] {
  const succeeded = collectSucceededToolUseIds(turnMessages)
  const presented = new Map<string, PresentedFileEntry>()

  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as SDKToolUseBlock
      if (toolUse.name !== PRESENT_TOOL_NAME || !succeeded.has(toolUse.id)) continue
      const files = (toolUse.input as { files?: unknown } | undefined)?.files
      if (!Array.isArray(files)) continue
      for (const file of files as Array<{ path?: unknown; description?: unknown }>) {
        const rawPath = typeof file?.path === 'string' ? file.path.trim() : ''
        if (rawPath.length === 0) continue
        const resolved = resolveMessagePath(rawPath, basePaths)
        const description = typeof file?.description === 'string' ? file.description.trim() : ''
        presented.set(resolved, {
          path: resolved,
          name: fileNameOf(resolved),
          ...(description.length > 0 ? { description } : {}),
        })
      }
    }
  }

  return [...presented.values()]
}

/** 扩展名标签：无扩展名时统一显示「文件」。 */
export function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '文件'
}

/** 去掉描述末尾的括号补充（中英文括号），避免副标题出现多余注解。 */
export function stripTrailingParenthetical(description: string | undefined, fallback: string): string {
  const stripped = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return stripped === undefined || stripped === '' ? fallback : stripped
}
