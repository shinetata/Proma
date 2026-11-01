/**
 * 受限的文件快照与行级 diff。
 *
 * 记忆目录监听（外部编辑）与工具执行前后追踪（Agent 写入）共用这一份实现，
 * 避免两处 diff 结果不一致。
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'

export const MAX_DIFF_FILE_BYTES = 96 * 1024
export const MAX_DIFF_LINES = 8

export interface FileSnapshot {
  signature: string
  text?: string
}

export interface FileDiffPayload {
  context: string[]
  removed: string[]
  added: string[]
  truncated: boolean
}

export interface FileChange {
  relativePath: string
  kind: 'created' | 'modified' | 'deleted'
  changedAt: number
  diffAvailable: boolean
  preview?: string
  diff?: FileDiffPayload
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 允许 ENOENT（用于删除判定），其余错误照常抛出。 */
export function readSnapshot(path: string): FileSnapshot | undefined {
  try {
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Not a regular file')
    if (stats.size > MAX_DIFF_FILE_BYTES) return { signature: `large:${stats.size}:${stats.mtimeMs}` }
    const raw = readFileSync(path)
    if (raw.includes(0)) return { signature: `binary:${sha256(raw)}` }
    return { signature: sha256(raw), text: raw.toString('utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function firstMeaningfulLine(lines: string[]): string | undefined {
  return lines.find((line) => line.trim())?.trim().slice(0, 180)
}

export function createFileChange(
  relativePath: string,
  before: FileSnapshot | undefined,
  after: FileSnapshot | undefined,
  changedAt: number,
): FileChange | undefined {
  if (before?.signature === after?.signature) return undefined
  const kind = !before ? 'created' : !after ? 'deleted' : 'modified'
  if ((before && before.text === undefined) || (after && after.text === undefined)) {
    return { relativePath, kind, changedAt, diffAvailable: false }
  }

  const previous = (before?.text ?? '').split(/\r?\n/)
  const next = (after?.text ?? '').split(/\r?\n/)
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1

  const removed = previous.slice(prefix, previous.length - suffix)
  const added = next.slice(prefix, next.length - suffix)
  return {
    relativePath,
    kind,
    changedAt,
    diffAvailable: true,
    preview: firstMeaningfulLine(added) ?? firstMeaningfulLine(removed),
    diff: {
      context: previous.slice(Math.max(0, prefix - 1), prefix),
      removed: removed.slice(0, MAX_DIFF_LINES),
      added: added.slice(0, MAX_DIFF_LINES),
      truncated: removed.length > MAX_DIFF_LINES || added.length > MAX_DIFF_LINES,
    },
  }
}