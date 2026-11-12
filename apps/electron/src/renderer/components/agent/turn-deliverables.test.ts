/**
 * 交付物收集逻辑单测
 *
 * 覆盖：只收成功的 Present 调用、失败调用与未返回调用被忽略、相对路径按候选根补全、
 * 重复路径去重与描述覆盖，以及副标题的扩展名回退与括号剥离。
 */

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'
import {
  collectPresentedFiles,
  fileExtensionLabel,
  stripTrailingParenthetical,
} from './turn-deliverables'

function assistantToolUse(id: string, name: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SDKMessage
}

function userToolResult(toolUseId: string, isError = false): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
  } as unknown as SDKMessage
}

describe('交付物收集', () => {
  test('只收集成功的 Present 调用', () => {
    const messages = [
      assistantToolUse('t1', 'Present', { files: [{ path: '/tmp/report.docx', description: '季度报告' }] }),
      userToolResult('t1'),
    ]
    expect(collectPresentedFiles(messages)).toEqual([
      { path: '/tmp/report.docx', name: 'report.docx', description: '季度报告' },
    ])
  })

  test('失败或尚未返回结果的调用不收集', () => {
    const failed = [
      assistantToolUse('t1', 'Present', { files: [{ path: '/tmp/secret.pdf' }] }),
      userToolResult('t1', true),
    ]
    expect(collectPresentedFiles(failed)).toEqual([])

    const pending = [assistantToolUse('t2', 'Present', { files: [{ path: '/tmp/report.docx' }] })]
    expect(collectPresentedFiles(pending)).toEqual([])
  })

  test('其他工具调用不会被当成交付物', () => {
    const messages = [
      assistantToolUse('t1', 'Write', { file_path: '/tmp/report.docx' }),
      userToolResult('t1'),
    ]
    expect(collectPresentedFiles(messages)).toEqual([])
  })

  test('相对路径按候选根补全', () => {
    const messages = [
      assistantToolUse('t1', 'Present', { files: [{ path: 'out/report.docx' }] }),
      userToolResult('t1'),
    ]
    expect(collectPresentedFiles(messages, ['/workspace/project'])[0]).toEqual({
      path: '/workspace/project/out/report.docx',
      name: 'report.docx',
    })
  })

  test('没有候选根时保留原始相对路径', () => {
    const messages = [
      assistantToolUse('t1', 'Present', { files: [{ path: 'out/report.docx' }] }),
      userToolResult('t1'),
    ]
    expect(collectPresentedFiles(messages)[0]?.path).toBe('out/report.docx')
  })

  test('重复路径去重且描述以最后一次为准', () => {
    const messages = [
      assistantToolUse('t1', 'Present', { files: [{ path: '/tmp/report.docx', description: '旧描述' }] }),
      userToolResult('t1'),
      assistantToolUse('t2', 'Present', { files: [{ path: '/tmp/report.docx', description: '最终报告' }] }),
      userToolResult('t2'),
    ]
    const files = collectPresentedFiles(messages)
    expect(files).toHaveLength(1)
    expect(files[0]?.description).toBe('最终报告')
  })

  test('空路径与缺少 files 的调用被忽略', () => {
    const messages = [
      assistantToolUse('t1', 'Present', { files: [{ path: '  ' }] }),
      userToolResult('t1'),
      assistantToolUse('t2', 'Present', {}),
      userToolResult('t2'),
    ]
    expect(collectPresentedFiles(messages)).toEqual([])
  })
})

describe('交付物副标题', () => {
  test('没有描述时回退到扩展名大写', () => {
    expect(stripTrailingParenthetical(undefined, fileExtensionLabel('report.docx'))).toBe('DOCX')
  })

  test('无扩展名时回退为「文件」', () => {
    expect(fileExtensionLabel('README')).toBe('文件')
  })

  test('剥离描述末尾的中英文括号补充', () => {
    expect(stripTrailingParenthetical('季度销售报告（已复核）', 'DOCX')).toBe('季度销售报告')
    expect(stripTrailingParenthetical('Quarterly report (final)', 'DOCX')).toBe('Quarterly report')
  })

  test('只有括号时回退到扩展名', () => {
    expect(stripTrailingParenthetical('（临时）', 'DOCX')).toBe('DOCX')
  })
})
