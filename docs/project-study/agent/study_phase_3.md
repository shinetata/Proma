# 第三阶段：编排器核心——发消息前的准备工作

## 学习目标

读完第三阶段，你应该能回答：

- 一条用户消息在真正发给 AI 之前，需要做哪些准备？
- 并发保护怎么实现？slot preemption 和 generation 匹配分别解决什么时序问题？
- SDK Session Resume 和上下文回填分别是什么？系统怎么自动切换？
- 环境变量为什么要双重清理 ANTHROPIC_* 前缀？
- 权限模式的三层优先级是什么？怎么实现运行中动态切换？
- pre-flight 错误（如渠道不存在）为什么不直接 throw，而是走消息通道？

文件路径：`apps/electron/src/main/lib/agent-orchestrator.ts`（第 754-1365 行）

---

## 3.1 阶段零：并发保护（Slot Preemption）

### 第一道防线

```typescript
// 源码第 758-763 行
if (this.activeSessions.has(sessionId)) {
  console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求`)
  callbacks.onError('上一条消息仍在处理中，请稍候再试')
  callbacks.onComplete([], { startedAt: input.startedAt })
  return
}
```

同一个 session 不允许并发发送两条消息。如果 `activeSessions` 中已有该 session，直接拒绝并通知前端。

### 时序漏洞

但这里有个问题：第 759 行检查和第 858 行的 `set()` 之间隔着异步操作：

```
检查 activeSessions.has()  ← 此时为空，通过
  ↓
getChannelById()            ← 同步
  ↓
decryptApiKey()             ← 同步
  ↓
await buildSdkEnv()         ← 异步！可能耗时数百毫秒
  ↓
activeSessions.set()        ← 太晚了！
```

如果在 `buildSdkEnv` 期间，用户又点击了一次发送（网络卡顿导致重复点击），第二次请求会发现 `activeSessions` 仍然为空，也通过了检查。结果：同一个 session 有两个并发的 AI 调用，JSONL 文件中出现重复消息。

### 解决方案：Slot Preemption

```typescript
// 源码第 851-858 行
// 在所有同步检查通过后、第一个 await 之前，立即抢占槽位
const runGeneration = Date.now()
const streamStartedAt = input.startedAt ?? runGeneration
this.activeSessions.set(sessionId, runGeneration)
```

注意这行代码的**精确位置**：

```
同步检查（快，毫秒级）
  ├─ activeSessions.has() → 未占用
  ├─ getChannelById()    → 渠道存在
  └─ decryptApiKey()     → 可解密
       │
       ▼  ← 此时抢占槽位！在所有 await 之前
  activeSessions.set(sessionId, runGeneration)
       │
       ▼  ← 现在可以安全地 await 了
  await buildSdkEnv()    ← 即使这里耗费数百毫秒
  await import('@anthropic-ai/claude-agent-sdk')  ← 即使这里更久
```

此时如果收到第二个请求，`activeSessions.has()` 返回 `true`，直接拒绝。

### Generation 匹配——防止旧流误删新流

`runGeneration = Date.now()` 不仅是一个值，还是一个**唯一标记**。它在 `finally` 块中被用来做安全清理：

```typescript
// 源码第 1952-1962 行 finally 块
finally {
  // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
  if (this.activeSessions.get(sessionId) === runGeneration) {
    this.activeSessions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.queuedMessageUuids.delete(sessionId)
  }
  // 如果 !== runGeneration，说明 session 已被新请求占用，不能误删
}
```

**什么场景下 generation 会不匹配？**

考虑这种极端情况：第一个请求正常完成，但在 `finally` 执行前，第二个请求已经开始了（比如用户通过 API 快速连续发送）。此时 `activeSessions` 中存的是第二个请求的 generation，第一个请求的 finally 如果直接 `delete`，就会误删第二个请求的注册。通过比较 generation，第一个请求发现不匹配，跳过清理。

---

## 3.2 阶段一：Pre-flight 检查与环境准备

### 3.2.1 TypedError —— 结构化的错误报告

```typescript
// 源码第 769-793 行
const reportPreflightError = (typedError: TypedError) => {
  // 构造错误消息
  const errorContent = typedError.title
    ? `${typedError.title}: ${typedError.message}`
    : typedError.message

  // 构造 SDK 消息格式的错误（让 UI 可以渲染为一条消息卡片）
  const errorSDKMsg: SDKMessage = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: errorContent }] },
    error: { message: typedError.message, errorType: typedError.code },
    _createdAt: Date.now(),
    _errorCode: typedError.code,
    _errorTitle: typedError.title,
    _errorDetails: typedError.details,
    _errorCanRetry: typedError.canRetry,
    _errorActions: typedError.actions,
  }

  // 持久化到 JSONL（UI 刷新后仍能看到）
  appendSDKMessages(sessionId, [errorSDKMsg])

  // 通知前端：出错 + 流结束
  callbacks.onError(errorContent)
  callbacks.onComplete([], { startedAt: input.startedAt })
}
```

**为什么 pre-flight 错误要走正常消息通道而不是直接 throw？**

对比两种做法：

```typescript
// 做法 A：直接 throw
throw new Error('渠道不存在')  // → IPC 收到一个 error 字符串 → UI 显示红色 toast → 用户困惑

// 做法 B：走消息通道
reportPreflightError({
  code: 'channel_not_found',
  title: '渠道不存在',
  message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
  actions: [
    { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
  ],
})
// → UI 渲染一条错误消息卡片，带"打开渠道设置"按钮
```

做法 B 让用户不仅看到错误，还能立刻执行修复操作。每个 `TypedError` 携带的 `actions` 数组定义了可用的恢复操作，前端渲染为可点击的按钮。

### 3.2.2 三步检查链

```typescript
// 1. Windows Shell 环境检查（第 795-818 行）
if (process.platform === 'win32') {
  const runtimeStatus = getRuntimeStatus()
  if (!shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
    reportPreflightError({
      code: 'windows_shell_missing',
      title: 'Windows 环境未就绪',
      message: '需要 Git Bash 或 WSL 才能运行 Agent...',
      details: [
        `Git Bash: ${shellStatus.gitBash?.error || '未检测到'}`,
        `WSL: ${shellStatus.wsl?.error || '未检测到'}`,
      ],
      actions: [
        { key: 'e', label: '打开环境检测', action: 'open_environment_check' },
        { key: 'g', label: '去官方下载 Git', action: 'open_external', payload: 'https://git-scm.com/download/win' },
      ],
      canRetry: false,
    })
    return
  }
}

// 2. 渠道检查（第 821-833 行）
const channel = getChannelById(channelId)
if (!channel) {
  reportPreflightError({
    code: 'channel_not_found',
    title: '渠道不存在',
    message: '当前会话引用的渠道已被删除或不可用...',
    actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
    canRetry: false,
  })
  return
}

// 3. API Key 解密（第 835-849 行）
try {
  apiKey = decryptApiKey(channelId)
} catch {
  reportPreflightError({
    code: 'api_key_decrypt_failed',
    title: 'API Key 解密失败',
    message: '无法解密此渠道的 API Key，可能是系统密钥环异常...',
    actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
    canRetry: false,
  })
  return
}
```

每一步失败都生成 `TypedError` 并通过 `return` 终止——不会进入后续的异步流程。

### 3.2.3 环境变量构建（buildSdkEnv）

这是 `sendMessage()` 中第一个真正的 `await`：

```typescript
// 第 879 行
const sdkEnv = await this.buildSdkEnv(apiKey, channel.baseUrl, channel.provider)
```

`buildSdkEnv`（第 404-490 行）做了五件事：

#### ① 清理 ANTHROPIC_ 污染

```typescript
// 从 process.env 继承系统变量，但清理所有 ANTHROPIC_ 前缀的变量
const cleanEnv: Record<string, string | undefined> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('ANTHROPIC_')) {
    cleanEnv[key] = value
  }
}
```

**为什么需要这一步？**

用户的 `~/.zshrc` 或 `~/.bashrc` 中可能设了开发用的 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等变量。启动时 Electron 的 `initializeRuntime().loadShellEnv()` 会把这些变量加载到 `process.env`。如果不清理，它们会泄漏到 SDK 子进程中，覆盖 Proma 的渠道配置，导致 AI 请求打到了错误的 API 地址或用了错误的 Key。

#### ② 注入 Proma 自定义环境变量

```typescript
const sdkEnv: Record<string, string | undefined> = {
  ...cleanEnv,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',       // 提升输出 token 上限（默认 32000）
  CLAUDE_CODE_ENABLE_TASKS: 'true',             // 启用 Agent Teams / Tasks
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',  // 禁用实验性 beta，使用稳定模式
  CLAUDE_CONFIG_DIR: getSdkConfigDir(),          // 独立配置目录，不读用户的 ~/.claude.json
}
```

#### ③ 认证方式按 provider 分支

```typescript
if (provider === 'kimi-coding') {
  sdkEnv.ANTHROPIC_AUTH_TOKEN = apiKey       // Kimi 只认 Bearer 认证
  sdkEnv.ANTHROPIC_CUSTOM_HEADERS = 'User-Agent: KimiCLI/1.3'
} else {
  sdkEnv.ANTHROPIC_API_KEY = apiKey          // 标准 Anthropic：x-api-key + Bearer
}
```

不同 provider 的认证方式不同：

| Provider | 认证方式 | 特殊要求 |
|----------|---------|---------|
| Anthropic 原生 | `ANTHROPIC_API_KEY`（SDK 内部同时发 x-api-key 和 Bearer） | 无 |
| Kimi Coding Plan | `ANTHROPIC_AUTH_TOKEN`（仅 Bearer） | 必须伪装 User-Agent: KimiCLI/1.3 |

#### ④ 自定义 Base URL + 代理

```typescript
// 显式控制 ANTHROPIC_BASE_URL：仅在用户配置了自定义 Base URL 时注入
if (baseUrl && baseUrl !== DEFAULT_ANTHROPIC_URL) {
  sdkEnv.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrlForSdk(baseUrl)
}

// 代理配置
const proxyUrl = await getEffectiveProxyUrl()
if (proxyUrl) {
  sdkEnv.HTTPS_PROXY = proxyUrl
  sdkEnv.HTTP_PROXY = proxyUrl
}
```

#### ⑤ ANTHROPIC_* 清零覆盖（双保险）

```typescript
// 针对 claude-agent-sdk 0.2.111+ 的 options.env 叠加语义：
// SDK 将 options.env 叠加到 process.env 之上传递给子进程。
// 若 shell 中存在但 sdkEnv 未显式管理的 ANTHROPIC_* 变量，
// 叠加后会回流到 SDK 子进程 → 必须显式置空覆盖
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_') && !(key in sdkEnv)) {
    sdkEnv[key] = ''
  }
}
```

为所有未被显式管理的 `ANTHROPIC_*` 变量设置空字符串。这是双保险——即使第一步的清理有遗漏，这一步确保它们不会在 SDK 的叠加语义下回流到子进程。

**为什么 process.env 和 sdkEnv 都要设置？**

```typescript
// 第 860-877 行 — 同步凭证到 process.env
// SDK in-process 代码可能直接读取 process.env
// 先清理再注入，确保 SDK 无论从 env 选项还是 process.env 都拿到正确值
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_CUSTOM_HEADERS

if (channel.provider === 'kimi-coding') {
  process.env.ANTHROPIC_AUTH_TOKEN = apiKey
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'User-Agent: KimiCLI/1.3'
} else {
  process.env.ANTHROPIC_API_KEY = apiKey
}
```

SDK 的部分代码可能直接读 `process.env` 而不是通过 `options.env` 传参。两种方式都要正确，确保不论 SDK 从哪个路径获取，拿到的都是正确的凭证。

---

## 3.3 阶段二：SDK Session Resume vs 上下文回填

这是整个编排器最重要的容错设计。它决定了 Agent 怎么"记住"之前的对话。

### 3.3.1 两种模式

```typescript
// 源码第 882-883 行
const sessionMeta = getAgentSessionMeta(sessionId)
let existingSdkSessionId = sessionMeta?.sdkSessionId
```

```
existingSdkSessionId 存在？
  ├─ YES → "Resume 模式"
  │   SDK 服务端保留了完整上下文
  │   prompt 只传当前用户消息 + 动态上下文
  │   AI 自己知道之前说了什么
  │   成本最低，上下文最完整
  │
  └─ NO → "上下文回填模式"
       SDK 没有历史记录
       prompt 需要拼接最近 20 条消息的摘要
       AI 需要从摘要中理解上下文
       成本更高，上下文压缩
```

### 3.3.2 Resume 模式

```typescript
// 源码第 1051-1058 行
const contextualMessage = `${dynamicCtx}\n\n${enrichedMessage}`

const finalPrompt = existingSdkSessionId
  ? contextualMessage                     // ← Resume：只传当前消息
  : buildContextPrompt(sessionId, contextualMessage, { agentCwd })
  // ↑ 新会话：需要拼接历史
```

Resume 模式下，prompt 很简单——只需要当前的用户消息 + 动态上下文（时间、工作区状态）。因为 SDK 服务端已经保留了完整的对话历史，AI 不需要任何额外的上下文提示。

**为什么直接信任 session ID 而不做预验证？**

```typescript
// 源码第 1007-1013 行
// 直接信任已保存的 sdkSessionId，跳过 listSessions 预验证
// 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
// 与 SDK 内部存储的路径哈希可能不匹配，导致 listSessions 始终返回 0 个会话，
// 误杀有效的 resume。
// SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
if (existingSdkSessionId) {
  console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume`)
}
```

这是踩过坑后得到的经验：与其在应用层做不可靠的预验证，不如信任 SDK 自己的错误处理——SDK 如果发现 session ID 无效会返回错误，Proma 在事件循环中捕获后自动切换到回填模式。

### 3.3.3 上下文回填

当没有可用的 SDK session 时，需要从本地 JSONL 构建历史上下文：

```typescript
// 源码第 295-344 行（简化版）
function buildContextPrompt(sessionId: string, currentUserMessage: string, sessionHint?: { agentCwd: string }): string {
  // 1. 读取所有 SDK 消息
  const allMessages = getAgentSessionSDKMessages(sessionId)
  // 2. 排除最后一条（刚刚才 append 的当前用户消息）
  const history = allMessages.slice(0, -1)
  // 3. 取最近 20 条
  const recent = history.slice(-MAX_CONTEXT_MESSAGES)

  // 4. 只保留 user 和 assistant 消息，提取文本内容
  const lines = recent
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const textParts = m.message?.content
        ?.filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
      const text = textParts?.join('\n') || ''

      let line = `[${m.type}]: ${text}`

      // 对 assistant 消息，附带工具活动摘要
      if (m.type === 'assistant') {
        const toolSummary = extractSDKToolSummary(m.message.content)
        if (toolSummary) {
          line += `\n  工具活动: ${toolSummary}`
        }
      }
      return line
    })
    .filter(Boolean)

  // 5. 包裹为 <conversation_history>
  return `<conversation_history>\n${lines.join('\n')}\n</conversation_history>\n\n${currentUserMessage}`
}
```

这段代码产出的效果大致是：

```
<conversation_history>
[user]: 帮我分析 auth 模块的性能瓶颈
[assistant]: 我来分析 auth 模块的代码...
  工具活动: [tool: Read: /project/src/auth/index.ts] [tool: Grep: bcrypt]
[user]: 重点关注密码哈希部分
[assistant]: 密码哈希使用了 bcrypt，当前 cost factor 为 10。
  这可能在大量并发注册时造成瓶颈...
</conversation_history>

帮我优化密码哈希的性能
```

**工具活动摘要的精妙之处**：

```typescript
// 源码第 278-293 行
function extractSDKToolSummary(content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>): string {
  const summaries: string[] = []
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const input = block.input ?? {}
      const keyParam = input.file_path ?? input.command ?? input.path ?? input.query ?? ''
      const paramStr = keyParam ? `: ${String(keyParam).slice(0, 100)}` : ''
      summaries.push(`[tool: ${block.name}${paramStr}]`)
    }
  }
  const joined = summaries.join(' ')
  return joined.length > 200
    ? joined.slice(0, 200) + '...'
    : joined
}
```

它不只是记录"Agent 调用了 Read 工具"，而是抓取了最关键的参数（文件路径、命令、搜索词），让新 SDK session 知道 Agent 之前**操作了哪些文件、执行了什么命令**，而不仅仅是"说了什么"。这大大提升了回填后的上下文质量。

### 3.3.4 Session 过期时的自动恢复

在后续的事件循环中，如果 SDK 返回了 "No conversation found with session ID" 错误：

```typescript
// 第 518-530 行事件循环中的恢复逻辑（伪代码）
if (isSessionNotFoundError(detailedMessage) && existingSdkSessionId && attempt <= MAX_AUTO_RETRIES) {
  // 1. 清除失效的 session ID
  existingSdkSessionId = undefined
  updateAgentSessionMeta(sessionId, { sdkSessionId: undefined })

  // 2. 切换到上下文回填模式
  queryOptions.resumeSessionId = undefined
  queryOptions.prompt = buildContextPrompt(sessionId, contextualMessage, { agentCwd })

  // 3. 清除累积的消息（那些是 resume 时的 replay 消息）
  persistSDKMessages(sessionId, accumulatedMessages)
  accumulatedMessages.length = 0

  // 4. 继续循环——重试！
  continue
}
```

用户在这个过程中完全感觉不到任何异常——消息继续发送成功，只是这次用了回填的上下文。

### 3.3.5 快照回退后的 Resume

用户可能调用了 `rewindSession` 回退到之前的某个消息点。这时需要从中断点继续：

```typescript
// 源码第 885-892 行
let rewindResumeAt: string | undefined
if (sessionMeta?.resumeAtMessageUuid) {
  rewindResumeAt = sessionMeta.resumeAtMessageUuid
  // 消费一次后清除（避免后续每次发消息都走回退模式）
  updateAgentSessionMeta(sessionId, { resumeAtMessageUuid: undefined })
  console.log(`[Agent 编排] 检测到回退 resume: resumeSessionAt=${rewindResumeAt}`)
}

// 在 queryOptions 中：
...(rewindResumeAt && { resumeSessionAt: rewindResumeAt }),
```

`resumeSessionAt` 告诉 SDK 从指定消息 UUID 处截断 JSONL，创建一个分支（fork），新的助手消息追加在分支上，不影响原始历史。

---

## 3.4 阶段三：工作目录与 SDK 项目设置

### 3.4.1 确定 Agent 的工作目录

```typescript
// 源码第 957-977 行
agentCwd = homedir()  // 默认：用户主目录
workspaceSlug = undefined
workspace = undefined

if (workspaceId) {
  const ws = getAgentWorkspace(workspaceId)
  if (ws) {
    // 工作区模式：每个 session 获得独立子目录
    agentCwd = getAgentSessionWorkspacePath(ws.slug, sessionId)
    // 例如：~/.proma/agent-workspaces/my-project/session-abc-123/

    workspaceSlug = ws.slug
    workspace = ws

    // 确保 Skill 清单文件存在
    ensurePluginManifest(ws.slug, ws.name)
  }
}
```

**为什么每个 session 要有独立目录？**

```
~/.proma/agent-workspaces/my-project/
  ├── session-aaa/
  │   ├── .claude/
  │   └── src/          ← session aaa 写入的代码文件
  ├── session-bbb/
  │   ├── .claude/
  │   └── src/          ← session bbb 写入的代码文件（互不干扰！）
  └── skills/           ← 工作区共享的 Skills
```

如果两个 session 共用同一个目录，Agent A 写入的文件会被 Agent B 覆盖。每个 session 获得独立的沙盒目录。

### 3.4.2 确保 SDK 项目设置

```typescript
// 源码第 983-1005 行
{
  const claudeSettingsDir = join(agentCwd, '.claude')
  if (!existsSync(claudeSettingsDir)) {
    mkdirSync(claudeSettingsDir, { recursive: true })
  }

  const settingsPath = join(claudeSettingsDir, 'settings.json')
  let sdkProjectSettings: Record<string, unknown> = {}
  try {
    sdkProjectSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch { /* 文件不存在或 JSON 格式错误 */ }

  let needsWrite = false

  // 强制设置 plansDirectory
  if (sdkProjectSettings.plansDirectory !== '.context') {
    sdkProjectSettings.plansDirectory = '.context'
    needsWrite = true
  }

  // 强制设置 skipWebFetchPreflight
  if (sdkProjectSettings.skipWebFetchPreflight !== true) {
    sdkProjectSettings.skipWebFetchPreflight = true
    needsWrite = true
  }

  if (needsWrite) {
    writeFileSync(settingsPath, JSON.stringify(sdkProjectSettings, null, 2))
  }
}
```

SDK 启动时会读取 `{cwd}/.claude/settings.json` 作为项目级配置。Proma 强制确保两个设置：

- `plansDirectory: '.context'` → 计划模式产出的 plan 文件写入 `.context/plan/` 目录（与 Proma 的 `.context/` 文档体系一致）
- `skipWebFetchPreflight: true` → 跳过 WebFetch 的预检确认。默认 SDK 会在每次 WebFetch 前要求用户确认（安全考虑），Proma 选择关闭以提升体验。

---

## 3.5 阶段四：工具注入

### 3.5.1 MCP 服务器配置

```typescript
// 源码第 1017 行
const mcpServers = this.buildMcpServers(workspaceSlug)
```

`buildMcpServers`（第 495-532 行）从工作区配置中构建 MCP 服务器列表：

```typescript
private buildMcpServers(workspaceSlug: string | undefined) {
  const mcpServers = {}
  if (!workspaceSlug) return mcpServers

  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)

  for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
    if (!entry.enabled) continue           // 跳过未启用的
    if (name === 'memos-cloud') continue   // 跳过 MemOS（后面单独注入）

    // stdio 类型：启动本地命令行程序
    if (entry.type === 'stdio' && entry.command) {
      const mergedEnv = {
        ...(process.env.PATH && { PATH: process.env.PATH }),
        ...entry.env,
      }
      mcpServers[name] = {
        type: 'stdio',
        command: entry.command,
        ...(entry.args?.length > 0 && { args: entry.args }),
        ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
        required: false,                     // ← 关键：不是必需的
        startup_timeout_sec: entry.timeout ?? 30,
      }
    }
    // HTTP/SSE 类型：连接远程服务
    else if ((entry.type === 'http' || entry.type === 'sse') && entry.url) {
      mcpServers[name] = {
        type: entry.type,
        url: entry.url,
        ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
        required: false,
      }
    }
  }
  return mcpServers
}
```

**为什么 `required: false`？**

MCP 服务器是外部进程或远程服务，可能因为网络问题、进程被杀、配置错误等原因启动失败。如果标记为 `required: true`，SDK 会在 MCP 启动失败时直接让整个 Agent session 报错退出。

`required: false` 意味着：Agent 可以继续运行主流程，只是缺少了这个 MCP 的工具。对于大多数场景，这是更好的用户体验——一个工具的缺失不应该阻塞整个对话。

### 3.5.2 记忆工具注入

```typescript
// 源码第 1018 行
await this.injectMemoryTools(sdk, mcpServers)
```

记忆工具的注入方式与普通 MCP 不同——它不是外部进程，而是用 SDK API 内联创建：

```typescript
// 源码第 537-589 行（简化版）
private async injectMemoryTools(sdk, mcpServers) {
  const memoryConfig = getMemoryConfig()
  if (!memoryConfig.enabled || !memoryConfig.apiKey) return  // 未配置就跳过

  const { z } = await import('zod')

  // 用 SDK API 创建一个 SDK 内置 MCP Server（不启动额外进程）
  const memosServer = sdk.createSdkMcpServer({
    name: 'mem',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'recall_memory',
        'Search user memories (facts and preferences) from MemOS Cloud. Use this to recall relevant context about the user.',
        {
          query: z.string().describe('Search query for memory retrieval'),
          limit: z.number().optional().describe('Max results (default 6)'),
        },
        async (args) => {
          const result = await searchMemory(config, args.query, args.limit)
          return { content: [{ type: 'text', text: formatSearchResult(result) }] }
        },
        { annotations: { readOnlyHint: true } },
      ),
      sdk.tool(
        'add_memory',
        'Store a conversation message pair into MemOS Cloud for long-term memory.',
        {
          userMessage: z.string().describe('The user message to store'),
          assistantMessage: z.string().optional().describe('The assistant response to store'),
        },
        async (args) => {
          await addMemory(config, args)
          return { content: [{ type: 'text', text: 'Memory stored successfully.' }] }
        },
      ),
    ],
  })

  // 注入到 MCP 服务器列表，SDK 自动注册到 Agent 的工具列表中
  mcpServers['mem'] = memosServer
}
```

**为什么用 SDK API 而不是外部 MCP 进程？**

对比：

| 方式 | 进程数 | 延迟 | 可靠性 |
|------|--------|------|--------|
| 外部 MCP 进程 | +1 子进程 | 进程启动耗时 | 进程可能崩溃 |
| SDK API 内联 | +0 | 即时可用 | 函数调用，不崩溃 |

记忆工具只做 HTTP 请求（调 MemOS Cloud API），不需要独立进程。用 SDK API 创建更轻量。

### 3.5.3 自定义 MCP 合并

```typescript
// 源码第 1021-1025 行
// 合并外部注入的自定义 MCP 服务器（如飞书群聊工具）
if (customMcpServers) {
  Object.assign(mcpServers, customMcpServers)
  console.log(`[Agent 编排] 已合并 ${Object.keys(customMcpServers).length} 个自定义 MCP 服务器`)
}
```

飞书 Bridge 等外部集成通过 `customMcpServers` 参数注入额外的 MCP 工具（如发送群聊消息）。这些工具只在当前这次调用中生效，不会持久化到工作区配置。

---

## 3.6 阶段五：Prompt 构建

### 3.6.1 动态上下文

```typescript
// 源码第 1028-1032 行
const dynamicCtx = buildDynamicContext({
  workspaceName: workspace?.name,
  workspaceSlug,
  agentCwd,
})
```

每次发消息时实时计算，内容很短（几十行），包括：
- 当前精确时间（含时区、分钟）
- 工作区 MCP 服务器列表（名称、类型、启用状态）
- skill-creator 改进提示（如果启用了该 Skill）
- 当前工作目录

### 3.6.2 Mention 工具引用

```typescript
// 源码第 1034-1049 行
let enrichedMessage = userMessage

if (mentionedSkills?.length || mentionedMcpServers?.length) {
  const toolLines: string[] = [
    '用户在消息中明确引用了以下工具，请在本次回复中主动调用：'
  ]

  for (const slug of mentionedSkills ?? []) {
    // Skill 需要完整限定名：proma-workspace-工作区名:skill-slug
    const qualifiedName = workspaceSlug
      ? `proma-workspace-${workspaceSlug}:${slug}`
      : slug
    toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
  }

  for (const name of mentionedMcpServers ?? []) {
    toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
  }

  enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${userMessage}`
}
```

当用户在 UI 上通过 `@skill:skill-name` 或 `#mcp:server-name` 引用工具时，这段代码在用户消息前注入指令。

**为什么 Skill 需要完整限定名？**

SDK 通过 plugin 机制加载 Skill，Skill 的调用名称遵循 `proma-workspace-{工作区slug}:{skill-slug}` 格式。如果只传 `skill-slug`，SDK 可能找不到对应的 Skill。

### 3.6.3 最终 Prompt

```typescript
// 源码第 1051-1064 行
const contextualMessage = `${dynamicCtx}\n\n${enrichedMessage}`

const isCompactCommand = userMessage.trim() === '/compact'

const finalPrompt = isCompactCommand
  ? '/compact'               // 压缩命令，原样传给 SDK
  : existingSdkSessionId
    ? contextualMessage      // Resume：只需当前消息
    : buildContextPrompt(    // 新会话：需要拼接历史
        sessionId,
        contextualMessage,
        { agentCwd },
      )

console.log(
  existingSdkSessionId
    ? `[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`
    : `[Agent 编排] 无 resume，已回填历史上下文（最近 20 条消息）`
)
```

三条路径：

```
用户输入 "/compact"？
  ├─ YES → 直接传 '/compact'
  │         SDK 识别为内置压缩指令
  │         不附加任何上下文
  │
  └─ NO → 已有 SDK session？
            │
            ├─ YES → contextualMessage
            │         = dynamicCtx + enrichedMessage
            │         SDK 保留完整历史，无需拼接
            │
            └─ NO  → buildContextPrompt(...)
                      = <conversation_history> + contextualMessage
                      需拼接最近 20 条消息摘要
```

---

## 3.7 阶段六：权限模式与 canUseTool 构建

### 3.7.1 权限模式优先级

```typescript
// 源码第 1067-1073 行
const initialPermissionMode: PromaPermissionMode = permissionModeOverride   // 最高优先级
  ?? (workspaceSlug
    ? getWorkspacePermissionMode(workspaceSlug)          // 工作区级设置
    : (appSettings.agentPermissionMode ?? 'auto'))      // 应用全局设置 → 默认 auto

// 注册到 Map，支持运行中动态切换
this.sessionPermissionModes.set(sessionId, initialPermissionMode)
```

三层优先级：

```
① permissionModeOverride（外部强制覆盖）
  飞书 Bridge 等无 UI 交互场景 → 强制 bypassPermissions
     ↓ 未设置
② 工作区级设置
  用户为每个工作区独立配置
     ↓ 未设置或无工作区
③ 应用全局设置 → 默认 'auto'
```

**为什么用 Map 而不是闭包变量？**

```typescript
// 动态读取权限模式（第 1077-1078 行）
const getPermissionMode = (): PromaPermissionMode =>
  this.sessionPermissionModes.get(sessionId) ?? initialPermissionMode
```

用 Map 的原因是：权限模式需要在运行时动态切换。用户可能在 Agent 运行中点击 PermissionMode Selector 从 `auto` 切换到 `bypassPermissions`。Map 让 `getPermissionMode()` 这个闭包能读到最新值，不需要重建整个 `canUseTool` 回调。

### 3.7.2 canUseTool 构建

整个 `canUseTool` 回调用闭包实现，捕获了 `sessionId`、`getPermissionMode`、`eventBus`、`autoCanUseTool` 等上下文。每次 SDK 调用它时，它通过 `getPermissionMode()` 读取当前权限模式并分派：

```
canUseTool(toolName, input, options)
  │
  ├─ 参数校验守卫（所有模式、所有工具通用）
  │    ├─ validateToolInput(toolName, input) → 参数缺失？→ deny
  │    └─ Write 内容过大？→ deny（token 截断防护）
  │
  ├─ 特殊工具处理
  │    ├─ EnterPlanMode → 标记 planModeEntered = true，通知渲染进程
  │    ├─ ExitPlanMode → 审批流程（agent-orchestrator 自己的逻辑）
  │    └─ AskUserQuestion → 委托给 askUserService
  │
  └─ 普通工具分派
       ├─ bypassPermissions → allow
       ├─ plan → 只读工具 + .md 写入 → allow；其余 → deny
       └─ auto → autoCanUseTool（委托给 permissionService）
```

这个阶段的权限检查在之前的架构分析中已经详细覆盖过。它在 `queryOptions` 中的注册：

```typescript
// 源码第 1275-1277 行
allowDangerouslySkipPermissions: !canUseTool,
// 有 canUseTool 回调时，必须为 false
// 否则 CLI 同时收到 --allow-dangerously-skip-permissions 和 --permission-prompt-tool stdio
// 两个矛盾的指令，导致 ExitPlanMode/AskUserQuestion 交互式工具失败
canUseTool,
```

---

## 3.8 阶段七：queryOptions 组装

把所有准备好的数据打包成 `ClaudeAgentQueryOptions`：

```typescript
// 源码第 1261-1364 行 — queryOptions 完整结构
const queryOptions: ClaudeAgentQueryOptions = {
  sessionId,                                   // Proma 会话 ID
  prompt: finalPrompt,                         // 经过所有处理后的最终 prompt
  model: modelId || DEFAULT_MODEL_ID,          // claude-sonnet-4-6
  cwd: agentCwd,                               // session 独立目录或 home
  sdkCliPath: cliPath,                         // SDK CLI binary 绝对路径
  env: sdkEnv,                                 // 清理过的环境变量
  maxTurns,                                    // 最大轮次（可选）
  sdkPermissionMode: initialPermissionMode,    // SDK 自身的权限模式
  allowDangerouslySkipPermissions: !canUseTool,// 有 canUseTool 就必须为 false
  canUseTool,                                  // 自定义权限回调
  allowedTools: [...SAFE_TOOLS],              // auto 模式的只读工具白名单

  // 系统提示词：分层构建
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',                     // SDK 内置 preset
    append: buildSystemPrompt({               // Proma 自定义指令
      workspaceName, workspaceSlug, sessionId,
      permissionMode: initialPermissionMode,
      memoryEnabled: ..., claudeAvailable,
    }),
  },

  // Session 管理
  resumeSessionId: existingSdkSessionId,       // 关键：resume 用的 SDK session ID
  resumeSessionAt: rewindResumeAt,             // 回退后从指定消息继续

  // 工具
  mcpServers,                                  // MCP 服务器 + 记忆/生图工具
  plugins: [{ type: 'local', path: ... }],    // Skill 插件

  // 目录
  additionalDirectories: [                     // 用户附加 + 工作区附加 + 工作区文件
    ...additionalDirectories,
    ...workspaceAttachedDirs,
    workspaceFilesDir,
  ],

  // 高级选项
  enableFileCheckpointing: true,               // 启用文件检查点
  thinking: appSettings.agentThinking,         // 思考模式
  effort: appSettings.agentEffort ?? 'high',   // 推理深度
  maxBudgetUsd: appSettings.agentMaxBudgetUsd, // 预算上限
  betas: ['context-1m-2025-08-07'],           // 1M context window（支持的模型）
  agents: buildBuiltinAgents(claudeAvailable), // 内置 SubAgent 定义

  // 回调
  onStderr: (data) => { stderrChunks.push(data) },
  onSessionId: (id) => {
    capturedSdkSessionId = id           // 保存供 auto-resume 使用
    updateAgentSessionMeta(sessionId, { sdkSessionId: id })  // 持久化供下次 resume
    if (!titleGenerationStarted) {
      autoGenerateTitle(...)            // SDK 就绪后生成标题
    }
  },
  onModelResolved: (model) => {
    resolvedModel = model               // SDK 可能用了不同于请求的模型
    eventBus.emit({ type: 'model_resolved', model })
  },
  onContextWindow: (cw) => {
    console.log(`[Agent 编排] 缓存 contextWindow: ${cw}`)
  },
}
```

**几个 queryOptions 关键设计**：

1. **`allowDangerouslySkipPermissions` 与 `canUseTool` 互斥**：如果同时为 true 和提供回调，SDK CLI 会收到矛盾的指令。Proma 的设计是：有 `canUseTool` 时 `allowDangerouslySkipPermissions` 强制为 false。

2. **`resumeSessionAt` vs `resumeSessionId`**：`resumeSessionId` 是"恢复哪个 session"；`resumeSessionAt` 是"在 session 内的哪个消息点分叉"。后者用于快照回退功能。

3. **`additionalDirectories` 的三个来源**：用户手动附加的目录 + 工作区级附加目录 + 工作区文件目录（`workspace-files/`）。Promise 用 IIFE 合并它们。

4. **`betas` 按模型自动选择**：检查当前模型是否支持 1M context window（`supports1MContext()`），支持才启用。不支持的模型启用会导致 SDK 报错。

---

## 第三阶段总结

从用户点击发送到 `queryOptions` 准备就绪，编排器完成了 **15 个步骤**：

```
用户消息到达
  │
  ├─  0.  并发保护（activeSessions.has）
  ├─  0.5 清除上一轮的中断标记
  │
  ├─  1.  Windows Shell 环境检查（Windows 平台）
  ├─  2.  渠道查找 + API Key 解密
  ├─  2.1 槽位抢占（在所有 await 之前！← 防并发）
  │
  ├─  3.  环境变量构建（清理 ANTHROPIC_* + 注入凭证 + 代理 + 双保险清零）
  │        ↑ 第一个真正的 await
  ├─  4.  读取 SDK Session ID（判断 Resume vs 上下文回填）
  ├─  4.1 检测回退后的 resume 截断点
  ├─  5.  持久化用户消息到 JSONL
  │
  ├─  6.  状态初始化
  ├─  7.  动态导入 SDK + 解析 CLI binary 路径（3 种策略降级）
  ├─  8.  确定 Agent 工作目录（home vs session 独立目录）
  ├─  9.  确保 SDK 项目设置（plansDirectory + skipWebFetchPreflight）
  │
  ├─ 10.  构建 MCP 服务器配置 + 注入记忆工具（SDK API）+ 注入生图工具
  │      + 合并自定义 MCP（飞书等外部集成）
  │
  ├─ 11.  构建动态上下文（时间 + 工作区状态）
  │      + 注入 mention 工具引用指令
  │      + 构建最终 prompt（3 条路径：/compact / resume / 回填）
  │
  ├─ 12.  读取权限模式（3 层优先级：外部覆盖 > 工作区 > 全局）
  │      + 构建 canUseTool 回调（闭包 + 动态读取 Map）
  │
  └─ 13.  组装 queryOptions
          → 传给 adapter.query()
```

**关键设计模式总结**：

| 模式 | 解决的问题 | 位置 |
|------|----------|------|
| **Slot Preemption** | 异步操作期间的并发安全 | 步骤 2.1 |
| **Generation 匹配** | 旧流 finally 不误删新流注册 | finally 块 |
| **Resume + 回填双轨** | SDK session 过期时的无缝降级 | 步骤 4/11 |
| **ANTHROPIC_* 双重隔离** | 防止开发环境变量泄漏到 SDK | 步骤 3 |
| **TypedError + actions** | 结构化错误 → UI 可展示恢复按钮 | 所有 pre-flight 检查 |
| **闭包读取 Map** | 运行中动态切换权限模式 | 步骤 12 |
| **required: false** | MCP 失败不影响主流程 | 步骤 10 |
| **IIFE 合并目录** | 三元来源的附加目录合并 | 步骤 13 |

---

**下一阶段（第四阶段）**：事件循环——Adapter 产出的 SDKMessage 流如何被遍历、错误分类、自动重试、Watchdog 死锁检测、Agent Teams 追踪、持久化、以及 Auto-Resume。这是编排器最复杂的部分。
