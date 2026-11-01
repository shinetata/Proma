/**
 * Proma Coach：应用内置核心指南。
 *
 * 与商业版一致：读取随应用分发的 `default-skills/proma-coach/SKILL.md`，
 * 去掉 frontmatter 后随每轮系统提示加载；`references/` 链接改写为绝对路径，
 * 让模型可以按需直接读取具体指南。
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getBundledDefaultSkillsDir } from './config-paths'

export function buildPromaCoachPrompt(
  directory = join(getBundledDefaultSkillsDir(), 'proma-coach'),
): string {
  let source: string
  try {
    source = readFileSync(join(directory, 'SKILL.md'), 'utf-8')
  } catch (error) {
    // 分发目录缺失时不能阻断整个 Agent 运行；保留最小可用的能力路由提示。
    console.warn('[Proma Coach] 读取内置指南失败，已跳过:', error)
    return '## Proma Coach（应用内置核心，已加载）\n内置指南未能加载；按当前工具列表与项目规则执行，需要知识维护细节时读取工作区 Skill。'
  }
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim()
  const resolvedBody = body.replace(/\]\((references\/[^)]+)\)/g, (_match, path: string) => `](${resolve(directory, path)})`)
  return `## Proma Coach（应用内置核心，已加载）
${resolvedBody}`
}
