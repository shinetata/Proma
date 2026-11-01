/**
 * Agent 写入知识文件时的事前快照与事后 diff。
 *
 * 覆盖三类写入：记忆工具、Write/Edit、以及 bash 里的重定向与 sed -i 等命令。
 * 目标分类决定界面上的标签（全局画像 / 项目记忆 / 项目规则）。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertMemoryPath,
  memoryPaths,
  memoryTarget,
  type AgentMemoryContext,
} from './agent-memory'
import { createFileChange, readSnapshot, type FileSnapshot } from './file-change-diff'
import { resolveMemoryPath } from './memory-file-path'

const INSTRUCTION_MUTATIONS = new Set([
  'ProjectInstructionsMaintain',
  'ProjectInstructionsMigrate',
  'ProjectInstructionsResume',
  'ProjectInstructionsReplan',
])
const SHELL_MUTATION = /(?:^|[\s;&|])(?:rm|mv|cp|tee|touch|sed\s+-i|perl\s+-[\w]*i|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item)\b|(?:>|>>)|(?:writeFile|write_text|write_bytes|\.write\()/i
const MAX_TARGETS = 128

export interface KnowledgeFileChange {
  /** 供界面展示的分类标签，例如 `项目记忆/MEMORY.md`。 */
  relativePath: string
  absolutePath: string
  kind: 'created' | 'modified' | 'deleted'
  changedAt: number
  diffAvailable: boolean
  preview?: string
  diff?: {
    context: string[]
    removed: string[]
    added: string[]
    truncated: boolean
  }
}

interface ChangeTarget {
  path: string
  label: string
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function resolveToolPath(raw: string, cwd: string): string {
  let value = raw.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ').replace(/^@/, '')
  if (process.platform === 'win32' && !value.includes('\\')) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i, (_match, drive: string) => `${drive.toUpperCase()}:\\`)
  }
  if (value === '~') value = homedir()
  else if (/^~[/\\]/.test(value)) value = join(homedir(), value.slice(2))
  if (value.startsWith('file://')) value = fileURLToPath(value)
  return resolve(cwd, value)
}

function canonicalPath(path: string): string {
  return resolveMemoryPath(path)
}

function safeCanonicalPath(path: string): string | undefined {
  try {
    return canonicalPath(path)
  } catch {
    return undefined
  }
}

function withinSafeRoot(root: string, path: string): boolean {
  const canonical = safeCanonicalPath(root)
  return canonical !== undefined && within(canonical, path)
}

export interface KnowledgeChangeTrackerOptions {
  memoryContext?: AgentMemoryContext
  cwd: string
  additionalDirectories?: string[]
  onChanges: (changes: KnowledgeFileChange[]) => void
}

export function createKnowledgeChangeTracker(options: KnowledgeChangeTrackerOptions): {
  run: <T>(name: string, params: unknown, execute: () => Promise<T>) => Promise<T>
  runSynchronous: <T>(name: string, params: unknown, execute: () => T) => T
} {
  const ctx = options.memoryContext
  const roots = [options.cwd, ...(options.additionalDirectories ?? []), ...(ctx ? [ctx.projectRoot] : [])]

  function classify(raw: string): ChangeTarget | undefined {
    const logical = resolveToolPath(raw, options.cwd)
    const path = canonicalPath(logical)

    if (ctx && path === safeCanonicalPath(memoryPaths(ctx).profile)) {
      return { path: logical, label: '全局画像/user_profile.md' }
    }

    const workspaces = ctx
      ? [{ root: ctx.workspaceRoot, slug: '' }, ...(ctx.allowProfileMigration === false ? [] : ctx.workspaces)]
      : []
    for (const workspace of workspaces) {
      const logicalRoot = join(workspace.root, 'memory')
      const memory = safeCanonicalPath(logicalRoot)
      const isLogical = within(logicalRoot, logical)
      if (memory && (isLogical || within(memory, path)) && /\.md$/i.test(logical)) {
        const rel = relative(isLogical ? logicalRoot : memory, isLogical ? logical : path).split(sep).join('/')
        if (rel.split('/').some((part) => part.startsWith('.') || part === 'archive')) return undefined
        return { path: logical, label: workspace.slug ? `${workspace.slug}/memory/${rel}` : `项目记忆/${rel}` }
      }
      if (
        /^(user[_-]profile|MEMORY)\.md$/i.test(path.split(sep).pop() ?? '') &&
        withinSafeRoot(join(workspace.root, '.claude', 'memory'), path)
      ) {
        return {
          path,
          label: `${workspace.slug || '当前项目'}/旧画像/${path.split(sep).pop()}`,
        }
      }
    }

    if (
      /^(AGENTS|CLAUDE)\.md$/i.test(path.split(sep).pop() ?? '') &&
      (roots.some((root) => withinSafeRoot(root, path)) || (ctx && withinSafeRoot(ctx.workspaceRoot, path)))
    ) {
      return { path, label: `项目规则/${path.split(sep).pop()}` }
    }

    return undefined
  }

  function targets(name: string, params: unknown): ChangeTarget[] {
    const paths: string[] = []
    const addCore = (): void => {
      if (!ctx) return
      const core = memoryPaths(ctx)
      const map = join(
        ctx.projectRoot,
        existsSync(join(ctx.projectRoot, 'AGENTS.md')) || !existsSync(join(ctx.projectRoot, 'AGENTS.MD')) ? 'AGENTS.md' : 'AGENTS.MD',
      )
      paths.push(core.profile, core.index, core.preferences, map)
    }

    const record = (params ?? {}) as Record<string, unknown>
    if (ctx && name === 'MemoryUpdate' && typeof record.target === 'string') {
      paths.push(memoryTarget(ctx, record.target))
    } else if (ctx && name === 'MemoryArchive' && typeof record.target === 'string') {
      paths.push(memoryTarget(ctx, record.target), memoryPaths(ctx).index)
    } else if (name === 'MemoryInitialize') {
      addCore()
    } else if (ctx && INSTRUCTION_MUTATIONS.has(name)) {
      addCore()
      paths.push(join(ctx.workspaceRoot, 'AGENTS.md'), join(ctx.workspaceRoot, 'AGENTS.MD'))
    } else if (ctx && name === 'MemoryMigrateProfile') {
      const proposal = record.proposal as { sourceId?: unknown } | undefined
      let sourceId = proposal?.sourceId
      const migrationId = typeof record.resumeId === 'string' ? record.resumeId : record.replanId
      if (typeof migrationId === 'string' && /^[a-f0-9-]{36}$/.test(migrationId)) {
        const journalPath = join(ctx.globalDir, 'migrations', migrationId, 'pending.json')
        assertMemoryPath(journalPath)
        if (lstatSync(journalPath).size <= 8 * 1024 * 1024) {
          const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { sourceId?: unknown }
          sourceId = journal.sourceId
        }
      }
      for (const workspace of ctx.allowProfileMigration === false ? [] : ctx.workspaces) {
        for (const folder of ['memory', '.claude/memory']) {
          for (const filename of ['user_profile.md', 'user-profile.md']) {
            const sourcePath = join(workspace.root, folder, filename)
            if (createHash('sha256').update(resolve(sourcePath)).digest('hex') !== sourceId) continue
            const pathsForSource = memoryPaths({ ...ctx, workspaceRoot: workspace.root })
            paths.push(pathsForSource.profile, pathsForSource.index, pathsForSource.preferences, sourcePath, join(dirname(sourcePath), 'MEMORY.md'))
          }
        }
      }
    } else if (['write', 'edit', 'Write', 'Edit', 'MultiEdit'].includes(name)) {
      const raw = record.path ?? record.file_path ?? record.filePath
      if (typeof raw === 'string') paths.push(raw)
    } else if (
      ['bash', 'Bash', 'powershell', 'PowerShell'].includes(name) &&
      typeof record.command === 'string' &&
      SHELL_MUTATION.test(record.command)
    ) {
      let commandCwd: string | undefined = options.cwd
      for (const segment of record.command.split(/&&|;|\n/)) {
        const cd = segment.match(/^\s*(?:cd|Set-Location)\s+(?:--\s+)?(?:(?:"([^"\n]+)")|(?:'([^'\n]+)')|([^\s]+))\s*$/i)
        if (cd) {
          const raw = cd[1] ?? cd[2] ?? cd[3] ?? ''
          commandCwd = commandCwd && raw !== '-' && !/[$`*?]/.test(raw) ? resolveToolPath(raw, commandCwd) : undefined
          continue
        }
        const quoted = [...segment.matchAll(/(["'])([^"'\r\n]*?\.md)\1/gi)].map((match) => match[2])
        const unquoted = [...segment.matchAll(/[^\s"'();|<>]+\.md\b/gi)].map((match) => match[0])
        for (const raw of [...quoted, ...unquoted]) {
          if (!raw || /[$`*?]/.test(raw)) continue
          if (commandCwd || isAbsolute(raw)) paths.push(resolveToolPath(raw, commandCwd ?? options.cwd))
        }
      }
    }

    const unique = new Map<string, ChangeTarget>()
    for (const path of paths) {
      try {
        const target = classify(path)
        if (!target) continue
        const identity = canonicalPath(target.path)
        if (!unique.has(identity)) unique.set(identity, target)
      } catch {
        // 目标不可解析时跳过，不影响工具执行。
      }
      if (unique.size >= MAX_TARGETS) break
    }
    return [...unique.values()]
  }

  function begin(name: string, params: unknown): () => void {
    const before = new Map<ChangeTarget, FileSnapshot | undefined>()
    try {
      for (const target of targets(name, params)) {
        try {
          assertMemoryPath(target.path)
          before.set(target, readSnapshot(canonicalPath(target.path)))
        } catch {
          // 单个目标不可读时继续处理其他目标。
        }
      }
    } catch {
      // 目标解析失败时不阻塞工具执行。
    }

    return () => {
      const changes: KnowledgeFileChange[] = []
      for (const [target, snapshot] of before) {
        try {
          assertMemoryPath(target.path)
          const change = createFileChange(target.label, snapshot, readSnapshot(canonicalPath(target.path)), Date.now())
          if (change) changes.push({ ...change, absolutePath: target.path })
        } catch {
          // 变更检查失败不影响工具结果。
        }
      }
      if (changes.length) {
        try {
          options.onChanges(changes)
        } catch {
          // 界面通知失败不得影响工具结果。
        }
      }
    }
  }

  return {
    async run<T>(name: string, params: unknown, execute: () => Promise<T>): Promise<T> {
      const finish = begin(name, params)
      try {
        const result = await execute()
        finish()
        return result
      } catch (error) {
        if (['bash', 'Bash', 'powershell', 'PowerShell'].includes(name)) finish()
        throw error
      }
    },
    runSynchronous<T>(name: string, params: unknown, execute: () => T): T {
      const finish = begin(name, params)
      try {
        return execute()
      } finally {
        finish()
      }
    },
  }
}