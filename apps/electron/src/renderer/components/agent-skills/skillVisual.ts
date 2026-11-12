/**
 * skillVisual — Skill 卡片的视觉标识
 *
 * 0.22.28 起不再用统一的星形图标，而是用 slug 的 FNV-1a 哈希从 8 色板取一个稳定的配色，
 * 图标内容取 SKILL.md 的 emoji 图标，没有 emoji 时退化为名称首字母。
 * 同一 slug 在任何会话、任何列表顺序下都得到同一配色，分组标题也复用这套哈希。
 */

import type { SkillMeta } from '@proma/shared'

export interface SkillAccent {
  /** 图标块底色 + 文字色 */
  surface: string
  /** 分组标题的小圆点 */
  dot: string
}

/** 8 色板；按哈希取模，因此增删颜色会整体换色，需谨慎调整。 */
export const SKILL_ACCENTS: readonly SkillAccent[] = [
  { surface: 'bg-amber-500/12 text-amber-600 dark:text-amber-400', dot: 'bg-amber-500/70' },
  { surface: 'bg-sky-500/12 text-sky-600 dark:text-sky-400', dot: 'bg-sky-500/70' },
  { surface: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500/70' },
  { surface: 'bg-violet-500/12 text-violet-600 dark:text-violet-400', dot: 'bg-violet-500/70' },
  { surface: 'bg-rose-500/12 text-rose-600 dark:text-rose-400', dot: 'bg-rose-500/70' },
  { surface: 'bg-teal-500/12 text-teal-600 dark:text-teal-400', dot: 'bg-teal-500/70' },
  { surface: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400', dot: 'bg-indigo-500/70' },
  { surface: 'bg-orange-500/12 text-orange-600 dark:text-orange-400', dot: 'bg-orange-500/70' },
]

/** FNV-1a 32 位哈希，对短字符串足够分散且完全确定。 */
export function hashSkillSlug(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/** Skill 卡片的配色，按 slug 稳定取色。 */
export function getSkillAccent(skill: Pick<SkillMeta, 'slug'>): SkillAccent {
  return SKILL_ACCENTS[hashSkillSlug(skill.slug) % SKILL_ACCENTS.length] as SkillAccent
}

/** 分组标题的配色，用 `group:` 前缀与 Skill 自身的取色区分开。 */
export function getSkillGroupAccent(title: string): SkillAccent {
  return SKILL_ACCENTS[hashSkillSlug(`group:${title}`) % SKILL_ACCENTS.length] as SkillAccent
}

const EMOJI_ONLY = /^\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*$/u

/**
 * 图标块里的内容：优先 SKILL.md 声明的 emoji，否则取名称首字符；
 * 首字符是拉丁字母时转大写，中文等字符原样保留。
 */
export function getSkillIconText(skill: Pick<SkillMeta, 'slug' | 'name' | 'icon'>): string {
  const icon = skill.icon?.trim()
  if (icon && EMOJI_ONLY.test(icon)) return icon

  const firstChar = [...(skill.name?.trim() || skill.slug)][0] ?? '?'
  return /[a-z]/i.test(firstChar) ? firstChar.toUpperCase() : firstChar
}
