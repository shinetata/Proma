/**
 * 轮次文件改动录制器
 *
 * 每轮 Agent 运行开始给工作树做一次 Git 快照（私有 objects + 临时 index，不碰用户仓库），
 * 文件修改工具执行前另存写前副本，轮末再快照一次：两次树的差异给出「真实改了什么」，
 * 副本比较覆盖 Git 看不到的部分（仓库外、被 ignore、非 Git 目录）。
 *
 * 所有磁盘任务都排进一条串行链，因此同一会话内不会并发读写 scratch；
 * dispose 用生命周期 AbortSignal 打断还没开始的任务，并清理 scratch 目录。
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { normalizePathForCompare } from '@proma/shared'
import type { TurnChangesSummary, TurnFileDiff } from '@proma/shared'
import { captureFile, sameCapture, type CaptureResult } from './capture'
import { compareText } from './compare'
import {
  blobText,
  diffTrees,
  gitlinkPaths,
  ignoredPaths,
  locateGitWorkspace,
  snapshotTree,
  treeBlob,
  type GitWorkspace,
} from './git'
import {
  canonicalPath,
  compareDisplay,
  displayPathOf,
  isInside,
  isTemporaryPath,
  resolveToolMutationPath,
  temporaryRoots,
  toPosix,
} from './paths'

const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 需要捕获写前副本的工具；其余工具（含 Bash）只依赖 Git 快照差异。 */
const FILE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit'])

/** 单侧内容来源：Git 树中的 blob、磁盘上的副本，或文件不存在。 */
type ContentSide =
  | { kind: 'absent' }
  | { kind: 'file'; file: string; binary: boolean }
  | { kind: 'snapshot'; workspace: GitWorkspace; tree: string; path: string }

/** 单文件的改动来源：要么拒绝比较（二进制/过大），要么给出前后两侧。 */
type FileSources =
  | { refusal: 'binary' | 'oversized' }
  | { before: ContentSide; after: ContentSide }

interface TurnState {
  /** 触发本轮的用户消息 uuid */
  key: string
  rawCwd: string
  canonicalCwd?: string
  baseline: { workspace: GitWorkspace; tree: string } | 'failed' | null
  /** 绝对路径 → 本轮首次修改前的内容副本 */
  captures: Map<string, CaptureResult>
  hasToolActivity: boolean
  settled: boolean
  result: TurnChangesSummary | null
}

interface RecordedTurn {
  summary: TurnChangesSummary
  sources: FileSources[]
  /** 规范化路径与展示路径 → files 下标，供 getFileDiff 定位 */
  indexByKey: Map<string, number>
}

export interface TurnRecorderOptions {
  /** scratch 根目录，默认系统临时目录 */
  tempRoot?: string
  /** 摘要最多保留的文件数 */
  maxFiles?: number
  /** 单文件比较上限 */
  maxFileBytes?: number
  /** 内部告警输出，测试可注入 */
  warn?: (message: string) => void
}

function createTurnState(key: string, rawCwd: string): TurnState {
  return {
    key,
    rawCwd,
    baseline: null,
    captures: new Map(),
    hasToolActivity: false,
    settled: false,
    result: null,
  }
}

/** 从工具输入里取出被修改的路径；不是文件修改工具时返回 null。 */
function extractMutationTargetPath(toolName: string, input: Record<string, unknown>): string | null {
  if (!FILE_MUTATION_TOOLS.has(toolName)) return null
  if (toolName === 'NotebookEdit') {
    const notebookPath = input.notebook_path
    return typeof notebookPath === 'string' && notebookPath.trim().length > 0 ? notebookPath.trim() : null
  }
  const raw = input.file_path ?? input.filePath ?? input.path
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

/** 内容超过上限的哨兵，与「文件不存在」(null) 区分开。 */
const OVERSIZED = Symbol('oversized')

export class TurnRecorder {
  /** 串行任务链：所有快照、捕获、结算都排在这里 */
  private chain: Promise<void> = Promise.resolve()
  private state: TurnState | null = null
  private sessionPaths: { home: string; temporaryRoots: string[] } | null = null
  /** 按 canonicalCwd 缓存定位到的 Git 工作区，支持会话内切换 worktree */
  private workspacesByCwd = new Map<string, GitWorkspace | null>()
  private scratchPromise?: Promise<string>
  private records = new Map<string, RecordedTurn>()
  private lifetime = new AbortController()
  private readonly tempRoot: string
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly warn: (message: string) => void

  constructor(options: TurnRecorderOptions = {}) {
    this.tempRoot = options.tempRoot ?? tmpdir()
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  /**
   * 开启新一轮并异步排入工作树基线快照。
   *
   * @param key 触发本轮的用户消息 uuid
   * @param cwd 本轮 Agent 工作目录
   */
  start(key: string, cwd: string): void {
    const state = createTurnState(key, cwd)
    this.state = state

    void this.enqueue(async (signal) => {
      try {
        this.sessionPaths ??= {
          home: await canonicalPath(homedir()),
          temporaryRoots: await temporaryRoots(),
        }
        const resolvedCwd = await canonicalPath(cwd)
        state.canonicalCwd = resolvedCwd
        const workspace = await this.locateWorkspace(resolvedCwd, signal)
        if (workspace === null) return
        const tree = await snapshotTree(workspace, signal)
        state.baseline = { workspace, tree }
      } catch (error) {
        state.baseline = 'failed'
        throw error
      }
    })
  }

  /**
   * 工具通过权限校验后、实际执行前的钩子。
   *
   * 保证本轮基线快照已排入队列，并对文件修改工具捕获该路径「本轮首次修改前」的内容。
   */
  async preExecuteTool(toolName: string, input: Record<string, unknown>, fallbackCwd: string): Promise<void> {
    const state = this.state
    if (state === null || state.settled) return

    state.hasToolActivity = true
    const rawTarget = extractMutationTargetPath(toolName, input)
    if (rawTarget !== null) {
      const baseCwd = state.canonicalCwd ?? state.rawCwd ?? fallbackCwd
      this.capture(state, resolveToolMutationPath(rawTarget, baseCwd))
    }
    await this.settled()
  }

  /** 直接按路径捕获写前副本（供测试或直接文件操作调用）。 */
  capturePath(absoluteOrRelativePath: string, fallbackCwd?: string): Promise<void> {
    const state = this.state
    if (state === null || state.settled) return Promise.resolve()

    state.hasToolActivity = true
    const baseCwd = state.canonicalCwd ?? state.rawCwd ?? fallbackCwd ?? process.cwd()
    this.capture(state, resolveToolMutationPath(absoluteOrRelativePath, baseCwd))
    return this.settled()
  }

  /** 标记本轮观察到工具执行结果。 */
  observeToolResult(): void {
    if (this.state !== null && !this.state.settled) {
      this.state.hasToolActivity = true
    }
  }

  /** 等待当前队列中的所有快照与捕获完成。 */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * 结束当前轮次，汇总快照差异与写前/轮末副本差异。
   *
   * @param expectedKey 可选的轮次 key 校验；已结算过的其他 key 直接返回其缓存结果
   */
  async finish(expectedKey?: string): Promise<TurnChangesSummary | null> {
    const state = this.state
    if (state === null) return null
    if (expectedKey !== undefined && state.key !== expectedKey) {
      return this.records.get(expectedKey)?.summary ?? null
    }
    if (state.settled) return state.result

    await this.enqueue((signal) => this.record(state, signal))
    return state.result
  }

  /** 获取已结算轮次的改动摘要。 */
  getSummary(key: string): TurnChangesSummary | null {
    return this.records.get(key)?.summary ?? null
  }

  /**
   * 按需计算某轮某个改动文件的 hunks。
   *
   * 无论来自 Git 快照树还是非 Git 目录的副本，都返回统一结构。
   */
  async getFileDiff(key: string, filePath: string, signal?: AbortSignal): Promise<TurnFileDiff | null> {
    const record = this.records.get(key)
    if (record === undefined) return null

    let index = record.indexByKey.get(normalizePathForCompare(filePath))
    if (index === undefined) {
      const canonical = await canonicalPath(filePath).catch(() => filePath)
      index = record.indexByKey.get(normalizePathForCompare(canonical))
    }
    if (index === undefined) return null

    const file = record.summary.files[index]
    const sources = record.sources[index]
    if (file === undefined || sources === undefined) return null

    const { path, display } = file
    if ('refusal' in sources) {
      return { kind: sources.refusal, path, display }
    }

    const combinedSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    try {
      const [before, after] = await Promise.all([
        this.readSide(sources.before, combinedSignal),
        this.readSide(sources.after, combinedSignal),
      ])
      if (before === OVERSIZED || after === OVERSIZED) {
        return { kind: 'oversized', path, display }
      }
      const { hunks, coarse } = compareText(before, after)
      return {
        kind: 'text',
        path,
        display,
        before: before !== null,
        after: after !== null,
        hunks,
        coarse,
      }
    } catch (error) {
      if (this.lifetime.signal.aborted) return null
      throw error
    }
  }

  /** 释放录制器：打断未开始的任务，清理内存与 scratch 目录。 */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.records.clear()
    this.workspacesByCwd.clear()
    await this.chain

    if (this.scratchPromise !== undefined) {
      const scratch = await this.scratchPromise.catch(() => null)
      if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /** 排入一次写前捕获；同一轮内同一路径只保留首次捕获。 */
  private capture(state: TurnState, targetPath: string): void {
    void this.enqueue(async () => {
      const absolute = await canonicalPath(targetPath)
      if (state.captures.has(absolute)) return
      const capturesDir = join(await this.scratchDir(), 'captures')
      const captured = await captureFile(absolute, capturesDir, this.maxFileBytes)
      if (captured !== undefined) {
        state.captures.set(absolute, captured)
      }
    })
  }

  private enqueue(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.lifetime.signal.aborted) return
      try {
        await task(this.lifetime.signal)
      } catch (error) {
        if (!this.lifetime.signal.aborted) {
          this.warn(`[turn-changes] ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
    this.chain = run
    return run
  }

  private scratchDir(): Promise<string> {
    this.scratchPromise ??= mkdtemp(join(this.tempRoot, 'proma-turn-changes-'))
    return this.scratchPromise
  }

  private async locateWorkspace(canonicalCwd: string, signal: AbortSignal): Promise<GitWorkspace | null> {
    if (this.workspacesByCwd.has(canonicalCwd)) {
      return this.workspacesByCwd.get(canonicalCwd) ?? null
    }
    const baseScratch = await this.scratchDir()
    const repoScratch = await mkdtemp(join(baseScratch, 'repo-'))
    const workspace = await locateGitWorkspace(canonicalCwd, repoScratch, signal)
    this.workspacesByCwd.set(canonicalCwd, workspace)
    return workspace
  }

  private async readSide(side: ContentSide, signal: AbortSignal): Promise<string | typeof OVERSIZED | null> {
    switch (side.kind) {
      case 'absent':
        return null
      case 'file':
        return readFile(side.file, { encoding: 'utf8', signal })
      case 'snapshot': {
        const blob = await treeBlob(side.workspace, side.tree, side.path, signal)
        if (blob === null) return null
        if (blob.size > this.maxFileBytes) return OVERSIZED
        return blobText(side.workspace, blob.oid, this.maxFileBytes, signal)
      }
    }
  }

  /** 结算本轮：组装摘要并缓存供 IPC 查询。 */
  private async record(state: TurnState, signal: AbortSignal): Promise<void> {
    if (state.settled) return
    state.settled = true

    const sessionPaths = this.sessionPaths
    const cwd = state.canonicalCwd
    const { baseline } = state
    if (
      sessionPaths === null ||
      cwd === undefined ||
      baseline === 'failed' ||
      (!state.hasToolActivity && state.captures.size === 0)
    ) {
      return
    }

    const root = baseline?.workspace.root ?? cwd
    const listed = new Map<string, { file: TurnChangesSummary['files'][number]; sources: FileSources }>()

    if (baseline !== null) {
      const after = await snapshotTree(baseline.workspace, signal)
      for (const entry of await diffTrees(baseline.workspace, baseline.tree, after, signal)) {
        const absolute = await canonicalPath(resolve(root, entry.path))
        listed.set(absolute, {
          file: this.buildChangedFile(cwd, root, sessionPaths.home, absolute, entry),
          sources: entry.binary
            ? { refusal: 'binary' }
            : {
                before: {
                  kind: 'snapshot',
                  workspace: baseline.workspace,
                  tree: baseline.tree,
                  path: entry.oldPath ?? entry.path,
                },
                after: {
                  kind: 'snapshot',
                  workspace: baseline.workspace,
                  tree: after,
                  path: entry.path,
                },
              },
        })
      }
    }

    const capturedPaths = [...state.captures.keys()].filter((absolute) => !listed.has(absolute))
    const workTreePath = (absolute: string): string => toPosix(relative(root, absolute))

    // 仓库内但 Git 看不见的文件：子模块内部与被 .gitignore 覆盖的路径
    let inWorkspace = capturedPaths.filter((absolute) => isInside(root, absolute))
    if (baseline !== null && inWorkspace.length > 0) {
      const gitlinks = await gitlinkPaths(baseline.workspace, signal)
      inWorkspace = inWorkspace.filter(
        (absolute) => ![...gitlinks].some((link) => isInside(resolve(root, link), absolute)),
      )
    }
    const uncoveredInWorkspace = baseline === null
      ? new Set(inWorkspace.map(workTreePath))
      : await ignoredPaths(baseline.workspace, inWorkspace.map(workTreePath), signal)

    const capturesDir = join(await this.scratchDir(), 'captures')
    for (const absolute of capturedPaths) {
      // 仓库内要求 Git 看不见；仓库外只保留 cwd 内或非临时目录的文件，
      // 避免把 /tmp 下的临时验证页算进本轮改动。
      const uncovered = isInside(root, absolute)
        ? uncoveredInWorkspace.has(workTreePath(absolute))
        : isInside(cwd, absolute) || !isTemporaryPath(absolute, sessionPaths.temporaryRoots)
      if (!uncovered) continue

      const before = state.captures.get(absolute)
      if (before === undefined) continue
      const after = await captureFile(absolute, capturesDir, this.maxFileBytes)
      if (after === undefined || sameCapture(before, after)) continue

      listed.set(absolute, await this.compareCapturedPair(cwd, root, sessionPaths.home, absolute, before, after))
    }

    const sorted = [...listed.values()].sort((a, b) => compareDisplay(a.file, b.file))
    const kept = sorted.slice(0, this.maxFiles)

    const summary: TurnChangesSummary = {
      key: state.key,
      cwd: state.rawCwd,
      files: kept.map((entry) => entry.file),
      total: sorted.length,
      added: sorted.reduce((sum, entry) => sum + entry.file.added, 0),
      deleted: sorted.reduce((sum, entry) => sum + entry.file.deleted, 0),
    }

    const indexByKey = new Map<string, number>()
    kept.forEach((entry, index) => {
      indexByKey.set(normalizePathForCompare(entry.file.path), index)
      indexByKey.set(normalizePathForCompare(entry.file.display), index)
    })

    this.records.set(state.key, {
      summary,
      sources: kept.map((entry) => entry.sources),
      indexByKey,
    })
    state.result = summary
  }

  private async compareCapturedPair(
    cwd: string,
    root: string,
    home: string,
    absolute: string,
    before: CaptureResult,
    after: CaptureResult,
  ): Promise<{ file: TurnChangesSummary['files'][number]; sources: FileSources }> {
    if (before.kind === 'oversized' || after.kind === 'oversized') {
      return {
        file: this.buildChangedFile(cwd, root, home, absolute, { added: 0, deleted: 0, oversized: true }),
        sources: { refusal: 'oversized' },
      }
    }
    if ((before.kind === 'file' && before.binary) || (after.kind === 'file' && after.binary)) {
      return {
        file: this.buildChangedFile(cwd, root, home, absolute, { added: 0, deleted: 0, binary: true }),
        sources: { refusal: 'binary' },
      }
    }

    const readCaptured = async (side: CaptureResult): Promise<string | null> => (
      side.kind === 'file' ? readFile(side.file, 'utf8') : null
    )
    const { added, deleted } = compareText(await readCaptured(before), await readCaptured(after))
    return {
      file: this.buildChangedFile(cwd, root, home, absolute, { added, deleted }),
      sources: { before, after },
    }
  }

  private buildChangedFile(
    cwd: string,
    root: string,
    home: string,
    absolute: string,
    counts: { added: number; deleted: number; binary?: boolean; oversized?: boolean },
  ): TurnChangesSummary['files'][number] {
    return {
      path: normalizePathForCompare(absolute),
      display: displayPathOf(absolute, cwd, root, home),
      added: counts.added,
      deleted: counts.deleted,
      ...(counts.binary ? { binary: true } : {}),
      ...(counts.oversized === true ? { oversized: true } : {}),
    }
  }
}
