import { describe, expect, test } from 'bun:test'
import { buildFileSegments, countHunkLines } from './continuous-diff-rows'
import { parseChangesPatch } from './changes-patch-parse'

/** 真实 `git diff -M` 输出：一个改动文件 + 一个新增文件。 */
const PATCH = `diff --git a/f.txt b/f.txt
index f9d9a01..7fb1f47 100644
--- a/f.txt
+++ b/f.txt
@@ -1,7 +1,7 @@
 a
-b
+B
 c
 d
 e
-f
+F
 g
diff --git a/n.txt b/n.txt
new file mode 100644
index 0000000..07f33c4
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+new
+file
`

describe('parseChangesPatch', () => {
  test('parses each file with status, paths and line counts', () => {
    const files = parseChangesPatch(PATCH)

    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ['f.txt', 'change', 2, 2],
      ['n.txt', 'new', 2, 0],
    ])
    expect(files[0]!.previousPath).toBeNull()
    expect(files[1]!.empty).toBe(false)
  })

  test('strips trailing newlines from parsed lines so rows render cleanly', () => {
    const [changedFile] = parseChangesPatch(PATCH)
    const rows = buildFileSegments(changedFile!, undefined, new Set())

    // hunk 之后还有一段长度未知的尾部未改动行
    expect(rows.map((segment) => segment.kind)).toEqual(['rows', 'gap'])
    const segment = rows[0]!
    if (segment.kind !== 'rows') throw new Error('unreachable')
    expect(segment.rows.map((row) => row.text)).toEqual(['a', 'b', 'B', 'c', 'd', 'e', 'f', 'F', 'g'])
    expect(segment.rows.map((row) => [row.old, row.new])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, null],
      [null, 6],
      [7, 7],
    ])
  })

  test('counts lines from hunks and treats empty patches as no changes', () => {
    const files = parseChangesPatch(PATCH)

    expect(countHunkLines(files[0]!.metadata.hunks)).toEqual({ additions: 2, deletions: 2 })
    expect(parseChangesPatch('')).toEqual([])
  })
})
