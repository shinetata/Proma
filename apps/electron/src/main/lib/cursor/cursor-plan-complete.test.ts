import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage } from '@proma/shared'
import {
  extractCreatePlanFromMessages,
  persistPlanMarkdown,
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

  test('persistPlanMarkdown 写入计划文件', () => {
    const artifact = persistPlanMarkdown(cwd, '# Hello', 'Test Plan')
    expect(artifact.planPath).toContain('.context/plan/Test-Plan.md')
  })
})
