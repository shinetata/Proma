/**
 * `git diff --numstat -z` 输出解析
 *
 * -z 模式下每条记录以 NUL 分隔；重命名记录的路径段为空字符串，随后两段分别是
 * 旧路径和新路径。二进制文件的增删统计是 `-`，记为 0 并标记 binary。
 */

export interface NumstatEntry {
  /** 改动后路径（重命名时为新路径） */
  path: string
  /** 重命名/复制时的旧路径 */
  oldPath?: string
  added: number
  deleted: number
  binary: boolean
}

/** 解析 numstat 输出；空输出返回空数组。 */
export function parseNumstat(output: string): NumstatEntry[] {
  if (output.length === 0) return []

  const queue = output.split('\0')
  if (queue.at(-1) === '') queue.pop()

  const entries: NumstatEntry[] = []
  while (queue.length > 0) {
    const record = queue.shift()
    if (record === undefined || record.length === 0) continue

    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (secondTab < 0) throw new Error(`malformed numstat record: ${record}`)

    const addedRaw = record.slice(0, firstTab)
    const deletedRaw = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)

    let target = path
    let oldPath: string | undefined
    if (target === '') {
      const renamedFrom = queue.shift()
      const renamedTo = queue.shift()
      if (renamedFrom === undefined || renamedTo === undefined) {
        throw new Error('malformed numstat rename record')
      }
      oldPath = renamedFrom
      target = renamedTo
    }

    const binary = addedRaw === '-' || deletedRaw === '-'
    entries.push({
      path: target,
      ...(oldPath === undefined ? {} : { oldPath }),
      added: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
      deleted: binary ? 0 : Number.parseInt(deletedRaw, 10) || 0,
      binary,
    })
  }

  return entries
}
