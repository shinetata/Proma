/**
 * 轮次改动的 Git 快照能力
 *
 * 目标是在**不污染用户仓库**的前提下拿到「本轮开始」与「本轮结束」两棵树：
 * - 对象写进会话私有 scratch 的 objects 目录（GIT_OBJECT_DIRECTORY）
 * - 原仓库 objects 通过 GIT_ALTERNATE_OBJECT_DIRECTORIES 只读复用
 * - index 用临时文件（GIT_INDEX_FILE），绝不覆盖用户仓库的 index
 *
 * 其余函数都是围绕这两个树做查询：diff 统计、子模块（gitlink）识别、被 ignore 路径识别、
 * blob 读取。
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseNumstat, type NumstatEntry } from './numstat'
import { canonicalPath, isInside, toPosix } from './paths'

const DEFAULT_GIT_TIMEOUT_MS = 20_000
const DEFAULT_GIT_MAX_BYTES = 8 * 1024 * 1024

export interface GitWorkspace {
  /** 仓库工作树根（realpath 后） */
  root: string
  /** 仓库 .git 目录（git 返回的绝对路径） */
  gitDir: string
  /** 本会话的私有 scratch 目录 */
  scratch: string
  /** 指向私有 objects + 原仓库 objects 的环境变量 */
  env: Record<string, string>
  /** scratch 落在仓库内时需要排除的相对路径（':' 排除语法用 posix 路径） */
  excludes: string[]
}

export interface RunGitOptions {
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  /** 需要传给 git 的标准输入（如 check-ignore --stdin） */
  stdin?: string
  maxBytes?: number
  timeoutMs?: number
}

export interface RunGitResult {
  exitCode: number
  stdout: string
  stderr: string
  /** 输出超过上限被截断 */
  truncated: boolean
}

/** 执行一次 git 命令；超时或 aborted 时 kill 子进程并以错误结束。 */
export function runGit(args: string[], options: RunGitOptions): Promise<RunGitResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_GIT_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS

  return new Promise<RunGitResult>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(new Error(`git ${args[0] ?? ''} was aborted`))
      return
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let stderr = ''
    let settled = false
    let timedOut = false

    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: options.cwd,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 不读用户 git 配置，避免 includeIf / 别名 / hooks 干扰快照结果
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.env,
      },
    })

    const finish = (error: Error | undefined, result?: RunGitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) rejectPromise(error)
      else if (result) resolvePromise(result)
    }

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已退出
      }
      finish(new Error(`git ${args.join(' ')} was aborted`))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已退出
      }
      finish(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return
      if (totalBytes + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - totalBytes))
        totalBytes = maxBytes
        truncated = true
        return
      }
      chunks.push(chunk)
      totalBytes += chunk.length
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 16 * 1024) stderr += chunk
    })

    child.on('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })

    child.on('close', (exitCode) => {
      if (timedOut) return
      finish(undefined, {
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr,
        truncated,
      })
    })
  })
}

function assertOk(result: RunGitResult, what: string): RunGitResult {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim()}`)
  }
  return result
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 定位 cwd 所属的 Git 仓库，并在 scratch 下建好私有 object 目录。
 *
 * @returns null 表示 cwd 不在任何 Git 仓库内（非错误，调用方退化为纯捕获比较）
 */
export async function locateGitWorkspace(
  cwd: string,
  scratchDir: string,
  signal?: AbortSignal,
): Promise<GitWorkspace | null> {
  const found = await runGit(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'],
    { cwd, signal },
  )

  if (found.exitCode !== 0) {
    if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null
    throw new Error(`git rev-parse failed: ${found.stderr.trim()}`)
  }

  const lines = found.stdout.trim().split('\n').map((line) => resolve(cwd, line.trim()))
  const [rootRaw, gitDir, repositoryObjects] = lines
  if (!rootRaw || !gitDir || !repositoryObjects) return null

  const root = await canonicalPath(rootRaw)
  const directory = await canonicalPath(scratchDir)
  const objects = join(directory, 'objects')
  await mkdir(objects, { recursive: true })

  // scratch 若被放在仓库内（例如 cwd 就在 ~/.proma 下），快照时必须排除，否则会把自己算进去
  const excludes = isInside(root, directory) ? [toPosix(relative(root, directory))] : []

  return {
    root,
    gitDir,
    scratch: directory,
    env: {
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
    },
    excludes,
  }
}

/**
 * 用临时 index 把当前工作树写入一棵树对象，返回 tree oid。
 *
 * 不修改用户仓库 index，也不在用户仓库 objects 里留新对象。
 */
export async function snapshotTree(workspace: GitWorkspace, signal?: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(join(workspace.scratch, 'index-'))
  try {
    const index = join(scratch, 'index')
    await copyFile(join(workspace.gitDir, 'index'), index).catch((error) => {
      if (!isMissingFileError(error)) throw error
    })

    const env = { ...workspace.env, GIT_INDEX_FILE: index }
    const pathspec = workspace.excludes.length === 0
      ? []
      : ['--', '.', ...workspace.excludes.map((path) => `:(exclude)${path}`)]

    const added = await runGit(['add', '--all', '--ignore-errors', ...pathspec], {
      cwd: workspace.root,
      env,
      signal,
    })
    // exitCode 1 用于「有路径被 ignore / 无法添加」，不影响可用的树
    if (added.exitCode !== 0 && added.exitCode !== 1) {
      assertOk(added, `git add in ${workspace.root}`)
    }

    const written = assertOk(
      await runGit(['write-tree'], { cwd: workspace.root, env, signal }),
      'git write-tree',
    )
    return written.stdout.trim()
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 读取树中某个 blob 的 oid 与大小；路径不是 blob（目录/子模块/不存在）时返回 null。 */
export async function treeBlob(
  workspace: GitWorkspace,
  tree: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ oid: string; size: number } | null> {
  const result = assertOk(
    await runGit(['ls-tree', '-z', '-l', tree, '--', path], {
      cwd: workspace.root,
      env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' },
      signal,
    }),
    'git ls-tree',
  )

  const entry = result.stdout.split('\0')[0] ?? ''
  const match = /^\d+ (\S+) ([0-9a-f]+) +(\d+)\t/.exec(entry)
  if (match === null || match[1] !== 'blob') return null
  return { oid: match[2] as string, size: Number(match[3]) }
}

/** 读取 blob 文本；超过 maxBytes 时视为无法比较（抛错由调用方转为 oversized）。 */
export async function blobText(
  workspace: GitWorkspace,
  oid: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = assertOk(
    await runGit(['cat-file', 'blob', oid], {
      cwd: workspace.root,
      env: workspace.env,
      maxBytes,
      signal,
    }),
    'git cat-file',
  )
  if (result.truncated) throw new Error(`blob ${oid} exceeds ${maxBytes} bytes`)
  return result.stdout
}

/** 比较两棵树，返回逐文件增删统计（含重命名与二进制标记）。 */
export async function diffTrees(
  workspace: GitWorkspace,
  before: string,
  after: string,
  signal?: AbortSignal,
): Promise<NumstatEntry[]> {
  if (before === after) return []

  const result = assertOk(
    await runGit(['diff-tree', '-r', '-M', '-z', '--numstat', before, after], {
      cwd: workspace.root,
      env: workspace.env,
      signal,
    }),
    'git diff-tree',
  )
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap')
  return parseNumstat(result.stdout)
}

/** 列出工作树里的子模块（gitlink）路径，子模块内部改动不算本轮文件改动。 */
export async function gitlinkPaths(workspace: GitWorkspace, signal?: AbortSignal): Promise<Set<string>> {
  const result = assertOk(
    await runGit(['ls-files', '-z', '--stage'], {
      cwd: workspace.root,
      env: workspace.env,
      signal,
    }),
    'git ls-files',
  )

  const links = new Set<string>()
  for (const entry of result.stdout.split('\0')) {
    if (entry.startsWith('160000 ')) {
      links.add(entry.slice(entry.indexOf('\t') + 1))
    }
  }
  return links
}

/** 从给定相对路径中筛出被 .gitignore 覆盖的那些。 */
export async function ignoredPaths(
  workspace: GitWorkspace,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set()

  const result = await runGit(['check-ignore', '-z', '--stdin'], {
    cwd: workspace.root,
    env: workspace.env,
    stdin: `${paths.join('\0')}\0`,
    signal,
  })
  // exitCode 1 表示没有任何路径被 ignore
  if (result.exitCode === 1) return new Set()

  return new Set(
    assertOk(result, 'git check-ignore').stdout.split('\0').filter((path) => path !== ''),
  )
}
