/**
 * 历史思考块的重放策略
 *
 * 背景：Anthropic Messages 协议要求带 signature 的 thinking 块与「当时的上下文」严格一致。
 * 一旦上下文变化（记忆/项目规则刷新、上下文压缩、跨模型续接、resume artifact 与当前前缀
 * 不一致），把历史思考块原样回传会让上游直接返回 400，而部分网关还会把错误详情脱敏成
 * `upstream http 400`，导致 Proma 侧无法按具体错误码分流。
 *
 * 因此这里在**发给上游之前**就按轮次边界剥掉不该回传的思考块，让请求本身不触发 400。
 * 已经收到 400 时有两条补救路径：
 * - 上游明确报签名错误：Pi 原生重试在同一 transcript 上原地重试，重试前剥掉出错时点之前的
 *   全部带签名思考块（见 `prepareThinkingSignatureRecovery`），已完成的工具结果都保留；
 * - 网关隐去诊断的 400 或原地重试用尽：编排层整次重跑，并通过 query 选项 `forceThinkingStrip`
 *   让新会话以 `none` 模式启动。
 *
 * 设计约定：
 * - 只在 Anthropic Messages 协议下生效（其他协议不校验 signature，剥离会丢失有价值的思考内容）。
 * - 只剥离 assistant 消息里**带 signature** 的 thinking 块；无 signature 的思考块上游本来就不校验，
 *   删掉反而会改变模型看到的推理内容。
 * - 轮次边界取 `user` / `custom` / `bashExecution` / `branchSummary` / `compactionSummary`：
 *   这几种角色都表示「上一次 assistant 输出已经闭环、人类/系统重新发起了输入」。
 *   Anthropic 只要求同一轮工具循环内保留思考块，跨轮的历史思考块既无价值也是 400 的主要来源。
 * - 未真正删块时返回原数组引用，避免下游无谓的缓存失效与重渲染。
 * - `none` 模式丢弃全部带 signature 的思考块：这是「已确认当前前缀与历史 artifact 不再兼容」
 *   后的补救口径，任何残留都可能导致同一个 400 反复出现。
 */

import { createHash } from 'node:crypto'

/** 思考块重放模式；`legacy` 表示完全不干预（排查问题时用）。 */
export type ThinkingReplayMode = 'legacy' | 'turn' | 'none'

/** 单次请求的前缀指纹，用于诊断上游缓存/400 是否来自前缀漂移。 */
export interface ThinkingReplayFingerprint {
  at: number
  systemHash: string
  systemLength: number
  conversationHash: string
  messageCount: number
  signedThinkingCount: number
}

/** 签名错误原地恢复的状态；随一次 adapter.query 存在。 */
export interface ThinkingSignatureRecoveryState {
  /** 已启动的原地恢复次数。 */
  attempts: number
  /** 已判定过的失败消息；Pi 对同一条失败消息会多次询问是否可重试。 */
  handled: WeakSet<object>
  /** 剥离时点：时间戳不晚于该值的 assistant 消息，其带签名思考块一律不再回传。 */
  stripSignedBefore?: number
}

/** 会话级重放状态；随一次 adapter.query 存在，模式在建立会话时确定。 */
export interface ThinkingReplayState {
  mode: ThinkingReplayMode
  fingerprints: ThinkingReplayFingerprint[]
  signatureRecovery: ThinkingSignatureRecoveryState
}

/** `prepareThinkingSignatureRecovery` 的判定结果。 */
export type ThinkingSignatureRecoveryStatus =
  /** 本次失败首次判定，已记录剥离时点，应原地重试。 */
  | 'started'
  /** 同一条失败消息已判定过，保持「应重试」的结论。 */
  | 'pending'
  /** 本次 query 的原地恢复次数已用完，交给编排层兜底。 */
  | 'exhausted'
  /** 当前协议不校验签名，或处于 legacy 排查模式。 */
  | 'unsupported'

/** 策略只需要消息的 role / content，不绑定具体 SDK 消息类型以保持调用方类型。 */
interface ReplayMessageShape {
  role?: unknown
  content?: unknown
  sections?: unknown
  timestamp?: unknown
}

/** 最多保留的指纹条数：只比较相邻两次请求，留 3 条足够定位漂移。 */
const MAX_FINGERPRINTS = 3

/**
 * 每次 query 最多原地恢复的次数。
 *
 * 一次恢复后旧思考块已全部剥掉，同一原因不会再触发；第二次只用于同一轮内 system 又变了一次
 * （例如本轮再次写入记忆）。再失败说明问题不在思考块，交给编排层处理。
 */
export const MAX_THINKING_SIGNATURE_RECOVERIES = 2

/** 轮次边界角色：表示「上一轮 assistant 输出已闭环，新的输入从这里开始」。 */
const TURN_BOUNDARY_ROLES: ReadonlySet<string> = new Set([
  'user',
  'custom',
  'bashExecution',
  'branchSummary',
  'compactionSummary',
])

/** 网关隐去诊断后的 400 文本形态（new-api 类中转常见）。 */
const OPAQUE_UPSTREAM_400 = /upstream http 400|upstream request failed/i

/** 创建会话级重放状态；默认按轮次边界剥离。 */
export function createThinkingReplayState(mode: ThinkingReplayMode = 'turn'): ThinkingReplayState {
  return { mode, fingerprints: [], signatureRecovery: { attempts: 0, handled: new WeakSet() } }
}

/** 读取 `PROMA_THINKING_REPLAY_MODE`；非法值视为未配置，由调用方回落到默认模式。 */
export function resolveThinkingReplayMode(
  raw: string | undefined = process.env.PROMA_THINKING_REPLAY_MODE,
): ThinkingReplayMode | undefined {
  const value = raw?.trim().toLowerCase()
  if (value === 'legacy' || value === 'turn' || value === 'none') return value
  return undefined
}

/**
 * 上游以签名错误拒绝请求时，判定能否剥离思考块后原地重试。
 *
 * 典型成因是同一轮工具循环中 system 段发生了变化（记忆或 AGENTS.md 被写入、项目规则维护），
 * 也可能是网关把请求路由到了另一个上游。两种情况下，此前生成的思考块都与当前前缀不再匹配，
 * 只要不再回传就能通过；后续新生成的思考块绑定的是新前缀，继续正常回传。
 *
 * Pi 对同一条失败消息会多次询问是否可重试，这里按消息去重，只在首次判定时计数并记录剥离时点。
 */
export function prepareThinkingSignatureRecovery(
  state: ThinkingReplayState,
  failedMessage: object,
  options: { supported: boolean, now?: number },
): ThinkingSignatureRecoveryStatus {
  if (!options.supported || state.mode === 'legacy') return 'unsupported'
  const recovery = state.signatureRecovery
  if (recovery.handled.has(failedMessage)) return 'pending'
  if (recovery.attempts >= MAX_THINKING_SIGNATURE_RECOVERIES) return 'exhausted'
  recovery.attempts += 1
  recovery.handled.add(failedMessage)
  recovery.stripSignedBefore = options.now ?? Date.now()
  return 'started'
}

function isSignatureBoundThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false
  const candidate = block as { type?: unknown, thinkingSignature?: unknown }
  if (candidate.type !== 'thinking') return false
  const signature = candidate.thinkingSignature
  return typeof signature === 'string' && signature.length > 0
}

/** 取 assistant 消息的内容块数组；非 assistant 或内容不是块数组时返回 undefined。 */
function assistantBlocksOf(message: ReplayMessageShape | undefined): unknown[] | undefined {
  if (message?.role !== 'assistant') return undefined
  const blocks = message.content
  return Array.isArray(blocks) ? blocks : undefined
}

/** 找到最后一个轮次边界的下标；没有边界时返回 -1（整段历史都属于同一轮或无法判定）。 */
function findLastTurnBoundaryIndex(messages: readonly ReplayMessageShape[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role
    if (typeof role === 'string' && TURN_BOUNDARY_ROLES.has(role)) return index
  }
  return -1
}

function hasCompactionSummary(messages: readonly ReplayMessageShape[]): boolean {
  return messages.some((message) => message?.role === 'compactionSummary')
}

/** 消息生成时间不晚于剥离时点；缺少时间戳的消息按旧消息处理。 */
function isBeforeStripPoint(message: ReplayMessageShape, stripSignedBefore: number | undefined): boolean {
  if (stripSignedBefore === undefined) return false
  const timestamp = message.timestamp
  return typeof timestamp !== 'number' || timestamp <= stripSignedBefore
}

/** 剥离单条 assistant 消息里的带 signature 思考块；无变化时返回 undefined。 */
function stripSignedThinkingBlocks<T extends ReplayMessageShape>(message: T): T | undefined {
  const blocks = assistantBlocksOf(message)
  if (!blocks) return undefined
  const kept = blocks.filter((block) => !isSignatureBoundThinkingBlock(block))
  if (kept.length === blocks.length) return undefined
  return { ...message, content: kept } as T
}

/**
 * 按当前模式改写即将发给上游的消息数组。
 *
 * @param options.supported 当前请求协议是否校验 thinking signature（仅 `anthropic-messages` 为真）。
 * @returns 未发生裁剪时返回入参本身。
 */
export function applyThinkingReplayPolicy<T extends ReplayMessageShape>(
  messages: T[],
  state: ThinkingReplayState,
  options: { supported: boolean },
): T[] {
  if (!options.supported || messages.length === 0) return messages
  if (state.mode === 'legacy') return messages

  const turnBoundaryIndex = findLastTurnBoundaryIndex(messages)
  const dropAll = state.mode === 'none' || hasCompactionSummary(messages) || turnBoundaryIndex < 0

  const { stripSignedBefore } = state.signatureRecovery
  let changed = false
  const next = messages.map((message, index) => {
    if (!assistantBlocksOf(message)) return message
    // 当前轮的思考块默认保留，供同一轮工具循环续接推理；
    // 上游已经以签名错误拒绝过时，剥离时点之前生成的块也不再回传。
    if (!dropAll && index > turnBoundaryIndex && !isBeforeStripPoint(message, stripSignedBefore)) return message
    const stripped = stripSignedThinkingBlocks(message)
    if (!stripped) return message
    changed = true
    return stripped
  })

  return changed ? next : messages
}

function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** system 段文本：`content` 字符串 + 命名段的可序列化形态。 */
function systemTextOf(message: ReplayMessageShape): string {
  const content = typeof message.content === 'string' ? message.content : ''
  const sections = message.sections
  return sections === undefined ? content : `${content}\0${JSON.stringify(sections)}`
}

/** 计算一次请求的前缀指纹；system 段与对话段分别取哈希，便于区分漂移来源。 */
export function buildPrefixFingerprint<T extends ReplayMessageShape>(
  messages: readonly T[],
  now = Date.now(),
): ThinkingReplayFingerprint {
  const systemParts: string[] = []
  const conversationParts: string[] = []
  let messageCount = 0
  let signedThinkingCount = 0

  for (const message of messages) {
    if (message?.role === 'system') {
      systemParts.push(systemTextOf(message))
      continue
    }
    messageCount += 1
    conversationParts.push(JSON.stringify(message))
    const blocks = assistantBlocksOf(message)
    if (blocks) {
      for (const block of blocks) {
        if (isSignatureBoundThinkingBlock(block)) signedThinkingCount += 1
      }
    }
  }

  const systemText = systemParts.join('\0')
  return {
    at: now,
    systemHash: hashOf(systemText),
    systemLength: systemText.length,
    conversationHash: hashOf(conversationParts.join('\0')),
    messageCount,
    signedThinkingCount,
  }
}

/** 记录指纹；只保留最近 MAX_FINGERPRINTS 条。 */
export function recordPrefixFingerprint(state: ThinkingReplayState, fingerprint: ThinkingReplayFingerprint): void {
  state.fingerprints.push(fingerprint)
  if (state.fingerprints.length > MAX_FINGERPRINTS) {
    state.fingerprints.splice(0, state.fingerprints.length - MAX_FINGERPRINTS)
  }
}

/** 描述相邻两次请求的前缀漂移；仅在诊断模式（`none`）下打印。 */
export function describePrefixDrift(state: ThinkingReplayState): string {
  const recent = state.fingerprints
  if (recent.length < 2) {
    return '前缀指纹不足（首次请求即失配，可视为历史 artifact 与当前前缀不一致）'
  }
  const previous = recent[recent.length - 2]!
  const current = recent[recent.length - 1]!
  const drift: string[] = []
  if (previous.systemHash !== current.systemHash) {
    drift.push(`system 段变化（${previous.systemLength}→${current.systemLength} 字符）`)
  }
  if (previous.conversationHash !== current.conversationHash) {
    drift.push(`会话序列变化（${previous.messageCount}→${current.messageCount} 条）`)
  }
  if (previous.signedThinkingCount !== current.signedThinkingCount) {
    drift.push(`可回传思考块 ${previous.signedThinkingCount}→${current.signedThinkingCount}`)
  }
  return drift.length > 0 ? drift.join('；') : '前缀指纹一致（失配来自更早的请求或上游侧）'
}

/** 判断模型是否属于 Claude 家族；思考块 signature 校验只由该家族触发。 */
export function isClaudeFamilyModelId(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && modelId.toLowerCase().includes('claude')
}

/** 判断错误文本是否属于「400 诊断被网关隐去」的形态。 */
export function isOpaqueUpstream400(...messages: Array<string | null | undefined>): boolean {
  const combined = messages.filter((message): message is string => typeof message === 'string').join('\n')
  return OPAQUE_UPSTREAM_400.test(combined)
}