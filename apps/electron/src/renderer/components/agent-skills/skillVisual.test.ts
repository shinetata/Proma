import { describe, expect, test } from 'bun:test'
import { SKILL_ACCENTS, getSkillAccent, getSkillGroupAccent, getSkillIconText, hashSkillSlug } from './skillVisual'

describe('Skill 取色', () => {
  test('Given 同一个 slug When 多次取色 Then 结果稳定', () => {
    expect(getSkillAccent({ slug: 'docx' })).toEqual(getSkillAccent({ slug: 'docx' }))
  })

  test('Given 不同 slug When 取色 Then 落在色板范围内', () => {
    for (const slug of ['docx', 'xlsx', 'pptx', 'pdf', 'proma-coach']) {
      expect(SKILL_ACCENTS).toContainEqual(getSkillAccent({ slug }))
    }
  })

  test('Given 分组标题 When 取色 Then 与同名 Skill 的取色可以不同且稳定', () => {
    expect(getSkillGroupAccent('文档')).toEqual(getSkillGroupAccent('文档'))
    expect(SKILL_ACCENTS).toContainEqual(getSkillGroupAccent('文档'))
  })

  test('Given 同样的字符串 When 计算哈希 Then 结果确定', () => {
    expect(hashSkillSlug('docx')).toBe(hashSkillSlug('docx'))
    expect(hashSkillSlug('docx')).not.toBe(hashSkillSlug('xlsx'))
  })
})

describe('Skill 图标内容', () => {
  test('Given 声明了 emoji 图标 When 取图标 Then 使用 emoji', () => {
    expect(getSkillIconText({ slug: 'docx', name: '文档', icon: '📄' })).toBe('📄')
  })

  test('Given 没有图标且名称以英文开头 When 取图标 Then 返回大写首字母', () => {
    expect(getSkillIconText({ slug: 'web', name: 'web design' })).toBe('W')
  })

  test('Given 名称为中文 When 取图标 Then 返回首个汉字', () => {
    expect(getSkillIconText({ slug: 'report', name: '报表生成' })).toBe('报')
  })

  test('Given 没有名称 When 取图标 Then 回退到 slug 首字母', () => {
    expect(getSkillIconText({ slug: 'excel', name: '' })).toBe('E')
  })

  test('Given 图标字段不是纯 emoji When 取图标 Then 忽略它改用首字母', () => {
    expect(getSkillIconText({ slug: 'pdf', name: 'pdf', icon: 'files/pdf.png' })).toBe('P')
  })
})
