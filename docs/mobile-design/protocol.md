# 通信协议设计

## 协议总览

所有通信基于 WebSocket，消息格式为 JSON：

```typescript
type WireMessage =
  | { kind: 'auth'; token: string; role: 'desktop' | 'mobile' }  // 认证
  | { kind: 'auth_ok'; sessionId?: string }                       // 认证成功
  | { kind: 'auth_error'; reason: string }                        // 认证失败
  | DownMessage    // Gateway → 客户端
  | UpMessage      // 客户端 → Gateway
```

认证完成后，后续所有消息都是 `DownMessage` 或 `UpMessage`。

---

## 下行消息（Gateway → Mobile）

```typescript
// 桌面端通过 RemoteBridge 推送到 Gateway，Gateway 原样转发到 Mobile

type DownMessage =
  // ── 流式消息（桌面 Agent 实时产出） ──
  | {
      kind: 'sdk_message'
      sessionId: string
      message: SDKMessage                // 与现有 SDKMessage 完全一致
    }

  // ── 人机交互事件 ──
  | {
      kind: 'proma_event'
      sessionId: string
      event: PromaEvent                   // 与现有 PromaEvent 完全一致
    }

  // ── 会话列表（连接初始化 + 变更时） ──
  | {
      kind: 'session_list'
      sessions: SessionMeta[]             // 精简：id、title、workspaceName、updatedAt
    }

  // ── 连接状态事件 ──
  | {
      kind: 'peer_status'
      status: 'online' | 'offline'
    }

  // ── 错误 ──
  | {
      kind: 'error'
      code: string
      message: string
    }
```

### 关键设计决策

**为什么要转发原始 `SDKMessage` 和 `PromaEvent`？**

桌面端和移动端共用同一套事件体系。Gateway 不做格式转换——原始消息直接透传。移动端的渲染逻辑与桌面端 SDKMessageRenderer 共享核心数据结构，只是 UI 表达适配移动端竖屏布局。

这避免了 Gateway 层的格式转换错误和版本兼容问题。

---

## 上行消息（Mobile → Gateway → Desktop）

```typescript
type UpMessage =
  // ── 会话查询 ──
  | {
      kind: 'list_sessions'
      requestId: string
    }

  | {
      kind: 'get_messages'
      requestId: string
      sessionId: string
      since?: number                       // seqNo 起点的增量拉取
    }

  // ── Agent 操作 ──
  | {
      kind: 'send_message'
      requestId: string
      sessionId: string
      text: string
      // 如果是新 session：channelId, workspaceId (可选，用默认)
    }

  | {
      kind: 'stop_agent'
      requestId: string
      sessionId: string
    }

  // ── 人机交互响应 ──
  | {
      kind: 'permission_respond'
      requestId: string                    // PermissionRequest.requestId
      behavior: 'allow' | 'deny'
      alwaysAllow: boolean
    }

  | {
      kind: 'askuser_respond'
      requestId: string                    // AskUserRequest.requestId
      answers: Record<string, string>      // question text → answer text
    }

  | {
      kind: 'exitplan_respond'
      requestId: string                    // ExitPlanModeRequest.requestId
      action: 'approve_auto' | 'approve_edit' | 'deny' | 'feedback'
      feedback?: string                    // 仅 action='feedback' 时有值
    }
```

### 关键设计决策

**为什么 requestId 作为交互响应的匹配键？**

三块人机交互服务（PermissionService / AskUserService / ExitPlanService）都使用 `requestId` 作为 Pending Promise 的 key。移动端的响应直接传入已有的 `respond*()` 方法：

```typescript
// 桌面端 RemoteBridge 收到上行消息时（与实际 IPC handler 逻辑一致）
case 'permission_respond':
  permissionService.respondToPermission(msg.requestId, msg.behavior, msg.alwaysAllow)
  break
case 'askuser_respond':
  askUserService.respondToAskUser(msg.requestId, msg.answers)
  break
case 'exitplan_respond':
  exitPlanService.respondToExitPlanMode({ requestId: msg.requestId, action: msg.action, feedback: msg.feedback })
  break
```

Gateway 不需要知道 requestId 的语义，只是转发。

---

## 会话列表同步（session_list 下行消息）

连接建立后，桌面端立即推送完整会话列表：

```typescript
// 下行
{
  kind: 'session_list',
  sessions: [
    {
      id: 'abc-123',
      title: '重构 auth 模块',
      workspaceName: '我的项目',
      updatedAt: 1715123456789,
      messageCount: 42,
      isActive: true                     // 是否正在运行中
    }
  ]
}
```

**为什么不直接传 `AgentSessionMeta`？**

`AgentSessionMeta` 包含 `channelId`、`sdkSessionId`、`forkSourceDir` 等桌面端内部字段。这些对移动端毫无意义且可能包含敏感信息（SDK Session ID）。`session_list` 只提取展示所需的最小字段。

---

## 消息历史加载（get_messages 上行 + sdk_message 批量下行）

移动端连接后按需加载消息历史：

```
Mobile → Gateway: { kind: 'get_messages', requestId: 'r1', sessionId: 'abc-123', since: 0 }
Gateway → Desktop: 转发
Desktop → Gateway: 读取 JSONL，批量发送多条 sdk_message
Gateway → Mobile:  转发每条 sdk_message

// 增量拉取（重连后）
Mobile → Gateway: { kind: 'get_messages', requestId: 'r2', sessionId: 'abc-123', since: 42 }
// 只返回 seqNo > 42 的新消息
```

**为什么是桌面端读取 JSONL 而不是 Gateway 读？**

桌面端是唯一真相源。让桌面端而不是 Gateway 直接读取 JSONL 保证了数据一致性——如果让 Gateway 访问桌面端的文件系统，需要额外的文件共享机制（NFS、同步、权限），且引入了另一个真相源。

---

## 错误处理

```typescript
// 下行错误
{
  kind: 'error',
  code: 'session_not_found' | 'desktop_offline' | 'rate_limited' | 'auth_expired',
  message: string
}
```

移动端的错误处理策略：
- `desktop_offline`: 显示状态指示，禁用输入，允许查看历史
- `session_not_found`: 刷新会话列表
- `auth_expired`: 重新走配对流程
- 网络断开: 自动重连（指数退避 1s/2s/4s/8s/10s cap）
