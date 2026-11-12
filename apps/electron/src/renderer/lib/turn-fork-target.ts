/**
 * 轮次分叉点解析（对齐商业版 0.22.28 的「探索引用从所选轮次末尾分叉」）
 *
 * 一轮 Agent 回复可能包含多条 assistant 消息（工具调用之间各有一条）。用户在正文里划选文字时，
 * 选区可能落在轮次中途的那条消息上；若直接以该消息 uuid 分叉，分支会丢掉本轮后续的工具结果
 * 与最终回复。因此分叉点统一取「轮次末尾的主线 assistant 消息」。
 *
 * 约定：
 * - 主线消息指 `parent_tool_use_id` 为空的 assistant 消息；子 Agent 消息不能作为 Pi 分叉入口。
 * - 只有同时写入 `piEntryBindings` 的消息才能被 Pi SessionManager 分叉，所以解析时允许传
 *   `isForkable` 判定；轮末消息没有绑定时退回选区自身所在消息，避免入口整体不可用。
 */

/** 计算分叉点所需的最小消息形状，避免依赖完整 SDKMessage 类型。 */
export interface TurnForkMessageLike {
  uuid?: string | null
  parent_tool_use_id?: string | null
}

/** 取本轮最后一条主线（非子 Agent）assistant 消息的 uuid。 */
export function getTurnForkTargetUuid(messages: readonly TurnForkMessageLike[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.parent_tool_use_id) continue
    if (typeof message.uuid === 'string' && message.uuid) return message.uuid
  }
  return undefined
}

export interface ResolveTurnForkTargetInput {
  /** 所属轮次末尾主线 assistant 消息 uuid（取自 `data-turn-fork-uuid`）。 */
  turnEndUuid?: string | null
  /** 选区自身所在消息的 uuid。 */
  selectedMessageId?: string | null
  /** 该 uuid 是否已写入 Pi entry 绑定，只有绑定的消息才能被分叉。 */
  isForkable: (uuid: string) => boolean
}

/**
 * 解析实际用于分叉的消息 uuid。
 *
 * 顺序：轮末消息 → 选区所在消息。轮末消息缺少 Pi 绑定（例如该轮被中断或运行未落盘）时
 * 退回选区消息，保证「从这里探索」入口仍然可用且不会静默丢掉用户可见的引用内容。
 */
export function resolveTurnForkTargetUuid({
  turnEndUuid,
  selectedMessageId,
  isForkable,
}: ResolveTurnForkTargetInput): string | undefined {
  const candidates = [turnEndUuid, selectedMessageId]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue
    if (isForkable(candidate)) return candidate
  }
  return undefined
}
