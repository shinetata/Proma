import { describe, expect, test } from 'bun:test'
import type { SDKMessage, TurnChangesSummary } from '@proma/shared'
import {
  buildTurnFileNameMap,
  collectEstimatedChanges,
  countLines,
  estimateChangeStats,
  extensionOf,
  isDirectPreviewFile,
  mergeTurnChanges,
  stripBasePathPrefix,
} from './turn-change-files'

/** 构造一次成功的工具调用：assistant tool_use + user tool_result。 */
function toolTurn(
  name: string,
  input: Record<string, unknown>,
  options: { id?: string; failed?: boolean; sourceCwd?: string } = {},
): SDKMessage[] {
  const id = options.id ?? `tool-${name}`
  return [
    {
      type: 'assistant',
      uuid: `assistant-${id}`,
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id, name, input }] },
      ...(options.sourceCwd ? { _sourceCwd: options.sourceCwd } : {}),
    } as unknown as SDKMessage,
    {
      type: 'user',
      uuid: `user-${id}`,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content: 'ok',
          ...(options.failed ? { is_error: true } : {}),
        }],
      },
    } as unknown as SDKMessage,
  ]
}

describe('turn-change-files 纯逻辑', () => {
  test('countLines 忽略结尾换行', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\nb\n')).toBe(2)
  })

  test('estimateChangeStats 按工具类型估算增删', () => {
    expect(estimateChangeStats('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' }))
      .toEqual({ added: 3, deleted: 2 })
    expect(estimateChangeStats('Write', { content: 'x\ny\n' })).toEqual({ added: 2, deleted: 0 })
    expect(estimateChangeStats('MultiEdit', {
      edits: [
        { old_string: 'a', new_string: 'a\nb' },
        { old_string: 'c\nd', new_string: 'c' },
      ],
    })).toEqual({ added: 3, deleted: 3 })
    expect(estimateChangeStats('Edit', {})).toBeNull()
  })

  test('collectEstimatedChanges 只统计成功调用并按文件累加', () => {
    const messages = [
      ...toolTurn('Edit', { file_path: '/repo/a.ts', old_string: 'one', new_string: 'one\ntwo' }, { id: 'a1' }),
      ...toolTurn('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'x\ny' }, { id: 'a2' }),
      ...toolTurn('Write', { file_path: '/repo/b.ts', content: 'l1\nl2\n' }, { id: 'b1' }),
      ...toolTurn('Edit', { file_path: '/repo/c.ts', old_string: 'q', new_string: 'r' }, { id: 'c1', failed: true }),
    ]

    const changes = collectEstimatedChanges(messages)
    expect(changes.map((change) => change.path)).toEqual(['/repo/a.ts', '/repo/b.ts'])

    const a = changes.find((change) => change.path === '/repo/a.ts')
    expect(a?.added).toBe(4)
    expect(a?.deleted).toBe(2)
    expect(a?.name).toBe('a.ts')

    const b = changes.find((change) => change.path === '/repo/b.ts')
    expect(b?.added).toBe(2)
    expect(b?.deleted).toBe(0)
  })

  test('相对路径按消息的 _sourceCwd 补全', () => {
    const messages = toolTurn('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, { sourceCwd: '/repo' })
    expect(collectEstimatedChanges(messages)[0]?.path).toBe('/repo/src/a.ts')
  })

  test('stripBasePathPrefix 取最长基准前缀', () => {
    expect(stripBasePathPrefix('/a/b/c/d.ts', ['/a', '/a/b'])).toBe('c/d.ts')
    expect(stripBasePathPrefix('/a/bc/d.ts', ['/a/b'])).toBe('/a/bc/d.ts')
    expect(stripBasePathPrefix('/a/b/c/d.ts', [])).toBe('/a/b/c/d.ts')
    expect(stripBasePathPrefix('/a/b/', ['/a/b'])).toBe('')
  })

  test('mergeTurnChanges 优先使用录制结果', () => {
    const summary: TurnChangesSummary = {
      key: 'turn-1',
      cwd: '/repo',
      files: [
        { path: '/repo/src/a.ts', display: 'src/a.ts', added: 4, deleted: 2 },
        { path: '/repo/logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
      ],
      total: 2,
      added: 4,
      deleted: 2,
    }
    const view = mergeTurnChanges(summary, [], ['/repo'])
    expect(view.fromRecorder).toBe(true)
    expect(view.files[0]).toMatchObject({ name: 'a.ts', display: 'src/a.ts', added: 4, deleted: 2 })
    expect(view.files[1]?.binary).toBe(true)
    expect(view.total).toBe(2)
  })

  test('录制结果里的 ../.. 展示路径优先进用 basePaths 裁剪', () => {
    const summary: TurnChangesSummary = {
      key: 'turn-2',
      cwd: '/Users/me/.proma/agent-workspaces/demo/session',
      files: [
        { path: '/Users/me/GitHub/Proma/src/a.ts', display: '../../../../GitHub/Proma/src/a.ts', added: 1, deleted: 0 },
      ],
      total: 1,
      added: 1,
      deleted: 0,
    }
    const view = mergeTurnChanges(summary, [], ['/Users/me/GitHub/Proma'])
    expect(view.files[0]?.display).toBe('src/a.ts')
  })

  test('没有录制结果时退回估算并标记 fromRecorder=false', () => {
    const messages = toolTurn('Write', { file_path: '/repo/new.ts', content: 'a\nb\n' })
    const view = mergeTurnChanges(null, messages, ['/repo'])
    expect(view.fromRecorder).toBe(false)
    expect(view.files).toHaveLength(1)
    expect(view.files[0]?.display).toBe('new.ts')
    expect(view.added).toBe(2)
  })

  test('buildTurnFileNameMap 纳入 Read 与 turn_changes 文件', () => {
    const messages = [
      ...toolTurn('Read', { file_path: '/repo/docs/spec.md' }, { id: 'r1' }),
      ...toolTurn('Edit', { file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' }, { id: 'e1' }),
    ]
    const inputMessage = {
      type: 'user',
      uuid: 'turn-1',
      parent_tool_use_id: null,
      message: { content: [] },
      turn_changes: {
        key: 'turn-1',
        cwd: '/repo',
        files: [{ path: '/repo/added.ts', display: 'added.ts', added: 1, deleted: 0 }],
        total: 1,
        added: 1,
        deleted: 0,
      },
    } as unknown as Parameters<typeof buildTurnFileNameMap>[1]

    const map = buildTurnFileNameMap(messages, inputMessage)
    expect(map.get('spec.md')).toBe('/repo/docs/spec.md')
    expect(map.get('b.ts')).toBe('/repo/src/b.ts')
    expect(map.get('added.ts')).toBe('/repo/added.ts')
  })

  test('同名不同目录的文件从映射中剔除', () => {
    const messages = [
      ...toolTurn('Edit', { file_path: '/repo/a/index.ts', old_string: 'a', new_string: 'b' }, { id: 'x1' }),
      ...toolTurn('Edit', { file_path: '/repo/b/index.ts', old_string: 'a', new_string: 'b' }, { id: 'x2' }),
    ]
    expect(buildTurnFileNameMap(messages).has('index.ts')).toBe(false)
  })

  test('isDirectPreviewFile 只认预览面板能渲染的类型', () => {
    expect(isDirectPreviewFile('/repo/logo.PNG')).toBe(true)
    expect(isDirectPreviewFile('/repo/spec.pdf')).toBe(true)
    expect(isDirectPreviewFile('/repo/page.html')).toBe(true)
    expect(isDirectPreviewFile('/repo/report.docx')).toBe(true)
    expect(isDirectPreviewFile('/repo/src/a.ts')).toBe(false)
    expect(isDirectPreviewFile('/repo/noext')).toBe(false)
  })

  test('extensionOf 忽略查询串与大小写', () => {
    expect(extensionOf('/repo/a.TS?x=1')).toBe('.ts')
    expect(extensionOf('/repo/noext')).toBe('')
  })
})
