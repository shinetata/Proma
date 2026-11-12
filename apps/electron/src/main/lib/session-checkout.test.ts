import { describe, expect, test } from 'bun:test'
import {
  MAX_CHECKOUT_HISTORY,
  appendCheckoutEntry,
  checkoutFromActiveWorktree,
  defaultCheckout,
  isCurrentCheckout,
  resolveSessionCheckout,
} from './session-checkout'
import type { AgentActiveWorktree, SessionCheckoutEntry } from '@proma/shared'

const activeWorktree: AgentActiveWorktree = {
  path: '/repo/worktrees/feature',
  mainRepoRoot: '/repo',
  branch: 'feature/x',
  selectedAt: 1000,
}

function worktreeEntry(path: string, since = 1): SessionCheckoutEntry {
  return { kind: 'worktree', path, mainRepoRoot: '/repo', branch: 'feature/x', since }
}

describe('checkoutFromActiveWorktree', () => {
  test('把旧字段转成 worktree 记录，并按需带上基准提交', () => {
    expect(checkoutFromActiveWorktree(activeWorktree)).toEqual({
      kind: 'worktree',
      path: '/repo/worktrees/feature',
      mainRepoRoot: '/repo',
      branch: 'feature/x',
      since: 1000,
    })
    expect(checkoutFromActiveWorktree(activeWorktree, 'abc1234').baseCommit).toBe('abc1234')
  })
})

describe('defaultCheckout', () => {
  test('按 cwd 模式取项目目录或会话工作台', () => {
    expect(defaultCheckout('project', '/project', '/workbench')).toEqual({ kind: 'project', path: '/project', since: 0 })
    expect(defaultCheckout('session', '/project', '/workbench')).toEqual({ kind: 'workbench', path: '/workbench', since: 0 })
  })

  test('目标目录缺失时返回 null', () => {
    expect(defaultCheckout('project', undefined, '/workbench')).toBeNull()
    expect(defaultCheckout('session', '/project', undefined)).toBeNull()
  })
})

describe('resolveSessionCheckout', () => {
  const existing = new Set(['/repo/worktrees/feature', '/repo', '/workbench'])

  test('取历史末尾仍存在的目录，不标记回退', () => {
    const history = [{ kind: 'project' as const, path: '/repo', since: 1 }, worktreeEntry('/repo/worktrees/feature', 2)]
    const resolved = resolveSessionCheckout({
      history,
      agentCwdMode: 'session',
      projectPath: '/repo',
      workbenchPath: '/workbench',
      isDirectory: (path) => existing.has(path),
    })
    expect(resolved?.path).toBe('/repo/worktrees/feature')
    expect(resolved?.fellBack).toBe(false)
  })

  test('末尾目录已删除时向前回退，并标记 fellBack', () => {
    const history = [
      { kind: 'project' as const, path: '/repo', since: 1 },
      worktreeEntry('/repo/worktrees/gone', 2),
    ]
    const resolved = resolveSessionCheckout({
      history,
      agentCwdMode: 'session',
      projectPath: '/repo',
      workbenchPath: '/workbench',
      isDirectory: (path) => existing.has(path),
    })
    expect(resolved?.path).toBe('/repo')
    expect(resolved?.fellBack).toBe(true)
  })

  test('历史为空时使用 activeWorktree', () => {
    const resolved = resolveSessionCheckout({
      activeWorktree,
      agentCwdMode: 'session',
      workbenchPath: '/workbench',
      isDirectory: (path) => existing.has(path),
    })
    expect(resolved?.path).toBe('/repo/worktrees/feature')
    expect(resolved?.fellBack).toBe(false)
  })

  test('历史与 activeWorktree 都失效时退到默认目录并标记回退', () => {
    const resolved = resolveSessionCheckout({
      history: [worktreeEntry('/repo/worktrees/gone')],
      activeWorktree,
      agentCwdMode: 'session',
      workbenchPath: '/workbench',
      isDirectory: (path) => existing.has(path),
    })
    expect(resolved).toMatchObject({ kind: 'workbench', path: '/workbench', fellBack: true })
  })

  test('没有任何可用目录时返回 null', () => {
    const resolved = resolveSessionCheckout({
      history: [worktreeEntry('/repo/worktrees/gone')],
      agentCwdMode: 'project',
      isDirectory: () => false,
    })
    expect(resolved).toBeNull()
  })
})

describe('appendCheckoutEntry', () => {
  test('同路径先去重再追加到末尾', () => {
    const history = [{ kind: 'project' as const, path: '/repo', since: 1 }, worktreeEntry('/repo/worktrees/a', 2)]
    const next = appendCheckoutEntry(history, { kind: 'project', path: '/repo', since: 3 })
    expect(next.map((item) => item.path)).toEqual(['/repo/worktrees/a', '/repo'])
    expect(next[1]?.since).toBe(3)
  })

  test('超过上限时丢弃最早条目', () => {
    let history: SessionCheckoutEntry[] = []
    for (let index = 0; index < MAX_CHECKOUT_HISTORY + 5; index += 1) {
      history = appendCheckoutEntry(history, { kind: 'worktree', path: `/w/${index}`, since: index })
    }
    expect(history).toHaveLength(MAX_CHECKOUT_HISTORY)
    expect(history[0]?.path).toBe('/w/5')
    expect(history[history.length - 1]?.path).toBe(`/w/${MAX_CHECKOUT_HISTORY + 4}`)
  })
})

describe('isCurrentCheckout', () => {
  test('只认最后一条', () => {
    const history = [{ kind: 'project' as const, path: '/repo', since: 1 }, worktreeEntry('/repo/worktrees/a', 2)]
    expect(isCurrentCheckout(history, '/repo/worktrees/a')).toBe(true)
    expect(isCurrentCheckout(history, '/repo')).toBe(false)
    expect(isCurrentCheckout(undefined, '/repo')).toBe(false)
  })
})