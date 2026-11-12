/**
 * 会话文件引用
 *
 * 预览打开文件时改成记录「相对会话检出根的路径」，而不是只存绝对路径。
 * worktree 被删除或重建到别处后，主进程按当前检出根重新拼出绝对路径，
 * 引用依然能打开同一个文件。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 归一化后的文件引用；kind 已确定为 session 或 absolute。 */
export interface NormalizedSessionFileRef {
  sessionId: string
  path: string
  kind: 'session' | 'absolute'
  line?: number
  column?: number
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 校验并归一化来自 renderer 的文件引用。
 *
 * 约定：
 * - 引用必须属于本次访问的会话（sessionId 精确相等），否则整条丢弃。
 * - kind 缺省为 session；session 引用必须是安全的 posix 相对路径。
 * - line / column 只接受正安全整数，其他值忽略而不是整条拒绝。
 */
export function normalizeSessionFileRef(ref: unknown, sessionId?: string): NormalizedSessionFileRef | null {
  if (!ref || typeof ref !== 'object') return null
  const raw = ref as Record<string, unknown>
  if (!sessionId || typeof raw.sessionId !== 'string' || raw.sessionId !== sessionId) return null
  if (typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.includes('\0')) return null

  const kind = raw.kind === 'absolute' ? 'absolute' : 'session'
  const line = positiveInteger(raw.line)
  const column = positiveInteger(raw.column)
  const position = { ...(line ? { line } : {}), ...(column ? { column } : {}) }

  if (kind === 'absolute') {
    if (!isAbsolute(raw.path)) return null
    return { sessionId, path: raw.path, kind, ...position }
  }

  const relPath = raw.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (relPath.length === 0 || isAbsolute(relPath) || /^[A-Za-z]:\//.test(relPath)) return null
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return { sessionId, path: relPath, kind: 'session', ...position }
}

/** 把引用拼成绝对路径：session 引用相对检出根，absolute 引用原样返回。 */
export function resolveSessionFileRefPath(ref: NormalizedSessionFileRef, checkoutRoot: string): string {
  if (ref.kind === 'absolute') return ref.path
  const base = checkoutRoot.replace(/[\\/]+$/, '')
  const separator = /^[A-Za-z]:\\|\\\\/.test(checkoutRoot) ? '\\' : '/'
  const relPath = separator === '\\' ? ref.path.replace(/\//g, '\\') : ref.path
  return `${base}${separator}${relPath}`
}

/** 绝对路径相对某个根的 posix 路径；不在根内时返回 null。 */
export function toSessionFileRefRelPath(absolutePath: string, root: string): string | null {
  if (!absolutePath || !root) return null
  const rel = relative(resolve(root), resolve(absolutePath))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}