import { describe, expect, test } from 'bun:test'
import { resolveGoogleModelsEndpoint, toGoogleChannelModels } from './google-model-list'

describe('resolveGoogleModelsEndpoint', () => {
  test('Given 协议根地址 When 解析 Then 补 /v1beta/models', () => {
    expect(resolveGoogleModelsEndpoint('https://generativelanguage.googleapis.com'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(resolveGoogleModelsEndpoint(' https://api-int.memtensor.cn/ '))
      .toBe('https://api-int.memtensor.cn/v1beta/models')
  })

  test('Given 已含 /v1beta 或 /v1 When 解析 Then 不重复拼接版本段', () => {
    expect(resolveGoogleModelsEndpoint('https://api-int.memtensor.cn/v1beta'))
      .toBe('https://api-int.memtensor.cn/v1beta/models')
    expect(resolveGoogleModelsEndpoint('https://proxy.example.com/gemini/v1/'))
      .toBe('https://proxy.example.com/gemini/v1/models')
  })
})

describe('toGoogleChannelModels', () => {
  test('Given 官方响应 When 转换 Then 去掉 models/ 前缀并只保留 generateContent 模型', () => {
    const models = toGoogleChannelModels([
      { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ])
    expect(models).toEqual([
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true },
    ])
  })

  test('Given 网关响应（name 无前缀、方法与名称为 null）When 转换 Then 保留对话模型并排除向量模型', () => {
    const models = toGoogleChannelModels([
      { name: 'gemini-4-argon', displayName: null, supportedGenerationMethods: null },
      { name: 'gemini-4-carbon', displayName: null, supportedGenerationMethods: null },
      { name: 'gemini-embedding-001', displayName: null, supportedGenerationMethods: null },
      { name: 'text-embedding-3-large', supportedGenerationMethods: null },
      { name: 'claude-opus-5-5' },
    ])
    expect(models.map((model) => model.id)).toEqual(['gemini-4-argon', 'gemini-4-carbon', 'claude-opus-5-5'])
    expect(models[0]).toEqual({ id: 'gemini-4-argon', name: 'gemini-4-argon', enabled: true })
  })

  test('Given 空 name、重复 ID 或空列表 When 转换 Then 跳过且不抛错', () => {
    expect(toGoogleChannelModels([
      { name: null },
      { name: '  ' },
      { name: 'gemini-4-argon' },
      { name: 'models/gemini-4-argon' },
    ]).map((model) => model.id)).toEqual(['gemini-4-argon'])
    expect(toGoogleChannelModels(undefined)).toEqual([])
    expect(toGoogleChannelModels(null)).toEqual([])
  })
})
