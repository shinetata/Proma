import type {
  AgentSendInput,
  AgentSessionMeta,
  FeishuBotConfig,
  FeishuSessionMirrorSettings,
} from '@proma/shared'
import { stripPromaInjectedBlocks } from '@proma/shared'

const DESKTOP_MIRROR_PREFIX = '📱 Proma 桌面'
const MAX_FEISHU_MIRROR_BODY_LENGTH = 3900
const TRUNCATION_SUFFIX = '…（完整内容见 Proma 桌面）'

export const DEFAULT_FEISHU_SESSION_MIRROR: FeishuSessionMirrorSettings = { mode: 'off' }

export function normalizeFeishuSessionMirrorSettings(
  settings: FeishuSessionMirrorSettings | undefined,
): FeishuSessionMirrorSettings {
  if (!settings) return DEFAULT_FEISHU_SESSION_MIRROR
  if (settings.mode !== 'stream') return { mode: 'off' }
  return { mode: 'stream', botId: settings.botId }
}

export function resolveSessionMirrorBot(
  settings: FeishuSessionMirrorSettings | undefined,
  bots: FeishuBotConfig[],
): FeishuBotConfig | null {
  const normalized = normalizeFeishuSessionMirrorSettings(settings)
  if (normalized.mode === 'off') return null
  if (!normalized.botId) return null
  const bot = bots.find((item) => item.id === normalized.botId)
  if (!bot || !bot.enabled || !bot.appId || !bot.appSecret) return null
  return bot
}

export function buildSessionMirrorGroupName(session: Pick<AgentSessionMeta, 'id' | 'title'>): string {
  const rawTitle = session.title?.trim()
  const title = rawTitle && rawTitle !== '新 Agent 会话'
    ? rawTitle
    : `新会话 ${session.id.slice(0, 8)}`
  return truncateGroupName(`Proma - ${title}`)
}

function truncateGroupName(name: string): string {
  return name.length > 60 ? `${name.slice(0, 57)}...` : name
}

function countAttachedFileRefs(content: string): number {
  const match = content.match(/<attached_files>\n?([\s\S]*?)\n?<\/attached_files>/)
  if (!match) return 0
  let count = 0
  for (const line of match[1]!.split('\n')) {
    if (/^-\s+(.+?):\s+(.+)$/.test(line.trim())) count++
  }
  return count
}

function firstAttachedFileLabel(content: string): string | null {
  const match = content.match(/<attached_files>\n?([\s\S]*?)\n?<\/attached_files>/)
  if (!match) return null
  for (const line of match[1]!.split('\n')) {
    const lineMatch = line.match(/^-\s+(.+?):\s+(.+)$/)
    if (lineMatch) return lineMatch[1]!.trim()
  }
  return null
}

/** 将桌面端 userMessage 格式化为飞书镜像群可见文本。 */
export function formatDesktopMirrorUserMessage(raw: string): string {
  const attachmentCount = countAttachedFileRefs(raw)
  let body = stripPromaInjectedBlocks(raw)

  if (!body && attachmentCount > 0) {
    const firstLabel = firstAttachedFileLabel(raw)
    const withoutExt = firstLabel?.replace(/\.[^.]+$/, '') ?? '文件'
    body = `[附件] ${withoutExt || firstLabel || '文件'}`
  }

  if (!body && attachmentCount === 0) return ''

  if (body.length > MAX_FEISHU_MIRROR_BODY_LENGTH) {
    body = `${body.slice(0, MAX_FEISHU_MIRROR_BODY_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
  }

  let result = `${DESKTOP_MIRROR_PREFIX}\n${body}`
  if (attachmentCount > 0) {
    result += `\n📎 附带 ${attachmentCount} 个文件（请在 Proma 桌面查看）`
  }
  return result
}

/** 判断桌面端发起的 Agent 消息是否应镜像到飞书群。 */
export function shouldMirrorDesktopUserMessage(
  input: AgentSendInput,
  mirrorSettings: FeishuSessionMirrorSettings | undefined,
): boolean {
  if (normalizeFeishuSessionMirrorSettings(mirrorSettings).mode !== 'stream') return false
  if (input.triggeredBy === 'automation') return false
  if (input.automationContext) return false

  const trimmed = input.userMessage.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/compact')) return false
  if (trimmed.startsWith('请执行该计划')) return false

  return true
}
