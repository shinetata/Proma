import { describe, expect, test } from 'bun:test'
import { inferWorktreeRelativePath, joinUnderRoot, rebaseStaleWorktreePath } from './stale-worktree-path-rebase'

describe('inferWorktreeRelativePath', () => {
  test('优先命中更长的旧根', () => {
    const inferred = inferWorktreeRelativePath('/repo/worktrees/feature/src/a.ts', ['/repo', '/repo/worktrees/feature'])
    expect(inferred).toEqual({ relPath: 'src/a.ts', via: 'stale-root', matchedRoot: '/repo/worktrees/feature' })
  })

  test('没有旧根时按 worktrees/<name>/ 段推断', () => {
    const inferred = inferWorktreeRelativePath('/Users/dev/proma/worktrees/feat/src/a.ts')
    expect(inferred).toEqual({ relPath: 'src/a.ts', via: 'worktrees-segment' })
  })

  test('也识别 .worktrees 目录', () => {
    expect(inferWorktreeRelativePath('/repo/.worktrees/feat/docs/plan.md')?.relPath).toBe('docs/plan.md')
  })

  test('相对路径、空路径与 NUL 一律拒绝', () => {
    expect(inferWorktreeRelativePath('src/a.ts')).toBeNull()
    expect(inferWorktreeRelativePath('')).toBeNull()
    expect(inferWorktreeRelativePath('/repo/a\0.ts')).toBeNull()
  })

  test('路径恰好等于旧根时无法得到相对路径', () => {
    expect(inferWorktreeRelativePath('/repo/worktrees/feature', ['/repo/worktrees/feature'])).toBeNull()
  })

  test('worktrees 段后没有文件部分时返回 null', () => {
    // `worktrees/<name>` 之后没有剩余段，无法得到可用的相对路径
    expect(inferWorktreeRelativePath('/repo/worktrees/feature')).toBeNull()
    expect(inferWorktreeRelativePath('/repo/worktrees')).toBeNull()
    expect(inferWorktreeRelativePath('/repo/worktrees/feature/src/a.ts')?.relPath).toBe('src/a.ts')
  })
})

describe('joinUnderRoot', () => {
  test('按根的斜杠风格拼接，不重复分隔符', () => {
    expect(joinUnderRoot('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinUnderRoot('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(joinUnderRoot('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts')
  })
})

describe('rebaseStaleWorktreePath', () => {
  const stalePath = '/old/worktrees/feature/src/a.ts'
  const staleRoots = ['/old/worktrees/feature']

  test('在根下找到同名文件时重定位', () => {
    const hit = rebaseStaleWorktreePath({
      stalePath,
      staleRoots,
      roots: ['/new/feature', '/other'],
      isFile: (path) => path === '/new/feature/src/a.ts',
    })
    expect(hit).toEqual({ path: '/new/feature/src/a.ts', root: '/new/feature', relPath: 'src/a.ts', via: 'stale-root' })
  })

  test('没有同名文件时返回 null', () => {
    expect(rebaseStaleWorktreePath({ stalePath, staleRoots, roots: ['/new/feature'], isFile: () => false })).toBeNull()
  })

  test('推断不出相对路径时返回 null', () => {
    expect(rebaseStaleWorktreePath({
      stalePath: '/tmp/plain.ts',
      roots: ['/new'],
      isFile: () => true,
    })).toBeNull()
  })

  test('拒绝越出目标根的相对路径', () => {
    const hit = rebaseStaleWorktreePath({
      // 旧根推断出的相对路径含 ..，必须被拦掉
      stalePath: '/old/../etc/passwd',
      staleRoots: ['/'],
      roots: ['/new'],
      isFile: () => true,
    })
    expect(hit).toBeNull()
  })
})