/**
 * 轮次文件改动的行级差异计算
 *
 * 输入是改动前后的全文，输出是统一的 hunk 结构，供轮末改动卡的悬停预览
 * 与改动 Tab 的连续视图复用。算法为「去掉公共前后缀 + LCS」，超出格子上限时
 * 退化为整体替换（coarse），避免大文件把主进程算爆。
 */

import type { TurnDiffHunk } from '@proma/shared'

/** hunk 前后保留的上下文行数 */
const CONTEXT_LINES = 3

/** LCS 动态规划的格子上限（约 2500 万格，约 100MB 的 Uint32Array） */
const DEFAULT_MAX_CELLS = 2_500_000

export interface CompareTextResult {
  hunks: TurnDiffHunk[]
  /** 是否因规模超限退化为整体替换 */
  coarse: boolean
  added: number
  deleted: number
}

/** 按行切分：统一换行符，去掉末尾换行产生的空行。 */
function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return body.split('\n')
}

type DiffOp =
  | { type: 'equal'; oldLine: number; newLine: number; text: string }
  | { type: 'del'; oldLine: number; text: string }
  | { type: 'add'; newLine: number; text: string }

/**
 * 比较两段文本，返回带上下文的 hunks 与增删行数。
 *
 * @param before 改动前全文，null 表示文件原本不存在
 * @param after 改动后全文，null 表示文件已被删除
 */
export function compareText(
  before: string | null,
  after: string | null,
  maxCells: number = DEFAULT_MAX_CELLS,
): CompareTextResult {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)

  if (midOld.length === 0 && midNew.length === 0) {
    return { hunks: [], coarse: false, added: 0, deleted: 0 }
  }

  const rows = midOld.length + 1
  const cols = midNew.length + 1
  if (rows * cols > maxCells) {
    return {
      hunks: [{
        oldStart: 1,
        oldLines: oldLines.length,
        newStart: 1,
        newLines: newLines.length,
        lines: [
          ...oldLines.map((line) => `-${line}`),
          ...newLines.map((line) => `+${line}`),
        ],
      }],
      coarse: true,
      added: newLines.length,
      deleted: oldLines.length,
    }
  }

  const ops: DiffOp[] = []
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: 'equal', oldLine: i + 1, newLine: i + 1, text: oldLines[i] ?? '' })
  }

  // dp[i * cols + j] = midOld[i..] 与 midNew[j..] 的 LCS 长度
  const dp = new Uint32Array(rows * cols)
  for (let i = midOld.length - 1; i >= 0; i -= 1) {
    for (let j = midNew.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = midOld[i] === midNew[j]
        ? (dp[(i + 1) * cols + (j + 1)] ?? 0) + 1
        : Math.max(dp[(i + 1) * cols + j] ?? 0, dp[i * cols + (j + 1)] ?? 0)
    }
  }

  let i = 0
  let j = 0
  while (i < midOld.length && j < midNew.length) {
    if (midOld[i] === midNew[j]) {
      ops.push({ type: 'equal', oldLine: prefix + i + 1, newLine: prefix + j + 1, text: midOld[i] ?? '' })
      i += 1
      j += 1
    } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + (j + 1)] ?? 0)) {
      ops.push({ type: 'del', oldLine: prefix + i + 1, text: midOld[i] ?? '' })
      i += 1
    } else {
      ops.push({ type: 'add', newLine: prefix + j + 1, text: midNew[j] ?? '' })
      j += 1
    }
  }
  while (i < midOld.length) {
    ops.push({ type: 'del', oldLine: prefix + i + 1, text: midOld[i] ?? '' })
    i += 1
  }
  while (j < midNew.length) {
    ops.push({ type: 'add', newLine: prefix + j + 1, text: midNew[j] ?? '' })
    j += 1
  }

  for (let k = 0; k < suffix; k += 1) {
    const oldIdx = oldLines.length - suffix + k
    const newIdx = newLines.length - suffix + k
    ops.push({ type: 'equal', oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx] ?? '' })
  }

  // 把连续改动合并成窗口，两侧各带 CONTEXT_LINES 行上下文；相邻窗口重叠时合并。
  const windows: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < ops.length) {
    if (ops[cursor]?.type === 'equal') {
      cursor += 1
      continue
    }
    const changeStart = cursor
    while (cursor < ops.length && ops[cursor]?.type !== 'equal') {
      cursor += 1
    }
    const start = Math.max(0, changeStart - CONTEXT_LINES)
    const end = Math.min(ops.length, cursor + CONTEXT_LINES)
    const prev = windows[windows.length - 1]
    if (prev !== undefined && start <= prev.end) {
      prev.end = end
    } else {
      windows.push({ start, end })
    }
  }

  let added = 0
  let deleted = 0
  const hunks: TurnDiffHunk[] = windows.map(({ start, end }) => {
    const slice = ops.slice(start, end)
    let oldCount = 0
    let newCount = 0
    let firstOld: number | undefined
    let firstNew: number | undefined
    const lines: string[] = []

    for (const op of slice) {
      if (op.type === 'equal') {
        firstOld ??= op.oldLine
        firstNew ??= op.newLine
        oldCount += 1
        newCount += 1
        lines.push(` ${op.text}`)
      } else if (op.type === 'del') {
        firstOld ??= op.oldLine
        oldCount += 1
        deleted += 1
        lines.push(`-${op.text}`)
      } else {
        firstNew ??= op.newLine
        newCount += 1
        added += 1
        lines.push(`+${op.text}`)
      }
    }

    return {
      oldStart: oldCount === 0 ? 1 : firstOld ?? 1,
      oldLines: oldCount,
      newStart: newCount === 0 ? 1 : firstNew ?? 1,
      newLines: newCount,
      lines,
    }
  })

  return { hunks, coarse: false, added, deleted }
}
