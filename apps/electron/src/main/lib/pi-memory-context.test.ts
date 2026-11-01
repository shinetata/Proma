/**
 * 每轮记忆注入、项目能力首次维护与项目地图复查。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  PROFILE_MAX_CHARS,
  ensureMemoryFiles,
  memoryPaths,
  readMemoryFile,
  updateMemory,
  type AgentMemoryContext,
} from './agent-memory'
import { buildLiveMemoryContext, refreshMemorySystemMessages } from './adapters/pi-memory-context'
import { maintainProjectInstructions } from './project-instruction-maintenance'
import { readInstructionReadyRecord } from './project-instruction-state'
import { completeProjectMapReview, inspectProjectMap, readProjectMapReviewState } from './project-map-review'

function createContext(): AgentMemoryContext {
  const root = mkdtempSync(join(tmpdir(), 'proma-context-'))
  const workspaceRoot = join(root, 'agent-workspaces', 'demo')
  mkdirSync(workspaceRoot, { recursive: true })
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

describe('每轮记忆注入', () => {
  test('注入画像、索引与偏好，并附带 revision 与复查状态', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const context = buildLiveMemoryContext({ ctx })

    expect(context).toContain('## 当前记忆（每次模型请求前重新读取）')
    expect(context).toContain(`<memory_file path="${memoryPaths(ctx).profile}"`)
    expect(context).toContain('review_due="false"')
    expect(context).toContain('暂无已确认的跨项目偏好')
  })

  test('画像超预算时截断并提示启动后台整理', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    // 外部编辑可以绕过写入预算，运行时按注入预算截断并提示后台整理。
    writeFileSync(memoryPaths(ctx).profile, `# 全局用户画像\n\n${'x'.repeat(PROFILE_MAX_CHARS + 100)}\n`)

    const context = buildLiveMemoryContext({ ctx })
    expect(context).toContain(`Profile 超过 ${PROFILE_MAX_CHARS} 字符`)
    expect(context).toContain('start_profile_maintenance')
  })

  test('缺少必需文件时给出待建立提示', () => {
    const ctx = createContext()
    const context = buildLiveMemoryContext({ ctx })
    expect(context).toContain('必需记忆待建立')
    expect(context).toContain('首次项目能力维护（本轮自动完成）')
  })

  test('refreshMemorySystemMessages 只保留一个记忆段并可重复执行', () => {
    const ctx = createContext()
    ensureMemoryFiles(ctx)
    const messages = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hi' },
    ] as unknown as AgentMessage[]

    const first = refreshMemorySystemMessages(messages, { ctx })
    const system = first[0] as unknown as { sections?: Record<string, string | null> }
    expect(system.sections?.proma_memory).toContain('当前记忆')

    const second = refreshMemorySystemMessages(first, { ctx })
    const sections = second[0] as unknown as { sections?: Record<string, string | null> }
    expect(Object.keys(sections.sections ?? {}).filter((key) => key === 'proma_memory')).toHaveLength(1)
  })

  test('计划模式不注入写入型维护要求', () => {
    const ctx = createContext()
    ctx.allowInstructionMaintenance = false
    ctx.allowProfileMigration = false
    const context = buildLiveMemoryContext({ ctx })
    expect(context).not.toContain('首次项目能力维护（本轮自动完成）')
  })
})

describe('首次项目能力维护', () => {
  test('自动建立 AGENTS.md、索引与全局画像并记录完成', () => {
    const ctx = createContext()
    const state = maintainProjectInstructions(ctx)
    expect(state.status).toBe('ready')

    const map = readFileSync(join(ctx.projectRoot, 'AGENTS.md'), 'utf8')
    expect(map).toContain('# 项目约定')
    expect(map).toContain('<!-- proma:memory:start -->')
    expect(readFileSync(memoryPaths(ctx).index, 'utf8')).toContain('项目记忆索引')
    expect(readFileSync(memoryPaths(ctx).profile, 'utf8')).toContain('全局用户画像')
    expect(readInstructionReadyRecord(ctx)?.changed).toBe(true)

    const second = maintainProjectInstructions(ctx)
    expect(second.status).toBe('ready')
    expect(second.status === 'ready' && second.changed).toBe(false)
  })

  test('旧外层 AGENTS.md 会被语义迁移并归档', () => {
    const ctx = createContext()
    writeFileSync(join(ctx.workspaceRoot, 'AGENTS.md'), '# 旧规则\n\n- 使用 bun\n')
    const state = maintainProjectInstructions(ctx)
    expect(state.status).toBe('ready')
    expect(readFileSync(join(ctx.projectRoot, 'AGENTS.md'), 'utf8')).toContain('使用 bun')
    expect(readFileSync(join(ctx.projectRoot, 'AGENTS.md'), 'utf8')).toContain('<!-- proma:memory:start -->')
  })

  test('两侧都有不同正文时返回 needs-merge，交由工具语义合并', () => {
    const ctx = createContext()
    writeFileSync(join(ctx.workspaceRoot, 'AGENTS.md'), '# 旧规则\n\n- 使用 bun\n')
    writeFileSync(join(ctx.projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 使用 pnpm\n')
    const state = maintainProjectInstructions(ctx)
    expect(state.status).toBe('needs-merge')
  })
})

describe('项目地图复查', () => {
  test('缺失、过短与已建立三态，以及复查记录只对同一 revision 生效', () => {
    const ctx = createContext()
    expect(inspectProjectMap(ctx.projectRoot).status).toBe('缺失')

    writeFileSync(join(ctx.projectRoot, 'AGENTS.md'), '# 项目约定\n\n- 使用 bun\n')
    const short = inspectProjectMap(ctx.projectRoot)
    expect(short.status).toBe('待完善')

    writeFileSync(join(ctx.projectRoot, 'AGENTS.md'), `# 项目约定\n\n${'- 事实描述\n'.repeat(40)}`)
    const full = inspectProjectMap(ctx.projectRoot)
    expect(full.status).toBe('已存在')

    const state = readProjectMapReviewState(ctx.workspaceRoot, ctx.projectRoot)
    expect(state.reviewDue).toBe(false)

    const record = completeProjectMapReview(ctx.workspaceRoot, ctx.projectRoot, full.revision!, '核验目录与命令')
    expect(record.checkedAt).toBeGreaterThan(0)
    expect(readProjectMapReviewState(ctx.workspaceRoot, ctx.projectRoot).checkedAt).toBe(record.checkedAt)

    writeFileSync(join(ctx.projectRoot, 'AGENTS.md'), `# 项目约定\n\n${'- 新事实\n'.repeat(40)}`)
    expect(readProjectMapReviewState(ctx.workspaceRoot, ctx.projectRoot).checkedAt).toBeUndefined()
  })
})
