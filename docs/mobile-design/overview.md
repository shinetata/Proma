# Proma Remote — 移动端架构设计

## 背景

Proma 桌面端已具备完整的 Agent 编排能力——多轮自主推理、工具调用链、权限审批、Session 恢复、SubAgent 协作等。用户在离开桌面时需要能通过手机实时继续会话级任务，而不仅仅是查看消息。

本设计对标 Claude Code `/remote` 体验，实现真正的双端会话互联：桌面的流式消息、Agent 思考过程、权限审批、AskUser 问答——全部同步到手机；手机上的一切操作（输入/停止/审批/作答）全部回传到桌面并影响 Agent 执行。

## 总体架构

采用 **Gateway 中继模式**（参考 OpenClaw GateWay）——桌面和手机都向一个中继网关发起出站 WebSocket 连接，网关负责消息路由。不需要公网 IP，不需暴露端口，不需 NAT 穿透。

```
┌─────────────────────────────────────────────┐
│              Gateway（中继服务）               │
│                                              │
│  ┌─────────────────────────────────────┐     │
│  │  房间管理（以 session 为单位)          │     │
│  │  ┌─────────┐  ┌─────────┐           │     │
│  │  │ Room A  │  │ Room B  │  ...      │     │
│  │  │ desk │ mobile│ desk │mobile│      │     │
│  │  └─────────┘  └─────────┘           │     │
│  └─────────────────────────────────────┘     │
│                                              │
│  职责：认证配对、消息路由、连接管理、离线排队   │
└────────┬────────────────────────┬────────────┘
         │ WebSocket (出站)        │ WebSocket (出站)
         │                        │
┌────────┴──────────┐    ┌───────┴──────────┐
│ 桌面 Proma        │    │ 移动端 App         │
│                   │    │                   │
│ RemoteBridge      │    │ RemoteClient      │
│  ├─ 发起连接       │    │  ├─ 发起连接       │
│  ├─ 转发全部事件   │    │  ├─ 接收全部事件   │
│  ├─ 接收操作指令   │    │  ├─ 发送操作指令   │
│  ├─ 会话列表同步   │    │  └─ 本地 IndexedDB │
│  └─ EventBus 接入  │    │                   │
│                   │    │ React SPA          │
│ AgentOrchestrator │    │ Capacitor 壳       │
│ claude binary     │    │                   │
└───────────────────┘    └───────────────────┘
```

### 为什么是 Gateway 而不是局域网直连？

| 维度 | LAN 直连 | Gateway 中继 |
|------|---------|------------|
| 出门（蜂窝网络） | 不可用 | 可用 |
| NAT/防火墙 | 可能不通 | 无影响 |
| 配对方式 | IP:Port 扫码 | 短码配对 |
| 部署复杂度 | 零 | 需一个小服务 |
| 安全性 | 局域网内 | 加密传输 + Token 双向认证 |

Gateway 只需 ~300 行 Node.js，可以部署在用户自己的 VPS 上，或后期提供托管服务。

### 桌面离线策略

桌面端关机或休眠时：
- 移动端显示 "桌面端未连接" 状态指示
- 本地 IndexedDB 缓存的历史消息仍可完整查看
- 输入框禁用，提示 "桌面端不在线"
- 不排队消息（避免恢复后消息顺序混乱）

---

## 核心原则

**桌面端是唯一的真相源（Source of Truth）**。所有 AI 推理、工具执行、文件读写、权限决定都在桌面端完成。Gateway 不做任何业务逻辑处理，只是消息路由。移动端是完整的人机交互终端，不是精简版。

**桌面端代码改动最小化**。RemoteBridge 利用已有 EventBus 中间件机制接入；移动端的所有操作都映射到已有的 Service 方法（permissionService.respondToPermission / askUserService.respondToAskUser 等），不复刻任何业务逻辑。

---

## 三端交互全景

```
SDK 调用 canUseTool('Write', ...)
  │
  ├─ permissionService 构建 PermissionRequest
  ├─ EventBus.emit('permission_request')
  │     ├─ IPC 中间件 → 桌面渲染进程 → PermissionBanner
  │     └─ RemoteBridge 中间件 → Gateway → 手机 → PermissionCard
  │
  │  用户在手机点击 "允许"
  │     └─ RemoteClient → Gateway → RemoteBridge
  │           └─ permissionService.respondToPermission(requestId, 'allow')
  │                 └─ Pending Promise resolve
  │                       └─ canUseTool 返回 { behavior: 'allow' }
  │                             └─ SDK 继续执行 Write
  │
  │  桌面端的 PermissionBanner 同步消失
  │  （通过 EventBus 回推 resolved 事件）
```

关键在于：**三块人机交互服务（Permission / AskUser / ExitPlanMode）的双向通信都是通过已有服务实例的方法调用完成的，不重复实现任何交互逻辑。**

---

## 实施阶段

### Phase 1: Gateway + 桌面端 RemoteBridge（~2 周）

| 步骤 | 产出 |
|------|------|
| Gateway 服务搭建 | Node.js WebSocket relay, 房间管理, 短码配对 |
| 桌面端 RemoteBridge | EventBus 中间件, 出站 WS 客户端, 上行指令处理 |
| 基础协议验证 | 桌面→Gateway→桌面（自测）, 消息完整性 |

### Phase 2: 移动端 P0 能力（~2 周）

| 优先级 | 功能 |
|-------|------|
| P0 | WebSocket 连接 + 短码配对 + 断线重连 |
| P0 | 消息实时接收和渲染（SDKMessage 完整展示） |
| P0 | 文本输入 + 发送 + 停止 Agent |
| P0 | 权限审批（allow / deny / always allow） |
| P0 | AskUser 问答（single / multi select） |
| P0 | 本地 IndexedDB 离线缓存 |
| P0 | 桌面离线状态指示 + 历史查看 |

### Phase 3: 移动端 P1 能力（~1 周）

| 优先级 | 功能 |
|-------|------|
| P1 | ExitPlanMode 审批（四种 action） |
| P1 | 会话列表 + 切换会话 |
| P1 | 本地通知（Agent 回复完成） |
| P1 | 工具调用/结果卡片渲染 |
| P1 | Markdown 渲染（消息气泡） |

### Phase 4: 完善（~1 周）

| 优先级 | 功能 |
|-------|------|
| P2 | 消息内代码块语法高亮 |
| P2 | 消息搜索 |
| P2 | 暗色模式 |
| P2 | 多桌面端支持（多 token 管理） |
