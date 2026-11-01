/**
 * 旧外层 AGENTS.md（Proma 工作区级）合并进项目根 AGENTS.md 的迁移状态机。
 *
 * 与商业版一致：先写 pending 日志并保存来源与目标快照，再写入并回读核验，
 * 最后归档外层文件；任何一步发现外部改动都保留原文并要求重新合并。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inspectProjectMap } from './project-map-review'
import { assertMemoryPath, readMemoryFile, withMemoryLock, writeMemoryText, type AgentMemoryContext, type MemoryFile } from './agent-memory'
import {
  instructionPathIdentity,
  readInstructionReadyRecord,
} from './project-instruction-state'
import { writeJsonFileAtomic } from './safe-file'

export interface InstructionMigrationIssue {
  path: string
  message: string
}

export interface InstructionMigrationState {
  sources: MemoryFile[]
  issues: InstructionMigrationIssue[]
  target: MemoryFile
  pendingIds: string[]
  deferred: boolean
  needed: boolean
}

export interface InstructionMigrationJournal {
  id: string
  projectRoot: string
  target: MemoryFile
  sources: MemoryFile[]
  content: string
  summary: string
  createdAt: number
}

export interface InstructionMigrationProposal {
  targetRevision: string
  sources: Array<{ path: string; revision: string }>
  content: string
  summary: string
}

const AGENTS_NAMES = ['AGENTS.md', 'AGENTS.MD']

function identity(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

export function projectInstructionsPath(projectRoot: string): string {
  return inspectProjectMap(projectRoot).path
}

export function legacyProjectInstructions(ctx: AgentMemoryContext): MemoryFile[] {
  return inspectLegacyProjectInstructions(ctx).sources
}

export function inspectLegacyProjectInstructions(ctx: AgentMemoryContext): {
  sources: MemoryFile[]
  issues: InstructionMigrationIssue[]
} {
  if (readInstructionReadyRecord(ctx)) return { sources: [], issues: [] }

  const target = identity(projectInstructionsPath(ctx.canonicalProjectRoot ?? ctx.projectRoot))
  const seen = new Set([target])
  const sources: MemoryFile[] = []
  const issues: InstructionMigrationIssue[] = []

  for (const name of AGENTS_NAMES) {
    const path = join(ctx.workspaceRoot, name)
    if (seen.has(identity(path))) continue
    seen.add(identity(path))
    try {
      const file = readMemoryFile(path)
      if (file.content !== null) sources.push(file)
    } catch (error) {
      issues.push({ path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sources, issues }
}

function migrationDirectory(ctx: AgentMemoryContext): string {
  return join(ctx.workspaceRoot, 'instruction-migrations')
}

export function pendingInstructionMigrations(ctx: AgentMemoryContext): string[] {
  const directory = migrationDirectory(ctx)
  assertMemoryPath(directory)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(
    (id) => /^[a-f0-9-]{36}$/.test(id) && existsSync(join(directory, id, 'pending.json')),
  )
}

export function inspectInstructionMigration(ctx: AgentMemoryContext): InstructionMigrationState {
  const { sources, issues } = inspectLegacyProjectInstructions(ctx)
  const target = readMemoryFile(projectInstructionsPath(ctx.projectRoot))
  const pendingIds = pendingInstructionMigrations(ctx)
  const deferred = identity(ctx.projectRoot) !== identity(ctx.canonicalProjectRoot ?? ctx.projectRoot)
  return { sources, issues, target, pendingIds, deferred, needed: sources.length > 0 || pendingIds.length > 0 || issues.length > 0 }
}

/** 每轮注入的规则迁移提示；已完成或无需迁移时返回 undefined。 */
export function instructionMigrationPrompt(ctx: AgentMemoryContext): string | undefined {
  try {
    if (readInstructionReadyRecord(ctx)) return undefined
    const state = inspectInstructionMigration(ctx)
    if (!state.needed) return undefined

    if (state.issues.length) {
      return `## 项目规则迁移受阻
${state.issues.map((issue) => `${issue.path}：${issue.message}`).join('\n')}
原文件保持不变，不得把异常当作缺失或宣称维护完成。继续本轮正常任务，不反复调用维护工具；仅在需要处理这些规则时说明受阻原因，修复来源后再合并。`
    }

    return `## 项目 AGENTS.md 待统一
唯一项目入口：${state.target.path}。旧外层来源：${state.sources.map((source) => source.path).join('、') || '见未完成迁移记录'}。
${state.deferred ? '当前处于 worktree。旧外层规则应在原项目主目录的会话中合并，禁止为了清除提醒修改其他 checkout；当前保留旧规则作为待迁移来源。' : `在本轮首次对话（包括问候）中自动维护：先调用 ProjectInstructionsMaintain；需要语义合并时调用 ProjectInstructionsInspect，读取两侧规则，按语义合并、去重，保留有效要求和来源。冲突不能按 mtime 取胜；有证据的用户纠正优先，不确定冲突先询问，解决前不提交迁移。通过 ProjectInstructionsMigrate 提交正文、全部版本与合并依据；工具先保存历史并写后核验，再归档旧文件，禁止手工先删除外层文件。${state.pendingIds.length ? `未完成迁移：${state.pendingIds.join(', ')}，先用 ProjectInstructionsResume 恢复。` : ''}`}
只读、计划模式、用户禁止写入或无人值守任务只报告待迁移状态，不迁移。迁移前两份原文都保留；迁移后只以项目根文件为主入口。`
  } catch (error) {
    return `项目规则迁移检查失败，不能当作文件缺失或直接覆盖：${String(error)}`
  }
}

function assertMigrationAllowed(ctx: AgentMemoryContext): void {
  if (ctx.allowInstructionMaintenance === false) throw new Error('当前计划或只读会话不执行项目规则迁移。')
  if (ctx.allowProfileMigration === false) throw new Error('自动化和委派不执行项目规则迁移，请在用户主会话中处理。')
  if (identity(ctx.projectRoot) !== identity(ctx.canonicalProjectRoot ?? ctx.projectRoot)) {
    throw new Error('请在原项目主目录的会话中合并外层规则；不能从 worktree 改写其他 checkout。')
  }
}

export function replanProjectInstructions(ctx: AgentMemoryContext, id: string): string {
  assertMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = join(migrationDirectory(ctx), id)
    const path = join(directory, 'pending.json')
    assertMemoryPath(path)
    if (!existsSync(path) && existsSync(join(directory, 'superseded.json'))) return id
    if (!lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) throw new Error('规则迁移记录无效。')

    const journal = JSON.parse(readFileSync(path, 'utf8')) as InstructionMigrationJournal
    const allowedSources = AGENTS_NAMES.map((name) => join(ctx.workspaceRoot, name))
    if (
      journal.id !== id ||
      journal.projectRoot !== identity(ctx.projectRoot) ||
      !Array.isArray(journal.sources) ||
      journal.sources.some(
        (source) => !allowedSources.includes(source.path) || identity(source.path) === identity(projectInstructionsPath(ctx.projectRoot)),
      )
    ) {
      throw new Error('迁移记录与当前项目不匹配。')
    }

    for (const source of journal.sources) {
      if (readMemoryFile(source.path).content === null) writeMemoryText(source.path, source.content ?? '')
    }
    renameSync(path, join(directory, 'superseded.json'))
    return id
  })
}

export function mergeProjectInstructions(ctx: AgentMemoryContext, proposal: InstructionMigrationProposal): string {
  assertMigrationAllowed(ctx)
  return withMemoryLock(ctx, () => {
    const state = inspectInstructionMigration(ctx)
    if (state.issues.length) throw new Error(`旧规则无法安全读取，未提交迁移：${state.issues.map((issue) => issue.path).join('、')}`)
    if (state.pendingIds.length) throw new Error(`请先恢复未完成的规则迁移：${state.pendingIds.join(', ')}`)
    if (!state.sources.length) throw new Error('没有待合并的外层 AGENTS.md。')

    if (
      state.target.revision !== proposal.targetRevision ||
      state.sources.length !== proposal.sources.length ||
      state.sources.some((source) => !proposal.sources.some((item) => item.path === source.path && item.revision === source.revision))
    ) {
      throw new Error('项目规则已变化，请重新读取两侧内容并合并。')
    }
    if (!proposal.content.trim() || !proposal.summary.trim()) throw new Error('请提供合并后的有效正文和逐项保留、去重、冲突处理依据。')
    if (Buffer.byteLength(proposal.content) > 512 * 1024) throw new Error('合并后的规则超过 512 KiB，请先按主题整理。')

    const legacyClaude =
      state.target.content === null
        ? ['CLAUDE.md', 'CLAUDE.MD'].find((name) => existsSync(join(ctx.projectRoot, name)))
        : undefined
    const content =
      legacyClaude && !proposal.content.includes(`](./${legacyClaude})`)
        ? `${proposal.content.trimEnd()}

请先读取并遵循 [${legacyClaude}](./${legacyClaude}) 中的现有项目规则。
`
        : proposal.content

    const journal: InstructionMigrationJournal = {
      id: randomUUID(),
      projectRoot: identity(ctx.projectRoot),
      target: state.target,
      sources: state.sources,
      content,
      summary: proposal.summary,
      createdAt: Date.now(),
    }
    const directory = join(migrationDirectory(ctx), journal.id)
    assertMemoryPath(directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeJsonFileAtomic(join(directory, 'pending.json'), journal)
    return applyInstructionMigration(ctx, journal)
  })
}

export function resumeProjectInstructions(ctx: AgentMemoryContext, id: string): string {
  assertMigrationAllowed(ctx)
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('迁移 ID 无效。')
  return withMemoryLock(ctx, () => {
    const directory = join(migrationDirectory(ctx), id)
    const path = join(directory, 'pending.json')
    assertMemoryPath(path)
    if (!existsSync(path) && existsSync(join(directory, 'completed.json'))) return id
    if (!lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) throw new Error('规则迁移记录无效。')

    const journal = JSON.parse(readFileSync(path, 'utf8')) as InstructionMigrationJournal
    if (journal.id !== id) throw new Error('规则迁移 ID 不一致。')
    return applyInstructionMigration(ctx, journal)
  })
}

function applyInstructionMigration(ctx: AgentMemoryContext, journal: InstructionMigrationJournal): string {
  const allowedTargets = AGENTS_NAMES.map((name) => join(ctx.projectRoot, name))
  const allowedSources = AGENTS_NAMES.map((name) => join(ctx.workspaceRoot, name))
  if (
    journal.projectRoot !== identity(ctx.projectRoot) ||
    !allowedTargets.includes(journal.target.path) ||
    !journal.sources.length ||
    journal.sources.some((file) => !allowedSources.includes(file.path) || identity(file.path) === identity(journal.target.path))
  ) {
    throw new Error('迁移记录与当前项目不匹配，未修改文件。')
  }

  const target = readMemoryFile(journal.target.path)
  if (target.content !== journal.target.content && target.content !== journal.content) {
    throw new Error('项目 AGENTS.md 有新改动，不能用迁移记录覆盖。')
  }
  for (const source of journal.sources) {
    const current = readMemoryFile(source.path)
    if (current.content !== null && current.revision !== source.revision) {
      throw new Error('外层 AGENTS.md 有新改动，保留原文等待重新核对。')
    }
  }

  const directory = join(migrationDirectory(ctx), journal.id)
  for (const [index, source] of journal.sources.entries()) {
    writeMemoryText(join(directory, `source-${index}.md`), source.content ?? '')
  }
  if (journal.target.content !== null) writeMemoryText(join(directory, 'target-before.md'), journal.target.content)

  if (target.content !== journal.content) writeMemoryText(journal.target.path, journal.content)
  if (readMemoryFile(journal.target.path).content !== journal.content) throw new Error('项目规则写后核验失败，保留原文。')

  for (const source of journal.sources) {
    const current = readMemoryFile(source.path)
    if (current.content === null) continue
    if (current.revision !== source.revision) throw new Error('归档前外层规则变化，保留源文件。')
    rmSync(source.path)
  }

  renameSync(join(directory, 'pending.json'), join(directory, 'completed.json'))
  return journal.id
}

export function instructionInspectionRevision(ctx: AgentMemoryContext): string {
  const state = inspectInstructionMigration(ctx)
  return createHash('sha256')
    .update(JSON.stringify({ target: state.target.revision, sources: state.sources.map((file) => [file.path, file.revision]) }))
    .digest('hex')
}
