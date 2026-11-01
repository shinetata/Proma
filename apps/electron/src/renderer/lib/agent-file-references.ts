/**
 * Agent 输入框的「文件 → 内联引用」解析。
 *
 * 与商业版一致的策略：粘贴或拖入的文件先落盘到会话私有目录，再在光标处插入
 * `@file:` 引用 chip，由引用本身携带路径并占住输入框里的位置。
 * 只有拿不到项目（无 workspace slug）、超过大小上限或落盘失败时才回退成
 * 待发送附件（`<attached_files>` 块 + 消息上方缩略图行）。
 *
 * 这里只保留与 UI 无关的决策逻辑，base64 读取、IPC 保存和插入动作全部由调用方注入，
 * 便于单测覆盖各条回落分支。
 */

import type { AgentSavedFile, AgentSaveFilesInput } from '@proma/shared'

/** 待判定为内联引用的一个文件。 */
export interface InlineFileReferenceInput<T> {
  /** 调用方需要拿回的原始对象（例如 `File`），回落时原样返回。 */
  item: T
  /** 落盘时使用的文件名。 */
  filename: string
  /** 字节数，用于判断是否超过内联引用上限。 */
  size: number
  /** 读取 base64；只会在真正尝试落盘时调用。 */
  readBase64: () => Promise<string>
}

/** 已成功落盘、可插入输入框的内联引用。 */
export interface InlineFileReference<T> {
  /** 会话目录内的绝对路径，作为 `@file:` 引用的 id。 */
  path: string
  /** 展示用名称（文件名），作为引用 chip 的 label。 */
  name: string
  /** 原始对象，供调用方建立路径映射等附加信息。 */
  item: T
}

export interface SaveFilesAsInlineReferencesOptions<T> {
  sessionId: string
  /** 当前会话绑定的项目 slug；缺失时全部回落为附件。 */
  workspaceSlug?: string | null
  /** 内联引用的大小上限；超过则回落为附件。 */
  maxAttachmentSize: number
  /** 实际落盘实现（主进程 `saveFilesToAgentSession`）。 */
  save: (input: AgentSaveFilesInput) => Promise<AgentSavedFile[]>
  /** 单个文件落盘失败时的回调，默认静默（调用方通常只关心回落结果）。 */
  onSaveError?: (input: InlineFileReferenceInput<T>, error: unknown) => void
}

export interface SaveFilesAsInlineReferencesResult<T> {
  /** 成功落盘的引用，保持输入顺序。 */
  references: InlineFileReference<T>[]
  /** 需要回退成待发送附件的原始对象，保持输入顺序。 */
  fallback: T[]
}

/** 从保存结果中取用于 chip label 的文件名，避免展示 `attachments/xxx.png` 这类相对路径。 */
export function getReferenceDisplayName(savedFilename: string): string {
  const normalized = savedFilename.replace(/\\/g, '/')
  const baseName = normalized.split('/').pop()
  return baseName && baseName.length > 0 ? baseName : savedFilename
}

/**
 * 依次尝试把文件落盘为内联引用，返回成功列表与需要回落的列表。
 *
 * - 无 `workspaceSlug`：直接回落（会话目录不可写）；
 * - `size` 超过上限：直接回落（避免把大文件读进内存再失败）；
 * - 落盘返回空结果或抛错：回落，并按需上报错误。
 */
export async function saveFilesAsInlineReferences<T>(
  inputs: InlineFileReferenceInput<T>[],
  options: SaveFilesAsInlineReferencesOptions<T>,
): Promise<SaveFilesAsInlineReferencesResult<T>> {
  const references: InlineFileReference<T>[] = []
  const fallback: T[] = []
  const workspaceSlug = options.workspaceSlug?.trim()

  for (const input of inputs) {
    if (!workspaceSlug || input.size > options.maxAttachmentSize) {
      fallback.push(input.item)
      continue
    }

    try {
      const data = await input.readBase64()
      const saved = await options.save({
        workspaceSlug,
        sessionId: options.sessionId,
        files: [{ filename: input.filename, data }],
      })
      const savedFile = saved?.[0]
      if (!savedFile?.targetPath) {
        fallback.push(input.item)
        continue
      }
      references.push({
        path: savedFile.targetPath,
        name: getReferenceDisplayName(savedFile.filename || input.filename),
        item: input.item,
      })
    } catch (error) {
      options.onSaveError?.(input, error)
      fallback.push(input.item)
    }
  }

  return { references, fallback }
}
