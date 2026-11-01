/**
 * 记忆文件路径解析与原子写入。
 *
 * 这里的解析规则必须与商业版逐字符一致：`history/`、`reviews/` 的记录 key
 * 都是 `sha256(resolveMemoryPath(target))`，规则一旦不同，两个 App 会算出
 * 不同的 key，互相看不到对方的记录。
 */

import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { writeTextFileAtomic } from './safe-file'

/** 逐段解析符号链接，末段不存在时返回拼接结果。 */
export function resolveMemoryPath(path: string): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent === absolute) return realpathSync.native(absolute)
  const candidate = join(resolveMemoryPath(parent), basename(absolute))

  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
    throw error
  }

  if (stats.isSymbolicLink()) {
    try {
      return realpathSync.native(candidate)
    } catch (error) {
      throw new Error(`记忆符号链接目标不可用（失效、循环或不可访问）: ${path}`, { cause: error })
    }
  }
  return realpathSync.native(candidate)
}

/** 记忆文件只允许写到普通文件；目标已存在但不是普通文件时拒绝。 */
export function writeMemoryFileAtomic(path: string, content: string): void {
  const target = resolveMemoryPath(path)
  try {
    if (!statSync(target).isFile()) throw new Error(`记忆目标不是普通文件: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(target), { recursive: true })
  writeTextFileAtomic(target, content)
}
