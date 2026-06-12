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
 * Cursor 后端按 CLI 能力分两档：
 * - 支持 `acp` 子命令（默认）→ CursorAcpAdapter：持久会话、流式追加、软中断、动态权限、逐工具审批，
 *   能力对齐 Claude 直连（除 token 用量不可得）。
 * - 旧版 CLI 无 acp → CursorAgentAdapter（headless 单轮）：流式追加 throw、软中断 no-op、权限模式下轮生效。
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
import { cursorSupportsAcp } from './cursor-cli-finder'
import type { CursorAgentQueryOptions } from './cursor-agent-adapter'

/** 会话后端类型 */
type Backend = 'claude' | 'cursor'
/** Cursor 后端实现：ACP（能力完整）/ headless（旧 CLI 回退，单轮降级） */
type CursorImpl = 'acp' | 'headless'

export class RouterAgentAdapter implements AgentProviderAdapter {
  /** sessionId → channelId（agent-service 每轮运行前登记） */
  private readonly sessionChannel = new Map<string, string>()
  /** Cursor headless 回退时待生效的权限模式（下轮 spawn 时应用；ACP 即时生效不用） */
  private readonly sessionPendingMode = new Map<string, string>()
  /** sessionId → 本会话实际使用的 Cursor 实现（query 时确定，供 interrupt/queue/mode 路由） */
  private readonly sessionCursorImpl = new Map<string, CursorImpl>()

  constructor(
    private readonly claudeAdapter: AgentProviderAdapter,
    private readonly cursorAdapter: AgentProviderAdapter,
    private readonly cursorAcpAdapter: AgentProviderAdapter,
  ) {}

  /** 解析会话当前使用的 Cursor 适配器（ACP 优先，回退 headless） */
  private cursorAdapterFor(sessionId: string): AgentProviderAdapter {
    return this.sessionCursorImpl.get(sessionId) === 'headless' ? this.cursorAdapter : this.cursorAcpAdapter
  }

  /** 登记会话使用的渠道（供后端判定与 Cursor 凭证解析） */
  setSessionBackend(sessionId: string, channelId: string): void {
    this.sessionChannel.set(sessionId, channelId)
  }

  /** 解析会话对应的 channelId（显式登记优先，回退会话元数据） */
  private resolveChannelId(sessionId: string): string | undefined {
    return this.sessionChannel.get(sessionId) ?? getAgentSessionMeta(sessionId)?.channelId
  }

  /** 解析会话后端类型 */
  private resolveBackend(sessionId: string): Backend {
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
      // 确保 CLI 可用（缺失则自动安装），并注入凭证与路径
      const cli = await ensureCursorCli()
      const options = input as CursorAgentQueryOptions
      options.cursorCliPath = cli.path
      options.cursorApiKey = decryptApiKey(channelId)

      // 能力探测：支持 acp 子命令走 ACP 适配器（能力完整），否则回退 headless 单轮
      const impl: CursorImpl = cursorSupportsAcp(cli.path) ? 'acp' : 'headless'
      this.sessionCursorImpl.set(input.sessionId, impl)

      if (impl === 'headless') {
        // headless 回退：保留"待生效权限模式下轮应用"语义（单轮进程无法运行中改 flags）
        const pendingMode = this.sessionPendingMode.get(input.sessionId)
        if (pendingMode) {
          options.sdkPermissionMode = pendingMode
          this.sessionPendingMode.delete(input.sessionId)
          console.log(`[Router] Cursor(headless) 应用待生效权限模式: sessionId=${input.sessionId}, mode=${pendingMode}`)
        }
        console.log(`[Router] Cursor 渠道使用 headless 回退（CLI 不支持 acp）: sessionId=${input.sessionId}`)
        yield* this.cursorAdapter.query(options)
        return
      }

      yield* this.cursorAcpAdapter.query(options)
      return
    }

    yield* this.claudeAdapter.query(input)
  }

  abort(sessionId: string): void {
    // 三发兜底：各适配器对未知会话自然 no-op
    this.claudeAdapter.abort(sessionId)
    this.cursorAdapter.abort(sessionId)
    this.cursorAcpAdapter.abort(sessionId)
  }

  dispose(): void {
    this.claudeAdapter.dispose()
    this.cursorAdapter.dispose()
    this.cursorAcpAdapter.dispose()
  }

  async interruptQuery(sessionId: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      // ACP：session/cancel 软中断；headless：未实现（no-op）
      await this.cursorAdapterFor(sessionId).interruptQuery?.(sessionId)
      return
    }
    await this.claudeAdapter.interruptQuery?.(sessionId)
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      const impl = this.cursorAdapterFor(sessionId)
      if (!impl.sendQueuedMessage) {
        throw new Error('Cursor 渠道（旧版 CLI 回退）暂不支持流式追加消息，请等当前回合结束后再发送')
      }
      await impl.sendQueuedMessage(sessionId, message)
      return
    }
    await this.claudeAdapter.sendQueuedMessage?.(sessionId, message)
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      await this.cursorAdapterFor(sessionId).cancelQueuedMessage?.(sessionId, messageUuid)
      return
    }
    await this.claudeAdapter.cancelQueuedMessage?.(sessionId, messageUuid)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    if (this.resolveBackend(sessionId) === 'cursor') {
      const impl = this.cursorAdapterFor(sessionId)
      if (impl.setPermissionMode) {
        // ACP：session/set_mode 即时生效
        await impl.setPermissionMode(sessionId, mode)
      } else {
        // headless：记录 pending，下轮 query 时应用
        this.sessionPendingMode.set(sessionId, mode)
        console.log(`[Router] Cursor(headless) 权限模式已记录（下轮生效）: sessionId=${sessionId}, mode=${mode}`)
      }
      return
    }
    await this.claudeAdapter.setPermissionMode?.(sessionId, mode)
  }

  /** 当前会话是否走 Cursor 后端 */
  isCursorBackend(sessionId: string): boolean {
    return this.resolveBackend(sessionId) === 'cursor'
  }
}
