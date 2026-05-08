/**
 * RemoteBridge — 桌面端远程协作桥接模块
 *
 * 通过 Gateway 中继与移动端建立双向实时通道：
 * - 下行：将 Agent 事件（SDKMessage / PromaEvent）推送到移动端
 * - 上行：接收移动端的操作指令（发送/停止/审批/问答），调用已有 Service 方法
 *
 * 核心约束：Orchestrator 零改动，以 EventBus 中间件方式挂载。
 */
import WebSocket from 'ws'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { listAgentSessions, getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'
import type { AgentStreamPayload, PromaEvent } from '@proma/shared'

/** 需要转发到移动端的 PromaEvent 类型 */
const FORWARD_EVENT_TYPES = new Set([
  'permission_request',
  'permission_resolved',
  'ask_user_request',
  'ask_user_resolved',
  'exit_plan_mode_request',
  'exit_plan_mode_resolved',
  'permission_mode_changed',
])

/** 重连配置 */
const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 30_000

export class RemoteBridge {
  private ws: WebSocket | null = null
  private gatewayUrl: string | null = null
  private token: string | null = null
  private pairingCode: string | null = null
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // ========== 连接管理 ==========

  /** 连接到 Gateway 并完成认证 */
  async connect(gatewayUrl: string, token: string, code: string): Promise<void> {
    this.gatewayUrl = gatewayUrl
    this.token = token
    this.pairingCode = code

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(gatewayUrl)

      const timeout = setTimeout(() => {
        reject(new Error('连接 Gateway 超时'))
      }, 10_000)

      this.ws.on('open', () => {
        this.ws!.send(JSON.stringify({ kind: 'auth', role: 'desktop', token, code }) as unknown as Buffer)
      })

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())

        if (msg.kind === 'auth_ok') {
          clearTimeout(timeout)
          this.connected = true
          // 认证成功后推一次会话列表
          this.pushSessionList()
          resolve()
          return
        }

        if (msg.kind === 'auth_error') {
          clearTimeout(timeout)
          reject(new Error(msg.reason as string))
          return
        }

        // 业务消息 → 上行处理
        this.handleUpMessage(msg).catch(err => console.error('[RemoteBridge] 上行处理失败:', err))
      })

      this.ws.on('close', () => {
        this.connected = false
        this.scheduleReconnect()
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  /** 断开连接 */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.connected = false
    this.ws?.close()
    this.ws = null
  }

  get isConnected(): boolean {
    return this.connected
  }

  // ========== 下行：EventBus 中间件 ==========

  /**
   * EventBus 中间件入口
   *
   * 与 IPC 中间件平行注册，将 Agent 事件转发到移动端。
   * 总是调用 next()，不影响其他中间件。
   */
  forward(sessionId: string, payload: AgentStreamPayload, next: () => void): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      next()
      return
    }

    try {
      if (payload.kind === 'sdk_message') {
        this.send({
          kind: 'sdk_message',
          sessionId,
          message: payload.message,
        })
      } else if (payload.kind === 'proma_event') {
        const event = payload.event
        if (FORWARD_EVENT_TYPES.has(event.type)) {
          this.send({
            kind: 'proma_event',
            sessionId,
            event: event as Record<string, unknown>,
          })
        }
      }
    } catch (err) {
      console.error('[RemoteBridge] 转发事件失败:', err)
    }

    next()
  }

  // ========== 上行：处理移动端指令 ==========

  private async handleUpMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.kind) {
      case 'list_sessions':
        this.pushSessionList()
        break

      case 'get_messages': {
        const sessionId = msg.sessionId as string
        const since = (msg.since as number) || 0
        const messages = getAgentSessionSDKMessages(sessionId)
        for (const sdkMsg of messages.slice(since)) {
          this.send({ kind: 'sdk_message', sessionId, message: sdkMsg })
        }
        break
      }

      case 'send_message': {
        const sessionId = msg.sessionId as string
        const text = msg.text as string
        const meta = getAgentSessionMeta(sessionId)
        if (!meta) {
          this.send({ kind: 'error', code: 'session_not_found', message: '会话不存在' })
          return
        }
        // 动态导入避免循环依赖
        const [
          { queueAgentMessage, isAgentSessionActive, runAgentHeadless, runAgent, getSessionWebContents },
          { listChannels },
        ] = await Promise.all([
          import('./agent-service'),
          import('./channel-manager'),
        ])
        // 渠道 fallback：meta → 首个可用渠道
        const channelId = meta.channelId || listChannels()[0]?.id
        if (!channelId) {
          this.send({ kind: 'error', code: 'no_channel', message: '未找到可用渠道，请先在模型配置中创建渠道' })
          return
        }
        if (isAgentSessionActive(sessionId)) {
          // Agent 正在运行：排队注入，不打断
          await queueAgentMessage(
            { sessionId, userMessage: text, uuid: crypto.randomUUID(), interrupt: false },
            undefined as unknown as Electron.WebContents,
          )
        } else {
          // Agent 空闲：启动新一轮推理
          const existingWc = getSessionWebContents(sessionId)
          if (existingWc && !existingWc.isDestroyed()) {
            // 桌面端已有 webContents 映射 → 用 runAgent，桌面 + 手机双端渲染
            runAgent(
              { sessionId, userMessage: text, channelId, workspaceId: meta.workspaceId },
              existingWc,
            )
          } else {
            // 无桌面窗口 → fallback 到纯无头模式
            runAgentHeadless(
              { sessionId, userMessage: text, channelId, workspaceId: meta.workspaceId },
              {
                onError: (err) => console.error('[RemoteBridge] runAgentHeadless 失败:', err),
                onComplete: () => {},
                onTitleUpdated: () => {},
              },
            )
          }
        }
        break
      }

      case 'stop_agent': {
        const { stopAgent } = await import('./agent-service')
        stopAgent(msg.sessionId as string)
        break
      }

      case 'permission_respond': {
        const result = permissionService.respondToPermission(
          msg.requestId as string,
          msg.behavior as 'allow' | 'deny',
          msg.alwaysAllow as boolean,
        )
        if (result) {
          const { agentEventBus } = await import('./agent-service')
          agentEventBus.emit(result, {
            kind: 'proma_event',
            event: {
              type: 'permission_resolved',
              requestId: msg.requestId,
              behavior: msg.behavior,
            } as PromaEvent,
          })
        }
        break
      }

      case 'askuser_respond': {
        const result = askUserService.respondToAskUser(
          msg.requestId as string,
          msg.answers as Record<string, string>,
        )
        if (result) {
          const { agentEventBus } = await import('./agent-service')
          agentEventBus.emit(result, {
            kind: 'proma_event',
            event: {
              type: 'ask_user_resolved',
              requestId: msg.requestId,
            } as PromaEvent,
          })
        }
        break
      }

      case 'exitplan_respond': {
        const result = exitPlanService.respondToExitPlanMode({
          requestId: msg.requestId as string,
          action: msg.action as 'approve_auto' | 'approve_edit' | 'deny' | 'feedback',
          feedback: msg.feedback as string | undefined,
        })
        if (result) {
          const { agentEventBus } = await import('./agent-service')
          agentEventBus.emit(result.sessionId, {
            kind: 'proma_event',
            event: {
              type: 'exit_plan_mode_resolved',
              requestId: msg.requestId,
            } as PromaEvent,
          })
          if (result.targetMode) {
            agentEventBus.emit(result.sessionId, {
              kind: 'proma_event',
              event: {
                type: 'permission_mode_changed',
                mode: result.targetMode,
              } as PromaEvent,
            })
          }
        }
        break
      }
    }
  }

  // ========== 工具方法 ==========

  /** 推送当前桌面端会话列表 */
  private pushSessionList(): void {
    const sessions = listAgentSessions()
      .filter((s) => !s.archived)
      .map((s) => ({
        id: s.id,
        title: s.title,
        workspaceName: s.workspaceId ?? '',
        updatedAt: s.updatedAt,
        messageCount: 0,
        isActive: false,
      }))
    this.send({ kind: 'session_list', sessions })
  }

  /** 安全发送（仅在连接时） */
  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg) as unknown as Buffer)
    }
  }

  /** 指数退避重连 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.gatewayUrl || !this.token) return

    let attempt = 0
    const tryConnect = (): void => {
      if (!this.gatewayUrl || !this.token) return
      attempt++
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS)
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null
        try {
          await this.connect(this.gatewayUrl!, this.token!, this.pairingCode!)
        } catch {
          tryConnect()
        }
      }, delay)
    }
    tryConnect()
  }
}

export const remoteBridge = new RemoteBridge()
