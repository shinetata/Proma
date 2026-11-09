/**
 * 记忆行级检索：按关键词在全局画像与当前项目 `memory/*.md` 中定位片段。
 *
 * 用于项目索引变长后「不确定事实在哪个主题文件」的场景，先看片段再决定是否整篇读取。
 * 中文按相邻两字切片（bigram），英文按词；标题行加权，路径命中额外加权。
 * 纯读，不写文件、不加锁。
 */

import { readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { memoryPaths, readMemoryFile, MAX_MEMORY_BYTES, type AgentMemoryContext } from './agent-memory'

/** 中日韩文字：命中后按 bigram 切片，避免单字噪声过大。 */
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/
/** 单次检索最多递归收集的 Markdown 文件数。 */
const MAX_FILES = 200
/** 单条命中展示的最大字符数。 */
const MAX_EXCERPT = 240
/** 记忆目录下不该参与检索的子目录：归档与内部记录。 */
const SKIP_DIRS = new Set(['archive', 'history', 'migrations', 'reviews'])
/** 递归深度上限：记忆目录本身通常只有两层。 */
const MAX_DEPTH = 3
/** 单次检索返回的命中上限。 */
const MAX_HITS = 20
/** 单个文件最多返回的命中条数，保证结果覆盖多个主题。 */
const MAX_HITS_PER_FILE = 2

export interface MemorySearchHit {
  /** 命中文件的绝对路径。 */
  path: string
  /** 相对记忆目录的展示名；全局画像固定为 `user_profile.md`。 */
  label: string
  /** 命中行号（1 起）。 */
  line: number
  score: number
  excerpt: string
}

export interface MemorySearchResult {
  query: string
  /** 实际扫描的文件数，便于判断检索范围。 */
  scannedFiles: number
  hits: MemorySearchHit[]
}

/** 把查询拆成检索词：英文取长度 >1 的词，中文取相邻两字切片。 */
export function tokenizeMemoryQuery(text: string): string[] {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue
    if (!CJK.test(word)) {
      if (word.length > 1) tokens.add(word)
      continue
    }
    if ([...word].length === 1) {
      tokens.add(word)
      continue
    }
    for (let index = 0; index < word.length - 1; index += 1) tokens.add(word.slice(index, index + 2))
  }
  return [...tokens]
}

/** 递归收集目录下的 `.md` 文件，跳过隐藏目录与内部记录目录。 */
export function listMarkdownFiles(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  let entries: Dirent[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdownFiles(path, depth + 1))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
    if (files.length >= MAX_FILES) break
  }
  return files
}

/** 单行得分：命中次数累计，标题行加权 2，路径命中额外 +0.8。 */
export function lineScore(line: string, tokens: string[], pathBonus: Set<string>): number {
  const lower = line.toLowerCase()
  const heading = /^\s{0,3}#{1,6}\s/.test(line)
  let score = 0
  for (const token of tokens) {
    if (!lower.includes(token)) continue
    let occurrences = 0
    let index = lower.indexOf(token)
    while (index !== -1 && occurrences < 3) {
      occurrences += 1
      index = lower.indexOf(token, index + token.length)
    }
    score += (heading ? 2 : 1) + occurrences * 0.3
    if (pathBonus.has(token)) score += 0.8
  }
  return score
}

function excerptOf(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}…` : trimmed
}

function scoreMemoryLines(
  content: string,
  tokens: string[],
  pathLabel: string,
  path: string,
): Array<Omit<MemorySearchHit, 'path' | 'label'>> {
  const fileName = basename(path).toLowerCase()
  const pathBonus = new Set(
    tokens.filter((token) => pathLabel.toLowerCase().includes(token) || fileName.includes(token)),
  )
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return []
    const score = lineScore(line, tokens, pathBonus)
    return score > 0 ? [{ line: index + 1, score, excerpt: excerptOf(line) }] : []
  })
}

/** 检索全局画像与当前项目记忆，返回按得分排序的片段。 */
export function searchMemory(ctx: AgentMemoryContext, query: string, limit = 8): MemorySearchResult {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('请提供检索关键词。')
  const tokens = tokenizeMemoryQuery(trimmed)
  if (!tokens.length) return { query: trimmed, scannedFiles: 0, hits: [] }

  const paths = memoryPaths(ctx)
  const candidates: Array<{ path: string; label: string }> = [{ path: paths.profile, label: 'user_profile.md' }]
  for (const path of listMarkdownFiles(paths.directory)) {
    candidates.push({ path, label: relative(paths.directory, path).split(/[\\/]/).join('/') })
  }

  const hits: MemorySearchHit[] = []
  let scannedFiles = 0
  for (const candidate of candidates) {
    let content: string | null
    try {
      const stats = statSync(candidate.path)
      if (!stats.isFile() || stats.size > MAX_MEMORY_BYTES) continue
      content = readMemoryFile(candidate.path).content
    } catch {
      continue
    }
    if (!content?.trim()) continue
    scannedFiles += 1
    for (const hit of scoreMemoryLines(content, tokens, candidate.label, candidate.path)) {
      hits.push({ path: candidate.path, label: candidate.label, ...hit })
    }
  }

  const cap = Math.max(1, Math.min(limit, MAX_HITS))
  hits.sort((a, b) => b.score - a.score)
  // 单文件命中过多会淹没其他主题，按文件限流后再截断总数。
  const perFile = new Map<string, number>()
  const selected = hits
    .filter((hit) => {
      const used = perFile.get(hit.path) ?? 0
      if (used >= MAX_HITS_PER_FILE) return false
      perFile.set(hit.path, used + 1)
      return true
    })
    .slice(0, cap)
  return { query: trimmed, scannedFiles, hits: selected }
}