/**
 * Router Agent 适配器
 *
 * 实现 AgentProviderAdapter，按会话的后端（claude / cursor）把编排层调用分发到
 * 对应的底层适配器。编排层（AgentOrchestrator）完全无感，仍按统一接口消费，
 * 从而复用全部编排能力（持久化、事件、重试、并发守卫、渲染）。
 *
 * 后端判定：sessionId → channelId → channel.provider。
 * channelId 由 agent-service 在每轮运行前显式登记（setSessionBackend），
 * 并回退到会话元数据中的 channelId（覆盖应用重启后 abort 等场景）。
 *
 * Cursor 后端统一走 CursorAcpAdapter（ACP，Agent Client Protocol，JSON-RPC 2.0 over stdio）：
 * 持久会话、流式追加、软中断、动态权限、逐工具审批、thinking 流。
 */

import type {
  AgentQueryInput,
  AgentProviderAdapter,
  SDKMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import { getChannelById, decryptApiKey } from '../channel-manager'
import { getAgentSessionMeta } from '../agent-session-manager'
import { ensureCursorCli } from './cursor-cli-installer'
import type { CursorAcpQueryOptions } from './cursor-acp-adapter'

export class RouterAgentAdapter implements AgentProviderAdapter {
  /** sessionId → channelId（agent-service 每轮运行前登记） */
  private readonly sessionChannel = new Map<string, string>()

  constructor(
    private readonly claudeAdapter: AgentProviderAdapter,
    private readonly cursorAcpAdapter: AgentProviderAdapter,
  ) {}

  /** 登记会话使用的渠道（供后端判定与 Cursor 凭证解析） */
  setSessionBackend(sessionId: string, channelId: string): void {
    this.sessionChannel.set(sessionId, channelId)
  }

  /** 解析会话对应的 channelId（显式登记优先，回退会话元数据） */
  private resolveChannelId(sessionId: string): string | undefined {
    return this.sessionChannel.get(sessionId) ?? getAgentSessionMeta(sessionId)?.channelId
  }

  /** 解析会话后端类型 */
  private resolveBackend(sessionId: string): 'claude' | 'cursor' {
    const channelId = this.resolveChannelId(sessionId)
    if (!channelId) return 'claude'
    return getChannelById(channelId)?.provider === 'cursor' ? 'cursor' : 'claude'
  }

  async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
    const backend = this.resolveBackend(input.sessionId)

    if (backend === 'cursor') {
      const channelId = this.resolveChannelId(input.sessionId)
      if (!channelId) {
        throw new Error('[Router] 无法确定 Cursor 渠道，请重新选择 Agent 渠道')
      }
      // 确保 CLI 可用（缺失则自动安装），注入凭证与路径
      const cli = await ensureCursorCli()
      const options = input as CursorAcpQueryOptions
      options.cursorCliPath = cli.path
      options.cursorApiKey = decryptApiKey(channelId)

      yield* this.cursorAcpAdapter.query(options)
      return
    }

    yield* this.claudeAdapter.query(input)
  }

  abort(sessionId: string): void {
    this.claudeAdapter.abort(sessionId)
    this.cursorAcpAdapter.abort(sessionId)
  }

  dispose(): void {
    this.claudeAdapter.dispose()
    this.cursorAcpAdapter.dispose()
  }

  async interruptQuery(sessionId: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      await this.cursorAcpAdapter.interruptQuery?.(sessionId)
      return
    }
    await this.claudeAdapter.interruptQuery?.(sessionId)
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      await this.cursorAcpAdapter.sendQueuedMessage?.(sessionId, message)
      return
    }
    await this.claudeAdapter.sendQueuedMessage?.(sessionId, message)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      await this.cursorAcpAdapter.cancelQueuedMessage?.(sessionId, messageUuid)
      return
    }
    await this.claudeAdapter.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      await this.cursorAcpAdapter.setPermissionMode?.(sessionId, mode)
      return
    }
    await this.claudeAdapter.setPermissionMode?.(sessionId, mode)
  }

  /** 当前会话是否走 Cursor 后端 */
  isCursorBackend(sessionId: string): boolean {
    return this.resolveBackend(sessionId) === 'cursor'
  }
}
