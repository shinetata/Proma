/**
 * Present 工具路径校验单测
 *
 * 覆盖相对路径解析、授权根越界、目录/特殊文件拒绝、符号链接逃逸与重复声明去重。
 * 全部用临时目录构造真实文件系统状态，避免依赖仓库内文件。
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPresentedFiles, MAX_PRESENTED_FILES, resolvePresentedPath } from './pi-present-tools'

let sandbox = ''
let agentCwd = ''
let extraRoot = ''
let outsideRoot = ''

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'proma-present-'))
  agentCwd = join(sandbox, 'project')
  extraRoot = join(sandbox, 'attachments')
  outsideRoot = join(sandbox, 'outside')
  mkdirSync(agentCwd, { recursive: true })
  mkdirSync(extraRoot, { recursive: true })
  mkdirSync(outsideRoot, { recursive: true })
  writeFileSync(join(agentCwd, 'report.docx'), 'docx')
  writeFileSync(join(extraRoot, 'data.xlsx'), 'xlsx')
  writeFileSync(join(outsideRoot, 'secret.pdf'), 'pdf')
  mkdirSync(join(agentCwd, 'folder'))
  // macOS 的 /var 是指向 /private/var 的符号链接，期望值统一取 realpath。
  agentCwd = realpathSync(agentCwd)
  extraRoot = realpathSync(extraRoot)
  outsideRoot = realpathSync(outsideRoot)
  expect(sandbox.length).toBeGreaterThan(0)
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const ctx = () => ({ agentCwd, allowedRoots: [extraRoot] })

describe('Present 工具路径解析', () => {
  test('相对路径按 agentCwd 解析成绝对路径', () => {
    expect(resolvePresentedPath('report.docx', ctx())).toBe(join(agentCwd, 'report.docx'))
  })

  test('附加授权目录内的绝对路径可以通过', () => {
    expect(resolvePresentedPath(join(extraRoot, 'data.xlsx'), ctx())).toBe(join(extraRoot, 'data.xlsx'))
  })

  test('越出授权根的路径被拒绝', () => {
    expect(() => resolvePresentedPath(join(outsideRoot, 'secret.pdf'), ctx()))
      .toThrow(/文件超出当前会话的授权范围/)
  })

  test('相对路径向上越界同样被拒绝', () => {
    expect(() => resolvePresentedPath('../outside/secret.pdf', ctx()))
      .toThrow(/文件超出当前会话的授权范围/)
  })

  test('目录不能作为交付物', () => {
    expect(() => resolvePresentedPath('folder', ctx()))
      .toThrow(/不是普通文件/)
  })

  test('空路径被拒绝', () => {
    expect(() => resolvePresentedPath('   ', ctx())).toThrow(/文件路径不能为空/)
  })

  test('指向授权根之外的符号链接被拒绝', () => {
    const linkPath = join(agentCwd, 'secret-link.pdf')
    symlinkSync(join(outsideRoot, 'secret.pdf'), linkPath)
    expect(() => resolvePresentedPath('secret-link.pdf', ctx()))
      .toThrow(/文件超出当前会话的授权范围/)
  })

  test('指向授权根内部的符号链接按目标路径返回', () => {
    const linkPath = join(agentCwd, 'report-link.docx')
    symlinkSync(join(agentCwd, 'report.docx'), linkPath)
    expect(resolvePresentedPath('report-link.docx', ctx())).toBe(join(agentCwd, 'report.docx'))
  })
})

describe('Present 交付物收集', () => {
  test('重复路径去重且描述以最后一次为准', () => {
    const files = collectPresentedFiles([
      { path: 'report.docx', description: '旧描述' },
      { path: join(agentCwd, 'report.docx'), description: '最终报告' },
    ], ctx())
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({ path: join(agentCwd, 'report.docx'), name: 'report.docx', description: '最终报告' })
  })

  test('没有描述时不写入 description 字段', () => {
    const files = collectPresentedFiles([{ path: 'report.docx', description: '   ' }], ctx())
    expect(files[0]).toEqual({ path: join(agentCwd, 'report.docx'), name: 'report.docx' })
  })

  test('多项交付物按声明顺序保留', () => {
    const files = collectPresentedFiles([
      { path: 'report.docx' },
      { path: join(extraRoot, 'data.xlsx') },
    ], ctx())
    expect(files.map((file) => file.name)).toEqual(['report.docx', 'data.xlsx'])
  })

  test('一次最多声明 8 个交付物', () => {
    expect(MAX_PRESENTED_FILES).toBe(8)
  })
})
