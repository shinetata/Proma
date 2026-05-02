# 第四阶段：事件循环——SDKMessage 流处理

## 学习目标

读完第四阶段，你应该能回答：

- 自动重试的触发条件是什么？重试间隔怎么计算？
- Watchdog 怎么检测 Agent Teams 死锁？为什么不用 `for await` 而用 `Promise.race`？
- 哪些 SDK 消息会被持久化？哪些会被过滤？为什么？
- Agent Teams 的 auto-resume 怎么工作？inbox 和 summary 的 fallback 关系是什么？
- result 消息为什么要延迟发射？
- 错误发生后 sdkSessionId 要不要清除？按什么策略决定？

文件路径：`apps/electron/src/main/lib/agent-orchestrator.ts`（第 1368-1963 行）

---

## 4.1 重试机制

### 4.1.1 三层错误处理结构

```typescript
// 源码第 1383 行
for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
  // MAX_AUTO_RETRIES = 8，所以最多 9 次尝试
  // attempt = 1 → 正常执行
  // attempt = 2~9 → 重试
```

错误可能发生在两个层面，但处理逻辑是对称的：

```
发生错误
  │
  ├─ 是 "session not found"？
  │    → 清除 sdkSessionId + 切换到上下文回填模式 + 重试
  │
  ├─ 是 rate_limited / 5xx / network_error 等可重试错误？
  │    → 持久化已累积的部分消息（用户能看到 Agent 说到哪了）
  │    → 清空累积数组（避免重试后重复持久化）
  │    → 等待退避延迟 + 重试
  │
  └─ 是不可重试错误（认证失败、账单错误、prompt_too_long...）？
       → 构造 TypedError 消息 + 持久化 + 通知前端 + 终止
```

### 4.1.2 可重试错误分类

**assistant 消息 error 层面**（`isAutoRetryableTypedError`）：

```typescript
// 源码第 131-137 行
const AUTO_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limited',        // API 429 限流
  'provider_error',      // API 过载（overloaded 映射为此）
  'service_error',       // 5xx 服务端错误
  'service_unavailable', // 503
  'network_error',       // 网络中断
])
```

**catch 异常层面**（`isAutoRetryableCatchError`）：

```typescript
// 源码第 145-160 行
function isAutoRetryableCatchError(apiError, rawErrorMessage, stderr): boolean {
  // HTTP 429 或 5xx
  if (apiError) {
    if (apiError.statusCode === 429 || apiError.statusCode >= 500) return true
  }
  // 已知的可恢复错误模式（无 HTTP 状态码）
  if (rawErrorMessage?.includes('context_management')) return true
  // 瞬时网络错误（ECONNRESET, socket hang up, terminated 等）
  if (isTransientNetworkError(rawErrorMessage, stderr)) return true
  return false
}
```

**不可重试的错误**：认证失败（401/403）、账单错误、prompt_too_long、模型不支持工具、图片过大等。

### 4.1.3 重试延迟：指数退避 + Jitter

```typescript
// 源码第 186-190 行
function getRetryDelayMs(attempt: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 10_000)
  // 序列：1s, 2s, 4s, 8s, 10s, 10s, 10s, 10s（cap = 10s）
  // 最坏情况累计等待 ≈ 55s

  const jitter = base * (Math.random() * 0.4 - 0.2)  // ±20% 随机抖动
  return Math.max(0, Math.round(base + jitter))
}
```

**为什么需要 jitter？**

假设 1000 个用户同时遇到 API 限流（429），如果没有 jitter，所有人都在精确的 1s、2s、4s... 后同时重试，会瞬间又触发限流——"惊群效应"。jitter 把重试时间分散到 ±20% 的范围内，让请求平滑分布。

### 4.1.4 重试期间的用户中止检测

```typescript
// 源码第 1408-1413 行
// 等待期间如果会话被中止，退出
if (!this.activeSessions.has(sessionId)) {
  // 保存部分结果
  this.persistSDKMessages(sessionId, accumulatedMessages)
  callbacks.onComplete(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
  return  // 不继续重试
}
```

每次重试等待后都检查 session 是否仍在活跃。用户可能在等待期间手动点了停止——这时直接退出，不继续重试。

### 4.1.5 重试前后的完整状态机

```
重试前:
  persistSDKMessages(已累积的消息)    → 用户能看到崩溃前的部分输出
  accumulatedMessages.length = 0       → 清空，避免重复持久化
  stderrChunks.length = 0             → 清空 stderr（为新一轮收集做准备）

  通知 UI:
  eventBus.emit('retry', status: 'starting')   → 显示 "正在重试..."
  eventBus.emit('retry', status: 'attempt')    → 记录重试详情

重试后（成功）:
  eventBus.emit('retry', status: 'cleared')    → UI 清除重试状态

重试后（失败，还有剩余次数）:
  continue  → 外层循环继续

重试后（失败，所有次数耗尽）:
  eventBus.emit('retry', status: 'failed')     → UI 显示 "重试 8 次后仍然失败"
  保存错误消息到 JSONL
  callbacks.onError + onComplete
```

### 4.1.6 已累积消息的"部分保存"

```typescript
// 重试前保存（第 1538-1539 行）
this.persistSDKMessages(sessionId, accumulatedMessages)
accumulatedMessages.length = 0

// catch 块中保存（第 1846-1848 行）
this.persistSDKMessages(sessionId, accumulatedMessages)
accumulatedMessages.length = 0
```

这意味着：即使 Agent 在第 3 轮 tool call 时崩溃了，前 2 轮的工具调用和 AI 回复已经被持久化到 JSONL。用户刷新页面后能看到 Agent 崩溃前做了哪些操作——有利于诊断问题。

---

## 4.2 Watchdog 死锁检测

### 4.2.1 问题场景

主 Agent 通过 Agent 工具派生了 3 个 sub-agent 并行工作。正常流程：

```
主 Agent → 调用 Agent 工具 → SDK 启动 3 个 sub-agent（后台任务）
  → sub-agent 完成后通知主 Agent
  → 主 Agent 拿到结果，继续推理
```

但有时出现死锁：3 个 sub-agent 全部完成了，但 SDK 没有把结果传回给主 Agent 的 Task 工具——Task 工具永远阻塞等待。

### 4.2.2 Watchdog 实现

```typescript
// 源码第 1423-1452 行
const loopAbort = new AbortController()

// 启动 Watchdog（独立异步任务，fire-and-forget）
const watchdogDone = (async () => {
  while (!loopAbort.signal.aborted) {
    // 每 5 秒检查一次（timerWithAbort 支持 AbortSignal 提前退出）
    await timerWithAbort(5_000, loopAbort.signal)
    if (loopAbort.signal.aborted) break

    // 触发条件：有 Worker 启动 + 未全部完成 + 有 SDK session ID
    if (
      startedTaskIds.size > 0 &&
      completedTaskIds.size < startedTaskIds.size &&
      capturedSdkSessionId
    ) {
      const allIdle = await areAllWorkersIdle(capturedSdkSessionId, startedTaskIds.size)
      if (allIdle) {
        console.log(`Watchdog: 所有 ${startedTaskIds.size} 个 Worker 已 idle，Task 工具仍在等待 — 中断`)
        abortedByWatchdog = true
        loopAbort.abort()  // ← 触发 Promise.race 中的 abort 分支
        break
      }
    }
  }
})()
```

Watchdog 通过共享的 `loopAbort` AbortController 与事件循环通信：它调用 `loopAbort.abort()` → 事件循环中的 `abortPromise` 被 resolve → `Promise.race` 返回 `kind: 'abort'` → 事件循环退出。

### 4.2.3 为什么用 Promise.race 而不是 for await？

```typescript
// 如果用 for await——无法中断！
for await (const msg of queryIterator) {
  // SDK 卡住了，await 永远不返回
  // Watchdog 检测到死锁了，但没法中断这个 await
  // ❌ 死锁
}
```

用 Promise.race：

```typescript
// 源码第 1465-1505 行
while (!loopAbort.signal.aborted) {
  if (!pendingNext) {
    pendingNext = queryIterator.next()  // 发起获取下一条消息
  }

  const raceResult = await Promise.race([
    pendingNext.then(r => ({ kind: 'event', result: r })),   // ← SDK 消息
    abortPromise,                                             // ← Watchdog 信号
    drainTimeoutPromise,                                      // ← result 后 2s 安全网
  ].filter(Boolean))

  if (raceResult.kind === 'abort') {
    // Watchdog 触发：优雅关闭 iterator，退出循环
    await queryIterator.return?.()
    break
  }

  if (raceResult.kind === 'drain_timeout') {
    // 安全网：SDK 超时未关闭，强制退出
    queryIterator.return?.()
    break
  }

  // 正常流：处理 SDKMessage
  const msg = raceResult.result.value
  // ...
}
```

`Promise.race` 让"等 SDK 消息"和"等 Watchdog 中断"同时进行——谁先到就用谁的结果。

### 4.2.4 中断方式对比

| 中断方式 | 触发方 | 子进程 | iterator | 后续行为 |
|---------|--------|--------|----------|---------|
| Watchdog 中断 | Watchdog 检测到死锁 | **保留** | `return()` 优雅关闭 | 进入 auto-resume |
| abort() 中断 | 用户点停止 | **杀掉** | `close()` 强杀 | 结束 session |
| drain timeout | result 后超时 | **保留**（adapter 层已 close channel） | `return()` | 正常完成 |

关键区别：Watchdog 中断时**不杀子进程**——它只是跳出事件循环，然后进入 auto-resume 流程，用同一 session 发起新一轮 query 来收集 teammate 结果。

### 4.2.5 Drain Timeout 安全网

```typescript
// 源码第 1632-1638 行
if (!keepChannelOpen && !drainTimeoutPromise) {
  // 启动 drain 超时安全网：
  // adapter 层 channel.close() 应让 iterator 自然关闭
  // 此 timeout 仅在极端情况下（SDK 版本不兼容）防止事件循环无限挂起
  drainTimeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve('drain_timeout'), 2000)
  )
}
```

正常情况：result 到达 → `channel.close()` → iterator 自然结束 → `iterResult.done === true`。
异常情况：result 到达了，但 iterator 因 SDK bug 不结束 → 2 秒后 drain timeout 强制退出。宁可丢尾部消息（如 prompt_suggestion），也不能让事件循环永远挂起。

---

## 4.3 消息过滤与持久化

### 4.3.1 第一层：持久化过滤

```typescript
// 源码第 1586-1613 行
// 决定哪些消息写入 JSONL
if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
  if (!msg.isReplay) {                         // ← 1. 跳过 replay
    if (msg.type === 'user') {
      const hasToolResult = content?.some(b => b.type === 'tool_result')
      if (hasToolResult) {
        accumulatedMessages.push(msg)          // ← 2. user 消息只要 tool_result
      }
    } else {
      accumulatedMessages.push(msg)            // ← 3. assistant + result 全部保留
    }
  }
} else if (msg.type === 'system' && subtype === 'compact_boundary') {
  accumulatedMessages.push(msg)                // ← 4. compact_boundary 保留
}
// 其余（tool_progress, prompt_suggestion, tool_use_summary 等）不持久化
```

过滤规则：

| 消息类型 | 持久化？ | 原因 |
|---------|---------|------|
| assistant | 是 | AI 回复+工具调用，核心对话内容 |
| user (含 tool_result) | 是 | 工具执行结果，Agent 的"记忆" |
| user (纯文本) | 否 | SDK 生成的内部消息（Skill 展开 prompt 等），不是用户输入 |
| result | 是 | Turn 结束标记 |
| system (compact_boundary) | 是 | 上下文压缩的分界线，UI 需要显示 |
| system (init, task_*) | 否 | 临时事件，不需要回放 |
| tool_progress | 否 | 心跳消息，瞬时信息 |

**为什么跳过 replay？**

Resume 一个已有的 SDK session 时，SDK 会重放部分历史消息（标记为 `isReplay: true`）。这些消息已经在之前持久化过了，再写入一次会导致 JSONL 中出现重复。

**为什么 user 消息只保留 tool_result？**

SDK 在 resume 时、Skill 调用时会生成纯文本的 user 消息（如展开 Skill 指令文本）。这些是 SDK 内部的操作，不是用户实际输入，不应该占据对话历史。

### 4.3.2 第二层：发射过滤

```typescript
// 源码第 1641-1651 行
let shouldEmit = true
if (msg.type === 'user') {
  const hasToolResult = content?.some(b => b.type === 'tool_result')
  if (!hasToolResult) {
    shouldEmit = false           // ← SDK 内部 user 消息不发给前端
  }
}
```

持久化过滤和发射过滤的规则不同：

| 消息 | 持久化？ | 发射到前端？ |
|------|---------|------------|
| assistant | 是 | 是 |
| user (含 tool_result) | 是 | 是 |
| user (纯文本, isReplay) | 否 | 否 |
| user (纯文本, 非 replay) | 否 | 否 |
| result | 是 | 是（但 Agent Teams 场景延迟） |
| system (compact_boundary) | 是 | 是 |
| system (init, task_*) | 否 | 是 |

---

## 4.4 Agent Teams 相关设计

### 4.4.1 任务追踪

```typescript
// 源码第 1663-1683 行
if (msg.type === 'system') {
  const sysMsg = msg as SDKSystemMessage

  // 追踪任务启动
  if (sysMsg.subtype === 'task_started' &&
      sysMsg.task_id &&
      (sysMsg.task_type === 'local_agent' || sysMsg.task_type === 'remote_agent')) {
    startedTaskIds.add(sysMsg.task_id)
  }

  // 追踪任务完成
  else if (sysMsg.subtype === 'task_notification' && sysMsg.task_id) {
    completedTaskIds.add(sysMsg.task_id)
    if (sysMsg.summary) {
      taskNotificationSummaries.push({
        taskId: sysMsg.task_id,
        status: sysMsg.status,
        summary: sysMsg.summary,
        outputFile: sysMsg.output_file,
      })
    }
  }
}
```

这些追踪数据同时服务于两个功能：

1. **Watchdog**：`completedTaskIds.size < startedTaskIds.size` → 有未完成的 Worker → 需要检查死锁
2. **Auto-Resume**：`taskNotificationSummaries` → fallback prompt 来源

### 4.4.2 Deferred Result

```typescript
// 源码第 1653-1661 行
if (msg.type === 'result' && startedTaskIds.size > 0) {
  console.log(`延迟 result 消息（${startedTaskIds.size} 个 teammate 活跃）`)
  deferredResultMessage = msg  // ← 暂存，不发射
} else {
  eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
}
```

**为什么延迟 result？**

前端收到 `result` 消息后会认为整个 Agent session 结束，清理 streaming 状态、标记 teammates 为 stopped。但在 Agent Teams 场景下，主 Agent 的 result 只是它本轮 turn 的结束——teammates 可能还在后台运行。如果此时前端就标记停止，auto-resume 的新消息会被误认为是"新 session"。

正确的时机：auto-resume 完成（主 Agent 汇总了 teammate 结果并回复后），再发射 deferred result。

### 4.4.3 Auto-Resume

```typescript
// 源码第 1710-1782 行（简化版）
if (startedTaskIds.size > 0 && capturedSdkSessionId && this.activeSessions.has(sessionId)) {
  // 1. 通知前端 "正在收集结果"
  eventBus.emit({ type: 'waiting_resume', message: '正在收集 teammate 工作结果...' })

  // 2. 构造 resume prompt
  let resumePrompt = null

  // 2a. 优先：从文件系统 inbox 读取完整消息
  const inboxInfo = await findTeamLeadInboxPath(capturedSdkSessionId)
  if (inboxInfo) {
    const unreadMessages = await pollInboxWithRetry(inboxInfo.inboxPath, INBOX_RETRY_CONFIG)
    if (unreadMessages.length > 0) {
      await markInboxAsRead(inboxInfo.inboxPath)
      resumePrompt = formatInboxPrompt(unreadMessages)    // 含完整文本
    }
  }

  // 2b. Fallback：用 task_notification 中的 summary
  if (!resumePrompt && taskNotificationSummaries.length > 0) {
    resumePrompt = formatSummaryFallbackPrompt(taskNotificationSummaries)  // 简短摘要
  }

  // 3. 发起新一轮 query（相同 SDK session）
  if (resumePrompt && this.activeSessions.has(sessionId)) {
    const resumeOptions = {
      ...queryOptions,
      prompt: resumePrompt,
      resumeSessionId: capturedSdkSessionId,  // ← 关键：同一 session
    }

    eventBus.emit({ type: 'resume_start', messageId: resumeMessageId })

    for await (const resumeMsg of this.adapter.query(resumeOptions)) {
      if (!this.activeSessions.has(sessionId)) break
      eventBus.emit(sessionId, { kind: 'sdk_message', message: resumeMsg })
    }

    // 持久化 auto-resume 产生的新消息
    persistSDKMessages(sessionId, resumeMessages)
  }

  // 4. 发射之前延迟的 result
  if (deferredResultMessage) {
    eventBus.emit(sessionId, { kind: 'sdk_message', message: deferredResultMessage })
  }
}
```

**Inbox vs Summary 两种 prompt 来源**：

```typescript
// 源码第 1720-1741 行
// 构造 resume prompt（优先 inbox，fallback 到 summaries）
let resumePrompt = null

// 优先级 1：inbox 完整消息
const inboxInfo = await findTeamLeadInboxPath(capturedSdkSessionId)
if (inboxInfo) {
  const unreadMessages = await pollInboxWithRetry(inboxInfo.inboxPath, INBOX_RETRY_CONFIG)
  if (unreadMessages.length > 0) {
    await markInboxAsRead(inboxInfo.inboxPath)
    resumePrompt = formatInboxPrompt(unreadMessages)
  }
}

// 优先级 2：task_notification summaries（fallback）
if (!resumePrompt && taskNotificationSummaries.length > 0) {
  resumePrompt = formatSummaryFallbackPrompt(taskNotificationSummaries)
}
```

| 来源 | 内容 | 质量 | 何时可用 |
|------|------|------|---------|
| inbox（文件系统） | sub-agent 发回的完整消息 | 高（含具体代码、分析） | SDK 正常写入了 inbox |
| summary（task_notification） | 简短摘要字符串 | 中（如 "已完成代码审查，发现 3 个问题"） | 始终可用 |

Inbox 消息来自 `~/.claude/teams/{teamName}/inbox/` 目录。这是 SDK 管理 Agent 间通信的文件系统机制。`pollInboxWithRetry` 实现了带重试的轮询——因为 sub-agent 完成后写入文件可能略有延迟。

---

## 4.5 Plan 模式提示注入

```typescript
// 源码第 1791-1798 行
// Plan 模式：Agent 完成规划后注入"接受计划"建议
if (initialPermissionMode === 'plan' && planModeEntered && this.activeSessions.has(sessionId)) {
  eventBus.emit(sessionId, {
    kind: 'sdk_message',
    message: { type: 'prompt_suggestion', suggestion: '请执行该计划' }
  })
}
```

Plan 模式下，Agent 完成规划后，注入一条 SDK 原生支持的 `prompt_suggestion` 消息。前端将其渲染为可点击的按钮，用户点击后触发 ExitPlanMode 流程——审批通过后切换到完整权限模式执行。

---

## 4.6 错误处理的 sdkSessionId 保留策略

```typescript
// 源码第 1912-1921 行
// 根据错误类型决定是否保留 sdkSessionId
const shouldClearSession = !apiError || apiError.statusCode >= 500

if (existingSdkSessionId && shouldClearSession) {
  updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })
} else if (existingSdkSessionId && !shouldClearSession) {
  console.log(`保留 sdkSessionId (API 错误 ${apiError?.statusCode})`)
}
```

并非所有错误都意味着 session 损坏：

```
API 错误 429（限流）      → 保留 sdkSessionId → 下次 resume 还能正常恢复
API 错误 400（参数错误）   → 保留 sdkSessionId → session 数据没问题
API 错误 500/502/503      → 清除 sdkSessionId → 服务端异常，session 状态可能不一致
网络错误（连不上 API）     → 清除 sdkSessionId → 不确定风险，保守处理
```

---

## 4.7 最后清理

```typescript
// 源码第 1952-1962 行
finally {
  // generation 匹配：只清理自己这轮，不误删新流
  if (this.activeSessions.get(sessionId) === runGeneration) {
    this.activeSessions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.queuedMessageUuids.delete(sessionId)
  }
  // 清理所有待处理的交互请求（不管 generation）
  permissionService.clearSessionPending(sessionId)
  askUserService.clearSessionPending(sessionId)
  exitPlanService.clearSessionPending(sessionId)
}
```

清理分两类：

1. **generation 匹配的清理**：`activeSessions`、`sessionPermissionModes`、`queuedMessageUuids`。这些在旧流和新流之间不能混用，必须用 generation 保护。
2. **无条件清理**：pending 的权限请求、AskUser 请求、ExitPlanMode 请求。这些不管哪条流，只要 session 结束了就应该拒绝——否则 Promise 永远不 resolve，内存泄漏。

---

## 第四阶段总结

事件循环的完整结构：

```
for (attempt = 1; attempt <= 9; attempt++) {
  if (attempt > 1) {
    等待指数退避延迟（1s/2s/4s/8s/10s... + jitter）
    检查会话是否已被用户中止 → 是则 return
  }

  try {
    ┌─ 创建 Watchdog（后台异步任务）─────────────┐
    │ 每 5s 检查：Worker 全部 idle 但 Task 仍在等？ │
    │ → loopAbort.abort() 中断事件循环              │
    └──────────────────────────────────────────────┘

    while (事件循环) {
      Promise.race(
        下一个 SDKMessage,
        Watchdog abort,
        drain timeout (result 后 2s),
      )
      │
      ├─ SDKMessage 到达
      │   ├─ assistant.error？→ 可重试 break / 不可重试 return
      │   ├─ 持久化过滤（去重、去 replay、去纯文本 user）
      │   ├─ 发射过滤（去 SDK 内部 user 消息）
      │   ├─ Agent Teams 追踪（task_started / task_notification）
      │   ├─ result 处理（持久化 + drain timeout ± 延迟发射）
      │   └─ eventBus.emit() → IPC → 前端
      │
      ├─ Watchdog abort → break（进入 auto-resume）
      ├─ drain timeout → break（安全网）
      └─ done === true → break（正常结束）
    }

    清理 Watchdog

    if (有 sub-agent 启动过) {
      Auto-Resume:
        从 inbox 读取 teammate 完整消息（带重试轮询）
        fallback: 用 task_notification 摘要
        发起新一轮 query（同一 session）
        发射 deferred result
    }

    if (Plan 模式) 注入 "请执行该计划" 提示

    onComplete → break（成功，退出重试循环）

  } catch (error) {
    if (用户主动中止)   → 保存部分结果 + return
    if (session 过期)  → 切换回填模式 + continue
    if (可重试)        → 保存部分结果 + continue
    if (不可重试)      → 构造错误 + 清除 sdkSessionId(按策略) + onComplete
  }
}

全部重试耗尽 → 保存 "重试 8 次后仍然失败" + onComplete

finally {
  generation 匹配 → 清理 activeSessions 等
  无条件清理 pending 请求（防止 Promise 泄漏）
}
```

**关键设计模式总结**：

| 模式 | 解决的问题 | 位置 |
|------|----------|------|
| **外重试 + 内事件 双层循环** | 同一 session 支持下重试时 resume（不丢上下文） | 1383-1924 |
| **Promise.race 替代 for await** | 等待 SDK 的同时能响应 Watchdog 信号 | 1465-1505 |
| **Watchdog AbortController** | 非侵入式中断事件循环（不杀子进程） | 1427-1452 |
| **Deferred Result** | 防止前端在 teammates 完成前误结束 session | 1654-1661 |
| **双层过滤**（持久化 != 发射） | 不同消费者需要不同的消息子集 | 1586-1661 |
| **Inbox + Summary 双轨** | auto-resume 有完整消息就优先，没有就兜底 | 1720-1741 |
| **重试前部分持久化** | 崩溃后用户能看到 Agent 输出到哪了 | 1538-1539 |
| **sdkSessionId 保留策略** | 4xx 不影响 session，5xx 可能影响 | 1912-1921 |
| **Drain timeout 安全网** | SDK bug 导致 iterator 不关闭时的最后防线 | 1632-1638 |
| **Generation 匹配的 finally** | 旧流清理不误杀新流 | 1952-1962 |

---

**下一阶段（第五阶段）**：权限服务 + AskUser + ExitPlanMode——人机交互闭环比
