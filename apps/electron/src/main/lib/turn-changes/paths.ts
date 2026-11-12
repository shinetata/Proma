/**
 * 轮次文件改动的路径工具
 *
 * 记录器需要在三种路径空间之间搬运数据：
 * - 工具参数里的原始路径（可能带不可见空格、前导 `@`、`~`、`file://` 前缀或相对路径）
 * - 磁盘上的绝对路径（需要逐级 realpath，兼容 macOS 的 /private 前缀）
 * - 展示路径（仓库/工作目录内相对、home 内 `~/`、其余绝对）
 *
 * 这里只放纯函数，便于单测覆盖。
 */

import { realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Windows 路径统一成正斜杠，便于比较与展示。 */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** path 是否位于 root 之内（含 root 本身）。 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 逐级 realpath：解析符号链接，同时保留尚不存在的尾段。
 *
 * 文件被删除后仍需与写前副本比较，因此不能因为 ENOENT 就放弃解析。
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = []
  let head = resolve(path)
  while (true) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      const parent = dirname(head)
      // 到达根目录仍不可解析时退回原始绝对路径，避免无意义的重试。
      if (parent === head || dirname(parent) === parent) return resolve(path)
      missing.unshift(basename(head))
      head = parent
    }
  }
}

/** 默认临时目录候选：/tmp 与系统 tmpdir，含各自的 realpath（macOS 下 /tmp 指向 /private/tmp）。 */
export async function temporaryRoots(candidates: readonly string[] = ['/tmp', tmpdir()]): Promise<string[]> {
  const roots = new Set<string>()
  for (const root of candidates) {
    roots.add(resolve(root))
    roots.add(await canonicalPath(root))
  }
  return [...roots]
}

/** 路径是否落在临时目录内。 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(root, path))
}

/**
 * 计算展示路径。
 *
 * @param absolute 已规范化的绝对路径
 * @param cwd 本轮 Agent 工作目录
 * @param root 所在 Git 仓库根（非 Git 目录时与 cwd 相同）
 * @param home 用户 home 目录，空字符串表示不归一到 home
 */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  if (isInside(cwd, absolute) || isInside(root, absolute)) {
    const rel = toPosix(relative(cwd, absolute))
    return rel === '' ? basename(absolute) : rel
  }
  if (home !== '' && isInside(home, absolute)) {
    return `~/${toPosix(relative(home, absolute))}`
  }
  return toPosix(absolute)
}

/** 按展示路径排序（渲染层列表顺序）。 */
export function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
}

/**
 * 把工具参数里的路径解析成绝对路径。
 *
 * 需要处理的真实输入：` @src/a.ts `（前导空格与 @）、`~/x`、`file:///tmp/x`、
 * Windows 下 Git Bash 风格的 `/c/Users/x`。
 */
export function resolveToolMutationPath(raw: string, cwd: string): string {
  let value = raw
    .trim()
    // 复制粘贴常见的不换行空格与各种宽空格
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/^@/, '')

  if (process.platform === 'win32' && !value.includes('\\')) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
  }

  if (value === '~') {
    value = homedir()
  } else if (/^~[/\\]/.test(value)) {
    value = join(homedir(), value.slice(2))
  }

  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value)
    } catch {
      // 非法 file URL 时保留原字符串，交给 resolve 拼成路径
    }
  }

  return resolve(cwd, value)
}
