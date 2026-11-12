/**
 * patch 解析
 *
 * 把主进程 `git:get-changes-patch` 返回的 unified diff 解析成连续改动视图使用的文件列表。
 * 解析交给 `@pierre/diffs` 的 `parsePatchFiles`，这里只做归一化与增删统计。
 */

import { parsePatchFiles } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'
import { countHunkLines, stripLineEnding, type ChangesFile } from './continuous-diff-rows'

/** patch 解析出的行保留 `\n` 与 CRLF 的 `\r`，渲染前统一去掉，避免行尾出现不可见字符。 */
function normalizeMetadata(metadata: FileDiffMetadata): FileDiffMetadata {
  return {
    ...metadata,
    additionLines: metadata.additionLines.map(stripLineEnding),
    deletionLines: metadata.deletionLines.map(stripLineEnding),
  }
}

function toChangesFile(metadata: FileDiffMetadata): ChangesFile {
  const normalized = normalizeMetadata(metadata)
  const { additions, deletions } = countHunkLines(normalized.hunks)
  return {
    path: normalized.name,
    previousPath: normalized.prevName ?? null,
    status: normalized.type,
    additions,
    deletions,
    empty: normalized.hunks.length === 0,
    metadata: normalized,
  }
}

/** 解析 unified diff 文本；空 patch 返回空数组，单个文件解析失败时跳过该文件。 */
export function parseChangesPatch(patch: string): ChangesFile[] {
  if (patch.trim().length === 0) return []
  return parsePatchFiles(patch).flatMap((parsed) => parsed.files.map(toChangesFile))
}
