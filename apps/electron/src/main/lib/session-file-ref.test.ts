import { describe, expect, test } from 'bun:test'
import { normalizeSessionFileRef, resolveSessionFileRefPath, toSessionFileRefRelPath } from './session-file-ref'

describe('normalizeSessionFileRef', () => {
  test('会话相对引用按 posix 路径归一化', () => {
    expect(normalizeSessionFileRef({ sessionId: 's1', path: './src/a.ts' }, 's1')).toEqual({
      sessionId: 's1',
      path: 'src/a.ts',
      kind: 'session',
    })
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'src\\a.ts' }, 's1')?.path).toBe('src/a.ts')
  })

  test('保留正整数的行列号，忽略非法值', () => {
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'a.ts', line: 12, column: 3 }, 's1')).toMatchObject({ line: 12, column: 3 })
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'a.ts', line: 0, column: -1 }, 's1')).toEqual({
      sessionId: 's1',
      path: 'a.ts',
      kind: 'session',
    })
  })

  test('sessionId 不匹配或缺失时整条丢弃', () => {
    expect(normalizeSessionFileRef({ sessionId: 'other', path: 'a.ts' }, 's1')).toBeNull()
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'a.ts' })).toBeNull()
  })

  test('拒绝越界与非法相对路径', () => {
    expect(normalizeSessionFileRef({ sessionId: 's1', path: '../secret' }, 's1')).toBeNull()
    expect(normalizeSessionFileRef({ sessionId: 's1', path: '/etc/passwd' }, 's1')).toBeNull()
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'C:/Windows' }, 's1')).toBeNull()
    expect(normalizeSessionFileRef({ sessionId: 's1', path: '' }, 's1')).toBeNull()
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'a\0b' }, 's1')).toBeNull()
  })

  test('absolute 类型必须是绝对路径', () => {
    expect(normalizeSessionFileRef({ sessionId: 's1', path: '/repo/a.ts', kind: 'absolute' }, 's1')).toMatchObject({ kind: 'absolute' })
    expect(normalizeSessionFileRef({ sessionId: 's1', path: 'repo/a.ts', kind: 'absolute' }, 's1')).toBeNull()
  })
})

describe('resolveSessionFileRefPath', () => {
  test('相对检出根拼接，absolute 原样返回', () => {
    const ref = normalizeSessionFileRef({ sessionId: 's1', path: 'src/a.ts' }, 's1')!
    expect(resolveSessionFileRefPath(ref, '/repo/worktrees/feat')).toBe('/repo/worktrees/feat/src/a.ts')
    expect(resolveSessionFileRefPath(ref, '/repo/worktrees/feat/')).toBe('/repo/worktrees/feat/src/a.ts')

    const absolute = normalizeSessionFileRef({ sessionId: 's1', path: '/repo/a.ts', kind: 'absolute' }, 's1')!
    expect(resolveSessionFileRefPath(absolute, '/ignored')).toBe('/repo/a.ts')
  })
})

describe('toSessionFileRefRelPath', () => {
  test('根内文件得到 posix 相对路径', () => {
    expect(toSessionFileRefRelPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  })

  test('根外文件、根自身与缺失参数返回 null', () => {
    expect(toSessionFileRefRelPath('/other/a.ts', '/repo')).toBeNull()
    expect(toSessionFileRefRelPath('/repo', '/repo')).toBeNull()
    expect(toSessionFileRefRelPath('', '/repo')).toBeNull()
    expect(toSessionFileRefRelPath('/repo/a.ts', '')).toBeNull()
  })
})