/**
 * 记忆条目的单行增删改：把「整篇重写」换成按 `- ` 条目操作。
 *
 * 纯函数、无 IO，便于单测。语义与商业版 0.22.0 一致：
 * - 条目按 `- ` / `* ` 行首匹配，没有 bullet 时自动补 `- `；
 * - 判重与模糊匹配都用 `normalizeEntryText`，忽略来源括号注记、标点与空白；
 * - 只能操作单行条目，多行事实必须拆成多条；
 * - 实际生效与被跳过的情况都回传，让调用方知道哪条没落地。
 */

/** 条目行首：允许缩进，`-` 或 `*` 后必须跟空白。 */
const BULLET = /^\s*[-*]\s+/

export type MemoryEntryOperation =
  | {
      op: 'add'
      /** 单行条目正文；不含 bullet 时自动补 `- `。 */
      entry: string
      /** 插到哪条条目之后；省略时追加到最后一个条目之后。 */
      after?: string
    }
  | {
      op: 'update'
      /** 用于唯一定位旧条目的片段或整行。 */
      match: string
      /** 替换后的单行条目正文。 */
      entry: string
    }
  | {
      op: 'remove'
      /** 用于唯一定位待删除条目的片段或整行。 */
      match: string
      /** 删除全部匹配条目；默认只在唯一匹配时删除，多条匹配会报错。 */
      all?: boolean
    }

export interface MemoryEntryChange {
  op: MemoryEntryOperation['op']
  /** 实际写入或删除的条目文本。 */
  entry: string
}

export interface MemoryEntrySkip {
  op: MemoryEntryOperation['op']
  reason: 'duplicate' | 'not-found'
  /** 触发跳过的条目文本或 match。 */
  entry: string
}

export interface MemoryEntryResult {
  content: string
  changes: MemoryEntryChange[]
  skipped: MemoryEntrySkip[]
}

/** 规范化条目文本，用于判重与模糊全等匹配。 */
export function normalizeEntryText(line: string): string {
  const body = line.replace(BULLET, '').trim()
  // 去掉行尾的来源注记，例如「（来源：memos，2026-09-19）」。
  const withoutMeta = body.replace(/[（(][^（）()]*[）)]\s*$/, '').trim()
  return withoutMeta.toLowerCase().replace(/[\s，。；、,.;:：！？!?'"“”‘’（）()\-—_]/g, '')
}

/** 校验并规范化单行条目；无 bullet 时补 `- `。 */
export function entryLine(entry: string): string {
  const trimmed = entry.trim()
  if (!trimmed) throw new Error('条目内容不能为空。')
  if (/[\r\n]/.test(trimmed)) throw new Error('一次只能操作一个单行条目；多行事实请拆成多条。')
  return BULLET.test(trimmed) ? trimmed : `- ${trimmed}`
}

/** 返回所有匹配条目的行号：先做精确 `includes`，再做规范化全等。 */
export function indexOfMatches(lines: string[], match: string): number[] {
  const query = match.trim()
  if (!query) throw new Error('请提供用于定位条目的 match。')
  const normalized = normalizeEntryText(query)
  const found: number[] = []
  lines.forEach((line, index) => {
    if (!BULLET.test(line)) return
    if (line.includes(query) || (normalized.length > 0 && normalizeEntryText(line) === normalized)) found.push(index)
  })
  return found
}

/** 计算插入位置：优先 `after` 锚点，否则追加到最后一个条目之后。 */
export function insertPosition(lines: string[], after?: string): number {
  if (after) {
    const anchors = indexOfMatches(lines, after)
    const anchor = anchors[0]
    if (anchors.length === 1 && anchor !== undefined) return anchor + 1
    if (anchors.length > 1) throw new Error(`after 匹配到多条条目，请写得更具体：${after}`)
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && BULLET.test(line)) return index + 1
  }
  return lines.length
}

/**
 * 依次应用条目操作，返回新内容与实际生效/被跳过的操作。
 *
 * `update` / `remove` 找不到匹配时记为 `not-found` 跳过而不是抛错：一次提交多条操作时，
 * 单条缺失不应让整批失败。匹配到多条时抛错，避免误删或误改。
 */
export function applyMemoryEntryOperations(
  content: string,
  operations: MemoryEntryOperation[],
): MemoryEntryResult {
  if (!operations.length) throw new Error('请提供至少一条条目操作。')
  const lines = content.split(/\r?\n/)
  const changes: MemoryEntryChange[] = []
  const skipped: MemoryEntrySkip[] = []
  const seen = new Set(lines.filter((line) => BULLET.test(line)).map((line) => normalizeEntryText(line)))

  for (const operation of operations) {
    if (operation.op === 'add') {
      const line = entryLine(operation.entry)
      const key = normalizeEntryText(line)
      if (key && seen.has(key)) {
        skipped.push({ op: 'add', reason: 'duplicate', entry: line })
        continue
      }
      lines.splice(insertPosition(lines, operation.after), 0, line)
      if (key) seen.add(key)
      changes.push({ op: 'add', entry: line })
      continue
    }

    const matches = indexOfMatches(lines, operation.match)
    if (matches.length === 0) {
      skipped.push({ op: operation.op, reason: 'not-found', entry: operation.match })
      continue
    }
    if (matches.length > 1 && !(operation.op === 'remove' && operation.all)) {
      throw new Error(`match 匹配到 ${matches.length} 条条目，无法唯一定位：${operation.match}`)
    }

    if (operation.op === 'remove') {
      // 从后往前删除，避免前面的删除让后续行号失效。
      const targets = [...matches].sort((a, b) => b - a)
      for (const at of targets) {
        const [removed] = lines.splice(at, 1)
        if (removed === undefined) continue
        seen.delete(normalizeEntryText(removed))
        changes.push({ op: 'remove', entry: removed })
      }
      continue
    }

    const line = entryLine(operation.entry)
    const key = normalizeEntryText(line)
    const at = matches[0]
    if (at === undefined) continue
    const previous = lines[at]
    if (previous !== undefined) seen.delete(normalizeEntryText(previous))
    lines[at] = line
    if (key) seen.add(key)
    changes.push({ op: 'update', entry: line })
  }

  return { content: lines.join('\n'), changes, skipped }
}