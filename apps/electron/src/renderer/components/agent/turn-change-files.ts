/**
 * 轮次文件改动的渲染层纯逻辑
 *
 * 轮末改动卡的数据可能来自两处：
 * 1. 主进程录制器的真实结果（`turn_changes`，或 IPC 兜底到内存摘要）
 * 2. 没有录制结果时，按本轮成功的 Edit/MultiEdit/Write 工具输入估算行数
 *
 * 这里只放不依赖 React 的纯函数（收集路径、估算行数、合并数据源、路径裁剪、
 * 预览类型判定、正文文件名映射），便于单测覆盖；组件在 `TurnChangesCard.tsx`。
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
  TurnChangesSummary,
} from '@proma/shared'

/** 修改类工具：底部改动卡兜底统计与正文文件名映射都以它为准 */
export const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * 本轮"触碰过"的工具集合（改 + 读）——用于正文内联文件引用的路径补全。
 * Read 的 input.file_path 与 Edit/Write 同构，都是绝对路径，可零解析纳入映射；
 * Grep/Glob 的命中文件只存在于 tool_result 中，暂不纳入。
 */
const TOUCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

/** 折叠阈值：超过该文件数时只展示前 N 个，并提供展开入口 */
export const COLLAPSE_THRESHOLD = 4

/** 悬停 diff 单个 hunk 最多渲染的行数 */
export const HOVER_HUNK_MAX_LINES = 120

/** 渲染层使用的单文件改动条目 */
export interface TurnChangeFileEntry {
  /** 绝对路径 */
  path: string
  /** 文件名（展示标题用） */
  name: string
  /** 展示用路径（相对基准目录或 ~/ 相对路径） */
  display: string
  added: number
  deleted: number
  binary?: boolean
  oversized?: boolean
}

/** 渲染层使用的本轮改动数据 */
export interface TurnChangeView {
  files: TurnChangeFileEntry[]
  total: number
  added: number
  deleted: number
  /** 是否来自主进程录制器（false 表示按工具输入估算，不提供悬停 diff） */
  fromRecorder: boolean
}

/** 渲染层没有 node:path，跨平台绝对路径判定按前缀处理。 */
function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
}

/** 从工具输入里取被修改的路径。 */
export function resolveToolFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const notebookPath = input.notebook_path
    return typeof notebookPath === 'string' ? notebookPath : null
  }
  const filePath = input.file_path ?? input.filePath ?? input.path
  return typeof filePath === 'string' ? filePath : null
}

/** 把工具调用里的路径补成绝对路径：相对路径按消息当时的工作目录解析。 */
function absoluteToolPath(message: SDKAssistantMessage, filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath
  const sourceCwd = (message as unknown as { _sourceCwd?: unknown })._sourceCwd
  if (typeof sourceCwd !== 'string' || !isAbsolutePath(sourceCwd)) return filePath
  return `${sourceCwd.replace(/[\\/]+$/, '')}/${filePath}`
}

/** 统计文本行数；结尾换行不计入额外一行。 */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1
  }
  return text.endsWith('\n') ? lines - 1 : lines
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 按工具输入估算单个文件的行数变化。
 *
 * 没有录制结果时使用：Edit 按 old_string/new_string 行数，
 * MultiEdit 累加各条 edit，Write 的 content 全部计为新增。
 */
export function estimateChangeStats(
  toolName: string,
  input: Record<string, unknown>,
): { added: number; deleted: number } | null {
  if (toolName === 'Edit') {
    const oldString = asString(input.old_string)
    const newString = asString(input.new_string)
    if (oldString === null || newString === null) return null
    return { added: countLines(newString), deleted: countLines(oldString) }
  }

  if (toolName === 'MultiEdit') {
    const edits = input.edits
    if (!Array.isArray(edits)) return null
    let added = 0
    let deleted = 0
    let counted = false
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue
      const record = edit as Record<string, unknown>
      const oldString = asString(record.old_string)
      const newString = asString(record.new_string)
      if (oldString === null || newString === null) continue
      added += countLines(newString)
      deleted += countLines(oldString)
      counted = true
    }
    return counted ? { added, deleted } : null
  }

  if (toolName === 'Write') {
    const content = asString(input.content)
    if (content === null) return null
    return { added: countLines(content), deleted: 0 }
  }

  return null
}

/** 收集本轮成功（有非错误 tool_result）的工具调用 id。 */
function collectSucceededToolUseIds(turnMessages: readonly SDKMessage[]): Set<string> {
  const succeeded = new Set<string>()
  for (const message of turnMessages) {
    if (message.type !== 'user') continue
    const blocks = (message as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const resultBlock = block as SDKToolResultBlock
      if (resultBlock.is_error !== true) succeeded.add(resultBlock.tool_use_id)
    }
  }
  return succeeded
}

/** 按出现顺序收集本轮使用指定工具成功触碰过的文件路径（绝对路径、去重）。 */
export function collectToolFilePaths(
  turnMessages: readonly SDKMessage[],
  tools: ReadonlySet<string> = MUTATING_TOOLS,
): string[] {
  const succeeded = collectSucceededToolUseIds(turnMessages)
  const seen = new Set<string>()
  const paths: string[] = []

  for (const message of turnMessages) {
    if (message.type !== 'assistant') continue
    const blocks = (message as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as SDKToolUseBlock
      if (!tools.has(toolUse.name) || !succeeded.has(toolUse.id)) continue

      const filePath = resolveToolFilePath(toolUse.name, (toolUse.input ?? {}) as Record<string, unknown>)
      if (!filePath) continue
      const absolute = absoluteToolPath(message as SDKAssistantMessage, filePath)
      if (seen.has(absolute)) continue
      seen.add(absolute)
      paths.push(absolute)
    }
  }
  return paths
}

/** 相对路径裁剪：去掉最长匹配 base 前缀，返回用于展示的路径。 */
export function stripBasePathPrefix(filePath: string, basePaths: readonly string[] = []): string {
  const normalized = normalizeBasePath(filePath)
  let matched: string | null = null
  for (const base of basePaths) {
    if (!base) continue
    const normalizedBase = normalizeBasePath(base)
    if (normalizedBase.length === 0 || normalizedBase === '/') continue
    if (normalized !== normalizedBase && !normalized.startsWith(`${normalizedBase}/`)) continue
    if (matched === null || normalizedBase.length > matched.length) {
      matched = normalizedBase
    }
  }
  if (matched === null) return normalized
  return normalized.slice(matched.length).replace(/^\/+/, '')
}

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 拆分文件名与所在目录前缀。 */
export function splitFileName(filePath: string): { name: string; dir: string } {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (index < 0) return { name: filePath, dir: '' }
  return { name: filePath.slice(index + 1), dir: filePath.slice(0, index + 1) }
}

/**
 * 没有录制结果时，按本轮成功的修改类工具输入估算每个文件的行数变化。
 *
 * 同一文件被多次修改时累加，与真实改动方向一致（虽是估算）。
 */
export function collectEstimatedChanges(turnMessages: readonly SDKMessage[]): Array<{
  path: string
  name: string
  dir: string
  added: number
  deleted: number
}> {
  const succeeded = collectSucceededToolUseIds(turnMessages)
  const byPath = new Map<string, { path: string; name: string; dir: string; added: number; deleted: number }>()

  for (const message of turnMessages) {
    if (message.type !== 'assistant') continue
    const blocks = (message as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as SDKToolUseBlock
      if (!MUTATING_TOOLS.has(toolUse.name) || !succeeded.has(toolUse.id)) continue

      const input = (toolUse.input ?? {}) as Record<string, unknown>
      const filePath = resolveToolFilePath(toolUse.name, input)
      if (!filePath) continue

      const absolute = absoluteToolPath(message as SDKAssistantMessage, filePath)
      const stats = estimateChangeStats(toolUse.name, input)
      const existing = byPath.get(absolute)
      if (existing) {
        if (stats) {
          existing.added += stats.added
          existing.deleted += stats.deleted
        }
        continue
      }
      const { name, dir } = splitFileName(absolute)
      byPath.set(absolute, {
        path: absolute,
        name,
        dir,
        added: stats?.added ?? 0,
        deleted: stats?.deleted ?? 0,
      })
    }
  }

  return [...byPath.values()]
}

/**
 * 选择展示路径。
 *
 * 录制器按「相对 cwd」计算 display；Dev 的会话 cwd 往往是工作台目录
 * （`~/.proma/agent-workspaces/...`），比对到项目根时会得到 `../../../..` 这类路径。
 * 这种情况下优先用 basePaths 裁剪后的路径，避免卡片里出现一串 `..`。
 */
function preferredDisplay(
  recorded: string | undefined,
  absolute: string,
  name: string,
  basePaths: readonly string[],
): string {
  const trimmed = stripBasePathPrefix(absolute, basePaths)
  if (recorded && !recorded.startsWith('..')) return recorded
  if (trimmed && !trimmed.startsWith('..')) return trimmed
  return recorded || trimmed || name
}

/**
 * 合并录制结果与工具输入估算，产出改动卡需要的数据。
 *
 * @param summary 录制器结果（持久化字段或 IPC 内存摘要），null 表示不可用
 * @param turnMessages 本轮全部消息，兜底估算的数据源
 * @param basePaths 展示路径的裁剪基准（session 目录、附加目录等）
 */
export function mergeTurnChanges(
  summary: TurnChangesSummary | null | undefined,
  turnMessages: readonly SDKMessage[],
  basePaths: readonly string[] = [],
): TurnChangeView {
  if (summary) {
    const files: TurnChangeFileEntry[] = summary.files.map((file) => {
      const { name } = splitFileName(file.path)
      return {
        path: file.path,
        name,
        display: preferredDisplay(file.display, file.path, name, basePaths),
        added: file.added,
        deleted: file.deleted,
        ...(file.binary ? { binary: true } : {}),
        ...(file.oversized ? { oversized: true } : {}),
      }
    })
    return {
      files,
      total: summary.total,
      added: summary.added,
      deleted: summary.deleted,
      fromRecorder: true,
    }
  }

  const estimated = collectEstimatedChanges(turnMessages)
  const files: TurnChangeFileEntry[] = estimated.map((file) => ({
    path: file.path,
    name: file.name,
    display: stripBasePathPrefix(file.path, basePaths) || file.name,
    added: file.added,
    deleted: file.deleted,
  }))
  return {
    files,
    total: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    fromRecorder: false,
  }
}

/**
 * 构建「文件名 → 绝对路径」映射，供消息正文内联文件引用补全裸文件名使用。
 *
 * 数据源是本轮触碰过的文件（TOUCHED_TOOLS：改过 + Read 读过）与录制结果里的文件，
 * 覆盖"本轮只读过没改就在正文引用"的场景。同名不同目录的文件无法凭裸文件名区分，
 * 直接从映射中剔除，交由既有 basePaths 解析逻辑处理。
 */
export function buildTurnFileNameMap(
  turnMessages: readonly SDKMessage[],
  inputMessage?: SDKUserMessage,
): Map<string, string> {
  const paths = collectToolFilePaths(turnMessages, TOUCHED_TOOLS)
  for (const file of inputMessage?.turn_changes?.files ?? []) {
    if (!paths.includes(file.path)) paths.push(file.path)
  }

  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const absolute of paths) {
    const name = absolute.split(/[\\/]/).pop() || absolute
    if (conflicted.has(name)) continue
    const existing = map.get(name)
    if (existing && existing !== absolute) {
      map.delete(name)
      conflicted.add(name)
      continue
    }
    map.set(name, absolute)
  }
  return map
}

/** 取扩展名（小写，含点）。 */
export function extensionOf(filePath: string): string {
  const name = filePath.replace(/[?#].*$/, '').split(/[\\/]/).at(-1) ?? ''
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

const DIRECT_PREVIEW_EXTS = new Set([
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  // 文档
  '.pdf', '.html', '.htm', '.docx', '.xlsx', '.pptx',
  // 旧版 Office（Dev 预览面板对它们有专门的降级提示）
  '.doc', '.xls', '.ppt',
])

/**
 * 该文件是否适合直接在右侧预览打开（而不是进改动 Tab 看 diff）。
 *
 * 只覆盖 Dev 预览面板真正能渲染的类型；音视频等商业版会走预览的类型在 Dev
 * 尚未接入媒体预览，因此按文本/diff 处理更可靠。
 */
export function isDirectPreviewFile(filePath: string): boolean {
  if (!filePath) return false
  const ext = extensionOf(filePath)
  return ext.length > 0 && DIRECT_PREVIEW_EXTS.has(ext)
}

/** 千分位数字格式化（+1,234 / -56 的展示用）。 */
const numberFormatter = new Intl.NumberFormat('en-US')

export function formatChangeCount(value: number, sign: '+' | '-'): string {
  return `${sign}${numberFormatter.format(value)}`
}
