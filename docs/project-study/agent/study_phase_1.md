# 第一阶段：Agent 的骨架

## 学习目标

读完第一阶段，你应该能画出：**用户输入 → IPC → AgentService → Orchestrator → Adapter → SDK** 这条主链路。

你需要理解：

- 一个 Agent 系统需要哪些核心数据类型
- 这些数据怎么在主进程和渲染进程之间流动
- 各组件怎么创建和连接在一起

阅读顺序：类型定义 → 事件总线 → Agent 服务入口。

---

## 1. 类型定义——系统的"词汇表"

文件路径：
- `packages/shared/src/types/agent-provider.ts`（65 行）
- `packages/shared/src/types/agent.ts`（1369 行）

不要被 1369 行吓到，大部分是辅助类型。我们只看核心的几个。

### 1.1 最关键的抽象：AgentProviderAdapter

```typescript
// agent-provider.ts - 只有 65 行，但定义了整个系统的"心脏接口"

export interface AgentProviderAdapter {
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  abort(sessionId: string): void
  dispose(): void
  // 下面三个是可选的扩展能力
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput): Promise<void>
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
}
```

**为什么要定义这个接口？**

想象你要做一个"万能遥控器"，能控制不同品牌的电视。每台电视的内部实现完全不同，但遥控器只需要知道"开机""关机""换台"这几个按钮。换一台新品牌的电视，只要它还认这几个按钮，遥控器就不用改。

`AgentProviderAdapter` 就是这个"遥控器接口"：

- `query()` → 发消息给 AI，拿到回复流
- `abort()` → 停止当前会话
- `dispose()` → 销毁资源

未来如果你想换成另一个 AI 引擎（比如 PiAgent），只要实现这三个方法，整个系统其他代码一行不用改。

**Proma 当前只有一个实现**：`ClaudeAgentAdapter`（第二阶段会详细读），它底层是一个独立的 CLI 子进程，通过 stdin/stdout 与 SDK 通信。

### 1.2 消息的"通用语言"：SDKMessage

```typescript
// agent.ts - SDK 消息联合类型
export type SDKMessage =
  | SDKAssistantMessage    // AI 的回复（文本 + 工具调用）
  | SDKUserMessage         // 用户输入 + 工具执行结果
  | SDKResultMessage       // 一轮对话结束的信号
  | SDKSystemMessage       // 系统事件（初始化、压缩、任务状态）
  | SDKToolProgressMessage // 工具执行进度心跳
  | SDKPromptSuggestionMessage
  | SDKToolUseSummaryMessage
```

这个联合类型是 Agent 系统的"通用语言"——无论底层是 Claude SDK 还是未来的 PiAgent SDK，适配器产出的都是这几种消息，上层编排器和 UI 只认这个格式。

**用实际例子理解每种消息**：

假设用户说"帮我读取 README.md 文件"，Agent 会产生这样的消息流：

```
SDKAssistantMessage {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "我来读取 README.md 文件。" },
      { type: "tool_use", id: "tool_001", name: "Read", input: { file_path: "/path/README.md" } }
    ]
  }
}

↓（Agent 执行 Read 工具后）

SDKUserMessage {
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "tool_001", content: "文件内容是..." }
    ]
  }
}

↓（Agent 看到结果后继续回复）

SDKAssistantMessage {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "README.md 的内容如上，它包含了..." }
    ]
  }
}

↓（一轮对话结束）

SDKResultMessage {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 1500, output_tokens: 300 }
}
```

**关键设计点**：`SDKUserMessage` 承载两种不同含义：

- 用户输入的文本（`content: [{ type: "text", text: "帮我读文件" }]`）
- 工具执行结果（`content: [{ type: "tool_result", ... }]`）

它们共享同一个类型，因为 SDK 内部把它们视为同一个角色——"来自人类侧的信息"，包括工具结果也是人类侧系统执行后返回的。

这就是为什么在持久化时（第二阶段会看到），Orchestrator 会过滤：只保留含 `tool_result` 的 user 消息，丢弃 SDK 重新推来的纯文本 user 消息。

### 1.3 前端事件：AgentEvent

```typescript
// agent.ts - UI 驱动事件
export type AgentEvent =
  | { type: 'text_delta'; text: string }       // AI 逐字输出
  | { type: 'tool_start'; toolName: string }   // 开始执行工具
  | { type: 'tool_result'; result: string }    // 工具执行完成
  | { type: 'complete'; stopReason?: string }  // 本轮完成
  | { type: 'error'; message: string }         // 出错了
  | { type: 'permission_request'; request }    // 需要用户审批
  // ... 还有很多
```

**为什么有两套消息格式？SDKMessage vs AgentEvent？**

`SDKMessage` 是 SDK 原始产出，结构复杂（嵌套的 content 数组），不适合直接驱动 UI。

`AgentEvent` 是扁平化的"UI 事件"，从 `SDKMessage` 转换而来。比如一个 `SDKAssistantMessage` 里的 `content` 数组可能同时包含文本和工具调用，转换后就变成一连串 `text_delta` 事件，中间夹一个 `tool_start` 事件。

**转换逻辑**在 `useGlobalAgentListeners.ts` 里（第五阶段会读到），它做的事情大概是：

```typescript
// 伪代码
function sdkMessageToEvents(msg: SDKMessage): AgentEvent[] {
  if (msg.type === 'assistant') {
    const events = []
    for (const block of msg.message.content) {
      if (block.type === 'text') events.push({ type: 'text_delta', text: block.text })
      if (block.type === 'tool_use') events.push({ type: 'tool_start', toolName: block.name })
    }
    return events
  }
  // ... 其他消息类型类似转换
}
```

### 1.4 从发送到接收的完整数据结构

```
用户输入
  ↓
AgentSendInput {
  sessionId: "abc-123",
  userMessage: "帮我重构 auth 模块",
  channelId: "ch-001",     // 用哪个 API 渠道
  modelId: "claude-sonnet-4-6",
  workspaceId: "ws-456",   // 用哪个工作区
}

  ↓ Orchestrator 处理后，传给 Adapter

AgentQueryInput {
  sessionId: "abc-123",
  prompt: "<conversation_history>...\n\n帮我重构 auth 模块",  // 已注入上下文
  model: "claude-sonnet-4-6",
  cwd: "/Users/xxx/.proma/agent-workspaces/my-project/abc-123",
}

  ↓ Adapter 返回（AsyncIterable 流，逐个产出）

SDKMessage → SDKMessage → SDKMessage → ...

  ↓ EventBus 分发到渲染进程

AgentStreamPayload {
  kind: 'sdk_message',  // 或 'proma_event'
  message: SDKMessage,  // 或 event: PromaEvent
}

  ↓ 渲染进程转换为 UI 事件

AgentEvent → AgentEvent → AgentEvent → ...
```

**小结**：读完类型定义，你应该能回答：一条用户消息从发起到 AI 回复完成，经过了哪些数据结构的转换？答案是 `AgentSendInput → AgentQueryInput → SDKMessage → AgentStreamPayload → AgentEvent`。

---

## 2. EventBus——系统的"神经系统"

文件路径：`apps/electron/src/main/lib/agent-event-bus.ts`（93 行）

这是整个系统最简洁的组件，但也是最重要的架构解耦点。

### 2.1 它解决了什么问题？

Electron 应用里，主进程（Node.js）和渲染进程（Chromium）是两个独立的进程。主进程运行 Agent，渲染进程显示 UI。它们之间通过 `webContents.send()` / `ipcRenderer.on()` 通信。

如果 Orchestrator 直接调用 `webContents.send()`，会出现两个问题：

1. **测试困难**：单元测试里没有 Electron，无法 mock `webContents`
2. **扩展困难**：假如未来要让飞书 Bot 也能收到 Agent 事件，就得在 Orchestrator 里到处加 `if (feishuBot) { ... }`

EventBus 的解决方案：**Orchestrator 只向 EventBus 发射事件，不关心谁在听。**

### 2.2 实现

```typescript
export class AgentEventBus {
  private handlers: Set<AgentEventHandler> = new Set()
  private middlewares: AgentEventMiddleware[] = []

  // 发射事件：先走中间件链，再分发给所有监听器
  emit(sessionId: string, payload: AgentStreamPayload): void {

    // 构建最终的执行函数
    const dispatch = (): void => {
      for (const handler of this.handlers) {
        handler(sessionId, payload)  // 通知所有监听器
      }
    }

    // 把中间件串成链：middleware1 → middleware2 → ... → dispatch
    // 从最后一个中间件开始，逐层包裹
    let chain = dispatch
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const middleware = this.middlewares[i]
      const next = chain
      chain = () => middleware(sessionId, payload, next)
    }

    chain()  // 执行整条链
  }

  on(handler): () => void { /* 注册监听器，返回取消函数 */ }
  use(middleware): void { /* 注册中间件 */ }
}
```

**用例子理解中间件链**：

```
注册了两个中间件：
  middleware1: 打日志 ("event received")
  middleware2: 转发到 IPC (webContents.send)

事件流：
  emit(payload)
    → middleware1: console.log("event received"), 调用 next()
      → middleware2: webContents.send(payload), 调用 next()
        → dispatch: 通知所有 handler
```

**关键细节**：中间件可以**拦截**事件——如果某个中间件不调用 `next()`，后续中间件和 handler 都不会执行。比如你可以加一个"速率限制"中间件，每秒最多发 10 个事件，超出的直接丢弃。

### 2.3 实际怎么用的？

```typescript
// agent-service.ts 第 53-63 行
eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)  // 找到目标窗口
  if (wc && !wc.isDestroyed()) {
    wc.send('agent:stream:event', { sessionId, payload })  // 发到渲染进程
  }
  next()  // 继续传给下一个中间件/handler
})
```

这段代码做的事情：每次 Orchestrator 调用 `eventBus.emit(sessionId, payload)` 时，自动把事件通过 IPC 推送给对应的浏览器窗口。Orchestrator 完全不知道 IPC 的存在。

**小结**：93 行代码实现了"发射-转发-监听"的解耦模式。你以后搭 Agent 系统，也应该先定义这样一个事件层，不要直接在核心逻辑里写 IPC/WebSocket/HTTP 调用。

---

## 3. AgentService——系统的"接线板"

文件路径：`apps/electron/src/main/lib/agent-service.ts`（360 行）

这是最"薄"的一层——它不处理任何业务逻辑，只做三件事：**创建实例、接线、转发**。

### 3.1 创建三个单例

```typescript
// 第 36-38 行
const eventBus = new AgentEventBus()
const adapter = new ClaudeAgentAdapter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)
```

三个对象的依赖关系：

```
AgentOrchestrator  ← 核心编排器（大脑）
  ├── adapter: ClaudeAgentAdapter  ← 与 AI 通信（嘴巴和耳朵）
  └── eventBus: AgentEventBus     ← 向外界发送事件（神经系统）
```

Orchestrator 是大脑，它想问题时通过 adapter 和 AI 对话，思考结果通过 eventBus 告诉外界。

**注意依赖方向**：Orchestrator 依赖 Adapter 接口，不依赖具体实现。这样你可以 mock 一个假 Adapter 来测试 Orchestrator 的逻辑，不启动真正的 AI 调用。

### 3.2 注册 IPC 中间件（接线）

```typescript
// 第 53-63 行
eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload })
  }
  next()
})
```

这一行代码把 EventBus 和 Electron IPC 接上了。之后 Orchestrator 的任何 `eventBus.emit()` 调用都会自动推送到 UI。

### 3.3 runAgent——IPC 薄包装

```typescript
// 第 72-129 行
export async function runAgent(input: AgentSendInput, webContents: WebContents) {
  // 1. 记录哪个窗口对应哪个 session
  sessionWebContents.set(input.sessionId, webContents)

  // 2. 调用编排器，传入三个回调
  await orchestrator.sendMessage(input, {
    onError: (error) => {
      webContents.send('agent:stream:error', { sessionId, error })
    },
    onComplete: (messages, opts) => {
      webContents.send('agent:stream:complete', { sessionId, messages, ... })
    },
    onTitleUpdated: (title) => {
      webContents.send('agent:title-updated', { sessionId, title })
    },
  })
}
```

**为什么需要 SessionCallbacks？**

EventBus 处理的是**流式事件**（每个 SDKMessage 逐个推送）。但还有**控制信号**——流开始、流结束、出错——这些不适合走 EventBus，因为：

1. 只有调用方（`runAgent`）关心这些信号，不需要广播
2. 这些信号需要携带额外数据（如 `onComplete` 要带已持久化的完整消息列表）

所以 Orchestrator 的设计是：

```
Orchestrator.sendMessage()
  ├── 通过 eventBus.emit() 发流式事件 → EventBus → IPC → 渲染进程
  └── 通过 callbacks 发控制信号 → 直接 IPC → 渲染进程（不走 EventBus）
```

**两种事件通道的设计哲学**：

| 通道 | 用途 | 发送方式 | 接收方 |
|------|------|---------|--------|
| EventBus | 流式事件（每个消息实时推送） | `eventBus.emit()` | 中间件链 → IPC → 所有监听器 |
| SessionCallbacks | 生命周期信号（开始/结束/错误/标题变更） | 直接回调 | 调用方（runAgent）→ IPC |

### 3.4 完整的调用链路图

```
┌─ 渲染进程 ─────────────────────────────────────────────────┐
│                                                             │
│  AgentView.tsx                                              │
│    window.electronAPI.sendAgentMessage(input)               │
│      │                                                      │
│      │ IPC: 'agent:send-message'                            │
│      │                                                      │
├──────┼──────────────────────────────────────────────────────┤
│      ▼                                                      │
│  ┌─ ipc.ts ────────────────────────────────────────┐       │
│  │ ipcMain.handle('agent:send-message',             │       │
│  │   (_, input) => runAgent(input, webContents))    │       │
│  └────────────────┬────────────────────────────────┘       │
│                   │                                         │
│  ┌─ agent-service.ts ──────────────────────────────┐       │
│  │                                                  │       │
│  │  runAgent(input, webContents)                    │       │
│  │    ├─ sessionWebContents.set(sessionId, wc)      │       │
│  │    │                                             │       │
│  │    └─ orchestrator.sendMessage(input, {          │       │
│  │         onError: → wc.send('stream:error')       │       │
│  │         onComplete: → wc.send('stream:complete') │       │
│  │         onTitleUpdated: → wc.send('title-updated')│      │
│  │       })                                         │       │
│  │                                                  │       │
│  │  eventBus.use(← IPC 中间件已注册)                │       │
│  │    ↑                                             │       │
│  └────┼─────────────────────────────────────────────┘       │
│       │                                                     │
│  ┌─ AgentOrchestrator ─────────────────────────────┐       │
│  │                                                  │       │
│  │  sendMessage()                                   │       │
│  │    ├─ 构建 queryOptions                          │       │
│  │    ├─ adapter.query(options) → AsyncIterable     │       │
│  │    │     │                                        │       │
│  │    │     ▼ 遍历 SDKMessage 流                     │       │
│  │    │     ├─ eventBus.emit(sdk_message) →→→→→→→→  │       │
│  │    │     │                              IPC      │       │
│  │    │     ├─ 持久化累积的消息                       │       │
│  │    │     └─ 错误分类 + 重试判断                    │       │
│  │    │                                             │       │
│  │    └─ callbacks.onComplete(messages) →→→→→→→→    │       │
│  │                                          IPC     │       │
│  │                                                  │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 第一阶段总结

读完这三部分，你心里应该有一个清晰的骨架：

| 组件 | 角色 | 比喻 |
|------|------|------|
| **类型定义** | 定义数据的形状和接口 | 词汇表 + 合同 |
| **AgentProviderAdapter** | 与 AI 引擎通信的抽象接口 | 万能遥控器 |
| **SDKMessage** | 所有消息的统一格式 | 通用语言 |
| **AgentEventBus** | 解耦主进程和 UI 的事件层 | 神经系统 |
| **AgentService** | 创建实例、接线、提供 IPC 入口 | 接线板 |

**核心依赖关系**：

```
AgentOrchestrator  ──依赖──▶  AgentProviderAdapter (接口)
       │                            △
       │                            │ 实现
       │                    ClaudeAgentAdapter
       │
       └──依赖──▶  AgentEventBus
                        │
                        └──中间件──▶  IPC (webContents.send)
                        └──监听器──▶  飞书 Bridge 等扩展
```

**设计原则回顾**：

1. **依赖倒置**：Orchestrator 依赖 Adapter 接口，不依赖具体实现。可以 mock 假 Adapter 测试核心逻辑。
2. **单一职责**：AgentService 只管接线，Orchestrator 只管编排，Adapter 只管与 AI 通信。
3. **事件解耦**：核心逻辑通过 EventBus 发射事件，不直接操作 IPC。新的消费者只需注册监听器。

---

**下一阶段**：打开 `ClaudeAgentAdapter`——看看这个"万能遥控器"的具体实现：怎么启动 CLI 子进程、怎么构建 MessageChannel 长生命周期通道、怎么处理子进程残留的清理。
