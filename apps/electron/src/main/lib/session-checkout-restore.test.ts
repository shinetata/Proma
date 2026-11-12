/**
 * restoreWorktree 的集成测试：用临时目录里的真实 git 仓库验证三种恢复路径。
 * 纯逻辑（isRestorableWorktreeRecord / planWorktreeRestore）单独覆盖，不依赖 git。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRestorableWorktreeRecord, planWorktreeRestore, restoreWorktree } from './session-checkout-restore'

let tempRoot = ''
let repoPath = ''

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Proma Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Proma Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim()
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'proma-restore-'))
  repoPath = join(tempRoot, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(['init', '-b', 'main'], repoPath)
  writeFileSync(join(repoPath, 'README.md'), 'hello\n')
  git(['add', '.'], repoPath)
  git(['commit', '-m', 'init'], repoPath)
})

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

describe('isRestorableWorktreeRecord', () => {
  test('接受正常的绝对路径与分支名', () => {
    expect(isRestorableWorktreeRecord({ path: '/repo/worktrees/a', branch: 'feature/x', baseCommit: 'abc1234' })).toBe(true)
  })

  test('拒绝相对路径、空分支与危险分支名', () => {
    expect(isRestorableWorktreeRecord({ path: 'worktrees/a', branch: 'feature' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: '' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: '-rf' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'a..b' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'a b' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'a~1' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'a: b' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: '/a' })).toBe(false)
  })

  test('基准提交必须是 7-64 位十六进制', () => {
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'b', baseCommit: 'abc12' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'b', baseCommit: 'zzzzzzz' })).toBe(false)
    expect(isRestorableWorktreeRecord({ path: '/repo/a', branch: 'b', baseCommit: 'abcdef0123456' })).toBe(true)
  })
})

describe('planWorktreeRestore', () => {
  const record = { path: '/repo/worktrees/a', branch: 'feature/x' }

  test('分支仍存在时直接检出', () => {
    expect(planWorktreeRestore({ ...record, branchExists: true })).toEqual({ ok: true, branchRecreated: false })
  })

  test('分支已删但有基准提交时重建分支', () => {
    expect(planWorktreeRestore({ ...record, branchExists: false, baseCommit: 'abc1234' }))
      .toEqual({ ok: true, branchRecreated: true })
  })

  test('分支已删且没有基准提交时不可恢复', () => {
    expect(planWorktreeRestore({ ...record, branchExists: false }))
      .toEqual({ ok: false, reason: 'branch-unavailable' })
  })

  test('记录非法时直接拒绝', () => {
    expect(planWorktreeRestore({ path: 'rel', branch: 'feature', branchExists: true }))
      .toEqual({ ok: false, reason: 'invalid-record' })
  })
})

describe('restoreWorktree（真实 git）', () => {
  test('分支还在时按分支重建 worktree', async () => {
    const worktreePath = join(tempRoot, 'worktrees', 'feature-a')
    git(['worktree', 'add', '-b', 'feature/a', worktreePath], repoPath)
    // 模拟目录被删除：先移除 worktree 目录与登记
    rmSync(worktreePath, { recursive: true, force: true })
    git(['worktree', 'prune'], repoPath)

    const result = await restoreWorktree({ path: worktreePath, branch: 'feature/a', repoPath })
    expect(result).toEqual({ restored: true, path: worktreePath, branch: 'feature/a', branchRecreated: false })
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  test('分支已删但记录了基准提交时按提交重建分支', async () => {
    const baseCommit = git(['rev-parse', 'HEAD'], repoPath)
    const worktreePath = join(tempRoot, 'worktrees', 'feature-b')
    git(['worktree', 'add', '-b', 'feature/b', worktreePath], repoPath)
    rmSync(worktreePath, { recursive: true, force: true })
    git(['worktree', 'prune'], repoPath)
    git(['branch', '-D', 'feature/b'], repoPath)

    const result = await restoreWorktree({ path: worktreePath, branch: 'feature/b', baseCommit, repoPath })
    expect(result.branchRecreated).toBe(true)
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  test('分支已删且没有基准提交时报错', async () => {
    const worktreePath = join(tempRoot, 'worktrees', 'feature-c')
    git(['worktree', 'add', '-b', 'feature/c', worktreePath], repoPath)
    rmSync(worktreePath, { recursive: true, force: true })
    git(['worktree', 'prune'], repoPath)
    git(['branch', '-D', 'feature/c'], repoPath)

    await expect(restoreWorktree({ path: worktreePath, branch: 'feature/c', repoPath }))
      .rejects.toThrow('分支 feature/c 已删除且缺少基准提交，无法恢复')
  })

  test('目录仍存在时拒绝恢复', async () => {
    const worktreePath = join(tempRoot, 'worktrees', 'feature-d')
    git(['worktree', 'add', '-b', 'feature/d', worktreePath], repoPath)
    await expect(restoreWorktree({ path: worktreePath, branch: 'feature/d', repoPath }))
      .rejects.toThrow('worktree 目录已存在，无需恢复')
  })

  test('仓库目录不存在时报错', async () => {
    await expect(restoreWorktree({
      path: join(tempRoot, 'gone'),
      branch: 'feature/e',
      repoPath: join(tempRoot, 'missing-repo'),
    })).rejects.toThrow('worktree 所属仓库目录已不存在')
  })
})