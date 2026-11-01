import { describe, expect, test } from 'bun:test'
import { getReferenceDisplayName, saveFilesAsInlineReferences, type InlineFileReferenceInput } from './agent-file-references'

interface FakeFile {
  name: string
}

function makeInput(name: string, size: number, options: { failRead?: boolean } = {}): InlineFileReferenceInput<FakeFile> {
  return {
    item: { name },
    filename: name,
    size,
    readBase64: async () => {
      if (options.failRead) throw new Error('read failed')
      return `base64:${name}`
    },
  }
}

describe('文件落盘为内联引用', () => {
  test('Given 已绑定项目且未超限 When 落盘成功 Then 返回顺序稳定的引用并使用文件名做 chip 标签', async () => {
    const inputs = [makeInput('image-8.png', 1024), makeInput('notes.md', 2048)]
    const saves: Array<{ sessionId: string; workspaceSlug: string; files: Array<{ filename: string; data: string }> }> = []

    const result = await saveFilesAsInlineReferences(inputs, {
      sessionId: 'session-1',
      workspaceSlug: 'work-space',
      maxAttachmentSize: 100 * 1024 * 1024,
      save: async (input) => {
        saves.push(input)
        return [{ filename: `attachments/${input.files[0]!.filename}`, targetPath: `/session/attachments/${input.files[0]!.filename}` }]
      },
    })

    expect(result.fallback).toEqual([])
    expect(result.references).toEqual([
      { path: '/session/attachments/image-8.png', name: 'image-8.png', item: { name: 'image-8.png' } },
      { path: '/session/attachments/notes.md', name: 'notes.md', item: { name: 'notes.md' } },
    ])
    expect(saves.map((save) => save.files[0]!.data)).toEqual(['base64:image-8.png', 'base64:notes.md'])
    expect(saves.every((save) => save.sessionId === 'session-1' && save.workspaceSlug === 'work-space')).toBe(true)
  })

  test('Given 未绑定项目 When 请求内联引用 Then 全部回落且不读取文件内容', async () => {
    let readCount = 0
    const input: InlineFileReferenceInput<FakeFile> = {
      item: { name: 'image.png' },
      filename: 'image.png',
      size: 10,
      readBase64: async () => {
        readCount += 1
        return 'data'
      },
    }
    let saveCount = 0

    const result = await saveFilesAsInlineReferences([input], {
      sessionId: 'session-1',
      workspaceSlug: undefined,
      maxAttachmentSize: 100,
      save: async () => {
        saveCount += 1
        return []
      },
    })

    expect(result.references).toEqual([])
    expect(result.fallback).toEqual([{ name: 'image.png' }])
    expect(readCount).toBe(0)
    expect(saveCount).toBe(0)
  })

  test('Given 文件超过大小上限 When 请求内联引用 Then 回落为待发送附件', async () => {
    const small = makeInput('small.png', 10)
    const large = makeInput('huge.zip', 101)

    const result = await saveFilesAsInlineReferences([large, small], {
      sessionId: 'session-1',
      workspaceSlug: 'work-space',
      maxAttachmentSize: 100,
      save: async (input) => [{ filename: input.files[0]!.filename, targetPath: `/session/${input.files[0]!.filename}` }],
    })

    expect(result.references.map((reference) => reference.name)).toEqual(['small.png'])
    expect(result.fallback).toEqual([{ name: 'huge.zip' }])
  })

  test('Given 落盘返回空或抛错 When 请求内联引用 Then 落回附件并上报错误', async () => {
    const emptyResult = makeInput('empty.png', 10)
    const broken = makeInput('broken.png', 10)
    const errors: string[] = []

    const result = await saveFilesAsInlineReferences([emptyResult, broken], {
      sessionId: 'session-1',
      workspaceSlug: 'work-space',
      maxAttachmentSize: 100,
      save: async (input) => {
        if (input.files[0]!.filename === 'broken.png') throw new Error('disk full')
        return []
      },
      onSaveError: (input) => errors.push(input.filename),
    })

    expect(result.references).toEqual([])
    expect(result.fallback).toEqual([{ name: 'empty.png' }, { name: 'broken.png' }])
    expect(errors).toEqual(['broken.png'])
  })
})

describe('内联引用的 chip 标签', () => {
  test('Given 会话内相对路径 When 取展示名 Then 只保留文件名', () => {
    expect(getReferenceDisplayName('attachments/image-8.png')).toBe('image-8.png')
    expect(getReferenceDisplayName('attachments\\image-8.png')).toBe('image-8.png')
    expect(getReferenceDisplayName('image-8.png')).toBe('image-8.png')
  })
})
