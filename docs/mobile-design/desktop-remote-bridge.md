# 桌面端 RemoteBridge 设计

## 目标

在 Proma 桌面端新增 `RemoteBridge` 模块，实现对移动端的完整远程交互支持。核心约束：**Orchestrator 零改动，只新增文件 + 在 agent-service.ts 中注册中间件**。

---

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新增** | `apps/electron/src/main/lib/remote-bridge.ts` | RemoteBridge 主体 |
| **新增** | `apps/electron/src/main/lib/remote-auth.ts` | Token 生成验证 |
| **修改** | `apps/electron/src/main/lib/agent-service.ts` | 注册 RemoteBridge 中间件 + 导出 |

---

## RemoteBridge 核心结构

```typescript
// apps/electron/src/main/lib/remote-bridge.ts

import WebSocket from 'ws'
import { eventBus } from './agent-service'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import { listAgentSessions, getAgentSessionMeta, getAgentSessionSDKMessages } from './agent-session-manager'

class RemoteBridge {
  private ws: WebSocket | null = null
  private pendingRequests = new Map<string, (resp: unknown) => void>()

  // ── 连接管理 ──

  async connect(gatewayUrl: string, token: string): Promise<void> {
    this.ws = new WebSocket(gatewayUrl)

    this.ws.on('open', () => {
      this.ws!.send(JSON.stringify({ kind: 'auth', token, role: 'desktop' }))
    })

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      this.handleGatewayMessage(msg)
    })

    this.ws.on('close', () => {
      // 5s-20s 指数退避重连
      this.scheduleReconnect()
    })
  }

  // ── 下行（Proma → Gateway → Mobile） ──

  // 注册为 EventBus 中间件，与 IPC 中间件平行
  // 在 agent-service.ts 中: eventBus.use((sid, payload, next) => remoteBridge.forward(sid, payload, next))
  forward(sessionId: string, payload: AgentStreamPayload, next: () => void): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (payload.kind === 'sdk_message') {
        this.ws.send(JSON.stringify({
          kind: 'sdk_message',
          sessionId,
          message: payload.message,
        }))
      } else if (payload.kind === 'proma_event') {
        const event = payload.event
        // 转发所有交互事件到移动端
        if (event.type === 'permission_request' ||
            event.type === 'ask_user_request' ||
            event.type === 'exit_plan_mode_request' ||
            event.type === 'permission_resolved' ||
            event.type === 'ask_user_resolved' ||
            event.type === 'exit_plan_mode_resolved') {
          this.ws.send(JSON.stringify({
            kind: 'proma_event',
            sessionId,
            event,
          }))
        }
      }
    }
    next()  // 总要调用 next()，确保其他中间件（IPC）也收到事件
  }

  // ── 上行（Mobile → Gateway → Proma） ──

  private async handleGatewayMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.kind) {
      // 1. 会话列表
      case 'list_sessions': {
        const sessions = listAgentSessions()
          .filter(s => !s.archived)
          .map(s => ({
            id: s.id,
            title: s.title,
            workspaceName: s.title, // 可以从 workspaceId 查
            updatedAt: s.updatedAt,
            messageCount: 0,        // 可用 JSONL 行数
          }))
        this.ws!.send(JSON.stringify({ kind: 'session_list', sessions }))
        break
      }

      // 2. 消息历史
      case 'get_messages': {
        const allMessages = getAgentSessionSDKMessages(msg.sessionId as string)
        const since = (msg.since as number) || 0
        const newMessages = allMessages.slice(since)
        for (const sdkMsg of newMessages) {
          this.ws!.send(JSON.stringify({ kind: 'sdk_message', sessionId: msg.sessionId, message: sdkMsg }))
        }
        break
      }

      // 3. 发送消息 → 复用 runAgent / queueMessage
      case 'send_message': {
        // 需要 import 到这里或用已有接口
        const { runAgent, queueAgentMessage } = await import('./agent-service')
        const sessionMeta = getAgentSessionMeta(msg.sessionId as string)
        if (sessionMeta) {
          // 已有 session → 追加消息（和桌面端队列消息完全一样）
          await queueAgentMessage({
            sessionId: msg.sessionId as string,
            userMessage: msg.text as string,
          })
        } else {
          // 新 session → 需要创建
          // 走完整 sendMessage 流程
        }
        break
      }

      // 4. 停止
      case 'stop_agent': {
        const { stopAgent } = await import('./agent-service')
        stopAgent(msg.sessionId as string)
        break
      }

      // 5. 权限响应
      case 'permission_respond': {
        const result = permissionService.respondToPermission(
          msg.requestId as string,
          msg.behavior as 'allow' | 'deny',
          msg.alwaysAllow as boolean,
        )
        if (result) {
          // 通知桌面 UI 同步消失（通过 EventBus 回推）
          eventBus.emit(result, {
            kind: 'proma_event',
            event: {
              type: 'permission_resolved',
              requestId: msg.requestId as string,
              behavior: msg.behavior as 'allow' | 'deny',
            },
          })
        }
        break
      }

      // 6. AskUser 响应
      case 'askuser_respond': {
        const result = askUserService.respondToAskUser(
          msg.requestId as string,
          msg.answers as Record<string, string>,
        )
        if (result) {
          eventBus.emit(result, {
            kind: 'proma_event',
            event: { type: 'ask_user_resolved', requestId: msg.requestId as string },
          })
        }
        break
      }

      // 7. ExitPlanMode 响应
      case 'exitplan_respond': {
        const result = exitPlanService.respondToExitPlanMode({
          requestId: msg.requestId as string,
          action: msg.action as ExitPlanModeAction,
          feedback: msg.feedback as string | undefined,
        })
        if (result) {
          eventBus.emit(result.sessionId, {
            kind: 'proma_event',
            event: { type: 'exit_plan_mode_resolved', requestId: msg.requestId as string },
          })
          if (result.targetMode) {
            // 权限模式切换已由 canUseTool 中的 handleExitPlanMode 处理
            eventBus.emit(result.sessionId, {
              kind: 'proma_event',
              event: { type: 'permission_mode_changed', mode: result.targetMode },
            })
          }
        }
        break
      }
    }
  }

  // ── 会话列表推送（在连接建立 + 会话变更时） ──
  private pushSessionList(): void {
    const sessions = listAgentSessions()
      .filter(s => !s.archived)
      .map(s => ({
        id: s.id,
        title: s.title,
        workspaceName: '...',
        updatedAt: s.updatedAt,
      }))
    this.ws?.send(JSON.stringify({ kind: 'session_list', sessions }))
  }

  // ── 断开通知 ──
  private onPeerStatusChange(status: 'online' | 'offline'): void {
    this.ws?.send(JSON.stringify({ kind: 'peer_status', status }))
  }

  // ── 生命周期 ──
  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }
}

export const remoteBridge = new RemoteBridge()
```

---

## agent-service.ts 中的集成点

```typescript
// apps/electron/src/main/lib/agent-service.ts

import { remoteBridge } from './remote-bridge'

// 已有: const eventBus = new AgentEventBus()
// 已有: const adapter = new ClaudeAgentAdapter()
// 已有: const orchestrator = new AgentOrchestrator(adapter, eventBus)

// 已有 IPC 中间件（第 53 行）
eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
  }
  next()
})

// 新增 RemoteBridge 中间件（与 IPC 并列）
eventBus.use((sessionId, payload, next) => {
  remoteBridge.forward(sessionId, payload, next)
})

export { eventBus as agentEventBus, remoteBridge, ... }
```

**为什么 RemoteBridge 中间件注册在 IPC 中间件之后？**

EventBus 中间件按注册顺序执行。IPC 优先确保桌面 UI 延迟最低；RemoteBridge 的额外开销（JSON.stringify + WS send）不影响本地渲染。

---

## Token 生成与配对

```typescript
// apps/electron/src/main/lib/remote-auth.ts

import crypto from 'crypto'
import QRCode from 'qrcode'

export class RemoteAuth {
  private pairingTokens = new Map<string, { desktopToken: string; createdAt: number }>()

  // 生成新的配对 token（桌面端用户触发）
  generatePairingCode(): { code: string; qrcode: string; token: string } {
    const code = Array.from({ length: 6 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
    ).join('')
    const token = crypto.randomBytes(32).toString('hex')

    // 有效期 5 分钟
    this.pairingTokens.set(code, { desktopToken: token, createdAt: Date.now() })

    // 生成 QR 码（含 gateway URL + pairing code）
    const qrContent = `proma-remote://pair?gateway=wss://your-gateway.example.com&code=${code}`
    const qrcode = await QRCode.toDataURL(qrContent)

    return { code, qrcode, token }
  }

  // 验证配对（Gateway 调用）
  validatePairing(code: string): { desktopToken: string } | null {
    const record = this.pairingTokens.get(code)
    if (!record) return null

    // 过期检查（5 分钟）
    if (Date.now() - record.createdAt > 5 * 60 * 1000) {
      this.pairingTokens.delete(code)
      return null
    }

    this.pairingTokens.delete(code)
    return { desktopToken: record.token }
  }
}
```

配对流程：

```
1. 桌面用户点 "连接手机" → 生成 6 位配对短码 + QR
2. 桌面 RemoteBridge.connect(gatewayUrl, token) → 注册到 Gateway
3. 手机扫描 QR 或手动输入短码 → 获取 gatewayUrl + code
4. 手机 RemoteClient.connect(gatewayUrl, code) → 发给 Gateway
5. Gateway 在房间中 match(code) → 配对成功 → 双向消息开始
```

短码有效期 5 分钟，用完即失效，保证安全性。

---

## 与现有 IPC Handler 的对照

RemoteBridge 的上行处理与 `ipc.ts` 中的 IPC Handler 一一对应，调用相同的服务方法：

| 上行消息 | RemoteBridge 调用 | IPC Handler 调用 |
|---------|------------------|-----------------|
| `send_message` | `queueAgentMessage()` / `runAgent()` | `runAgent()` |
| `stop_agent` | `stopAgent()` | `stopAgent()` |
| `permission_respond` | `permissionService.respondToPermission()` | 同 |
| `askuser_respond` | `askUserService.respondToAskUser()` | 同 |
| `exitplan_respond` | `exitPlanService.respondToExitPlanMode()` | 同 |

所有业务逻辑只在一处实现（三个 Service 类中），IPC Handler 和 RemoteBridge 都是薄转发层。
