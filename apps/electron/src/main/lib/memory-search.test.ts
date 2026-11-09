/**
 * 记忆行级检索：分词、目录遍历、加权与单文件限流。
 *
 * 检索只读且必须稳定：结果顺序与截断规则直接决定 Agent 看到哪条记忆。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMemoryContext } from './agent-memory'
import { listMarkdownFiles, lineScore, searchMemory, tokenizeMemoryQuery } from './memory-search'

function createContext(): AgentMemoryContext {
  const root = mkdtempSync(join(tmpdir(), 'proma-memory-search-'))
  const workspaceRoot = join(root, 'agent-workspaces', 'demo')
  const projectRoot = join(root, 'projects', 'demo')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return {
    globalDir: join(root, 'memory'),
    workspaceRoot,
    projectRoot,
    canonicalProjectRoot: projectRoot,
    workspaces: [{ slug: 'demo', root: workspaceRoot }],
  }
}

function writeFile(root: string, name: string, content: string): void {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('查询分词', () => {
  test('英文取长度大于 1 的词，中文取相邻两字切片', () => {
    expect(tokenizeMemoryQuery('Memory Update')).toEqual(['memory', 'update'])
    expect(tokenizeMemoryQuery('记忆维护').sort()).toEqual(['记忆', '忆维', '维护'].sort())
    expect(tokenizeMemoryQuery('设计').sort()).toEqual(['设计'].sort())
  })

  test('单个中文字保留，单字母英文被丢弃', () => {
    expect(tokenizeMemoryQuery('记 忆')).toEqual(['记', '忆'])
    expect(tokenizeMemoryQuery('a 记忆')).toEqual(['记忆'])
    expect(tokenizeMemoryQuery('a')).toEqual([])
  })

  test('没有可检索词时返回空结果而不是抛错', () => {
    const ctx = createContext()
    expect(searchMemory(ctx, 'a').hits).toEqual([])
  })
})

describe('目录遍历与加权', () => {
  test('跳过隐藏目录与内部记录目录，超深不展开', () => {
    const ctx = createContext()
    const directory = join(ctx.workspaceRoot, 'memory')
    writeFile(directory, 'MEMORY.md', '# 索引\n')
    writeFile(directory, 'topics/a.md', '# A\n')
    writeFile(directory, '.hidden/b.md', '# B\n')
    writeFile(directory, 'history/c.md', '# C\n')
    writeFile(directory, 'deep/1/2/3/4/d.md', '# D\n')

    const files = listMarkdownFiles(directory)
    expect(files.some((path) => path.endsWith('MEMORY.md'))).toBe(true)
    expect(files.some((path) => path.endsWith('topics/a.md') || path.endsWith('topics\\a.md'))).toBe(true)
    expect(files.some((path) => path.includes('.hidden'))).toBe(false)
    expect(files.some((path) => path.includes('history'))).toBe(false)
    expect(files.some((path) => path.endsWith('d.md'))).toBe(false)
  })

  test('标题行加权 2，路径命中额外 0.8', () => {
    const tokens = ['memory']
    expect(lineScore('memory 说明', tokens, new Set())).toBeCloseTo(1.3, 5)
    expect(lineScore('# memory 说明', tokens, new Set())).toBeCloseTo(2.3, 5)
    expect(lineScore('# memory 说明', tokens, new Set(['memory']))).toBeCloseTo(3.1, 5)
    expect(lineScore('无关内容', tokens, new Set())).toBe(0)
  })
})

describe('检索结果', () => {
  test('同时扫描全局画像与项目记忆，返回行号与片段', () => {
    const ctx = createContext()
    writeFile(ctx.globalDir, 'user_profile.md', '# 全局用户画像\n\n- 重视可验证性\n')
    writeFile(join(ctx.workspaceRoot, 'memory'), 'MEMORY.md', '# 项目记忆索引\n\n- 可验证性优先\n')

    const result = searchMemory(ctx, '可验证性')
    expect(result.scannedFiles).toBe(2)
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
    const labels = result.hits.map((hit) => hit.label)
    expect(labels).toContain('user_profile.md')
    expect(labels).toContain('MEMORY.md')
    expect(result.hits[0]?.excerpt).toContain('可验证性')
    expect(result.hits[0]?.line).toBeGreaterThan(0)
  })

  test('单个文件最多返回 2 条命中', () => {
    const ctx = createContext()
    writeFile(
      join(ctx.workspaceRoot, 'memory'),
      'MEMORY.md',
      '# 索引\n\n- 记忆 1\n- 记忆 2\n- 记忆 3\n- 记忆 4\n',
    )
    const result = searchMemory(ctx, '记忆', 20)
    expect(result.hits.filter((hit) => hit.label === 'MEMORY.md').length).toBe(2)
  })

  test('limit 被限制在 1..20，结果按得分降序', () => {
    const ctx = createContext()
    writeFile(join(ctx.workspaceRoot, 'memory'), 'MEMORY.md', '# 记忆\n\n- 记忆记忆记忆\n')
    const result = searchMemory(ctx, '记忆', 100)
    expect(result.hits.length).toBeLessThanOrEqual(2)
    expect(result.hits[0]?.score).toBeGreaterThan(0)

    const clipped = searchMemory(ctx, '记忆', 0)
    expect(clipped.hits.length).toBe(1)
  })

  test('空查询报错', () => {
    const ctx = createContext()
    expect(() => searchMemory(ctx, '   ')).toThrow('请提供检索关键词')
  })
})