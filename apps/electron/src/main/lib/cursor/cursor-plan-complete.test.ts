import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage } from '@proma/shared'
import {
  findLatestPlanFile,
  buildSyntheticExitPlanInput,
  extractCreatePlanFromMessages,
  persistPlanMarkdown,
  resolveCursorPlanArtifact,
} from './cursor-plan-complete'

describe('cursor-plan-complete', () => {
  let cwd: string

  beforeEach(() => {
    cwd = join(tmpdir(), `proma-plan-test-${Date.now()}`)
    mkdirSync(join(cwd, '.context', 'plan'), { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  test('findLatestPlanFile 返回最新 mtime 的 plan 文件', () => {
    const older = join(cwd, '.context', 'plan', 'old.md')
    const newer = join(cwd, '.context', 'plan', 'new.md')
    writeFileSync(older, '# Old plan')
    writeFileSync(newer, '# New plan content')
    const now = Date.now() / 1000
    utimesSync(older, now - 100, now - 100)
    utimesSync(newer, now, now)

    const artifact = findLatestPlanFile(cwd)
    expect(artifact?.planPath).toBe(newer)
    expect(artifact?.excerpt).toContain('New plan')
  })

  test('extractCreatePlanFromMessages 从 CreatePlan 工具提取 plan 正文', () => {
    const messages = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 't1',
          name: 'CreatePlan',
          input: { plan: '# My Plan\n\nStep 1', name: 'My Plan' },
        }],
      },
    }] as unknown as SDKMessage[]

    expect(extractCreatePlanFromMessages(messages)).toEqual({
      plan: '# My Plan\n\nStep 1',
      name: 'My Plan',
      overview: undefined,
    })
  })

  test('resolveCursorPlanArtifact 将 CreatePlan 落盘到 .context/plan/', () => {
    const messages = [{
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 't1',
          name: 'CreatePlan',
          input: { plan: '# Synced Plan', name: 'Synced Plan' },
        }],
      },
    }] as unknown as SDKMessage[]

    const artifact = resolveCursorPlanArtifact(cwd, messages)
    expect(artifact?.planPath).toContain('.context/plan/Synced-Plan.md')
    expect(artifact?.excerpt).toContain('Synced Plan')
  })

  test('persistPlanMarkdown 写入计划文件', () => {
    const artifact = persistPlanMarkdown(cwd, '# Hello', 'Test Plan')
    expect(artifact.planPath).toContain('.context/plan/Test-Plan.md')
  })

  test('buildSyntheticExitPlanInput 包含 planPath 与摘要', () => {
    const artifact = {
      planPath: '/tmp/.context/plan/foo.md',
      excerpt: '## Step 1',
      mtimeMs: Date.now(),
    }
    const input = buildSyntheticExitPlanInput(artifact, 'summary text')
    expect(input.source).toBe('cursor_synthetic')
    expect(input.planPath).toBe(artifact.planPath)
    expect(input.planSummary).toBe('summary text')
  })
})
