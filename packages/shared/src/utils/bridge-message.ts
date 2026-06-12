/**
 * Bridge 消息净化工具
 *
 * 飞书桥等渠道会把 bridge_context、group_extra 等 XML 块注入 userMessage 供 Agent 消费。
 * 桌面 UI、标题生成、预览等展示层应调用 stripPromaInjectedBlocks 剥离这些块。
 */

/** 剥离 Proma / Bridge 注入的 XML 与 HTML 注释块，提取用户可见正文。 */
export function stripPromaInjectedBlocks(content: string): string {
  let text = content
    .replace(/<!--[\s\S]*?-->\n?/g, '')
    .replace(/<attached_files>\n?[\s\S]*?\n?<\/attached_files>\n*/g, '')
    .replace(/<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g, '')
    .replace(/<bridge_context>\n?[\s\S]*?\n?<\/bridge_context>\n*/g, '')
    .replace(/<quoted_message[^>]*>\n?[\s\S]*?\n?<\/quoted_message>\n*/g, '')
    .replace(/<interactive_card>\n?[\s\S]*?\n?<\/interactive_card>\n*/g, '')
    .replace(/<group_extra>\n?[\s\S]*?\n?<\/group_extra>\n*/g, '')
    .replace(/<mentioned_tools>\n?[\s\S]*?\n?<\/mentioned_tools>\n*/g, '')

  const userMessageMatch = text.match(/<user_message>\n?([\s\S]*?)\n?<\/user_message>/)
  if (userMessageMatch) {
    text = userMessageMatch[1]!
  }

  return text.trim()
}
