# 第二阶段：适配器层——与 AI 引擎对话

## 学习目标

读完第二阶段，你应该能回答：

- SDK 子进程怎么启动和通信？
- 为什么需要自定义 MessageChannel？不用它会怎样？
- 运行中怎么向 Agent 注入新消息（权限审批、用户追加）？
- 子进程残留怎么保证清理干净？

文件路径：`apps/electron/src/main/lib/adapters/claude-agent-adapter.ts`（844 行）

---

## 2.1 先理解：SDK 的工作方式

Claude Agent SDK 不是一个 HTTP API 调用，而是一个**独立的 CLI 子进程**。

```
Proma (Electron 主进程)
  │
  ├─ spawn('claude', [...args])  ← 启动 SDK CLI 二进制文件
  │
  ├─ stdin  → 发送用户消息、权限决定
  ├─ stdout ← 接收 AI 回复、工具调用结果
  └─ stderr ← 接收错误日志
```

用伪代码表示 SDK 内部大致的逻辑：

```typescript
// SDK 的 query() 函数内部（示意）
function query({ prompt, options }) {
  // 启动子进程
  const childProcess = spawn(options.pathToClaudeCodeExecutable, args)

  // 把 prompt 通过 stdin 发给子进程
  if (typeof prompt === 'string') {
    childProcess.stdin.write(formatPrompt(prompt))
    childProcess.stdin.end()      // 写完后关闭 → 子进程处理完退出
  } else {
    // prompt 是 AsyncGenerator → 持续逐条发送
    for await (const msg of prompt) {
      childProcess.stdin.write(JSON.stringify(msg))
    }
    // generator 结束后自动 end()
  }

  // 从 stdout 逐行读取响应
  for await (const line of childProcess.stdout) {
    yield JSON.parse(line)  // 每条消息是一个 JSON 对象
  }
}
```

**这对 Proma 意味着什么？**
- 子进程生命周期需要管理（启动、退出、残留清理）
- stdin/stdout 是单向的——一旦 stdin 关闭（EOF），子进程就会退出
- 但权限审批又需要在运行中向子进程发送新消息（"允许"或"拒绝"）

这就是下面四个设计的由来。

---

## 2.2 设计一：MessageChannel——保持 stdin 不关闭

### 问题

SDK 的 `query()` 接收 prompt 参数有两种用法：

```typescript
// 用法 1：传字符串（一次性）
sdk.query({ prompt: "帮我读文件" })
// → 子进程处理完后，stdin 自动关闭，进程退出

// 用法 2：传 AsyncGenerator（流式输入）
sdk.query({ prompt: myGenerator })
// → 子进程持续从 generator 读取，直到 generator 结束
```

如果用法 1，第一轮对话结束后 stdin 关闭，子进程退出。用户想继续问第二个问题，就需要启动一个新进程——丢失了上下文（session）。

如果用法 2，但 generator 只 yield 一次就结束，效果和用法 1 一样。

**关键矛盾**：我们既要长期保持同一个子进程（保留 session），又要在运行时注入新消息（如权限审批的"允许/拒绝"、用户运行中追加消息）。

### 方案：自定义长生命周期 MessageChannel

```typescript
// 源码第 45-105 行
interface MessageChannel {
  enqueue: (msg: SDKUserMessage) => void   // 向队列推消息
  generator: AsyncGenerator<SDKUserMessage> // 供 SDK 消费
  close: () => void                         // 优雅关闭
}

function createMessageChannel(signal: AbortSignal): MessageChannel {
  const queue: SDKUserMessage[] = []
  let resolver: ((value: void) => void) | null = null
  let done = false

  // 异步生成器：持续从队列取消息，队列空了就等待
  async function* generator(): AsyncGenerator<SDKUserMessage> {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!           // 有消息就产出
      } else {
        // 没消息就阻塞等待（不结束 generator）
        await new Promise<void>((resolve) => {
          resolver = resolve
        })
      }
    }
    // 标记关闭后排空剩余消息
    while (queue.length > 0) {
      yield queue.shift()!
    }
  }

  return {
    enqueue: (msg) => {
      queue.push(msg)
      if (resolver) {
        const r = resolver
        resolver = null
        r()                        // 唤醒等待中的 generator
      }
    },
    generator: generator(),
    close: () => {
      done = true
      if (resolver) {
        const r = resolver
        resolver = null
        r()                        // 让 while 循环退出，进入排空阶段
      }
    },
  }
}
```

**用时间线理解**：

```
时间 →

SDK 子进程:
  [处理 prompt 1] ...... [等待 stdin] ...... [处理 prompt 2] ......
                                ↑
MessageChannel:
  [yield prompt 1] → [generator 阻塞等待] → [yield prompt 2] →
                         ↑
外部调用:                enqueue(prompt 2)
                         ← 权限审批响应 或 用户追加消息
```

**调用流程**：

```typescript
// adapter.query() 内部（实际源码第 634-664 行）
const channel = createMessageChannel(controller.signal)

// 1. 先把初始 prompt 入队
channel.enqueue({
  type: 'user',
  message: { role: 'user', content: options.prompt },
  session_id: options.sessionId,
  parent_tool_use_id: null,
})

// 2. 用 generator 作为 prompt 传给 SDK
const queryIterator = sdk.query({
  prompt: channel.generator,   // ← SDK 会持续从这个 generator 读取
  options: sdkOptions,
})

// 3. 保存 channel 引用，供后续 sendQueuedMessage 注入
activeChannels.set(options.sessionId, channel)
activeQueries.set(options.sessionId, queryIterator)
```

### 什么时候关闭通道？

不是所有 `result` 消息都代表"对话结束"。SDK 引入了 `terminal_reason` 字段区分不同情况：

```typescript
// 源码第 218-229 行
export const CONTINUABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'aborted_streaming',      // 被 query.interrupt() 软中断
  'aborted_tools',          // 工具执行被中断
  'tool_deferred',          // 工具被延迟执行（等异步回填结果）
  'hook_stopped',           // hook 层面暂停
  'stop_hook_prevented',    // hook 阻止了停止
])

export function shouldKeepChannelOpen(terminalReason: string | undefined): boolean {
  return terminalReason != null && CONTINUABLE_TERMINAL_REASONS.has(terminalReason)
}
```

- 白名单内的 reason → 保持通道开放，SDK 继续等待下一轮输入
- 白名单外的 reason（如 `completed`、`max_turns`、`error`）→ `channel.close()`，让 SDK 自然结束

```typescript
// query() 方法中 result 消息的处理（实际源码第 699-705 行）
if (msg.type === 'result') {
  const resultMsg = msg as { terminal_reason?: string }
  if (!shouldKeepChannelOpen(resultMsg.terminal_reason)) {
    channel.close()
    // channel 关闭 → generator 结束 → stdin EOF → 子进程退出
  }
}
```

**为什么不做闲置超时自动关闭？**

注释里有明确的设计决策（第 695-698 行）：keep-open 场景本身就是"等待用户决策"（权限审批、Exit Plan、AskUser 等）。用户离开再回来继续交互是合法的体验，强行超时会破坏体验。如果用户关闭 Tab，TabBar/GlobalShortcuts 会主动调 stopAgent → abort() 终止子进程。

---

## 2.3 设计二：子进程生命周期管理

### 为什么需要 PID 追踪？

Adapter 通过 `spawnClaudeCodeProcess` hook 在子进程启动时记录 PID：

```typescript
// 源码第 601-629 行
spawnClaudeCodeProcess: (spawnOpts) => {
  // 自定义启动子进程（替代 SDK 默认的 spawnLocalProcess）
  const child = spawnChild(spawnOpts.command, spawnOpts.args, {
    cwd: spawnOpts.cwd,
    env: spawnOpts.env,
    signal: spawnOpts.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // 关键：手动转发 stderr
  // SDK 默认在 spawnLocalProcess 里做这件事，自定义 spawn 后必须自己做
  // 同时必须消费 stderr 流，否则 64KB 缓冲区满后子进程会挂起
  if (options.onStderr) {
    child.stderr?.on('data', (chunk: Buffer) => {
      try { onStderr(chunk.toString()) } catch { /* 用户回调异常不影响流 */ }
    })
  } else {
    child.stderr?.resume()  // 即使不关心内容，也要消费
  }

  // 记录 PID 到全局 Map
  if (child.pid) {
    pidMap.set(options.sessionId, child.pid)
    child.once('exit', () => {
      // 清理时做比对，防止并发会话误删
      if (pidMap.get(options.sessionId) === child.pid) {
        pidMap.delete(options.sessionId)
      }
    })
  }

  return child
}
```

**为什么自定义 spawn 而不让 SDK 自己管理？**

两个原因：
1. **需要 PID 用于 force-kill 兜底**：SDK 自身的 2s SIGTERM + 5s SIGKILL 在某些场景会失效（见 Issue #357），需要外部兜底
2. **需要控制 stderr 转发**：stderr 含有 API 错误信息，Proma 需要解析来做错误分类和重试判断

### 三层清理兜底

杀掉一个 Agent 子进程不是 `process.kill()` 那么简单。子进程可能卡死、可能不响应信号、可能已经变成孤儿。Proma 设计了逐层强化的清理策略：

#### 第 1 层：abort() —— SDK 自身清理

```typescript
// 源码第 448-474 行
abort(sessionId: string): void {
  // 1. 调用 SDK query.close()：强制终止子进程及其所有子进程
  const query = activeQueries.get(sessionId)
  if (query) {
    try { query.close() } catch { /* 可能已关闭 */ }
    activeQueries.delete(sessionId)
  }

  // 2. 关闭 MessageChannel
  activeChannels.delete(sessionId)

  // 3. 中止 AbortController（让事件循环中 await 的代码感知到中止）
  const controller = activeControllers.get(sessionId)
  if (controller) {
    controller.abort()
    activeControllers.delete(sessionId)
  }

  // 4. 启动 10 秒后 force-kill 兜底
  const pid = pidMap.get(sessionId)
  if (pid) {
    scheduleForceKill(sessionId, pid)
  }
}
```

#### 第 2 层：scheduleForceKill —— 10 秒后兜底

```typescript
// 源码第 399-444 行
function scheduleForceKill(sessionId: string, pid: number): void {
  // 取消旧 timer（快速重复 abort 的场景）
  const old = forceKillTimers.get(sessionId)
  if (old) clearTimeout(old)

  const timer = setTimeout(() => {
    forceKillTimers.delete(sessionId)
    // 仍是同一个 pid 才杀（防止期间 SDK 自己已清理、又被其他会话复用 pid）
    if (pidMap.get(sessionId) === pid) {
      forceKillClaudeProcess(pid)
      pidMap.delete(sessionId)
    }
  }, 10_000)  // 10 秒 grace period
  timer.unref?.()  // 不阻止 Node.js 进程退出
  forceKillTimers.set(sessionId, timer)
}

// 平台差异化强制终止
export function forceKillClaudeProcess(pid: number): void {
  // 存活探测
  try { process.kill(pid, 0) } catch { return }  // 已死，无需杀

  try {
    if (process.platform === 'win32') {
      // Windows：taskkill /T 级联杀子进程
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      // macOS/Linux：直接 SIGKILL
      process.kill(pid, 'SIGKILL')
    }
  } catch (error) {
    console.warn(`[Claude 适配器] force-kill pid=${pid} 失败:`, error)
  }
}
```

#### 第 3 层：scanAndKillOrphanedClaudeSubprocesses —— 应用退出时最后兜底

```typescript
// 源码第 799-843 行
export function scanAndKillOrphanedClaudeSubprocesses(): void {
  const parentPid = process.pid
  try {
    if (process.platform === 'win32') {
      // PowerShell 查找匹配的孤儿进程并强制终止
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.ParentProcessId -eq ${parentPid} -and ` +
        `$_.CommandLine -like '*claude-agent-sdk*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
      ], { stdio: 'ignore', timeout: 3000 })
    } else {
      // pgrep 找所有子进程 → ps 过滤含 "claude-agent-sdk" 的 → SIGKILL
      const childPids = execFileSync('pgrep', ['-P', String(parentPid)], {
        encoding: 'utf8', timeout: 3000
      })
      for (const line of childPids.split('\n')) {
        const pid = parseInt(line.trim(), 10)
        if (!pid) continue
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
          encoding: 'utf8', timeout: 3000
        })
        if (cmd.includes('claude-agent-sdk')) {
          process.kill(pid, 'SIGKILL')
        }
      }
    }
  } catch (error) {
    console.warn('[Claude 适配器] 退出扫描执行失败:', error)
  }
}
```

**为什么需要三层？**

```
第 1 层：SDK 自身清理 (2s SIGTERM + 5s SIGKILL)
  │
  ├─ 成功 (95% 场景) → 结束
  │
  └─ 失败 (SDK 信号处理卡死 / 子进程僵尸)

第 2 层：10 秒后 force-kill
  │
  ├─ 成功 → 结束
  │
  └─ 失败 (pidMap 漏记 / child 'exit' 事件未触发)

第 3 层：应用退出时孤儿进程扫描
  └─ 扫描所有含有 "claude-agent-sdk" 的孤儿子进程并 SIGKILL
```

**实际调用时机**：`agent-service.ts` 中

```typescript
export function stopAllAgents(): void {
  orchestrator.stopAll()  // → adapter.dispose() → 立即 force-kill 所有已知 PID
}

export function killOrphanedClaudeSubprocesses(): void {
  scanAndKillOrphanedClaudeSubprocesses()  // → 扫描并清理孤儿
}
```

Electron `before-quit` 事件中：先 `stopAllAgents()` → 再 `killOrphanedClaudeSubprocesses()`。

---

## 2.4 设计三：sendQueuedMessage——运行中注入消息

当 Agent 正在运行时，用户可能想追加一条消息（"等等，再加一个条件"），或系统需要注入权限审批的"允许/拒绝"决定。这要求在**不重启子进程**的情况下注入新消息。

```typescript
// 源码第 726-748 行
async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
  // 1. 等待 SDK 初始化完成（可能还在加载中，需要几秒）
  const readyPromise = queryReadyPromises.get(sessionId)
  if (readyPromise) {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('等待 SDK 初始化超时')), 60_000)
    )
    await Promise.race([readyPromise, timeoutPromise])
  }

  // 2. 通过 MessageChannel 注入消息
  const channel = activeChannels.get(sessionId)
  if (!channel) {
    throw new Error(`无活跃消息通道可注入队列消息: ${sessionId}`)
  }

  channel.enqueue(message)
  // ↑ 消息进入队列
  // → generator yield 出来
  // → SDK 子进程从 stdin 收到
  // → 作为下一轮 turn 的用户输入被处理
}
```

**Query 就绪机制**：

```typescript
// query() 方法中（实际源码第 539-542, 657-661 行）
// 创建就绪 Promise，sendQueuedMessage 会等待它
const readyPromise = new Promise<void>((resolve) => {
  queryReadyResolvers.set(options.sessionId, resolve)
})
queryReadyPromises.set(options.sessionId, readyPromise)

// ... SDK 初始化完成，queryIterator 创建成功 ...
activeQueries.set(options.sessionId, queryIterator)
activeChannels.set(options.sessionId, channel)

// 通知等待者：Query 已就绪，可以注入消息了
const resolveReady = queryReadyResolvers.get(options.sessionId)
if (resolveReady) {
  resolveReady()
  queryReadyResolvers.delete(options.sessionId)
}
```

**配合 interruptQuery 实现"立即打断"**：

```typescript
// 源码第 485-494 行
async interruptQuery(sessionId: string): Promise<void> {
  const query = activeQueries.get(sessionId)
  if (!query) return
  try {
    await query.interrupt()
    // ↑ SDK 内部：停止当前 turn（不杀进程），yield 一个 interrupted result
    // 随后从 channel 继续读取下一条用户输入
    console.log(`[Claude 适配器] 已软中断当前 turn: sessionId=${sessionId}`)
  } catch (error) {
    console.warn(`[Claude 适配器] 软中断失败: sessionId=${sessionId}`, error)
  }
}
```

Orchestrator 中的使用（`agent-orchestrator.ts`）：

```typescript
async queueMessage(sessionId, text, _, presetUuid, opts) {
  // 用户选择了"立即打断当前输出"
  if (opts?.interrupt && this.adapter.interruptQuery) {
    try {
      await this.adapter.interruptQuery(sessionId)
      // ↑ 软中断：结束正在输出的文本，但不杀进程
    } catch (error) {
      console.warn(`软中断失败（将继续追加消息）:`, error)
    }
  }
  // 然后注入新消息，作为下一轮 turn 的输入
  await this.adapter.sendQueuedMessage(sessionId, sdkMessage)
}
```

**interrupt vs abort 的区别**：

| 操作 | 行为 | 子进程 | 适用场景 |
|------|------|--------|---------|
| `interruptQuery()` | 软中断当前 turn | 保留 | 用户追加消息继续对话 |
| `abort()` | 硬中止整个会话 | 杀掉 | 用户关闭 Tab、停止 Agent |

---

## 2.5 设计四：query()——核心查询方法

把所有设计串起来，完整的 `query()` 方法流程：

```typescript
// 源码第 531-718 行（简化版）
async *query(input: AgentQueryInput): AsyncIterable<SDKMessage> {
  const options = input as ClaudeAgentQueryOptions

  // ── 第 1 步：创建 AbortController ──
  // 外部可通过 abort() → controller.abort() 中止
  const controller = new AbortController()
  activeControllers.set(options.sessionId, controller)

  // ── 第 2 步：创建 Query 就绪 Promise ──
  // sendQueuedMessage 会等待此 Promise
  const readyPromise = new Promise<void>((resolve) => {
    queryReadyResolvers.set(options.sessionId, resolve)
  })

  try {
    // ── 第 3 步：动态导入 SDK ──
    const sdk = await import('@anthropic-ai/claude-agent-sdk')

    // ── 第 4 步：构建 SDK options ──
    const sdkOptions = {
      pathToClaudeCodeExecutable: options.sdkCliPath,   // CLI binary 路径
      model: options.model || 'claude-sonnet-4-6',
      permissionMode: options.sdkPermissionMode,
      canUseTool: options.canUseTool,                    // 权限回调（第三阶段）
      includePartialMessages: false,                     // 拿完整 JSON 对象
      promptSuggestions: true,                           // 启用提示建议
      cwd: options.cwd,
      env: options.env,
      systemPrompt: options.systemPrompt,                // preset + append
      toolUseConcurrency: 1,                             // 顺序执行工具，防并发 400 错误
      settingSources: ['user', 'project'],               // 加载配置文件来源
      abortController: controller,
      enableFileCheckpointing: options.enableFileCheckpointing,
      agents: options.agents,                            // 内置 SubAgent
      betas: options.betas,                              // 1M context window
      spawnClaudeCodeProcess: ...,                       // 自定义子进程启动
      // ... 更多配置透传
    }

    // ── 第 5 步：创建 MessageChannel + 入队初始 prompt ──
    const channel = createMessageChannel(controller.signal)

    channel.enqueue({
      type: 'user',
      session_id: options.sessionId,
      message: { role: 'user', content: options.prompt },
      parent_tool_use_id: null,
    })

    // ── 第 6 步：调用 SDK（子进程启动！） ──
    const queryIterator = sdk.query({
      prompt: channel.generator,   // ← 长生命周期 AsyncGenerator
      options: sdkOptions,
    })

    // 保存引用供后续使用
    activeQueries.set(options.sessionId, queryIterator)
    activeChannels.set(options.sessionId, channel)

    // 通知等待者：Query 已就绪
    queryReadyResolvers.get(options.sessionId)?.()
    queryReadyResolvers.delete(options.sessionId)

    // ── 第 7 步：遍历 SDK 产出的事件流 ──
    for await (const sdkMessage of queryIterator) {
      if (controller.signal.aborted) break

      // 捕获 SDK session_id（resume 用）
      if (sdkMessage.session_id) {
        options.onSessionId?.(sdkMessage.session_id)
      }

      // 捕获模型确认
      if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
        options.onModelResolved?.(sdkMessage.model)
      }

      // 捕获 context window
      if (sdkMessage.type === 'result') {
        const resultMsg = sdkMessage as { modelUsage?: Record<string, { contextWindow?: number }> }
        if (resultMsg.modelUsage) {
          const firstEntry = Object.values(resultMsg.modelUsage)[0]
          if (firstEntry?.contextWindow) {
            options.onContextWindow?.(firstEntry.contextWindow)
          }
        }

        // 判断是否关闭通道（terminal_reason 白名单）
        if (!shouldKeepChannelOpen(resultMsg.terminal_reason)) {
          channel.close()
        }
      }

      // 产出给上层（Orchestrator）
      yield sdkMessage as SDKMessage
    }
  } finally {
    // 清理：pidMap 的清理由 child.on('exit') 触发，不在此处清除
    // 原因：finally 可能先于子进程真正退出执行
    activeControllers.delete(options.sessionId)
    activeQueries.delete(options.sessionId)
    activeChannels.delete(options.sessionId)
    queryReadyPromises.delete(options.sessionId)
    queryReadyResolvers.delete(options.sessionId)
  }
}
```

---

## 2.6 关键细节补充

### 2.6.1 SDK CLI Binary 路径解析

SDK 分平台分发了独立的 native binary（`claude` / `claude.exe`），通过 npm optionalDependencies 安装到对应子包。Proma 用三种策略解析路径：

```typescript
// agent-orchestrator.ts 第 219-265 行
function resolveSDKCliPath(): string {
  const subpkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude'

  // 策略 1：createRequire（标准 ESM/CJS 互操作）
  try {
    const cjsRequire = createRequire(__filename)
    const sdkEntryPath = cjsRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const anthropicDir = dirname(dirname(sdkEntryPath))
    return join(anthropicDir, subpkg, binaryName)
  } catch { /* 降级 */ }

  // 策略 2：全局 require
  try {
    const sdkEntryPath = require.resolve('@anthropic-ai/claude-agent-sdk')
    // ... 同策略 1 的逻辑
  } catch { /* 降级 */ }

  // 策略 3：手动从 app 目录查找
  return join(__dirname, '..', 'node_modules', '@anthropic-ai', subpkg, binaryName)
}
```

### 2.6.2 stderr 的消费

自定义 spawn 后 stderr 必须被消费，否则缓冲区满了之后子进程的 write 会阻塞：

```typescript
// 源码第 610-617 行
if (options.onStderr) {
  child.stderr?.on('data', (chunk: Buffer) => {
    try { onStderr(chunk.toString()) } catch { /* 用户回调异常不影响流 */ }
  })
} else {
  // 即使上层不关心 stderr，也要 resume() 消费流
  child.stderr?.resume()
}
```

### 2.6.3 toolUseConcurrency: 1

```typescript
// 源码第 596 行
toolUseConcurrency: 1,
```

强制顺序执行工具而非并发。注释说明的根因是：多个 tool_use 并发时，如果结果未完整批量提交到 API 会触发 `invalid_request_error` 400 错误。这是踩过坑后加的配置。

### 2.6.4 消息通道优先级

```typescript
// SDKUserMessageInput 类型（agent-provider.ts 第 10-19 行）
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'  // ← 优先级
  uuid?: string
  session_id: string
}
```

不同 priority 含义：
- `now`：立即处理，打断当前输出（用于用户说"停下，改做这个"）
- `next`：当前轮结束后下一轮处理（用于排队消息）
- `later`：后台任务，有空再处理

---

## 第二阶段总结

| 设计 | 解决的问题 | 核心思路 |
|------|----------|---------|
| **MessageChannel** | stdin 关闭后无法再注入消息 | AsyncGenerator 持续活跃，队列空时阻塞等待 |
| **PID 追踪 + 三层清理** | 子进程残留、信号处理失败 | SDK 自身 → 10s force-kill → 孤儿进程扫描 |
| **sendQueuedMessage** | 运行中追加/打断消息 | 通过 MessageChannel 入队 + interruptQuery 软中断 |
| **terminal_reason 白名单** | 区分"本轮结束"和"会话结束" | 白名单内的 reason 保留通道，其他关闭 |
| **Query 就绪 Promise** | 防止 SDK 未初始化就注入消息 | `race([readyPromise, timeout])` 等待就绪 |
| **toolUseConcurrency: 1** | 并发工具调用导致 400 错误 | 强制顺序执行，防止未完整批量提交 |

**一个完整生命周期的例子**：

```
1. query() 被调用
   └─ 创建 MessageChannel
   └─ enqueue 初始 prompt
   └─ sdk.query({ prompt: channel.generator, options: sdkOptions })
       └─ spawn claude 子进程（PID 记录到 pidMap）
       └─ 子进程从 stdin 读到 prompt
       └─ 子进程通过 stdout 发 SDKAssistantMessage

2. AI 决定调用 Bash 工具（rm 命令）
   └─ canUseTool('Bash', { command: 'rm -rf /' })
       └─ permissionService 构建 PermissionRequest
       └─ EventBus → IPC → 渲染进程显示"是否允许？"
       └─ （channel generator 阻塞等待，不关闭！）

3. 用户点击"拒绝"
   └─ IPC → respondToPermission → resolve Promise
   └─ canUseTool 返回 { behavior: 'deny' }
   └─ SDK 通过 channel 继续正常运行

4. 一轮对话结束
   └─ result 消息到达，terminal_reason = 'completed'
   └─ shouldKeepChannelOpen('completed') → false
   └─ channel.close()
       └─ generator while 循环退出 → 排空剩余消息 → 结束
       └─ SDK 检测到 generator 结束 → 调用 endInput() 关闭 stdin
       └─ 子进程检测到 stdin EOF → 退出
       └─ child.on('exit') → pidMap.delete(sessionId)

5. 用户又发了一条消息
   └─ sendMessage() 被调用
   └─ sdkSessionId 存在 → 进入 resume 模式
   └─ 回到步骤 1，但是 prompt 直接传给 SDK（无需回填历史上下文）

6. 子进程异常，SDK 清理失败
   └─ abort() → query.close() + controller.abort()
   └─ scheduleForceKill(sessionId, pid)  // 10 秒后
       └─ 10 秒后 forceKillTimer 触发
       └─ process.kill(pid, 'SIGKILL') 或 taskkill /F /T

7. 应用退出
   └─ stopAllAgents() → adapter.dispose()
       └─ 所有已知 PID 立即 force-kill
   └─ killOrphanedClaudeSubprocesses()
       └─ pgrep/ps 扫描孤儿 → SIGKILL
```

**核心数据结构总览**：

```
ClaudeAgentAdapter
  │
  ├── activeControllers: Map<sessionId, AbortController>
  │    用于中止正在运行的 session（abort 时触发）
  │
  ├── activeQueries: Map<sessionId, SDKQuery>
  │    活跃的 Query 对象，用于 close() / interrupt() / setPermissionMode()
  │
  ├── activeChannels: Map<sessionId, MessageChannel>
  │    持久化消息通道，用于 sendQueuedMessage() 注入消息
  │
  ├── queryReadyPromises / queryReadyResolvers
  │    就绪信号，sendQueuedMessage 等待 SDK 初始化完成
  │
  ├── pidMap: Map<sessionId, number>
  │    子进程 PID，用于 force-kill 兜底
  │
  └── forceKillTimers: Map<sessionId, NodeJS.Timeout>
       延时 kill 的 timer，重复 abort 时取消旧的
```

---

**下一阶段**：打开 `AgentOrchestrator.sendMessage()` 的第一部分——前置处理。包括：API Key 解密、环境变量构建、SDK Session Resume、上下文回填、MCP 工具注入、动态 prompt 构建。这是编排器的心脏，也是理解"一个 Agent 请求从发起到执行经过了哪些准备"的关键。
