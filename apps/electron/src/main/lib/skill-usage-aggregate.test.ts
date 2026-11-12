import { describe, expect, test } from 'bun:test'
import { belongsToWorkspace, summarizeSkillUsage } from './skill-usage-aggregate'

describe('Skill 使用统计：归属判断', () => {
  test('Given 路径指向本工作区 skills 目录 When 判断 Then 属于本工作区', () => {
    expect(belongsToWorkspace(
      { slug: 'a', filePath: '/Users/x/.proma/agent-workspaces/demo/skills/a/SKILL.md' },
      'demo',
    )).toBe(true)
  })

  test('Given Windows 分隔符路径 When 判断 Then 仍能识别归属', () => {
    expect(belongsToWorkspace(
      { slug: 'a', filePath: 'C:\\Users\\x\\.proma\\agent-workspaces\\demo\\skills\\a\\SKILL.md' },
      'demo',
    )).toBe(true)
  })

  test('Given 路径指向其他工作区 skills 目录 When 判断 Then 不算本工作区', () => {
    expect(belongsToWorkspace(
      { slug: 'a', workspaceSlug: 'demo', filePath: '/Users/x/.proma/agent-workspaces/other/skills/a/SKILL.md' },
      'demo',
    )).toBe(false)
  })

  test('Given 内置 Skill 路径但没有 workspaceSlug When 判断 Then 不计入工作区', () => {
    expect(belongsToWorkspace(
      { slug: 'docx', filePath: '/Users/x/.proma/default-skills/docx/SKILL.md' },
      'demo',
    )).toBe(false)
  })

  test('Given 内置 Skill 没有 filePath 也没有 workspaceSlug When 判断 Then 不计入工作区', () => {
    expect(belongsToWorkspace({ slug: 'docx' }, 'demo')).toBe(false)
  })

  test('Given 没有 filePath 但有 workspaceSlug When 判断 Then 按 slug 相等判断', () => {
    expect(belongsToWorkspace({ slug: 'a', workspaceSlug: 'demo' }, 'demo')).toBe(true)
    expect(belongsToWorkspace({ slug: 'a', workspaceSlug: 'other' }, 'demo')).toBe(false)
  })
})

describe('Skill 使用统计：按工作区汇总', () => {
  test('Given 多个会话用过同一个 Skill When 汇总 Then count 为会话数且 lastUsedAt 取最新', () => {
    const usage = summarizeSkillUsage([
      { lastUsedAt: 100, activations: [{ slug: 'docx', workspaceSlug: 'demo' }] },
      { lastUsedAt: 300, activations: [{ slug: 'docx', workspaceSlug: 'demo' }] },
      { lastUsedAt: 200, activations: [{ slug: 'xlsx', workspaceSlug: 'demo' }] },
    ], 'demo')

    expect(usage).toEqual({
      docx: { count: 2, lastUsedAt: 300 },
      xlsx: { count: 1, lastUsedAt: 200 },
    })
  })

  test('Given 同一会话里重复激活 When 汇总 Then 该会话只算一次', () => {
    const usage = summarizeSkillUsage([
      { lastUsedAt: 50, activations: [
        { slug: 'docx', workspaceSlug: 'demo' },
        { slug: 'docx', workspaceSlug: 'demo' },
      ] },
    ], 'demo')

    expect(usage).toEqual({ docx: { count: 1, lastUsedAt: 50 } })
  })

  test('Given 其他工作区的激活记录 When 汇总 Then 不混入结果', () => {
    const usage = summarizeSkillUsage([
      { lastUsedAt: 10, activations: [{ slug: 'other-skill', workspaceSlug: 'other' }] },
      { lastUsedAt: 20, activations: [{ slug: 'mine', workspaceSlug: 'demo' }] },
    ], 'demo')

    expect(usage).toEqual({ mine: { count: 1, lastUsedAt: 20 } })
  })

  test('Given 没有任何会话 When 汇总 Then 返回空对象', () => {
    expect(summarizeSkillUsage([], 'demo')).toEqual({})
  })
})
