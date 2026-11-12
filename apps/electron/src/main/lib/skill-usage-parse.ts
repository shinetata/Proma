/**
 * Skill 使用统计 — 会话消息流解析
 *
 * Proma 在每轮用户消息上持久化 `skill_activations`（见 agent-session-manager 的
 * updateSDKUserMessageSkillActivations）。统计只需要「哪些 Skill 在哪个会话里被加载过」，
 * 因此逐行扫描 JSONL、只解析含该字段的行，避免为统计把整个会话解析成消息对象。
 */

/** 从会话消息里抽出的最小激活记录，只保留归属判断需要的定位信息。 */
export interface SkillUsageActivationRef {
  /** Skill 目录 slug */
  slug: string
  /** 激活时所属的 Proma 工作区 slug（工作区 Skill 才有） */
  workspaceSlug?: string
  /** 加载 SKILL.md 时使用的绝对路径 */
  filePath?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从会话 JSONL 原始文本中抽取去重后的 Skill 激活记录。
 *
 * 约定：
 * - 只解析含 `skill_activations` 的行，坏行直接跳过，不影响整份会话；
 * - 同一个 slug 只保留第一次出现时的定位信息，与卡片统计的去重口径一致；
 * - 参数是文件原始内容，不读取文件本身，便于单测。
 */
export function extractSkillActivations(raw: string): SkillUsageActivationRef[] {
  if (!raw.includes('skill_activations')) return []

  const found = new Map<string, SkillUsageActivationRef>()
  for (const line of raw.split('\n')) {
    if (!line.includes('skill_activations')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue

    const activations = parsed.skill_activations
    if (!Array.isArray(activations)) continue

    for (const entry of activations) {
      if (!isRecord(entry)) continue
      const rawSlug = entry.slug
      if (typeof rawSlug !== 'string' || rawSlug.trim() === '') continue

      const slug = rawSlug.trim()
      if (found.has(slug)) continue

      const workspaceSlug = entry.workspaceSlug
      const filePath = entry.filePath
      found.set(slug, {
        slug,
        ...(typeof workspaceSlug === 'string' && workspaceSlug !== '' ? { workspaceSlug } : {}),
        ...(typeof filePath === 'string' && filePath !== '' ? { filePath } : {}),
      })
    }
  }

  return [...found.values()]
}
