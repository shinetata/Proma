# 移动端 App 设计

## 技术栈

```
React 18      ← 已有技能
TypeScript    ← 已有技能
Vite          ← 构建工具
Capacitor     ← 原生壳（调相机、本地通知）
IndexedDB     ← 本地缓存（idb 库）
react-markdown ← Markdown 渲染
```

## 项目结构

```
proma-mobile/
├── index.html
├── vite.config.ts
├── capacitor.config.ts
├── package.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── config.ts                ← gatewayUrl 配置
│   │
│   ├── services/
│   │   ├── RemoteClient.ts      ← WebSocket 客户端
│   │   ├── Storage.ts           ← IndexedDB 封装
│   │   └── Notifications.ts     ← Capacitor 本地通知
│   │
│   ├── screens/
│   │   ├── ConnectScreen.tsx    ← 扫码/输入短码连接
│   │   ├── SessionList.tsx      ← 会话列表
│   │   └── ChatScreen.tsx       ← 消息 + 输入 + 审批
│   │
│   ├── components/
│   │   ├── MessageBubble.tsx    ← 复用桌面端 SDKMessageRenderer 逻辑
│   │   ├── PermissionCard.tsx   ← 权限审批
│   │   ├── AskUserCard.tsx      ← AskUser 问答
│   │   ├── ExitPlanCard.tsx     ← ExitPlanMode 审批
│   │   └── ToolCallCard.tsx     ← 工具调用展示
│   │
│   └── hooks/
│       └── useConnection.ts     ← WS 连接管理 hook
```

## 核心服务

### RemoteClient

```typescript
// src/services/RemoteClient.ts

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

class RemoteClient {
  private ws: WebSocket | null = null
  private state: ConnectionState = 'disconnected'
  private listeners = new Map<string, Set<Function>>()

  // 连接（短码配对）
  connect(gatewayUrl: string, pairingCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(gatewayUrl)
      this.state = 'connecting'

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({
          kind: 'auth',
          role: 'mobile',
          code: pairingCode,
          token: '', // Gateway 验证 short code
        }))
      }

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)

        if (msg.kind === 'auth_ok') {
          this.state = 'connected'
          this.requestSessionList()
          resolve()
          return
        }
        if (msg.kind === 'auth_error') {
          reject(new Error(msg.reason))
          return
        }

        // 业务消息 → 分发给 listeners
        this.dispatch(msg)
      }

      this.ws.onclose = () => {
        this.state = 'reconnecting'
        this.scheduleReconnect(gatewayUrl, pairingCode)
      }
    })
  }

  // 发送上行消息
  send(msg: UpMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // 监听下行消息
  on(kind: string, handler: Function): () => void {
    if (!this.listeners.has(kind)) {
      this.listeners.set(kind, new Set())
    }
    this.listeners.get(kind)!.add(handler)
    return () => this.listeners.get(kind)?.delete(handler)
  }

  private dispatch(msg: Record<string, unknown>): void {
    const handlers = this.listeners.get(msg.kind as string)
    handlers?.forEach(h => h(msg))
  }

  private scheduleReconnect(gatewayUrl: string, code: string): void {
    let attempt = 0
    const tryReconnect = () => {
      attempt++
      const delay = Math.min(1000 * Math.pow(2, attempt), 20_000)
      setTimeout(() => {
        if (this.state === 'reconnecting') {
          this.connect(gatewayUrl, code).catch(() => tryReconnect())
        }
      }, delay)
    }
    tryReconnect()
  }

  disconnect(): void {
    this.state = 'disconnected'
    this.ws?.close()
  }
}

export const remoteClient = new RemoteClient()
```

### Storage (IndexedDB)

```typescript
// src/services/Storage.ts
import { openDB, DBSchema } from 'idb'

interface PromaDB extends DBSchema {
  sessions: {
    key: string
    value: { id: string; title: string; workspaceName?: string; updatedAt: number; messageCount: number }
  }
  messages: {
    key: string    // sessionId + '_' + seqNo
    value: { sessionId: string; seqNo: number; type: string; content: SDKMessage; createdAt: number }
    indexes: { 'by-session': [string, number] }
  }
}

const db = await openDB<PromaDB>('proma-mobile', 1, {
  upgrade(db) {
    db.createObjectStore('sessions', { keyPath: 'id' })
    const msgStore = db.createObjectStore('messages', { keyPath: ['sessionId', 'seqNo'] })
    msgStore.createIndex('by-session', ['sessionId', 'seqNo'])
  },
})

export async function getMessages(sessionId: string, since = 0): Promise<SDKMessage[]> {
  const messages = await db.getAllFromIndex('messages', 'by-session',
    IDBKeyRange.bound([sessionId, since], [sessionId, Infinity])
  )
  return messages.map(m => m.content)
}

export async function appendMessages(sessionId: string, messages: SDKMessage[]): Promise<void> {
  // ...
}
```

## 核心页面

### ChatScreen 渲染逻辑

```tsx
// src/screens/ChatScreen.tsx

function ChatScreen({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingAskUser, setPendingAskUser] = useState<AskUserRequest | null>(null)
  const [pendingExitPlan, setPendingExitPlan] = useState<ExitPlanModeRequest | null>(null)

  useEffect(() => {
    // 加载本地缓存
    const cached = await getMessages(sessionId)
    setMessages(cached)

    // 监听实时下行消息
    remoteClient.on('sdk_message', (msg) => {
      const displayMsg = decodeSDKMessage(msg.message)
      setMessages(prev => [...prev, displayMsg])
      await appendMessages(sessionId, [msg.message])
    })

    remoteClient.on('proma_event', (msg) => {
      switch (msg.event.type) {
        case 'permission_request':
          setPendingPermission(msg.event.request)
          break
        case 'permission_resolved':
          setPendingPermission(null)
          break
        case 'ask_user_request':
          setPendingAskUser(msg.event.request)
          break
        case 'ask_user_resolved':
          setPendingAskUser(null)
          break
        case 'exit_plan_mode_request':
          setPendingExitPlan(msg.event.request)
          break
        case 'exit_plan_mode_resolved':
          setPendingExitPlan(null)
          break
      }
    })
  }, [sessionId])

  return (
    <View>
      {/* 消息列表 */}
      <FlatList data={messages} renderItem={({ item }) => <MessageBubble msg={item} />} />

      {/* 有三个 pending 时优先显示审批 UI */}
      {pendingPermission && (
        <PermissionCard
          request={pendingPermission}
          onAllow={(always) => remoteClient.send({
            kind: 'permission_respond',
            requestId: pendingPermission.requestId,
            behavior: 'allow',
            alwaysAllow: always,
          })}
          onDeny={() => remoteClient.send({
            kind: 'permission_respond',
            requestId: pendingPermission.requestId,
            behavior: 'deny',
            alwaysAllow: false,
          })}
        />
      )}

      {pendingAskUser && (
        <AskUserCard
          request={pendingAskUser}
          onSubmit={(answers) => remoteClient.send({
            kind: 'askuser_respond',
            requestId: pendingAskUser.requestId,
            answers,
          })}
        />
      )}

      {pendingExitPlan && (
        <ExitPlanCard
          request={pendingExitPlan}
          onAction={(action, feedback?) => remoteClient.send({
            kind: 'exitplan_respond',
            requestId: pendingExitPlan.requestId,
            action,
            feedback,
          })}
        />
      )}

      {/* 输入栏 */}
      {!pendingPermission && !pendingAskUser && !pendingExitPlan && (
        <InputBar
          onSend={(text) => remoteClient.send({
            kind: 'send_message',
            requestId: crypto.randomUUID(),
            sessionId,
            text,
          })}
          onStop={() => remoteClient.send({
            kind: 'stop_agent',
            requestId: crypto.randomUUID(),
            sessionId,
          })}
        />
      )}
    </View>
  )
}
```

### 审批卡片设计

三个审批 UI 是移动端与桌面端的关键差异点——桌面端用横幅/弹窗，移动端适配底部弹出卡片：

```
PermissionCard:
┌──────────────────────────┐
│ ⚡ Agent 操作             │
│ 写入文件: /src/auth.ts   │
│ 危险等级: normal          │
│                          │
│ [拒绝] [允许一次] [始终允许]│
└──────────────────────────┘

AskUserCard:
┌──────────────────────────┐
│ Auth 方案选择             │
│ 使用哪个认证方案？         │
│                          │
│ ● JWT — 无状态, 适合微服务│
│ ○ Session — 传统方案      │
│                          │
│      [确认选择]           │
└──────────────────────────┘

ExitPlanCard:
┌──────────────────────────┐
│ 📋 计划已完成              │
│                          │
│ 后续操作:                 │
│ • Bash: npm run test     │
│ • Bash: npm install      │
│                          │
│ [拒绝]  [批准·手动] [批准·自动]│
└──────────────────────────┘
```

## 构建与打包

### 开发阶段

```bash
# 浏览器开发（直接用 Chrome DevTools 调试）
npm run dev

# 真机预览（通过 Capacitor）
npm run build
npx cap sync
npx cap open ios     # Xcode → 选自己 iPhone → Run
npx cap open android # Android Studio → Run
```

### 生产打包

```bash
# iOS（免费开发者账号，Xcode 直装）
npx cap sync
npx cap open ios
# Xcode: Product → Archive → Distribute → Development → 安装到 iPhone
# 免费账号有效期 7 天，到期重新打包

# Android
npx cap sync
npx cap open android
# Android Studio: Build → Build Bundle(s) / APK(s) → 生成 .apk
```

### Capacitor 配置

```typescript
// capacitor.config.ts
import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.proma.mobile',
  appName: 'Proma Remote',
  webDir: 'dist',
  bundledWebRuntime: false,
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_notification',
      iconColor: '#4880FF',
    },
    Camera: {
      // 仅用于 QR 扫描
    },
  },
}
```

---

## 移动端能力清单（完整）

| 优先级 | 功能 | 组件/服务 | 依赖 |
|-------|------|---------|------|
| P0 | WS 连接 + 短码配对 | RemoteClient | 标准 WebSocket |
| P0 | 断线自动重连（指数退避） | RemoteClient.scheduleReconnect | — |
| P0 | 消息实时接收 | ChatScreen | RemoteClient.on('sdk_message') |
| P0 | 文本输入 + 发送 | InputBar | RemoteClient.send('send_message') |
| P0 | 停止 Agent | InputBar 按钮 | RemoteClient.send('stop_agent') |
| P0 | 权限审批（allow/deny/always） | PermissionCard | RemoteClient.send('permission_respond') |
| P0 | AskUser 问答（单选/多选） | AskUserCard | RemoteClient.send('askuser_respond') |
| P0 | 本地 IndexedDB 缓存 | Storage | idb |
| P0 | 桌面离线状态 + 历史查看 | 连接指示器 | RemoteClient.on('peer_status') |
| P1 | ExitPlanMode 审批 | ExitPlanCard | RemoteClient.send('exitplan_respond') |
| P1 | 会话列表 + 切换 | SessionList | RemoteClient.send('list_sessions') |
| P1 | 本地通知 | Notifications | @capacitor/local-notifications |
| P1 | 工具调用/结果卡片 | ToolCallCard | — |
| P2 | 消息内代码高亮 | MessageBubble | 轻量语法高亮 |
| P2 | 暗色模式 | 全局 theme | — |
| P2 | 消息搜索 | SearchBar | IndexedDB 文本匹配 |

## 桌面端组件复用

移动端可复用桌面端渲染进程的核心逻辑（数据结构处理），而不是复制整个组件：

```
桌面端                             移动端
SDKMessageRenderer.tsx      →     MessageBubble.tsx
  ├─ decodeTextBlock()      复用    提取文本
  ├─ decodeToolUseBlock()   复用    提取工具调用信息
  ├─ decodeThinkingBlock()  复用    提取思考内容
  └─ 渲染逻辑              重写    适配移动端竖屏

PermissionBanner.tsx        →     PermissionCard.tsx
  ├─ dangerLevel 颜色映射   复用
  ├─ description 格式化     复用
  └─ 渲染布局              重写    底部弹出式

AskUserBanner.tsx           →     AskUserCard.tsx
  ├─ 问题解析逻辑           复用
  └─ 渲染布局              重写    竖向单选项列表

ExitPlanModeBanner.tsx      →     ExitPlanCard.tsx
  ├─ allowedPrompts 格式化  复用
  └─ 渲染布局              重写    底部弹出卡片
```
