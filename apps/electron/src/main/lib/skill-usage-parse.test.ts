import { describe, expect, test } from 'bun:test'
import { extractSkillActivations } from './skill-usage-parse'

describe('Skill 使用统计：会话 JSONL 解析', () => {
  test('Given 没有 skill_activations 的会话 When 解析 Then 返回空数组', () => {
    expect(extractSkillActivations('{"type":"user"}\n{"type":"assistant"}')).toEqual([])
  })

  test('Given 用户消息带激活记录 When 解析 Then 抽出 slug 与定位信息', () => {
    const raw = [
      JSON.stringify({ type: 'user', skill_activations: [
        { slug: 'docx', name: 'docx', sources: ['read'] },
      ] }),
      JSON.stringify({ type: 'assistant', skill_activations: [
        { slug: 'xlsx', workspaceSlug: 'demo', filePath: '/tmp/w/agent-workspaces/demo/skills/xlsx/SKILL.md' },
      ] }),
    ].join('\n')

    expect(extractSkillActivations(raw)).toEqual([
      { slug: 'docx' },
      { slug: 'xlsx', workspaceSlug: 'demo', filePath: '/tmp/w/agent-workspaces/demo/skills/xlsx/SKILL.md' },
    ])
  })

  test('Given 同一 slug 多次出现 When 解析 Then 只保留首次记录', () => {
    const raw = [
      JSON.stringify({ skill_activations: [{ slug: 'pdf', workspaceSlug: 'a' }] }),
      JSON.stringify({ skill_activations: [{ slug: 'pdf', workspaceSlug: 'b' }] }),
    ].join('\n')

    expect(extractSkillActivations(raw)).toEqual([{ slug: 'pdf', workspaceSlug: 'a' }])
  })

  test('Given 坏行与非法条目 When 解析 Then 跳过而不抛错', () => {
    const raw = [
      '{"skill_activations":[{"slug":"ok"}]}',
      '{坏行 skill_activations',
      JSON.stringify({ skill_activations: [null, { slug: '   ' }, { slug: 42 }, 'text'] }),
      JSON.stringify({ skill_activations: 'not-array' }),
    ].join('\n')

    expect(extractSkillActivations(raw)).toEqual([{ slug: 'ok' }])
  })
})
