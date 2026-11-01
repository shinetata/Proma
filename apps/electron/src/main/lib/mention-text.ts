/**
 * 会话标题等纯文本场景的 mention 标记处理。
 *
 * 用户消息里的 `@file:`、`/skill:`、`#mcp:`、`&session:`、`&todo:`、`&calendar_event:`、
 * `&quote:` 是渲染层用来显示引用 chip 的序列化标记（见
 * `renderer/lib/mention-patterns.ts`）。会话标题最多 20 个字符，装不下这些标记，
 * 因此标题生成与本地兜底都要先剥离；只有整条消息都是引用时，才退化到第一个引用的
 * 可读标签。
 *
 * 与渲染层的唯一差异是 `/skill:`、`#mcp:` 的取值边界：渲染层用 `\S+`（Skill 名可能
 * 含中文），标题场景改用 ASCII 边界，避免 `/skill:follow-builders帮我收集…` 这类没有
 * 空格的历史写法把后面的正文一起吞掉。
 */

const ENCODED_MENTION_VALUE = String.raw`[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}，。！？；：、（）【】《》“”‘’]+`
const PLAIN_MENTION_VALUE = String.raw`[A-Za-z0-9@._\-/]+`

/** 每次调用返回新实例，避免全局正则的 lastIndex 在多次匹配之间泄漏状态。 */
export function createMentionMarkerPattern(): RegExp {
  return new RegExp(
    String.raw`@file:(?<file>${ENCODED_MENTION_VALUE})` +
      String.raw`|/skill:(?<skill>${PLAIN_MENTION_VALUE})` +
      String.raw`|#mcp:(?<mcp>${PLAIN_MENTION_VALUE})` +
      String.raw`|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)(?<sessionLabel>${ENCODED_MENTION_VALUE}))?` +
      String.raw`|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)(?<todoLabel>${ENCODED_MENTION_VALUE}))?` +
      String.raw`|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)(?<calendarEventLabel>${ENCODED_MENTION_VALUE}))?` +
      String.raw`|&quote:(?<quote>[A-Za-z0-9%_.!~*'()-]+)`,
    'gu',
  )
}

function decodeMentionValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

/**
 * 剥离消息里的全部 mention 标记，只保留用户自己输入的文本。
 *
 * 标记被替换为空格并压缩连续空白，因此 `&session:…::标签 看一下这个问题` 会得到
 * `看一下这个问题`；整条消息只有引用时返回空字符串。
 */
export function stripMentionMarkers(text: string): string {
  if (!text) return ''
  return text
    .replace(createMentionMarkerPattern(), ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按出现顺序提取 mention 的可读标签。
 *
 * 只有 ID 没有标签的引用（例如 `&session:<id>` 单独出现）没有可读信息，直接跳过；
 * `@file:` 取路径的文件名，`&quote:` 取解码后的引用原文。
 */
export function extractMentionLabels(text: string): string[] {
  if (!text) return []
  const labels: string[] = []
  for (const match of text.matchAll(createMentionMarkerPattern())) {
    const groups = match.groups
    if (!groups) continue
    const { file, skill, mcp, sessionLabel, todoLabel, calendarEventLabel, quote } = groups
    let label = ''
    if (file) label = basenameOf(decodeMentionValue(file))
    else if (skill) label = skill
    else if (mcp) label = mcp
    else if (sessionLabel) label = decodeMentionValue(sessionLabel)
    else if (todoLabel) label = decodeMentionValue(todoLabel)
    else if (calendarEventLabel) label = decodeMentionValue(calendarEventLabel)
    else if (quote) label = decodeMentionValue(quote)
    if (label) labels.push(label)
  }
  return labels
}
