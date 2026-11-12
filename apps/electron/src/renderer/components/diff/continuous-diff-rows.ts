/**
 * 连续改动视图的行构建逻辑
 *
 * 把 @pierre/diffs 解析出的 `FileDiffMetadata` 展开成可直接渲染的行模型：
 * - unified 行：单列行号对（旧/新）+ 文本；
 * - split 行：把连续的删除与新增配对成左右两列；
 * - 段（segment）：hunk 行与未改动的 gap 交替排列，gap 只有显式展开后才取到完整上下文行。
 *
 * 本模块只做纯计算，不依赖 React 与 IPC，便于单测覆盖。
 */

import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

/** 文件改动类型，与 `@pierre/diffs` 的 parsed patch 保持一致 */
export type ChangesFileStatus = 'new' | 'deleted' | 'change' | 'rename-pure' | 'rename-changed'

/** 连续改动视图中的一个文件 */
export interface ChangesFile {
  /** 新路径（相对于所在 Git 仓库根） */
  path: string
  /** 重命名前的路径；未重命名为 null */
  previousPath: string | null
  status: ChangesFileStatus
  additions: number
  deletions: number
  /** 没有可展示的行改动（二进制文件或仅权限变化） */
  empty: boolean
  metadata: FileDiffMetadata
}

export type DiffLineKind = 'context' | 'add' | 'del'

/** unified 视图中的一行 */
export interface UnifiedDiffLine {
  kind: DiffLineKind
  /** 旧文件行号；新增行为 null */
  old: number | null
  /** 新文件行号；删除行为 null */
  new: number | null
  text: string
}

/** split 视图中的单个单元格 */
export interface SplitDiffCell {
  kind: DiffLineKind
  no: number
  text: string
}

/** split 视图中的一行：左右各自可能为空 */
export interface SplitDiffRow {
  left: SplitDiffCell | null
  right: SplitDiffCell | null
}

/** 连续滚动区中的一段：整块行，或一段被折叠的未改动行 */
export type DiffSegment =
  | { kind: 'rows'; rows: UnifiedDiffLine[] }
  | { kind: 'gap'; index: number; count: number | null }

/** 默认展开的行数预算：超过后后面的文件默认收起，避免一次渲染过多行 */
export const DEFAULT_EXPANDED_LINE_BUDGET = 8_000

/** 单文件超过此行数时先显示「展开 N 行改动」按钮，点击后才渲染 */
export const LARGE_FILE_LINE_THRESHOLD = 4_000

/** 判定二进制内容时最多检查的字符数 */
const BINARY_CHECK_LENGTH = 8_000

/**
 * 按行拆分文本内容。
 *
 * 去掉末尾换行产生的空行，并统一去掉行尾 `\r`，避免 CRLF 文件每行都带一个不可见字符。
 */
export function splitContentLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map(stripLineEnding)
}

/**
 * 去掉行尾换行标记。
 *
 * patch 解析出的行保留 `\n`（CRLF 文件还额外带 `\r`），而磁盘内容按行拆分后没有换行符，
 * 两者比较与渲染前都要先归一化。
 */
export function stripLineEnding(line: string): string {
  const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line
  return withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline
}

/** 内容中是否含 NUL 字节（视为二进制，不做文本 diff 展示）。 */
export function looksLikeBinaryContent(content: string): boolean {
  return content.slice(0, BINARY_CHECK_LENGTH).includes('\u0000')
}

/** 统计 hunk 中的新增与删除行数。 */
export function countHunkLines(hunks: readonly Hunk[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== 'change') continue
      additions += content.additions
      deletions += content.deletions
    }
  }
  return { additions, deletions }
}

/**
 * 为未跟踪文件构造「全新增」的伪 patch 元数据。
 *
 * 未跟踪文件不在 `git diff` 输出里，这里按新增文件的形态人工组装一个 hunk，
 * 让连续视图可以和其他改动一样展开、折叠、并排显示。
 */
export function buildNewFileChanges(filePath: string, content: string): ChangesFile {
  const lines = splitContentLines(content)
  const noEOFCR = content === '' || content.endsWith('\n')
  const isEmpty = lines.length === 0
  const hunk: Hunk = {
    collapsedBefore: 0,
    additionStart: 1,
    additionCount: lines.length,
    additionLines: lines.length,
    additionLineIndex: 0,
    deletionStart: 1,
    deletionCount: 0,
    deletionLines: 0,
    deletionLineIndex: 0,
    hunkContent: isEmpty
      ? []
      : [{ type: 'change', deletions: 0, deletionLineIndex: 0, additions: lines.length, additionLineIndex: 0 }],
    splitLineStart: 0,
    splitLineCount: lines.length,
    unifiedLineStart: 0,
    unifiedLineCount: lines.length,
    noEOFCRDeletions: noEOFCR,
    noEOFCRAdditions: noEOFCR,
  }
  const metadata: FileDiffMetadata = {
    name: filePath,
    type: 'new',
    hunks: isEmpty ? [] : [hunk],
    splitLineCount: lines.length,
    unifiedLineCount: lines.length,
    isPartial: true,
    deletionLines: [],
    additionLines: lines,
  }
  return {
    path: filePath,
    previousPath: null,
    status: 'new',
    additions: lines.length,
    deletions: 0,
    empty: isEmpty,
    metadata,
  }
}

/** 把一个 hunk 展开成 unified 行，行号按 hunk 起始位置递增。 */
export function buildUnifiedLines(
  hunk: Hunk,
  additionLines: readonly string[],
  deletionLines: readonly string[],
): UnifiedDiffLine[] {
  const rows: UnifiedDiffLine[] = []
  let oldLine = hunk.deletionStart
  let newLine = hunk.additionStart

  for (const content of hunk.hunkContent) {
    if (content.type === 'context') {
      for (let offset = 0; offset < content.lines; offset++) {
        rows.push({
          kind: 'context',
          old: oldLine++,
          new: newLine++,
          text: additionLines[content.additionLineIndex + offset] ?? '',
        })
      }
      continue
    }
    for (let offset = 0; offset < content.deletions; offset++) {
      rows.push({
        kind: 'del',
        old: oldLine++,
        new: null,
        text: deletionLines[content.deletionLineIndex + offset] ?? '',
      })
    }
    for (let offset = 0; offset < content.additions; offset++) {
      rows.push({
        kind: 'add',
        old: null,
        new: newLine++,
        text: additionLines[content.additionLineIndex + offset] ?? '',
      })
    }
  }
  return rows
}

/**
 * 把 unified 行配对成并排视图。
 *
 * 连续的删除行先攒在左列，遇到新增行时攒到右列，遇到上下文行或配对结束时左右成对输出；
 * 两侧数量不一致时短的一侧留空单元格。
 */
export function pairSplitRows(rows: readonly UnifiedDiffLine[]): SplitDiffRow[] {
  const paired: SplitDiffRow[] = []
  let leftBuffer: SplitDiffCell[] = []
  let rightBuffer: SplitDiffCell[] = []

  const flush = (): void => {
    const length = Math.max(leftBuffer.length, rightBuffer.length)
    for (let index = 0; index < length; index++) {
      paired.push({ left: leftBuffer[index] ?? null, right: rightBuffer[index] ?? null })
    }
    leftBuffer = []
    rightBuffer = []
  }

  for (const row of rows) {
    if (row.kind === 'del') {
      if (rightBuffer.length > 0) flush()
      leftBuffer.push({ kind: 'del', no: row.old ?? 0, text: row.text })
      continue
    }
    if (row.kind === 'add') {
      rightBuffer.push({ kind: 'add', no: row.new ?? 0, text: row.text })
      continue
    }
    flush()
    paired.push({
      left: { kind: 'context', no: row.old ?? 0, text: row.text },
      right: { kind: 'context', no: row.new ?? 0, text: row.text },
    })
  }
  flush()
  return paired
}

/**
 * 把文件展开成「行段 / gap 段」序列。
 *
 * - `expandedContent` 为完整的新文件内容时，已展开的 gap 直接铺开成上下文行；
 * - 被动折叠的 gap 交给界面渲染「N 行未更改」按钮；
 * - 文件尾部长度未知（还没有完整内容）时，gap 的 count 为 null，界面显示「展开剩余未更改行」。
 */
export function buildFileSegments(
  file: ChangesFile,
  expandedContent: readonly string[] | undefined,
  openGaps: ReadonlySet<number>,
): DiffSegment[] {
  const segments: DiffSegment[] = []
  let currentRows: UnifiedDiffLine[] = []

  const flushRows = (): void => {
    if (currentRows.length === 0) return
    segments.push({ kind: 'rows', rows: currentRows })
    currentRows = []
  }

  /** 起始/结束都按新文件行号（1-based）描述，gap 内旧文件行号按差值同步推进。 */
  const pushGap = (index: number, fromNew: number, toNew: number | null, fromOld: number): void => {
    if (expandedContent !== undefined && toNew !== null && openGaps.has(index)) {
      const count = toNew - fromNew + 1
      for (let offset = 0; offset < count; offset++) {
        currentRows.push({
          kind: 'context',
          old: fromOld + offset,
          new: fromNew + offset,
          text: expandedContent[fromNew - 1 + offset] ?? '',
        })
      }
      return
    }
    flushRows()
    segments.push({ kind: 'gap', index, count: toNew === null ? null : toNew - fromNew + 1 })
  }

  const hunks = file.metadata.hunks
  let lastNewLine = 0
  let lastOldLine = 0

  for (const [index, hunk] of hunks.entries()) {
    if (hunk.additionStart - 1 > lastNewLine) {
      pushGap(index, lastNewLine + 1, hunk.additionStart - 1, lastOldLine + 1)
    }
    currentRows.push(...buildUnifiedLines(hunk, file.metadata.additionLines, file.metadata.deletionLines))
    lastNewLine = hunk.additionStart + hunk.additionCount - 1
    lastOldLine = hunk.deletionStart + hunk.deletionCount - 1
  }

  // 尾部未改动行：新增/删除文件本来就只有到末尾的内容，不额外造 gap。
  if (hunks.at(-1) !== undefined && file.status !== 'new' && file.status !== 'deleted') {
    if (expandedContent !== undefined) {
      if (expandedContent.length > lastNewLine) {
        pushGap(hunks.length, lastNewLine + 1, expandedContent.length, lastOldLine + 1)
      }
    } else {
      pushGap(hunks.length, lastNewLine + 1, null, lastOldLine + 1)
    }
  }

  flushRows()
  return segments
}

/** 计算默认展开的文件集合：从上往下累计行数，不超过预算的文件默认展开。 */
export function computeDefaultExpandedPaths(
  files: readonly ChangesFile[],
  budget: number = DEFAULT_EXPANDED_LINE_BUDGET,
): Set<string> {
  const expanded = new Set<string>()
  let consumed = 0
  for (const file of files) {
    if (consumed > budget) break
    expanded.add(file.path)
    consumed += file.metadata.unifiedLineCount
  }
  return expanded
}

/** 渲染行号列宽所需的最大行号；展开 gap 后行号会变大，需要按完整内容重新计算。 */
export function getMaxLineNumber(file: ChangesFile, expandedContent?: readonly string[]): number {
  let max = expandedContent?.length ?? 0
  for (const hunk of file.metadata.hunks) {
    max = Math.max(max, hunk.deletionStart + hunk.deletionCount - 1, hunk.additionStart + hunk.additionCount - 1)
  }
  return max
}

/**
 * 校验完整文件内容与 patch 的上下文行是否一致。
 *
 * patch 可能来自旧快照（文件已被再次修改），此时展开 gap 会显示错位内容，
 * 因此展开前先逐行比对上下文块，不一致就不展开。
 */
export function areContextLinesMatching(
  metadata: FileDiffMetadata,
  contentLines: readonly string[],
): boolean {
  for (const hunk of metadata.hunks) {
    let cursor = hunk.additionStart - 1
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset++) {
          const expected = stripLineEnding(contentLines[cursor] ?? '')
          const actual = stripLineEnding(metadata.additionLines[content.additionLineIndex + offset] ?? '')
          if (expected !== actual) return false
          cursor++
        }
      } else {
        cursor += content.additions
      }
    }
  }
  return true
}
