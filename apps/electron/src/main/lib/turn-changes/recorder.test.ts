/**
 * TurnRecorder 集成测试
 *
 * 用真实临时目录与真实 git 验证两条主路径：
 * - 非 Git 目录：完全依赖写前/轮末副本比较
 * - Git 仓库：依赖前后树 diff（覆盖修改与新增）
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnRecorder } from './recorder'

const cleanupDirs: string[] = []
const recorders: TurnRecorder[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

function makeRecorder(): TurnRecorder {
  const recorder = new TurnRecorder({ warn: () => undefined })
  recorders.push(recorder)
  return recorder
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Proma Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
}

afterEach(async () => {
  for (const recorder of recorders.splice(0)) {
    await recorder.dispose()
  }
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('TurnRecorder', () => {
  test('非 Git 目录：按副本比较得出改动行数', async () => {
    const cwd = await makeTempDir('proma-turn-changes-plain-')
    const target = join(cwd, 'note.md')
    await writeFile(target, 'a\nb\nc\n')

    const recorder = makeRecorder()
    recorder.start('turn-1', cwd)
    await recorder.preExecuteTool('Write', { file_path: target }, cwd)
    await writeFile(target, 'a\nB\nc\nd\n')

    const summary = await recorder.finish('turn-1')
    expect(summary).not.toBeNull()
    expect(summary?.key).toBe('turn-1')
    expect(summary?.files).toHaveLength(1)
    expect(summary?.files[0]?.display).toBe('note.md')
    expect(summary?.files[0]?.added).toBe(2)
    expect(summary?.files[0]?.deleted).toBe(1)
    expect(summary?.added).toBe(2)
    expect(summary?.deleted).toBe(1)

    const diff = await recorder.getFileDiff('turn-1', target)
    expect(diff?.kind).toBe('text')
    if (diff?.kind === 'text') {
      expect(diff.before).toBe(true)
      expect(diff.after).toBe(true)
      expect(diff.hunks.flatMap((hunk) => hunk.lines)).toContain('+B')
    }
  })

  test('非 Git 目录：改动后又删除的临时文件不进入摘要', async () => {
    const cwd = await makeTempDir('proma-turn-changes-tmp-')
    const cwdFile = join(cwd, 'kept.ts')
    await writeFile(cwdFile, 'export const a = 1\n')

    const outsideTmp = join(tmpdir(), `proma-turn-changes-outside-${Date.now()}.ts`)
    await writeFile(outsideTmp, 'temp\n')

    const recorder = makeRecorder()
    recorder.start('turn-2', cwd)
    await recorder.preExecuteTool('Write', { file_path: cwdFile }, cwd)
    await recorder.preExecuteTool('Write', { file_path: outsideTmp }, cwd)
    await writeFile(cwdFile, 'export const a = 2\n')
    await writeFile(outsideTmp, 'temp changed\n')

    const summary = await recorder.finish('turn-2')
    expect(summary?.files.map((file) => file.display)).toEqual(['kept.ts'])
  })

  test('Git 仓库：修改与新增都进入摘要', async () => {
    const repo = await makeTempDir('proma-turn-changes-git-')
    git(repo, 'init', '-b', 'main')
    await writeFile(join(repo, 'existing.ts'), 'line1\nline2\n')
    git(repo, 'add', '--all')
    git(repo, 'commit', '-m', 'init')

    const recorder = makeRecorder()
    recorder.start('turn-3', repo)

    // 首次工具调用前必须等基线快照完成，否则前后树不可比
    await recorder.preExecuteTool('Edit', { file_path: join(repo, 'existing.ts') }, repo)
    await writeFile(join(repo, 'existing.ts'), 'line1\nline2\nline3\n')
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src', 'added.ts'), 'export const x = 1\n')

    const summary = await recorder.finish('turn-3')
    const displays = summary?.files.map((file) => file.display).sort()
    expect(displays).toEqual(['existing.ts', 'src/added.ts'])

    const added = summary?.files.find((file) => file.display === 'src/added.ts')
    expect(added?.added).toBe(1)
    expect(added?.deleted).toBe(0)

    const modified = summary?.files.find((file) => file.display === 'existing.ts')
    expect(modified?.added).toBe(1)
    expect(modified?.deleted).toBe(0)

    const diff = await recorder.getFileDiff('turn-3', join(repo, 'src', 'added.ts'))
    expect(diff?.kind).toBe('text')
    if (diff?.kind === 'text') {
      expect(diff.before).toBe(false)
      expect(diff.after).toBe(true)
    }
  })

  test('没有工具活动时不产生摘要', async () => {
    const cwd = await makeTempDir('proma-turn-changes-idle-')
    const recorder = makeRecorder()
    recorder.start('turn-4', cwd)
    expect(await recorder.finish('turn-4')).toBeNull()
    expect(recorder.getSummary('turn-4')).toBeNull()
  })
})
