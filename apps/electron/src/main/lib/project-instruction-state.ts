/**
 * 项目能力“首次维护已完成”的持久记录。
 *
 * 记录绑定项目根、全局目录、目标文件指纹与必需记忆文件，任一变化都会让记录失效，
 * 下次写入型项目任务重新执行一次基础维护。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertMemoryPath, memoryPaths, type AgentMemoryContext } from './agent-memory'
import { resolveMemoryPath } from './memory-file-path'
import { writeJsonFileAtomic } from './safe-file'

export interface InstructionReadyRecord {
  version: 1
  projectRoot: string
  globalDir: string
  targetPath: string
  targetStamp: string
  completedAt: number
  changed: boolean
}

export function instructionPathIdentity(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function recordPath(ctx: AgentMemoryContext): string {
  const key = createHash('sha256').update(instructionPathIdentity(ctx.projectRoot)).digest('hex')
  return join(ctx.workspaceRoot, 'instruction-maintenance', `${key}.json`)
}

function stamp(path: string): string | undefined {
  assertMemoryPath(path)
  try {
    const stats = lstatSync(resolveMemoryPath(path))
    if (!stats.isFile() || stats.size === 0) return undefined
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function readInstructionReadyRecord(ctx: AgentMemoryContext): InstructionReadyRecord | undefined {
  const path = recordPath(ctx)
  try {
    assertMemoryPath(path)
    if (!existsSync(path)) return undefined
    if (lstatSync(path).size > 16384) return undefined
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstructionReadyRecord>

    if (
      record.version !== 1 ||
      !Number.isFinite(record.completedAt) ||
      (record.completedAt ?? 0) <= 0 ||
      (record.completedAt ?? 0) > Date.now() ||
      record.projectRoot !== instructionPathIdentity(ctx.projectRoot) ||
      record.globalDir !== instructionPathIdentity(ctx.globalDir) ||
      !['AGENTS.md', 'AGENTS.MD'].some((name) => record.targetPath === join(ctx.projectRoot, name)) ||
      record.targetStamp !== stamp(record.targetPath!)
    ) {
      return undefined
    }
    // 同时存在 AGENTS.md 时，AGENTS.MD 记录立即失效。
    if (record.targetPath!.endsWith('AGENTS.MD') && existsSync(join(ctx.projectRoot, 'AGENTS.md'))) return undefined

    const canonical = instructionPathIdentity(ctx.canonicalProjectRoot ?? ctx.projectRoot)
    for (const name of ['AGENTS.md', 'AGENTS.MD']) {
      const source = join(ctx.workspaceRoot, name)
      if (instructionPathIdentity(ctx.workspaceRoot) !== canonical) {
        try {
          lstatSync(source)
          return undefined
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }

    const paths = memoryPaths(ctx)
    if (!stamp(paths.profile) || !stamp(paths.index)) return undefined
    return record as InstructionReadyRecord
  } catch {
    return undefined
  }
}

export function writeInstructionReadyRecord(
  ctx: AgentMemoryContext,
  targetPath: string,
  changed: boolean,
): InstructionReadyRecord {
  const existing = readInstructionReadyRecord(ctx)
  if (existing && !changed) return existing

  const targetStamp = stamp(targetPath)
  const paths = memoryPaths(ctx)
  if (!targetStamp || !stamp(paths.profile) || !stamp(paths.index)) {
    throw new Error('项目规则或必需记忆尚未就绪，不能记录完成。')
  }

  const record: InstructionReadyRecord = {
    version: 1,
    projectRoot: instructionPathIdentity(ctx.projectRoot),
    globalDir: instructionPathIdentity(ctx.globalDir),
    targetPath,
    targetStamp,
    completedAt: Date.now(),
    changed,
  }
  const path = recordPath(ctx)
  assertMemoryPath(path)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}
