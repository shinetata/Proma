import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPath,
  compareDisplay,
  displayPathOf,
  isInside,
  isTemporaryPath,
  resolveToolMutationPath,
  temporaryRoots,
  toPosix,
} from './paths'

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'proma-paths-test-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('turn-changes paths', () => {
  test('isInside 只认可 root 自身与后代', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.ts')).toBe(true)
    expect(isInside('/a/b', '/a/bc/d.ts')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })

  test('toPosix 在 Windows 分隔符下也产出正斜杠路径', () => {
    expect(toPosix('/a/b/c')).toBe('/a/b/c')
  })

  test('canonicalPath 解析已存在目录的符号链接', async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, 'real')
      await mkdir(real)
      await writeFile(join(real, 'file.txt'), 'x')
      const canonical = await canonicalPath(join(real, 'file.txt'))
      expect(canonical).toContain('real/file.txt')
    })
  })

  test('canonicalPath 保留不存在的尾段', async () => {
    await withTempDir(async (dir) => {
      const canonical = await canonicalPath(join(dir, 'missing', 'deep', 'a.ts'))
      expect(canonical.endsWith('/missing/deep/a.ts')).toBe(true)
    })
  })

  test('temporaryRoots 同时包含 /tmp 与其 realpath', async () => {
    const roots = await temporaryRoots()
    expect(roots).toContain('/tmp')
    expect(roots.length).toBeGreaterThanOrEqual(2)
  })

  test('isTemporaryPath 命中临时目录，未命中工作目录', async () => {
    const roots = await temporaryRoots()
    expect(isTemporaryPath('/tmp/verify.html', roots)).toBe(true)
    expect(isTemporaryPath('/Users/someone/project/a.ts', roots)).toBe(false)
  })

  test('displayPathOf 优先相对 cwd，其次仓库根，再次 home，最后绝对路径', () => {
    const home = homedir()
    expect(displayPathOf('/repo/work/src/a.ts', '/repo/work', '/repo', home)).toBe('src/a.ts')
    expect(displayPathOf('/repo/docs/b.md', '/repo/work', '/repo', home)).toBe('../docs/b.md')
    expect(displayPathOf(`${home}/notes/c.md`, '/repo/work', '/repo', home)).toBe('~/notes/c.md')
    expect(displayPathOf('/opt/other/d.ts', '/repo/work', '/repo', home)).toBe('/opt/other/d.ts')
  })

  test('compareDisplay 按展示路径升序', () => {
    const files = [{ display: 'b.ts' }, { display: 'a.ts' }, { display: 'c/d.ts' }]
    expect([...files].sort(compareDisplay).map((file) => file.display)).toEqual(['a.ts', 'b.ts', 'c/d.ts'])
  })

  test('resolveToolMutationPath 处理空白、@ 前缀、~ 与相对路径', () => {
    expect(resolveToolMutationPath(' @src/a.ts ', '/work')).toBe('/work/src/a.ts')
    expect(resolveToolMutationPath('~/x/y.ts', '/work')).toBe(join(homedir(), 'x/y.ts'))
    expect(resolveToolMutationPath('file:///tmp/a.txt', '/work')).toBe('/tmp/a.txt')
    expect(resolveToolMutationPath('\u00A0sub/b.ts', '/work')).toBe('/work/sub/b.ts')
  })
})
