import { describe, expect, test } from 'bun:test'
import { hasFileChangesForRun, hasUnviewedRunChanges, shouldAutoRevealChanges } from './agent-change-reveal'
import type { SessionFileChange } from './session-file-changes'

function change(path: string, runId: string): SessionFileChange {
  return { path, kind: 'edited', runId, updatedAt: 0 }
}

describe('hasFileChangesForRun', () => {
  test('Git 侧有未查看改动即视为本轮有改动', () => {
    expect(hasFileChangesForRun({ currentRunId: 'run-1', gitChangesUnseen: true })).toBe(true)
  })

  test('非 Git 写入记录按 runId 归属本轮', () => {
    expect(hasFileChangesForRun({
      currentRunId: 'run-2',
      nonGitChanges: [change('a.md', 'run-1'), change('b.md', 'run-2')],
    })).toBe(true)
  })

  test('只有其它轮次的写入记录不算本轮改动', () => {
    expect(hasFileChangesForRun({
      currentRunId: 'run-3',
      nonGitChanges: [change('a.md', 'run-1')],
    })).toBe(false)
  })

  test('没有 run ID 时不会把历史写入误判为当前轮', () => {
    expect(hasFileChangesForRun({
      nonGitChanges: [change('a.md', 'run-1')],
    })).toBe(false)
  })
})

describe('hasUnviewedRunChanges', () => {
  test('用户已看过同一轮时不再提示', () => {
    expect(hasUnviewedRunChanges({
      currentRunId: 'run-1',
      viewedRunId: 'run-1',
      gitChangesUnseen: true,
    })).toBe(false)
  })

  test('用户看过的是上一轮时仍算未查看', () => {
    expect(hasUnviewedRunChanges({
      currentRunId: 'run-2',
      viewedRunId: 'run-1',
      gitChangesUnseen: true,
    })).toBe(true)
  })

  test('从未查看过且有本轮改动时算未查看', () => {
    expect(hasUnviewedRunChanges({
      currentRunId: 'run-1',
      nonGitChanges: [change('a.md', 'run-1')],
    })).toBe(true)
  })

  test('本轮没有改动时不产生未查看提示', () => {
    expect(hasUnviewedRunChanges({ currentRunId: 'run-1' })).toBe(false)
  })
})

describe('shouldAutoRevealChanges', () => {
  test('没有未查看改动时始终不展开', () => {
    expect(shouldAutoRevealChanges({ hasUnviewedChanges: false, sidePanelOpen: false, preservesUserFocus: false })).toBe(false)
    expect(shouldAutoRevealChanges({ hasUnviewedChanges: false, sidePanelOpen: true, preservesUserFocus: false })).toBe(false)
  })

  test('右侧关闭时展开改动区', () => {
    expect(shouldAutoRevealChanges({ hasUnviewedChanges: true, sidePanelOpen: false, preservesUserFocus: false })).toBe(true)
  })

  test('右侧停在文件等页签时切到改动区', () => {
    expect(shouldAutoRevealChanges({ hasUnviewedChanges: true, sidePanelOpen: true, preservesUserFocus: false })).toBe(true)
  })

  test('用户正在读 Skills / 记忆时保留焦点', () => {
    expect(shouldAutoRevealChanges({ hasUnviewedChanges: true, sidePanelOpen: true, preservesUserFocus: true })).toBe(false)
  })
})