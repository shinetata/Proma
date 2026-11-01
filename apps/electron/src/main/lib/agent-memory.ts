/**
 * 全局画像与项目记忆的存储层。
 *
 * 文件格式、revision 算法、写锁、历史快照与复查记录必须与商业版完全一致：
 * 两个 App 共用同一个 `~/.proma`，格式不一致会互相覆盖或把对方数据判成冲突。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, isAbsolute, dirname, basename } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'
import { resolveMemoryPath, writeMemoryFileAtomic } from './memory-file-path'
import { inspectProjectMap } from './project-map-review'

/** 记忆文件 7 天复查周期。 */
export const MEMORY_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
/** 全局画像预算（UTF-16 单元）。 */
export const PROFILE_MAX_CHARS = 5000
/** 注入预算：项目索引与项目偏好。 */
export const MEMORY_INDEX_MAX_CHARS = 12000
export const PROJECT_PREFERENCES_MAX_CHARS = 8000
export const PROFILE_NAME = 'user_profile.md'
export const PREFERENCES_NAME = 'project-preferences.md'
export const PROFILE_NAMES = [PROFILE_NAME, 'user-profile.md']
export const MEMORY_INDEX_NAME = 'MEMORY.md'
export const MAX_MEMORY_BYTES = 512 * 1024

export interface AgentMemoryContext {
  /** 全局记忆目录：`<configRoot>/memory`，跨工作区共享。 */
  globalDir: string
  /** 当前工作区根：`<configRoot>/agent-workspaces/<slug>`。 */
  workspaceRoot: string
  /** 当前有效项目根，worktree 会话为 worktree 路径。 */
  projectRoot: string
  /** 项目别名根；worktree 会话指向原项目主目录。 */
  canonicalProjectRoot: string
  /** 已登记的工作区，供旧画像发现使用；自动化/委派会置空。 */
  workspaces: Array<{ slug: string; root: string }>
  allowProfileMigration?: boolean
  allowInstructionMaintenance?: boolean
}

export interface MemoryFile {
  path: string
  content: string | null
  revision: string
  modifiedAt?: number
}

export interface MemoryReview {
  checkedAt?: number
  reviewDue: boolean
}

export interface LegacyProfileSource {
  id: string
  workspace: { slug: string; root: string }
  path: string
  indexPath: string
}

export class ProfileBudgetExceededError extends Error {
  readonly attemptedChars: number

  constructor(attemptedChars: number) {
    super(`Profile 超过 ${PROFILE_MAX_CHARS} 字符，未保存；请整理后重试。`)
    this.name = 'ProfileBudgetExceededError'
    this.attemptedChars = attemptedChars
  }
}

export function assertProfileBudget(content: string): void {
  if (content.length > PROFILE_MAX_CHARS) throw new ProfileBudgetExceededError(content.length)
}

/** 内容为空时用 `missing` 参与哈希，与商业版保持一致。 */
export function memoryRevision(content: string | null): string {
  return createHash('sha256').update(content === null ? 'missing' : `file\0${content}`).digest('hex')
}

export function assertMemoryPath(path: string): void {
  resolveMemoryPath(path)
}

export function readMemoryFile(path: string): MemoryFile {
  const target = resolveMemoryPath(path)
  let content: string | null = null
  let modifiedAt: number | undefined
  try {
    const stats = statSync(target)
    if (!stats.isFile() || stats.size > MAX_MEMORY_BYTES) throw new Error(`记忆文件不是普通文件或超过 512 KiB: ${path}`)
    content = readFileSync(target, 'utf8')
    modifiedAt = stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { path, content, revision: memoryRevision(content), modifiedAt }
}

export function memoryPaths(ctx: AgentMemoryContext): {
  directory: string
  profile: string
  index: string
  preferences: string
} {
  const directory = join(ctx.workspaceRoot, 'memory')
  return {
    directory,
    profile: join(ctx.globalDir, PROFILE_NAME),
    index: join(directory, MEMORY_INDEX_NAME),
    preferences: join(directory, PREFERENCES_NAME),
  }
}

/** 目录锁：owner 记录 pid，进程存活即视为他人正在写入。 */
export function withMemoryLock<T>(ctx: AgentMemoryContext, action: () => T): T {
  const globalDir = resolveMemoryPath(ctx.globalDir)
  mkdirSync(globalDir, { recursive: true })
  const lock = join(globalDir, '.write-lock')

  try {
    mkdirSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(lock).isDirectory()) throw new Error('记忆写锁不是普通目录，请检查锁文件。')

    let pid: number
    try {
      pid = Number(readFileSync(join(lock, 'owner'), 'utf8'))
    } catch {
      throw new Error('记忆写锁尚未就绪，请稍后重试。')
    }
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('记忆写锁无效，请检查锁文件。')

    try {
      process.kill(pid, 0)
      throw new Error('其他会话正在更新记忆，请重新读取后重试。')
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
    }
    rmSync(lock, { recursive: true })
    mkdirSync(lock)
  }

  try {
    writeMemoryFileAtomic(join(lock, 'owner'), String(process.pid))
    return action()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

export function writeMemoryText(path: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) throw new Error('记忆文件超过 512 KiB，请拆分主题。')
  writeMemoryFileAtomic(path, content)
}

/** 建立必需的全局画像与项目索引；已存在则保持原样。 */
export function ensureMemoryFiles(ctx: AgentMemoryContext): void {
  withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const paths = memoryPaths(ctx)
    const defaults: Array<[string, string]> = [
      [paths.profile, '# 全局用户画像\n\n暂无已确认的跨项目偏好。仅记录用户明确表达或有充分证据的稳定事实，不推断、不编造。\n'],
      [paths.index, '# 项目记忆索引\n\n此文件维护主题入口和适用条件；详细内容按需读取。全局画像由运行时独立加载，不在此维护项目画像副本。\n\n## 主题\n\n暂无已确认的项目记忆。\n'],
    ]
    for (const [path, content] of defaults) {
      if (!readMemoryFile(path).content?.trim()) writeMemoryText(path, content)
    }
  })
}

/** 写入项目 AGENTS.md 的受管记忆关联块。 */
export function memoryAssociation(ctx: AgentMemoryContext): string {
  const paths = memoryPaths(ctx)
  return `<!-- proma:memory:start -->
## 记忆维护

- 项目记忆索引：[MEMORY.md](<${paths.index}>)；详细主题按索引按需读取，新增、移动、归档主题时同步索引。
- 全局用户画像：[user_profile.md](<${paths.profile}>)，跨项目共享；本项目补充偏好存入 ${paths.preferences} 并加入项目索引，仅在本项目覆盖全局偏好。
- 在任务中及时修订已确认的偏好、经验和决策，保留来源、适用范围和核验日期；不把临时任务进度写成永久偏好。超过一周的阶段性要求结合本轮证据复查；到期或被替代的内容移出有效入口并可恢复地归档。读取不等于核验，不编造用户事实。
<!-- proma:memory:end -->`
}

export function hasMemoryAssociation(ctx: AgentMemoryContext, content: string): boolean {
  const paths = memoryPaths(ctx)
  return content.includes(paths.index) && content.includes(paths.profile) && content.includes('记忆维护')
}

/** 把记忆维护方案追加到项目 AGENTS.md（幂等）。 */
export function linkProjectMemory(ctx: AgentMemoryContext): void {
  const map = inspectProjectMap(ctx.projectRoot)
  if (map.status === '不可安全修改') throw new Error('项目地图不可安全修改。')
  assertMemoryPath(map.path)
  if (hasMemoryAssociation(ctx, map.content ?? '')) return

  const legacy = ['CLAUDE.md', 'CLAUDE.MD'].find((name) => existsSync(join(ctx.projectRoot, name)))
  const initial = map.content ?? `# 项目约定
${legacy ? `
请先读取并遵循 [${legacy}](./${legacy}) 中的现有项目规则。
` : ''}`
  const managedBlock = /<!-- proma:memory:start -->[\s\S]*?<!-- proma:memory:end -->/
  writeMemoryText(
    map.path,
    managedBlock.test(initial)
      ? initial.replace(managedBlock, () => memoryAssociation(ctx))
      : `${initial.trimEnd()}

${memoryAssociation(ctx)}
`,
  )
}

export function inspectLegacyProfileLocations(ctx: AgentMemoryContext): {
  sources: LegacyProfileSource[]
  issues: Array<{ path: string; message: string }>
} {
  const sources: LegacyProfileSource[] = []
  const issues: Array<{ path: string; message: string }> = []
  const seen = new Set<string>()
  try {
    seen.add(resolveMemoryPath(memoryPaths(ctx).profile))
  } catch {
    // 全局画像路径不可解析时仍继续检查旧来源。
  }

  for (const workspace of ctx.workspaces) {
    for (const directory of ['memory', '.claude/memory']) {
      for (const name of PROFILE_NAMES) {
        const path = join(workspace.root, directory, name)
        try {
          const identity = resolveMemoryPath(path)
          if (seen.has(identity)) continue
          seen.add(identity)
          const stats = statSync(path)
          if (!stats.isFile() || stats.size > MAX_MEMORY_BYTES) throw new Error(`旧画像不是普通文件或超过 512 KiB: ${path}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          issues.push({ path, message: error instanceof Error ? error.message : String(error) })
          continue
        }
        sources.push({
          id: createHash('sha256').update(resolveMemoryPath(path)).digest('hex'),
          workspace,
          path,
          indexPath: join(dirname(path), MEMORY_INDEX_NAME),
        })
      }
    }
  }
  return { sources, issues }
}

export function listLegacyProfileLocations(ctx: AgentMemoryContext): LegacyProfileSource[] {
  return inspectLegacyProfileLocations(ctx).sources
}

export function discoverLegacyProfiles(
  ctx: AgentMemoryContext,
  sourceId?: string,
): Array<{ id: string; workspace: { slug: string; root: string }; profile: MemoryFile; index: MemoryFile }> {
  return listLegacyProfileLocations(ctx)
    .filter((item) => !sourceId || item.id === sourceId)
    .map((item) => ({
      id: item.id,
      workspace: item.workspace,
      profile: readMemoryFile(item.path),
      index: readMemoryFile(item.indexPath),
    }))
}

export function pendingMemoryMigrations(ctx: AgentMemoryContext): string[] {
  const directory = join(ctx.globalDir, 'migrations')
  assertMemoryPath(directory)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(
    (name) => /^[a-f0-9-]{36}$/.test(name) && existsSync(join(directory, name, 'pending.json')),
  )
}

export function assertNoPendingMemoryMigration(ctx: AgentMemoryContext): void {
  if (pendingMemoryMigrations(ctx).length) {
    throw new Error('有未完成的画像迁移，请先使用 MemoryMigrateProfile 恢复，再更新记忆。')
  }
}

export function memoryTarget(ctx: AgentMemoryContext, target: string): string {
  if (target === 'global-profile') return memoryPaths(ctx).profile
  if (
    target === MEMORY_INDEX_NAME ||
    target === PREFERENCES_NAME ||
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.md$/.test(target)
  ) {
    if (PROFILE_NAMES.includes(target)) throw new Error('用户画像只允许写入 global-profile。项目补充写入 project-preferences.md。')
    const path = join(memoryPaths(ctx).directory, target)
    const rel = relative(memoryPaths(ctx).directory, path)
    if (!isAbsolute(rel) && !rel.startsWith('..')) return path
  }
  throw new Error('仅支持 global-profile 或当前项目 memory/ 下的 Markdown 主题文件名。')
}

export function memoryReviewRecordPath(ctx: AgentMemoryContext, path: string): string {
  return join(ctx.globalDir, 'reviews', `${createHash('sha256').update(resolveMemoryPath(path)).digest('hex')}.json`)
}

/** 复查记录只对同一 revision 生效；内容变化后需要重新核验。 */
export function readMemoryReview(ctx: AgentMemoryContext, file: MemoryFile, now = Date.now()): MemoryReview {
  let checkedAt: number | undefined
  try {
    const record = JSON.parse(readMemoryFile(memoryReviewRecordPath(ctx, file.path)).content ?? '{}') as {
      revision?: unknown
      checkedAt?: unknown
    }
    if (
      record.revision === file.revision &&
      typeof record.checkedAt === 'number' &&
      Number.isFinite(record.checkedAt) &&
      record.checkedAt > 0 &&
      record.checkedAt <= now
    ) {
      checkedAt = record.checkedAt
    }
  } catch {
    // 记录缺失或损坏时视为未核验。
  }
  return { checkedAt, reviewDue: file.modifiedAt !== undefined && now - Math.max(file.modifiedAt, checkedAt ?? 0) > MEMORY_REVIEW_INTERVAL_MS }
}

/**
 * 版本校验下写入记忆：
 * `revision` 不一致说明别的会话已经改过，必须重新读取后合并。
 */
export function updateMemory(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  content: string,
  summary: string,
): MemoryFile {
  if (!summary.trim() || !content.trim()) throw new Error('请提供有效内容以及实际核验/更新的依据。')
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const path = memoryTarget(ctx, target)
    const before = readMemoryFile(path)
    if (before.revision !== revision) throw new Error('记忆已被其他会话修改，请重新读取并合并。')
    if (before.content !== content && resolveMemoryPath(path) === resolveMemoryPath(memoryPaths(ctx).profile)) {
      assertProfileBudget(content)
    }

    if (before.content !== content) {
      if (before.content !== null) {
        const key = createHash('sha256').update(resolveMemoryPath(path)).digest('hex')
        writeMemoryText(join(ctx.globalDir, 'history', key, `${before.revision}.md`), before.content)
      }
      writeMemoryText(path, content)
    }

    const after = readMemoryFile(path)
    const recordPath = memoryReviewRecordPath(ctx, path)
    assertMemoryPath(recordPath)
    mkdirSync(dirname(recordPath), { recursive: true })
    writeJsonFileAtomic(resolveMemoryPath(recordPath), { revision: after.revision, checkedAt: Date.now(), summary })
    return after
  })
}

/** 归档整个过期主题，并用新索引移除入口；核心记忆不允许整体归档。 */
export function archiveMemoryTheme(
  ctx: AgentMemoryContext,
  target: string,
  revision: string,
  indexRevision: string,
  indexContent: string,
): string {
  if (['global-profile', MEMORY_INDEX_NAME, PREFERENCES_NAME].includes(target)) {
    throw new Error('核心记忆不能整体归档；请按条目更新并保留必要事实。')
  }
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)
    const source = readMemoryFile(memoryTarget(ctx, target))
    const index = readMemoryFile(memoryPaths(ctx).index)
    const paths = memoryPaths(ctx)
    const identity = resolveMemoryPath(source.path)
    if ([paths.profile, paths.index, paths.preferences].some((path) => resolveMemoryPath(path) === identity)) {
      throw new Error('主题与核心记忆指向同一文件，不能归档。')
    }
    if (source.content === null || source.revision !== revision || index.revision !== indexRevision) {
      throw new Error('主题或索引已变化，请重新读取。')
    }
    if (!indexContent.trim() || indexContent.includes(target)) {
      throw new Error('新索引必须移除被归档主题的入口并保留其他内容。')
    }

    const archive = join(paths.directory, 'archive', `${Date.now()}-${randomUUID()}-${target}`)
    writeMemoryText(archive, source.content)
    writeMemoryText(index.path, indexContent)
    rmSync(source.path)
    return archive
  })
}

/** 供 brief 场景复用的文件名检查。 */
export function isMemoryCoreFile(ctx: AgentMemoryContext, path: string): boolean {
  const paths = memoryPaths(ctx)
  const identity = resolveMemoryPath(path)
  return [paths.profile, paths.index, paths.preferences].some((item) => resolveMemoryPath(item) === identity)
}

export { basename as memoryBasename }
