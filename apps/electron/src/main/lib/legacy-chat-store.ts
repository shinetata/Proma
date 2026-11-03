/**
 * 历史 Chat 存储（只读）
 *
 * Chat 模式已在 0.21 移除；本机遗留数据仍需可读，用于：
 * - 「历史 Chat」设置分区展示存量规模
 * - 交给 Agent 检索旧对话（搜索对话框复用同一目录）
 * - Chat → Agent 迁移（migrateChatToAgentSession）
 *
 * 数据布局（不再写入）：
 * - 索引：~/.proma/conversations.json
 * - 消息：~/.proma/conversations/{id}.jsonl
 */

import { readFileSync, existsSync } from 'node:fs'
import { readJsonFileSafe } from './safe-file'
import { getConversationsIndexPath, getConversationMessagesPath, getConversationsDir } from './config-paths'
import type { ConversationMeta, ChatMessage, LegacyChatSummary } from '@proma/shared'

/** 对话索引文件格式 */
interface ConversationsIndex {
  /** 配置版本号 */
  version: number
  /** 对话元数据列表 */
  conversations: ConversationMeta[]
}

const INDEX_VERSION = 1

/** 读取对话索引文件；缺失时返回空索引。 */
function readIndex(): ConversationsIndex {
  const data = readJsonFileSafe<ConversationsIndex>(getConversationsIndexPath())
  if (data) return data
  return { version: INDEX_VERSION, conversations: [] }
}

/** 获取所有历史对话（按 updatedAt 降序）。 */
export function listConversations(): ConversationMeta[] {
  return readIndex().conversations.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取单个历史对话的全部消息；文件缺失或损坏时返回空数组。 */
export function getConversationMessages(id: string): ChatMessage[] {
  const filePath = getConversationMessagesPath(id)
  if (!existsSync(filePath)) return []

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return lines.map((line) => JSON.parse(line) as ChatMessage)
  } catch (error) {
    console.error(`[历史 Chat] 读取消息失败 (${id}):`, error)
    return []
  }
}

export function getLegacyChatSummary(): LegacyChatSummary {
  const conversations = listConversations()
  return {
    conversationCount: conversations.length,
    archivedCount: conversations.filter((conversation) => conversation.archived).length,
    lastUpdatedAt: conversations[0]?.updatedAt ?? 0,
    conversationsDir: getConversationsDir(),
  }
}
