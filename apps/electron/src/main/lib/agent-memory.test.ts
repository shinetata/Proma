/**
 * 记忆存储层：revision、写锁、预算、历史、归档与复查记录。
 *
 * 这些断言直接锁住与商业版共享的数据契约，格式变化会让两个 App 互相看不到记录。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MEMORY_REVIEW_INTERVAL_MS,
  PROFILE_MAX_CHARS,
  archiveMemoryTheme,
  ensureMemoryFiles,
  hasMemoryAssociation,
  linkProjectMemory,
  listMemoryHistory,
  memoryAssociation,
  memoryHistoryDirectory,
  memoryPaths,
  memoryRevision,
  pendingMemoryMigrations,
  readMemoryFile,
  readMemoryHistoryVersion,
  readMemoryReview,
  restoreMemoryVersion,
  updateMemory,
  updateMemoryEntries,
  withMemoryLock,
  type AgentMemoryContext,
} from './agent-memory'

function createContext(): AgentMemoryContext {
  const root = mkdtempSync(join(tmpdir(), 'proma-memory-'))
  const workspaceRoot = join(root, 'agent-workspaces', 'demo')
  const projectRoot = join(root, 'projects', 'demo')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return {
    globalDir: join(root, 'memory'),
    workspaceRoot,
    projectRoot,
    canonicalProjectRoot: projectRoot,
    workspaces: [{ slug: 'demo', root: workspaceRoot }],
  }
}

describe('记忆 revision 与锁', () => {
  test('缺失文件与空内容的 revision 与商业版一致', () => {
    expect(memoryRevision(null)).toBe('ffa63583dfa6706b87d284b86b0d693a161e4840aad2c5cf6b5d27c3b9621f7d')
    expect(memoryRevision('a')).not.toBe(memoryRevision(null))
    expect(memoryRevision('a')).toBe(memoryRevision('a'))
  })

  test('版本不一致时拒绝写入并保留原内容', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const index = readMemoryFile(memoryPaths(ctx).index)
    updateMemory(ctx, 'MEMORY.md', index.revision, '# 项目记忆索引\n\n新内容\n', '测试写入')
    expect(() => updateMemory(ctx, 'MEMORY.md', index.revision, '# 项目记忆索引\n\n并发内容\n', '并发写入')).toThrow(
      '记忆已被其他会话修改',
    )
    expect(readMemoryFile(memoryPaths(ctx).index).content).toContain('新内容')
  })

  test('残留写锁按 pid 判定：活进程拒绝、死进程自动清理', () => {
    const ctx = createContext()
    const lock = join(ctx.globalDir, '.write-lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), String(process.pid))
    expect(() => withMemoryLock(ctx, () => 'ok')).toThrow('其他会话正在更新记忆')

    writeFileSync(join(lock, 'owner'), '999999')
    expect(withMemoryLock(ctx, () => 'ok')).toBe('ok')
    expect(existsSync(lock)).toBe(false)
  })
})

describe('预算、历史与复查', () => {
  test('画像超过 5000 字符时拒绝写入', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const profile = readMemoryFile(memoryPaths(ctx).profile)
    expect(() => updateMemory(ctx, 'global-profile', profile.revision, 'x'.repeat(PROFILE_MAX_CHARS + 1), '超限测试')).toThrow(
      '超过 5000 字符',
    )
  })

  test('内容变化写入历史快照，内容不变只刷新复查记录', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).index
    const first = readMemoryFile(path)
    const updated = updateMemory(ctx, 'MEMORY.md', first.revision, '# 项目记忆索引\n\n主题 A\n', '写入主题 A')

    const historyDir = join(ctx.globalDir, 'history')
    const historyFiles = readdirSync(historyDir, { recursive: true }).filter((name) => String(name).endsWith('.md'))
    expect(historyFiles.length).toBeGreaterThan(0)
    expect(readFileSync(join(historyDir, historyFiles[0] as string), 'utf8')).toContain('暂无已确认的项目记忆')

    const reviewed = updateMemory(ctx, 'MEMORY.md', updated.revision, updated.content ?? '', '复查未修改')
    expect(reviewed.revision).toBe(updated.revision)
    expect(readMemoryReview(ctx, reviewed).checkedAt).toBeGreaterThan(0)
  })

  test('内容变化时写入历史元信息，内容不变不产生新元信息', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).index
    const first = readMemoryFile(path)
    const updated = updateMemory(ctx, 'MEMORY.md', first.revision, '# 项目记忆索引\n\n主题 A\n', '写入主题 A')

    const metaPath = join(memoryHistoryDirectory(ctx, path), `${updated.revision}.json`)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      revision: string
      savedAt: number
      summary: string
      chars: number
    }
    expect(meta.revision).toBe(updated.revision)
    expect(meta.summary).toBe('写入主题 A')
    expect(meta.chars).toBe((updated.content ?? '').length)
    expect(meta.savedAt).toBeGreaterThan(0)

    // 内容不变时只刷新复查记录，元信息时间不变。
    updateMemory(ctx, 'MEMORY.md', updated.revision, updated.content ?? '', '复查未修改')
    expect((JSON.parse(readFileSync(metaPath, 'utf8')) as { savedAt: number }).savedAt).toBe(meta.savedAt)
  })

  test('复查周期为 7 天，且记录只对同一 revision 生效', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).index
    const file = readMemoryFile(path)
    updateMemory(ctx, 'MEMORY.md', file.revision, file.content ?? '', '首次核验')
    const reviewed = readMemoryFile(path)
    expect(readMemoryReview(ctx, reviewed).reviewDue).toBe(false)
    expect(readMemoryReview(ctx, reviewed, Date.now() + MEMORY_REVIEW_INTERVAL_MS + 1000).reviewDue).toBe(true)
    const changed = { ...reviewed, revision: 'deadbeef' }
    expect(readMemoryReview(ctx, changed).checkedAt).toBeUndefined()
  })
})

describe('归档与项目关联', () => {
  test('归档主题必须同时提交移除入口的新索引', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const paths = memoryPaths(ctx)
    const index = readMemoryFile(paths.index)
    const withTheme = updateMemory(ctx, 'MEMORY.md', index.revision, '# 项目记忆索引\n\n- lessons.md\n', '新增路由')
    writeFileSync(paths.directory + '/lessons.md', '# 经验\n')
    const theme = readMemoryFile(join(paths.directory, 'lessons.md'))

    expect(() =>
      archiveMemoryTheme(ctx, 'lessons.md', theme.revision, withTheme.revision, '# 项目记忆索引\n\n- lessons.md\n'),
    ).toThrow('必须移除被归档主题的入口')

    const archive = archiveMemoryTheme(ctx, 'lessons.md', theme.revision, withTheme.revision, '# 项目记忆索引\n\n暂无\n')
    expect(existsSync(archive)).toBe(true)
    expect(existsSync(join(paths.directory, 'lessons.md'))).toBe(false)
  })

  test('linkProjectMemory 幂等追加记忆关联块', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    linkProjectMemory(ctx)
    const mapPath = join(ctx.projectRoot, 'AGENTS.md')
    const first = readFileSync(mapPath, 'utf8')
    expect(hasMemoryAssociation(ctx, first)).toBe(true)

    linkProjectMemory(ctx)
    const second = readFileSync(mapPath, 'utf8')
    expect(second).toBe(first)
    expect(second.split('<!-- proma:memory:start -->').length).toBe(2)
    expect(memoryAssociation(ctx)).toContain('记忆维护')
  })

  test('存在 pending 迁移时拒绝其它写入', () => {
    const ctx = createContext()
    mkdirSync(join(ctx.globalDir, 'migrations', '123e4567-e89b-42d3-a456-426614174000'), { recursive: true })
    writeFileSync(join(ctx.globalDir, 'migrations', '123e4567-e89b-42d3-a456-426614174000', 'pending.json'), '{}')
    expect(pendingMemoryMigrations(ctx)).toHaveLength(1)
    expect(() => ensureMemoryFiles(ctx)).toThrow('有未完成的画像迁移')
    rmSync(ctx.globalDir, { recursive: true, force: true })
  })
})

describe('单条条目操作', () => {
  const CONTENT = '# 全局用户画像\n\n- 甲\n- 乙\n'

  function seed(): { ctx: AgentMemoryContext; path: string; revision: string } {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).profile
    const first = readMemoryFile(path)
    const written = updateMemory(ctx, 'global-profile', first.revision, CONTENT, '初始画像')
    return { ctx, path, revision: written.revision }
  }

  test('add / update / remove 只动目标条目并回报 changes', () => {
    const { ctx, path, revision } = seed()
    const result = updateMemoryEntries(
      ctx,
      'global-profile',
      revision,
      [
        { op: 'add', entry: '丙', after: '- 甲' },
        { op: 'update', match: '- 乙', entry: '乙改' },
      ],
      '补充与修正',
    )
    expect(result.changes).toEqual([
      { op: 'add', entry: '- 丙' },
      { op: 'update', entry: '- 乙改' },
    ])
    expect(result.skipped).toEqual([])
    expect(result.content).toBe('# 全局用户画像\n\n- 甲\n- 丙\n- 乙改\n')
    expect(readMemoryFile(path).content).toBe(result.content)
    // 未命中与重复只进 skipped，不写盘。
    const skipped = updateMemoryEntries(
      ctx,
      'global-profile',
      result.revision,
      [
        { op: 'add', entry: '甲' },
        { op: 'remove', match: '不存在' },
      ],
      '无实际变化',
    )
    expect(skipped.changes).toEqual([])
    expect(skipped.skipped.map((item) => item.reason)).toEqual(['duplicate', 'not-found'])
    expect(skipped.revision).toBe(result.revision)
  })

  test('版本不一致时拒绝条目写入', () => {
    const { ctx, revision } = seed()
    updateMemory(ctx, 'global-profile', revision, '# 全局用户画像\n\n- 甲改\n', '并发写入')
    expect(() => updateMemoryEntries(ctx, 'global-profile', revision, [{ op: 'add', entry: '丙' }], '并发条目')).toThrow(
      '记忆已被其他会话修改',
    )
  })

  test('空操作列表报错', () => {
    const { ctx, revision } = seed()
    expect(() => updateMemoryEntries(ctx, 'global-profile', revision, [], '空操作')).toThrow('请提供至少一条条目操作')
  })
})

describe('历史版本读取与恢复', () => {
  test('列出历史版本、读取指定版本并恢复', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).profile
    const first = readMemoryFile(path)
    const v1 = updateMemory(ctx, 'global-profile', first.revision, '# 全局用户画像\n\n- 旧事实\n', '第一版')
    const v2 = updateMemory(ctx, 'global-profile', v1.revision, '# 全局用户画像\n\n- 新事实\n', '第二版')

    const history = listMemoryHistory(ctx, 'global-profile')
    expect(history.some((entry) => entry.revision === v2.revision && entry.current)).toBe(true)
    const v1Entry = history.find((entry) => entry.revision === v1.revision)
    expect(v1Entry?.summary).toBe('第一版')
    expect(v1Entry?.chars).toBe((v1.content ?? '').length)
    expect(v1Entry?.current).toBe(false)

    expect(readMemoryHistoryVersion(ctx, 'global-profile', v1.revision).content).toBe(v1.content)
    expect(readMemoryHistoryVersion(ctx, 'global-profile', v2.revision).content).toBe(v2.content)

    const restored = restoreMemoryVersion(ctx, 'global-profile', v1.revision, v2.revision)
    expect(restored.content).toBe(v1.content)
    expect(readMemoryFile(path).content).toBe(v1.content)
    // 恢复本身也写一版历史，被覆盖的内容仍可找回。
    expect(readMemoryHistoryVersion(ctx, 'global-profile', v2.revision).content).toBe(v2.content)
  })

  test('恢复时版本标识与并发校验', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const path = memoryPaths(ctx).profile
    const first = readMemoryFile(path)
    const v1 = updateMemory(ctx, 'global-profile', first.revision, '# 全局用户画像\n\n- 旧事实\n', '第一版')
    const v2 = updateMemory(ctx, 'global-profile', v1.revision, '# 全局用户画像\n\n- 新事实\n', '第二版')

    expect(() => readMemoryHistoryVersion(ctx, 'global-profile', 'bad-revision')).toThrow('历史版本标识无效')
    expect(() =>
      readMemoryHistoryVersion(ctx, 'global-profile', 'a'.repeat(64)),
    ).toThrow('该历史版本不存在或已被清理')
    expect(() => restoreMemoryVersion(ctx, 'global-profile', v1.revision, v1.revision)).toThrow(
      '记忆已被其他会话修改，请刷新后再恢复',
    )
    expect(readMemoryFile(path).content).toBe(v2.content)
  })
})
