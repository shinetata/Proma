/**
 * 旧画像合并到全局画像的迁移状态机。
 *
 * 与商业版一致：先写 pending.json 日志，再逐目标写入并回读核验，最后归档源画像；
 * 任何一步发现外部改动都保留现状，要求重新读取后用 replanId 退役旧计划。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assertMemoryPath,
  assertNoPendingMemoryMigration,
  assertProfileBudget,
  discoverLegacyProfiles,
  memoryPaths,
  pendingMemoryMigrations,
  readMemoryFile,
  withMemoryLock,
  writeMemoryText,
  type AgentMemoryContext,
  type MemoryFile,
} from './agent-memory'
import { resolveMemoryPath } from './memory-file-path'
import { writeJsonFileAtomic } from './safe-file'

export type MigrationEditTarget = 'global' | 'preferences' | 'source-index' | 'index'

export interface ProfileMigrationEdit {
  target: MigrationEditTarget
  before: string | null
  after: string
}

export interface ProfileMigrationJournal {
  id: string
  sourceId: string
  workspaceRoot: string
  sourcePath: string
  sourceContent: string
  rationale: string
  createdAt: number
  edits: ProfileMigrationEdit[]
}

export interface ProfileMigrationProposal {
  sourceId: string
  sourceRevision: string
  globalRevision: string
  globalContent: string
  preferencesRevision: string
  preferencesContent: string | null
  sourceIndexRevision: string
  sourceIndexContent: string
  indexRevision: string
  indexContent: string
  rationale: string
}

function assertProfileMigrationAllowed(ctx: AgentMemoryContext): void {
  if (ctx.allowProfileMigration === false || ctx.allowInstructionMaintenance === false) {
    throw new Error('当前会话不允许整合用户画像；请在可写的用户项目会话中处理。')
  }
}

function assertRevision(file: MemoryFile, revision: string): void {
  if (file.revision !== revision) throw new Error(`迁移期间文件已变化，请重新读取并合并: ${file.path}`)
}

export function migrateProfile(ctx: AgentMemoryContext, proposal: ProfileMigrationProposal): string {
  assertProfileMigrationAllowed(ctx)
  return withMemoryLock(ctx, () => {
    assertNoPendingMemoryMigration(ctx)

    const source = discoverLegacyProfiles(ctx, proposal.sourceId)[0]
    if (!source || source.profile.content === null) throw new Error('源画像不存在或不属于已登记工作区。')

    const paths = memoryPaths({ ...ctx, workspaceRoot: source.workspace.root })
    const global = readMemoryFile(paths.profile)
    const preferences = readMemoryFile(paths.preferences)
    const index = readMemoryFile(paths.index)

    const checks: Array<[MemoryFile, string]> = [
      [source.profile, proposal.sourceRevision],
      [global, proposal.globalRevision],
      [preferences, proposal.preferencesRevision],
      [source.index, proposal.sourceIndexRevision],
      [index, proposal.indexRevision],
    ]
    for (const [file, revision] of checks) assertRevision(file, revision)

    if (!proposal.globalContent.trim() || !proposal.rationale.trim()) {
      throw new Error('请提供合并后的全局画像和逐项去重、项目范围、冲突处理依据。')
    }
    assertProfileBudget(proposal.globalContent)

    const sourceProfileName = source.profile.path.split('/').pop() ?? ''
    for (const content of [proposal.sourceIndexContent, proposal.indexContent]) {
      if (!content.trim() || content.toLowerCase().includes(sourceProfileName.toLowerCase())) {
        throw new Error('项目索引必须保留其他主题，并移除本次源画像的旧入口；其他待迁移画像的入口暂时保留。')
      }
    }
    if (preferences.content !== null && proposal.preferencesContent === null) {
      throw new Error('已有项目偏好不得在迁移中丢弃。')
    }
    if (proposal.preferencesContent !== null && (!proposal.preferencesContent.trim() || !proposal.indexContent.includes('project-preferences.md'))) {
      throw new Error('项目补充偏好必须有正文并在项目 MEMORY.md 中建立 project-preferences.md 索引。')
    }

    const sameIndex = resolveMemoryPath(source.index.path) === resolveMemoryPath(index.path)
    if (sameIndex && proposal.sourceIndexContent !== proposal.indexContent) {
      throw new Error('源索引与项目索引为同一文件，内容必须一致。')
    }

    const edits: ProfileMigrationEdit[] = [{ target: 'global', before: global.content, after: proposal.globalContent }]
    if (proposal.preferencesContent !== null) {
      edits.push({ target: 'preferences', before: preferences.content, after: proposal.preferencesContent })
    }
    edits.push({ target: 'source-index', before: source.index.content, after: proposal.sourceIndexContent })
    if (!sameIndex) edits.push({ target: 'index', before: index.content, after: proposal.indexContent })
    if (edits.some((edit) => Buffer.byteLength(edit.after) > 512 * 1024)) {
      throw new Error('迁移后的单个文件超过 512 KiB，请先按主题整理。')
    }

    const journal: ProfileMigrationJournal = {
      id: randomUUID(),
      sourceId: source.id,
      workspaceRoot: source.workspace.root,
      sourcePath: source.profile.path,
      sourceContent: source.profile.content,
      rationale: proposal.rationale,
      createdAt: Date.now(),
      edits,
    }

    assertUnsharedLegacySource(ctx, journal.sourcePath)
    validateMigrationAliases(migrationTargets(ctx, journal), journal)

    const directory = join(ctx.globalDir, 'migrations', journal.id)
    assertMemoryPath(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeJsonFileAtomic(join(directory, 'pending.json'), journal)
    return applyMigration(ctx, journal)
  })
}

export function resumeProfileMigration(ctx: AgentMemoryContext, id: string): string {
  assertProfileMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const path = join(ctx.globalDir, 'migrations', id, 'pending.json')
    if (!existsSync(path)) {
      if (existsSync(join(dirname(path), 'completed.json'))) return id
      throw new Error('迁移记录不存在。')
    }
    assertMemoryPath(path)
    if (!lstatSync(path).isFile() || lstatSync(path).size > 8 * 1024 * 1024) throw new Error('迁移日志无效或过大。')
    const journal = JSON.parse(readFileSync(path, 'utf8')) as ProfileMigrationJournal
    if (journal.id !== id) throw new Error('迁移记录与 ID 不一致。')
    return applyMigration(ctx, journal)
  })
}

export function replanProfileMigration(ctx: AgentMemoryContext, id: string): string {
  assertProfileMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = join(ctx.globalDir, 'migrations', id)
    const path = join(directory, 'pending.json')
    assertMemoryPath(path)
    if (!existsSync(path) && existsSync(join(directory, 'superseded.json'))) return id
    if (!lstatSync(path).isFile() || lstatSync(path).size > 8 * 1024 * 1024) throw new Error('迁移日志无效或过大。')
    const journal = JSON.parse(readFileSync(path, 'utf8')) as ProfileMigrationJournal
    if (journal.id !== id) throw new Error('迁移记录与 ID 不一致。')

    migrationTargets(ctx, journal)
    const source = readMemoryFile(journal.sourcePath)
    if (source.content === null) writeMemoryText(journal.sourcePath, journal.sourceContent)
    renameSync(path, join(directory, 'superseded.json'))
    return id
  })
}

function migrationTargets(ctx: AgentMemoryContext, journal: ProfileMigrationJournal): Record<MigrationEditTarget, string> {
  const workspace = ctx.workspaces.find((item) => item.root === journal.workspaceRoot)
  if (
    !workspace ||
    !['memory', '.claude/memory'].some((dir) =>
      ['user_profile.md', 'user-profile.md'].some((name) => join(workspace.root, dir, name) === journal.sourcePath),
    )
  ) {
    throw new Error('迁移源不在已登记的记忆目录。')
  }
  const paths = memoryPaths({ ...ctx, workspaceRoot: workspace.root })
  const targets: Record<MigrationEditTarget, string> = {
    global: paths.profile,
    preferences: paths.preferences,
    'source-index': join(dirname(journal.sourcePath), 'MEMORY.md'),
    index: paths.index,
  }
  if (
    typeof journal.sourceContent !== 'string' ||
    Buffer.byteLength(journal.sourceContent) > 512 * 1024 ||
    !Array.isArray(journal.edits) ||
    journal.edits[0]?.target !== 'global' ||
    !journal.edits.some((edit) => edit.target === 'source-index')
  ) {
    throw new Error('迁移记录不完整。')
  }
  if (
    new Set(journal.edits.map((edit) => edit.target)).size !== journal.edits.length ||
    journal.edits.some(
      (edit) =>
        !Object.hasOwn(targets, edit.target) ||
        typeof edit.after !== 'string' ||
        Buffer.byteLength(edit.after) > 512 * 1024 ||
        (edit.before !== null && typeof edit.before !== 'string'),
    )
  ) {
    throw new Error('迁移目标无效。')
  }
  return targets
}

function assertUnsharedLegacySource(ctx: AgentMemoryContext, sourcePath: string): void {
  const identity = resolveMemoryPath(sourcePath)
  const aliases = new Set<string>()
  for (const workspace of ctx.workspaces) {
    for (const directory of ['memory', '.claude/memory']) {
      for (const name of ['user_profile.md', 'user-profile.md']) {
        const path = join(workspace.root, directory, name)
        if (path === sourcePath) continue
        try {
          if (existsSync(path) && resolveMemoryPath(path) === identity) aliases.add(path)
        } catch {
          // 无法解析的别名不阻断其他来源的迁移判断。
        }
      }
    }
  }
  if (aliases.size) {
    throw new Error(`多个旧画像入口指向同一文件，当前提案不能同步其他来源索引；未修改任何文件。请先整理共享入口与索引后重新迁移：${[...aliases].join('、')}`)
  }
}

function validateMigrationAliases(targets: Record<MigrationEditTarget, string>, journal: ProfileMigrationJournal): void {
  const source = resolveMemoryPath(journal.sourcePath)
  const edits = new Map<string, ProfileMigrationEdit>()
  for (const edit of journal.edits) {
    const target = resolveMemoryPath(targets[edit.target])
    if (target === source) throw new Error('迁移源画像与目标指向同一文件，请先调整迁移内容。')
    const previous = edits.get(target)
    if (previous && (previous.before !== edit.before || previous.after !== edit.after)) {
      throw new Error('迁移目标指向同一文件，但合并内容不一致。')
    }
    edits.set(target, edit)
  }
}

function applyMigration(ctx: AgentMemoryContext, journal: ProfileMigrationJournal): string {
  const targets = migrationTargets(ctx, journal)
  assertUnsharedLegacySource(ctx, journal.sourcePath)
  validateMigrationAliases(targets, journal)

  const source = readMemoryFile(journal.sourcePath)
  if (source.content !== null && source.content !== journal.sourceContent) {
    throw new Error('源画像已变化，保留待处理迁移和源文件。请使用 replanId 保留新内容后重新合并。')
  }

  for (const edit of journal.edits) {
    if (!Object.hasOwn(targets, edit.target) || typeof edit.after !== 'string') throw new Error('迁移目标无效。')
    const content = readMemoryFile(targets[edit.target]).content
    if (content !== edit.before && content !== edit.after) {
      throw new Error(`迁移目标存在新改动，未覆盖: ${targets[edit.target]}。请使用 MemoryMigrateProfile 的 replanId 保留新改动并重新合并。`)
    }
  }

  const directory = join(ctx.globalDir, 'migrations', journal.id)
  writeMemoryText(join(directory, 'source-profile.md'), journal.sourceContent)
  for (const edit of journal.edits) {
    const file = readMemoryFile(targets[edit.target])
    if (file.content === edit.after) continue
    if (file.content !== edit.before) throw new Error('迁移期间出现并发修改，请重新检查。')
    writeMemoryText(file.path, edit.after)
  }
  for (const edit of journal.edits) {
    if (readMemoryFile(targets[edit.target]).content !== edit.after) throw new Error('迁移写后校验失败，保留源文件。')
  }

  const currentSource = readMemoryFile(journal.sourcePath)
  if (currentSource.content !== null) {
    if (currentSource.content !== journal.sourceContent) throw new Error('归档前源画像已变化，保留源文件。')
    rmSync(journal.sourcePath)
  }
  renameSync(join(directory, 'pending.json'), join(directory, 'completed.json'))
  return journal.id
}

/** 供 prompt/上下文复用的待迁移计数。 */
export function pendingMigrationCount(ctx: AgentMemoryContext): number {
  return pendingMemoryMigrations(ctx).length
}
