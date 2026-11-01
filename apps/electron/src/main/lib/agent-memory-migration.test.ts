/**
 * 旧画像合并迁移：状态机、版本校验与中断记录。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverLegacyProfiles,
  ensureMemoryFiles,
  memoryPaths,
  readMemoryFile,
  updateMemory,
  type AgentMemoryContext,
} from './agent-memory'
import {
  migrateProfile,
  pendingMigrationCount,
  replanProfileMigration,
  resumeProfileMigration,
  type ProfileMigrationProposal,
} from './agent-memory-migration'

function createContext(): AgentMemoryContext {
  const root = mkdtempSync(join(tmpdir(), 'proma-migrate-'))
  const workspaceRoot = join(root, 'agent-workspaces', 'demo')
  mkdirSync(join(workspaceRoot, 'memory'), { recursive: true })
  const projectRoot = join(root, 'projects', 'demo')
  mkdirSync(projectRoot, { recursive: true })
  return {
    globalDir: join(root, 'memory'),
    workspaceRoot,
    projectRoot,
    canonicalProjectRoot: projectRoot,
    workspaces: [{ slug: 'demo', root: workspaceRoot }],
  }
}

function prepareLegacyProfile(ctx: AgentMemoryContext): string {
  const legacyProfile = join(ctx.workspaceRoot, 'memory', 'user-profile.md')
  writeFileSync(legacyProfile, '# 旧画像\n\n- 偏好中文回答\n')
  writeFileSync(memoryPaths(ctx).index, '# 项目记忆索引\n\n- user-profile.md\n')
  updateMemory(ctx, 'MEMORY.md', readMemoryFile(memoryPaths(ctx).index).revision, '# 项目记忆索引\n\n- user-profile.md\n', '初始化索引')
  return legacyProfile
}

function buildProposal(ctx: AgentMemoryContext, globalContent: string): ProfileMigrationProposal {
  const source = discoverLegacyProfiles(ctx)[0]
  if (!source) throw new Error('缺少旧画像来源')
  const paths = memoryPaths(ctx)
  return {
    sourceId: source.id,
    sourceRevision: source.profile.revision,
    globalRevision: readMemoryFile(paths.profile).revision,
    globalContent,
    preferencesRevision: readMemoryFile(paths.preferences).revision,
    preferencesContent: '# 项目偏好\n\n- 本项目使用中文注释\n',
    sourceIndexRevision: source.index.revision,
    sourceIndexContent: '# 项目记忆索引\n\n- project-preferences.md\n',
    indexRevision: readMemoryFile(paths.index).revision,
    indexContent: '# 项目记忆索引\n\n- project-preferences.md\n',
    rationale: '跨项目稳定偏好合并进全局画像；项目偏好写入 project-preferences.md 并更新索引。',
  }
}

describe('画像迁移', () => {
  test('成功迁移：写入全局画像、同步项目索引并归档源画像', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const legacyPath = prepareLegacyProfile(ctx)

    const migrationId = migrateProfile(ctx, buildProposal(ctx, '# 全局用户画像\n\n- 偏好中文回答\n'))
    const paths = memoryPaths(ctx)

    expect(readFileSync(paths.profile, 'utf8')).toContain('偏好中文回答')
    expect(readFileSync(paths.index, 'utf8')).toContain('project-preferences.md')
    expect(readFileSync(paths.preferences, 'utf8')).toContain('中文注释')
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(join(ctx.globalDir, 'migrations', migrationId, 'completed.json'))).toBe(true)
    expect(existsSync(join(ctx.globalDir, 'migrations', migrationId, 'source-profile.md'))).toBe(true)
    expect(pendingMigrationCount(ctx)).toBe(0)
  })

  test('版本不一致时拒绝迁移且不动任何文件', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const legacyPath = prepareLegacyProfile(ctx)
    const proposal = buildProposal(ctx, '# 全局用户画像\n\n- 偏好中文回答\n')

    updateMemory(ctx, 'MEMORY.md', readMemoryFile(memoryPaths(ctx).index).revision, '# 项目记忆索引\n\n- lessons.md\n', '并发修改索引')

    expect(() => migrateProfile(ctx, proposal)).toThrow('迁移期间文件已变化')
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(memoryPaths(ctx).index, 'utf8')).toContain('lessons.md')
  })

  test('索引仍保留源画像入口时拒绝迁移', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    prepareLegacyProfile(ctx)
    const proposal = buildProposal(ctx, '# 全局用户画像\n\n- 偏好中文回答\n')

    expect(() =>
      migrateProfile(ctx, { ...proposal, sourceIndexContent: '# 项目记忆索引\n\n- user-profile.md\n' }),
    ).toThrow('移除本次源画像的旧入口')
  })

  test('resume 幂等、replan 保留新内容并退役旧计划', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const legacyPath = prepareLegacyProfile(ctx)
    const proposal = buildProposal(ctx, '# 全局用户画像\n\n- 偏好中文回答\n')

    // 制造一个中断的迁移：先写 pending 日志再手工删除目标写入机会
    const migrationId = '123e4567-e89b-42d3-a456-426614174000'
    const directory = join(ctx.globalDir, 'migrations', migrationId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'pending.json'), JSON.stringify({
      id: migrationId,
      sourceId: proposal.sourceId,
      workspaceRoot: ctx.workspaceRoot,
      sourcePath: legacyPath,
      sourceContent: readFileSync(legacyPath, 'utf8'),
      rationale: '中断测试',
      createdAt: Date.now(),
      edits: [
        { target: 'global', before: readMemoryFile(memoryPaths(ctx).profile).content, after: '# 全局用户画像\n\n- 偏好中文回答\n' },
        { target: 'source-index', before: readMemoryFile(join(ctx.workspaceRoot, 'memory', 'MEMORY.md')).content, after: '# 项目记忆索引\n\n暂无\n' },
      ],
    }))

    expect(pendingMigrationCount(ctx)).toBe(1)
    expect(replanProfileMigration(ctx, migrationId)).toBe(migrationId)
    expect(existsSync(join(directory, 'superseded.json'))).toBe(true)
    expect(pendingMigrationCount(ctx)).toBe(0)
    // 已退役的计划再次 replan 是幂等的
    expect(replanProfileMigration(ctx, migrationId)).toBe(migrationId)

    // resume 对已完成的迁移同样幂等
    const completedId = migrateProfile(ctx, buildProposal(ctx, '# 全局用户画像\n\n- 偏好中文回答\n'))
    expect(resumeProfileMigration(ctx, completedId)).toBe(completedId)
  })
})
