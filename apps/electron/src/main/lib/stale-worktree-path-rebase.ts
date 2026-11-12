/**
 * 失效 worktree 路径重定位
 *
 * 预览、读取与「在访达中显示」使用的绝对路径可能在旧 worktree 根下，目录被删除或
 * 重建到别处后这些路径就失效了。这里用两种线索推断出相对路径：
 *
 * - 路径落在某个已知旧根之下 → 取相对该根的路径；
 * - 路径里出现 `worktrees/<name>/` 或 `.worktrees/<name>/` 段 → 取其后部分。
 *
 * 再把相对路径拼到当前授权根上，只有真实存在的文件才算命中。
 * 模块内不做文件系统调用，是否命中由调用方注入的 `isFile` 判断。
 */

export interface InferredWorktreeRelativePath {
  /** 相对路径，使用 `/` 分隔 */
  relPath: string
  /** 推断依据：命中的旧根，或路径中的 worktrees 段 */
  via: 'stale-root' | 'worktrees-segment'
  /** via 为 stale-root 时命中的旧根 */
  matchedRoot?: string
}

export interface RebasedWorktreePath {
  path: string
  root: string
  relPath: string
  via: InferredWorktreeRelativePath['via']
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

function collapseInnerSlashes(path: string): string {
  if (path.startsWith('//')) return `//${path.slice(2).replace(/\/{2,}/g, '/')}`
  return path.replace(/\/{2,}/g, '/')
}

function trimTrailingSlash(path: string): string {
  if (path === '/' || /^[A-Za-z]:\/$/.test(path)) return path
  return path.replace(/\/+$/, '')
}

function isUnderRoot(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(`${root}/`)
}

/**
 * 从失效的绝对路径推断相对路径。
 *
 * 在多个旧根同时命中时取最长的根，避免外层仓库根把高层目录错当成相对路径。
 */
export function inferWorktreeRelativePath(
  stalePath: string,
  staleRoots: readonly string[] = [],
): InferredWorktreeRelativePath | null {
  if (typeof stalePath !== 'string' || stalePath.length === 0 || stalePath.includes('\0')) return null
  const normalized = collapseInnerSlashes(normalizeSlashes(stalePath))
  if (!isAbsolutePath(normalized)) return null
  const target = trimTrailingSlash(normalized)

  let best: { root: string; relPath: string } | null = null
  for (const candidate of staleRoots) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const root = trimTrailingSlash(normalizeSlashes(candidate))
    if (!isAbsolutePath(root) || root === '/') continue
    if (!isUnderRoot(target, root)) continue
    const relPath = target === root ? '' : target.slice(root.length + 1)
    if (relPath.length === 0) continue
    if (best === null || root.length > best.root.length) best = { root, relPath }
  }
  if (best) return { relPath: best.relPath, via: 'stale-root', matchedRoot: best.root }

  // 没有命中旧根时退回路径结构：worktrees/<name>/<relPath>。
  const segments = target.split('/')
  for (let index = segments.length - 2; index >= 1; index -= 1) {
    const segment = segments[index]
    if (segment !== 'worktrees' && segment !== '.worktrees') continue
    const relPath = segments.slice(index + 2).join('/')
    if (relPath.length === 0) continue
    return { relPath, via: 'worktrees-segment' }
  }
  return null
}

/** 只接受不含空段、`.`、`..` 和盘符的 posix 相对路径，避免重定位越出目标根。 */
function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\0')) return false
  if (/^[A-Za-z]:\//.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** 把相对路径拼到根目录下，按根的斜杠风格选择分隔符。 */
export function joinUnderRoot(root: string, relPath: string): string {
  const base = trimTrailingSlash(root)
  const separator = /^[A-Za-z]:\\|\\\\/.test(root) ? '\\' : '/'
  const relativePath = separator === '\\' ? relPath.replace(/\//g, '\\') : relPath
  return `${base}${base.endsWith(separator) ? '' : separator}${relativePath}`
}

/**
 * 把失效的 worktree 绝对路径重定位到当前授权根下。
 *
 * 返回第一个真实存在的候选：先用旧根推断相对路径，再用 `worktrees/<name>/` 结构兜底；
 * 推断不出安全的相对路径时返回 null，调用方按未命中处理。
 */
export function rebaseStaleWorktreePath(request: {
  stalePath: string
  staleRoots?: readonly string[]
  roots: readonly string[]
  isFile: (path: string) => boolean
}): RebasedWorktreePath | null {
  const { stalePath, staleRoots, roots, isFile } = request
  const inferred = inferWorktreeRelativePath(stalePath, staleRoots)
  if (!inferred || !isSafeRelativePath(inferred.relPath)) return null

  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue
    if (!isAbsolutePath(normalizeSlashes(root))) continue
    const path = joinUnderRoot(root, inferred.relPath)
    if (!isFile(path)) continue
    return { path, root, relPath: inferred.relPath, via: inferred.via }
  }
  return null
}