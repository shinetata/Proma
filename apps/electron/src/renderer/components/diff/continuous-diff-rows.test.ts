import { describe, expect, test } from 'bun:test'
import type { FileDiffMetadata, Hunk } from '@pierre/diffs'
import {
  areContextLinesMatching,
  buildFileSegments,
  buildNewFileChanges,
  buildUnifiedLines,
  computeDefaultExpandedPaths,
  countHunkLines,
  getMaxLineNumber,
  looksLikeBinaryContent,
  pairSplitRows,
  splitContentLines,
  type ChangesFile,
} from './continuous-diff-rows'

/** 构造一个两段上下文夹一段改动的 hunk：旧 1-3 行、新 1-4 行。 */
function createHunk(): Hunk {
  return {
    collapsedBefore: 0,
    additionStart: 1,
    additionCount: 4,
    additionLines: 2,
    additionLineIndex: 0,
    deletionStart: 1,
    deletionCount: 3,
    deletionLines: 1,
    deletionLineIndex: 0,
    hunkContent: [
      { type: 'context', lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
      { type: 'change', deletions: 1, deletionLineIndex: 1, additions: 2, additionLineIndex: 1 },
      { type: 'context', lines: 1, additionLineIndex: 3, deletionLineIndex: 2 },
    ],
    splitLineStart: 0,
    splitLineCount: 3,
    unifiedLineStart: 0,
    unifiedLineCount: 4,
    noEOFCRDeletions: false,
    noEOFCRAdditions: false,
  }
}

function createFile(overrides: Partial<ChangesFile> = {}): ChangesFile {
  const metadata: FileDiffMetadata = {
    name: 'src/app.ts',
    type: 'change',
    hunks: [createHunk()],
    splitLineCount: 3,
    unifiedLineCount: 4,
    isPartial: true,
    // patch 内的行：只有上下文行与被改动行的文本
    additionLines: ['alpha', 'beta-new-1', 'beta-new-2', 'omega'],
    deletionLines: ['alpha', 'beta-old', 'omega'],
  }
  return {
    path: 'src/app.ts',
    previousPath: null,
    status: 'change',
    additions: 2,
    deletions: 1,
    empty: false,
    metadata,
    ...overrides,
  }
}

describe('splitContentLines', () => {
  test('drops the trailing empty line and CRLF carriage returns', () => {
    expect(splitContentLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitContentLines('a\nb')).toEqual(['a', 'b'])
    expect(splitContentLines('')).toEqual([])
  })

  test('marks NUL content as binary', () => {
    expect(looksLikeBinaryContent('abc\u0000def')).toBe(true)
    expect(looksLikeBinaryContent('plain text')).toBe(false)
  })
})

describe('buildUnifiedLines', () => {
  test('numbers context, deletion and addition lines from the hunk header', () => {
    const rows = buildUnifiedLines(createHunk(), ['alpha', 'beta-new-1', 'beta-new-2', 'omega'], ['alpha', 'beta-old', 'omega'])

    expect(rows).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'alpha' },
      { kind: 'del', old: 2, new: null, text: 'beta-old' },
      { kind: 'add', old: null, new: 2, text: 'beta-new-1' },
      { kind: 'add', old: null, new: 3, text: 'beta-new-2' },
      { kind: 'context', old: 3, new: 4, text: 'omega' },
    ])
  })
})

describe('pairSplitRows', () => {
  test('pairs deletions with additions and keeps context on both sides', () => {
    const rows = buildUnifiedLines(createHunk(), ['alpha', 'beta-new-1', 'beta-new-2', 'omega'], ['alpha', 'beta-old', 'omega'])

    expect(pairSplitRows(rows)).toEqual([
      {
        left: { kind: 'context', no: 1, text: 'alpha' },
        right: { kind: 'context', no: 1, text: 'alpha' },
      },
      { left: { kind: 'del', no: 2, text: 'beta-old' }, right: { kind: 'add', no: 2, text: 'beta-new-1' } },
      { left: null, right: { kind: 'add', no: 3, text: 'beta-new-2' } },
      {
        left: { kind: 'context', no: 3, text: 'omega' },
        right: { kind: 'context', no: 4, text: 'omega' },
      },
    ])
  })

  test('keeps an empty left cell when a change adds more lines than it deletes', () => {
    const rows = pairSplitRows([
      { kind: 'del', old: 1, new: null, text: 'gone' },
      { kind: 'add', old: null, new: 1, text: 'one' },
      { kind: 'add', old: null, new: 2, text: 'two' },
    ])

    expect(rows).toHaveLength(2)
    expect(rows[1]!.left).toBeNull()
    expect(rows[1]!.right).toEqual({ kind: 'add', no: 2, text: 'two' })
  })
})

describe('buildFileSegments', () => {
  test('collapses the gap before the hunk and leaves the tail unknown', () => {
    const file = createFile({ metadata: { ...createFile().metadata, hunks: [{ ...createHunk(), additionStart: 11, deletionStart: 11 }] } })

    const segments = buildFileSegments(file, undefined, new Set())

    expect(segments).toEqual([
      { kind: 'gap', index: 0, count: 10 },
      expect.objectContaining({ kind: 'rows' }),
      { kind: 'gap', index: 1, count: null },
    ])
  })

  test('expands an opened gap into context lines when the full content is available', () => {
    const file = createFile({ metadata: { ...createFile().metadata, hunks: [{ ...createHunk(), additionStart: 3, deletionStart: 3 }] } })
    const content = ['line-1', 'line-2', 'alpha', 'beta-new-1', 'beta-new-2', 'omega', 'tail']

    const segments = buildFileSegments(file, content, new Set([0]))
    const firstSegment = segments[0]!

    expect(firstSegment.kind).toBe('rows')
    if (firstSegment.kind !== 'rows') throw new Error('unreachable')
    expect(firstSegment.rows.slice(0, 2)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'line-1' },
      { kind: 'context', old: 2, new: 2, text: 'line-2' },
    ])
    // 尾部 gap 未展开且长度已知：显示剩余行数而不是「展开剩余未更改行」
    expect(segments.at(-1)).toEqual({ kind: 'gap', index: 1, count: 1 })
  })

  test('skips the tail gap for new and deleted files', () => {
    const newFile = buildNewFileChanges('src/new.ts', 'a\nb\n')
    expect(buildFileSegments(newFile, undefined, new Set())).toEqual([
      expect.objectContaining({ kind: 'rows' }),
    ])

    const deletedFile = createFile({ status: 'deleted' })
    expect(buildFileSegments(deletedFile, undefined, new Set()).at(-1)).toEqual(expect.objectContaining({ kind: 'rows' }))
  })
})

describe('buildNewFileChanges', () => {
  test('turns untracked content into an all-addition file', () => {
    const file = buildNewFileChanges('docs/readme.md', '# 标题\n正文\n')

    expect(file).toMatchObject({ path: 'docs/readme.md', status: 'new', additions: 2, deletions: 0, empty: false })
    expect(file.metadata.unifiedLineCount).toBe(2)
    expect(buildUnifiedLines(file.metadata.hunks[0]!, file.metadata.additionLines, file.metadata.deletionLines)).toEqual([
      { kind: 'add', old: null, new: 1, text: '# 标题' },
      { kind: 'add', old: null, new: 2, text: '正文' },
    ])
  })

  test('keeps an empty untracked file empty instead of inventing a hunk', () => {
    const file = buildNewFileChanges('empty.txt', '')

    expect(file.empty).toBe(true)
    expect(file.metadata.hunks).toEqual([])
  })
})

describe('countHunkLines', () => {
  test('sums additions and deletions across hunk content blocks', () => {
    expect(countHunkLines([createHunk()])).toEqual({ additions: 2, deletions: 1 })
    expect(countHunkLines([])).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('computeDefaultExpandedPaths', () => {
  test('expands files in order until the line budget is exhausted', () => {
    const files = [
      createFile({ path: 'a.ts', metadata: { ...createFile().metadata, unifiedLineCount: 5_000 } }),
      createFile({ path: 'b.ts', metadata: { ...createFile().metadata, unifiedLineCount: 5_000 } }),
      createFile({ path: 'c.ts', metadata: { ...createFile().metadata, unifiedLineCount: 100 } }),
    ]

    expect([...computeDefaultExpandedPaths(files)]).toEqual(['a.ts', 'b.ts'])
    expect([...computeDefaultExpandedPaths(files, 10)]).toEqual(['a.ts'])
  })
})

describe('getMaxLineNumber', () => {
  test('prefers the expanded content length when available', () => {
    const file = createFile()
    expect(getMaxLineNumber(file)).toBe(4)
    expect(getMaxLineNumber(file, Array.from({ length: 1_200 }, (_, index) => `line-${index}`))).toBe(1_200)
  })
})

describe('areContextLinesMatching', () => {
  test('accepts the matching full content and rejects shifted content', () => {
    const file = createFile()

    expect(areContextLinesMatching(file.metadata, ['alpha', 'beta-new-1', 'beta-new-2', 'omega'])).toBe(true)
    expect(areContextLinesMatching(file.metadata, ['something-else', 'beta-new-1', 'beta-new-2', 'omega'])).toBe(false)
  })
})
