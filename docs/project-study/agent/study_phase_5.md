# 第五阶段：人机交互闭环 + Prompt 构建

## 学习目标

读完第五阶段，你应该能回答：

- SDK 的同步回调签名怎么等用户异步点"允许/拒绝"？（Promise + Map 模式）
- 为什么子代理的工具调用要自动批准？
- "始终允许"选项怎么实现？白名单为什么还需要二次验证？
- AskUserQuestion 的用户答案怎么注入回工具结果？
- ExitPlanMode 审批通过后权限模式怎么切换？
- Prompt 为什么分三层？与 Prompt Caching 有什么关系？
- 内置 SubAgent 的 prompt 和 tools 是怎么定义的？

---

## 5.1 核心模式：Promise + Map 异步桥接

三个服务（Permission、AskUser、ExitPlanMode）共享同一个设计模式，解决一个根本矛盾：

```
SDK 的 canUseTool 是 async 回调 → SDK 内部 await 这个回调的结果
但用户的决策需要经过 IPC → 渲染进程 → 用户点击 → IPC → 主进程
整个过程是异步的，可能需要几秒甚至几分钟
```

**模式实现**：

```typescript
// 三步走

// 步骤 1：创建请求，发到 UI，返回 Promise（阻塞 SDK）
handleRequest(input) {
  const requestId = randomUUID()
  const request = { requestId, ... }

  sendToRenderer(request)  // → IPC → 渲染进程显示 UI

  return new Promise((resolve) => {
    this.pendingRequests.set(requestId, { resolve, request })  // ← 存 Map

    // 注册 AbortSignal：如果用户关闭 Tab 或停止 Agent
    signal.addEventListener('abort', () => {
      this.pendingRequests.delete(requestId)
      resolve({ behavior: 'deny', message: '操作已中止' })
    }, { once: true })
  })
}

// 步骤 2：IPC handler 收到用户响应后调用
respondToRequest(requestId, userAnswer) {
  const pending = this.pendingRequests.get(requestId)  // ← 从 Map 取出
  if (!pending) return null

  pending.resolve({ behavior: 'allow', ...userAnswer })  // ← resolve Promise
  this.pendingRequests.delete(requestId)                  // ← SDK 解除阻塞
}
```

**为什么这个模式可靠？**

1. **单线程保证**：Node.js 主进程是单线程，Map 的 get/set/delete 操作天然线程安全
2. **AbortSignal 防泄漏**：用户关闭 Tab → signal 触发 → pending Promise 被 resolve 为 deny → 内存释放
3. **finally 兜底清理**：所有三个服务都有 `clearSessionPending()` 方法，在 session 结束时无条件清理所有残留 Promise

---

## 5.2 权限服务

文件路径：`apps/electron/src/main/lib/agent-permission-service.ts`（378 行）

### 5.2.1 canUseTool 的完整决策链

```typescript
// createCanUseTool 返回的函数（源码第 124-160 行，简化版）
async (toolName, input, options) => {

  // ── ① AskUserQuestion 拦截 ──
  if (toolName === 'AskUserQuestion' && askUserHandler) {
    return askUserHandler(sessionId, input, options.signal, sendAskUserToRenderer)
  }

  // ── ② Worker 子代理工具 → 直接批准 ──
  // 原因：sub-agent 的工具调用如果也弹审批，会导致多级 UI 等待死锁
  if (options.agentID) {
    return { behavior: 'allow', updatedInput: input }
  }

  // ── ③ 会话白名单命中 → 直接批准 ──
  // 用户之前对这个工具/命令选了"始终允许"
  if (this.isWhitelisted(sessionId, toolName, input)) {
    return { behavior: 'allow', updatedInput: input }
  }

  // ── ④ 只读工具 → 直接批准 ──
  // SDK 的 auto classifier 对只读操作未必真的放行
  // 这里做本地兜底，避免用户被无意义的审批打扰
  if (this.isReadOnlyTool(toolName, input)) {
    return { behavior: 'allow', updatedInput: input }
  }

  // ── ⑤ 需要询问用户 ──
  const request = this.buildPermissionRequest(sessionId, toolName, input, options)
  sendToRenderer(request)  // → EventBus → IPC → UI 横幅

  return new Promise<PermissionResult>((resolve) => {
    this.pendingPermissions.set(request.requestId, { resolve, request })

    // AbortSignal：会话中止时自动拒绝
    options.signal.addEventListener('abort', () => {
      if (this.pendingPermissions.has(request.requestId)) {
        this.pendingPermissions.delete(request.requestId)
        resolve({ behavior: 'deny', message: '操作已中止' })
      }
    }, { once: true })
  })
}
```

**决策树可视化**：

```
canUseTool(toolName, input, options)
  │
  ├─ AskUserQuestion？ → 委托给 askUserService
  │
  ├─ options.agentID 存在？ → 子代理工具，直接批准
  │   （原因：sub-agent 的权限请求如果也等待 UI → 主 Agent 死锁）
  │
  ├─ 会话白名单命中？ → 直接批准
  │   （用户之前选了"始终允许"）
  │
  ├─ 是只读工具？ → 直接批准
  │   （Read / Glob / Grep / WebSearch / WebFetch / 安全的 Bash 命令）
  │
  └─ 需要用户决策 → Promise 阻塞等待
       └─ 用户点击"允许"或"拒绝" → resolve Promise
```

**为什么子代理工具要跳过权限检查？**

```
主 Agent 调 Agent 工具 → 启动 sub-agent
  → sub-agent 调 Write 工具 → canUseTool 被调用
    → 如果此时弹审批 UI...
      → 用户在忙别的，没看到
        → sub-agent 一直阻塞
          → 主 Agent 的 Task 工具一直等 sub-agent
            → 死锁！Watchdog 也无法恢复（不是 Agent Teams 场景）
```

所以 `options.agentID` 一出现就直接放行——子代理的权限应该由主 Agent 的权限模式决定，不需要二级审批。

### 5.2.2 会话白名单

当用户在审批弹窗中勾选"始终允许"后：

```typescript
// 源码第 255-267 行
private addToWhitelist(sessionId: string, toolName: string, input: Record<string, unknown>): void {
  const whitelist = this.getOrCreateWhitelist(sessionId)

  if (toolName !== 'Bash') {
    // 普通工具：直接加工具名
    whitelist.allowedTools.add(toolName)
  } else {
    // Bash 工具：提取基础命令加入白名单
    const command = typeof input.command === 'string' ? input.command : ''
    const baseCommand = this.extractBaseCommand(command)
    if (baseCommand) {
      whitelist.allowedBashCommands.add(baseCommand)
    }
  }
}
```

**基础命令提取**：

```typescript
// 源码第 289-296 行
private extractBaseCommand(command: string): string {
  const parts = command.trim().split(/\s+/)
  // 两词组合命令
  if (parts.length >= 2 && ['git', 'npm', 'bun', 'yarn', 'pnpm'].includes(parts[0]!)) {
    return `${parts[0]} ${parts[1]}`   // "git push"、"npm install"
  }
  // 单词命令
  return parts[0] ?? ''               // "ls"、"cat"、"node"
}
```

**白名单检查时的二次验证（纵深防御）**：

```typescript
// 源码第 235-250 行
private isWhitelisted(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
  const whitelist = this.sessionWhitelists.get(sessionId)
  if (!whitelist) return false

  if (toolName !== 'Bash') {
    return whitelist.allowedTools.has(toolName)
  }

  // Bash 工具：即使基础命令在白名单中，也要重新检查完整命令的安全性！
  const command = typeof input.command === 'string' ? input.command : ''
  if (hasDangerousStructure(command)) return false   // 管道连接到危险命令
  if (isDangerousCommand(command)) return false       // rm -rf / 等
  const baseCommand = this.extractBaseCommand(command)
  return whitelist.allowedBashCommands.has(baseCommand)
}
```

**为什么需要二次验证？**

```
用户对 git push origin main 选了"始终允许"
  → 白名单加入 "git push"

后来 Agent 想执行：
  rm -rf / | git push origin main

如果不做二次验证，白名单检查只看基础命令 → "git push" 命中 → 放行
但实际上，管道前的 rm -rf / 会先执行！

二次验证：
  → extractBaseCommand("rm -rf / | git push origin main") = "rm" (不是 git push，不匹配)
  或者
  → hasDangerousStructure(command) 检测到管道配合危险命令 → 拒绝
```

**白名单只是"信任这个工具类别"，不是"信任任意组合"**。

### 5.2.3 渲染进程重载恢复

```typescript
// 源码第 203-205 行
getPendingRequests(): PermissionRequest[] {
  return [...this.pendingPermissions.values()].map((p) => p.request)
}
```

Electron 的渲染进程可能因为 crash 或手动刷新（Cmd+R）而重载。重载后所有 React 组件状态丢失——包括正在显示的权限请求横幅。

前端重载后调用 IPC `agent:get-pending-requests`，遍历所有 pending 的权限请求，重新渲染横幅。用户不会丢失任何待审批的操作。

对应的 IPC handler（在 `ipc.ts` 中）：

```typescript
ipcMain.handle('agent:get-pending-requests', () => {
  return {
    permissions: permissionService.getPendingRequests(),
    askUsers: askUserService.getPendingRequests(),
    exitPlans: exitPlanService.getPendingRequests(),
  }
})
```

---

## 5.3 AskUser 交互式问答服务

文件路径：`apps/electron/src/main/lib/agent-ask-user-service.ts`（155 行）

### 5.3.1 与权限服务的核心差异

虽然同样使用 Promise + Map 模式，但 AskUser 有一个关键不同：**它需要修改工具的输入（`updatedInput`）**。

```typescript
// 源码第 84-101 行
respondToAskUser(requestId: string, answers: Record<string, string>): string | null {
  const pending = this.pendingRequests.get(requestId)
  if (!pending) return null

  const sessionId = pending.request.sessionId

  // 关键：构建 updatedInput
  const updatedInput: Record<string, unknown> = {
    ...pending.request.toolInput,   // 保留 SDK 原始输入
    answers,                         // 注入用户回答
  }

  pending.resolve({
    behavior: 'allow',
    updatedInput,                    // ← 修改过的 input 返回给 SDK
  })
  this.pendingRequests.delete(requestId)
  return sessionId
}
```

**为什么需要 `updatedInput`？**

SDK 的 `AskUserQuestion` 工具的内部逻辑大致是：

```typescript
// SDK 内部伪代码
async function AskUserQuestion(input) {
  const result = await canUseTool('AskUserQuestion', input, options)
  // result.updatedInput.answers ← 用户回答在这里！
  return { answers: result.updatedInput.answers }
}
```

如果不把 `answers` 注入 `updatedInput` 返回，SDK 就收不到用户的回答，AskUserQuestion 工具永远返回空结果。

### 5.3.2 问题解析

```typescript
// 源码第 129-149 行
private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
  const rawQuestions = input.questions
  if (!Array.isArray(rawQuestions)) return []

  return rawQuestions.map((q: unknown): AskUserQuestion => {
    const raw = q as Record<string, unknown>
    const options = Array.isArray(raw.options)
      ? (raw.options as Array<Record<string, unknown>>).map((o): AskUserQuestionOption => ({
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : undefined,
          preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,  // 截断！
        }))
      : []

    return {
      question: typeof raw.question === 'string' ? raw.question : '',
      header: typeof raw.header === 'string' ? raw.header : undefined,
      options,
      multiSelect: raw.multiSelect === true,
    }
  })
}
```

注意 `preview.slice(0, 10_000)`：preview 是每个选项的预览内容（可能是一大段代码或 Markdown 文档），限制在 10,000 字符防止过大的数据通过 IPC 传输堵塞通道。

---

## 5.4 ExitPlanMode 计划审批服务

文件路径：`apps/electron/src/main/lib/agent-exit-plan-service.ts`（185 行）

### 5.4.1 四种用户选择

```typescript
// 源码第 95-145 行
respondToExitPlanMode(response: ExitPlanModeResponse) {
  const pending = this.pendingRequests.get(response.requestId)
  if (!pending) return null

  const sessionId = pending.request.sessionId
  this.pendingRequests.delete(response.requestId)

  switch (response.action) {

    case 'approve_auto': {
      // 批准 + 切换到 bypassPermissions（全自动）
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.toolInput,
        targetMode: 'bypassPermissions',
      })
      return { sessionId, targetMode: 'bypassPermissions' }
    }

    case 'approve_edit': {
      // 批准 + 保持 auto（需要逐一审批）
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.toolInput,
        targetMode: 'auto',
      })
      return { sessionId, targetMode: 'auto' }
    }

    case 'deny': {
      // 拒绝
      pending.resolve({ behavior: 'deny', message: '用户拒绝了计划' })
      return { sessionId, targetMode: null }
    }

    case 'feedback': {
      // 提供修改意见（拒绝 + 附带反馈）
      pending.resolve({
        behavior: 'deny',
        message: response.feedback ?? '用户要求修改计划',
      })
      return { sessionId, targetMode: null }
    }
  }
}
```

**targetMode 的作用链**：

```
ExitPlanService.respondToExitPlanMode 返回 { sessionId, targetMode }
  │
  ▼
Orchestrator 的 canUseTool 闭包（第三阶段讲过）:
  │
  ├─ this.sessionPermissionModes.set(sessionId, targetMode)
  │   下次 canUseTool 调用时 getPermissionMode() 返回新模式
  │
  ├─ planModeEntered = false
  │   后续 ExitPlanMode 调用不再走审批（静默放行）
  │
  └─ this.adapter.setPermissionMode(sessionId, targetMode)
      同步通知 SDK 侧切换权限模式
```

### 5.4.2 allowedPrompts 解析

```typescript
// 源码第 169-179 行
private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
  const raw = input.allowedPrompts
  if (!Array.isArray(raw)) return []

  return raw
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null
    )
    .map((item): ExitPlanAllowedPrompt => ({
      tool: typeof item.tool === 'string' ? item.tool as 'Bash' : 'Bash',
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
    }))
    .filter((item) => item.prompt.length > 0)
}
```

`allowedPrompts` 是 Agent 在调用 ExitPlanMode 时告知"我接下来要做这些操作"的列表，例如：

```json
[
  { "tool": "Bash", "prompt": "run tests with pytest" },
  { "tool": "Bash", "prompt": "install missing dependencies" }
]
```

审批 UI 展示这个列表，让用户清楚知道 Agent 的后续计划。

### 5.4.3 planModeEntered 守卫

```typescript
// orchestrator 中（第三阶段讲过的 canUseTool）
if (toolName === 'ExitPlanMode') {
  if (!planModeEntered) {
    return { behavior: 'allow', updatedInput: input }  // 静默放行，不弹审批
  }
  const result = await handleExitPlanMode(input, options.signal)
  // ... 正常审批流程
}
```

这个守卫防止 Agent 在非 plan 模式下误调 ExitPlanMode。例如用户一开始就是 `bypassPermissions` 模式，Agent 调了 ExitPlanMode 不应该弹审批 UI。

---

## 5.5 三个服务的对比

| 维度 | PermissionService | AskUserService | ExitPlanService |
|------|------------------|---------------|----------------|
| **触发时机** | SDK auto 模式的 escalation | Agent 调 AskUserQuestion 工具 | Agent 调 ExitPlanMode 工具 |
| **用户输入** | 允许/拒绝 + "始终允许"勾选 | 选择题答案（可多选、多问题） | 批准方式 + 可选反馈 |
| **updatedInput** | 原样返回 | 注入 `answers` 字段（关键！） | 原样返回 |
| **附加效果** | 更新会话白名单 | 无 | 返回 targetMode → 切换权限模式 |
| **复杂度** | 最高（白名单、只读判断、危险评级） | 最低（纯格式转换+注入） | 中等（四种 action 分支 + 模式切换） |

---

## 5.6 Prompt 构建（可选内容）

文件路径：`apps/electron/src/main/lib/agent-prompt-builder.ts`（492 行）

### 5.6.1 三层 Prompt 架构

```
┌──────────────────────────────────────────┐
│  Layer 1: claude_code preset (SDK 内置)  │  ← 约 1500 tokens
│  - 平台信息（OS/Shell/Git）               │     完全静态，利用 Prompt Caching
│  - 模型信息、知识截止日期                  │
│  - 基础工具说明                           │
├──────────────────────────────────────────┤
│  Layer 2: buildSystemPrompt()             │  ← 约 3000 tokens
│  - Proma Agent 角色定义                   │     完全静态，利用 Prompt Caching
│  - SubAgent 委派策略（含模型选择）         │
│  - 工作区路径信息                          │
│  - 记忆系统使用指引                        │
│  - 文档输出规范                            │
│  - 交互规范                                │
├──────────────────────────────────────────┤
│  Layer 3: buildDynamicContext()           │  ← 约 100-300 tokens
│  - 当前精确时间（含时区、分钟）             │     每次消息实时计算
│  - 工作区实时状态（MCP 列表、Skills 状态） │     非常短小，缓存开销可忽略
│  - 当前工作目录                            │
└──────────────────────────────────────────┘
```

**为什么分层？——Prompt Caching 的经济学**

Anthropic 的 Prompt Caching 机制：请求之间相同的前缀/tag 内容会被缓存，缓存命中的 tokens 按 1/10 价格计费。

Layer 1 + Layer 2 在同一个 session 的所有消息中完全不变 → 可被缓存。
Layer 3 每次都变，但只有 ~200 tokens → 缓存失效的代价极小。

**算一笔账**：
- Layer 1+2 = 4500 tokens
- 100 轮对话，每次 Layer 3 = 200 tokens
- 启用缓存：4500 (首轮全价) + 99 × 4500 × 0.1 (缓存命中) + 100 × 200 = 4500 + 44550 + 20000 = 69050 tokens 等效计费
- 不启用缓存：100 × (4500 + 200) = 470000 tokens
- **节省了约 85% 的 prompt token 费用**

### 5.6.2 内置 SubAgent 定义

```typescript
// 源码第 25-81 行
export function buildBuiltinAgents(claudeAvailable = true): Record<string, AgentDefinition> {
  const light = claudeAvailable ? 'haiku' : undefined
  return {
    'code-reviewer': {
      description: '代码审查子代理。在完成代码修改后调用...',
      prompt: `你是一个专注于代码质量的审查员。你的职责是：
1. 审查变更的代码，关注逻辑错误和边界情况...
2. 检查规范一致性：读取 CLAUDE.md...
3. 输出格式：按严重程度分类...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      ...(light && { model: light }),
    },
    'explorer': {
      description: '代码库探索子代理。用于快速搜索文件...',
      prompt: `你是一个高效的代码库探索员。并行使用 Glob 和 Grep 搜索...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      ...(light && { model: light }),
    },
    'researcher': {
      description: '技术调研子代理。用于对比技术方案...',
      prompt: `你是一个技术调研员。输出结构化的分析报告...`,
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      ...(light && { model: light }),
    },
  }
}
```

**每个 SubAgent 有独立定制的 prompt 和有限工具集**：

| Agent | 定制的行为 | 可用工具 |
|-------|----------|---------|
| explorer | 强调并行搜索 + 只收集不修改 | Read, Glob, Grep, Bash |
| researcher | 强调结构化输出 + 推荐方案 | Read, Glob, Grep, Bash, WebSearch, WebFetch |
| code-reviewer | 强调按严重程度分类 + 检查规范 | Read, Glob, Grep, Bash |

**非 Claude 渠道的兼容设计**：

```typescript
const light = claudeAvailable ? 'haiku' : undefined
// claudeAvailable = false → model 为 undefined
// → SubAgent 不指定 model → SDK 让它继承主 Agent 模型
```

DeepSeek、Kimi 等模型不支持 haiku/sonnet/opus 的模型别名。传了不认识的 model 会导致 SDK 报错。不传 model 是最安全的兼容策略。

### 5.6.3 记忆系统的 Prompt 设计

```typescript
// 源码第 297-335 行（核心片段）
`**理解记忆的本质：**
- 记忆是"我们一起经历过的事"，不是"关于用户的信息条目"
- 回忆起过去的经历时，像老搭档一样自然地带入，而不是像在查档案
- 例如：不要说"根据记忆记录，您偏好使用 Tailwind"
  而是自然地按照那个偏好去做，就像你本来就知道一样`
```

**这段 prompt 的精妙之处**：

不是下规则（"不要引用记忆记录"），而是给范例（"不要像在查档案，要像老搭档"）。这对 LLM 来说更有效——LLM 更擅长模仿范例而不是遵循否定性规则。

实际效果对比：
- 坏：AI 说"根据记忆记录 #42，您之前喜欢用 pnpm"（像机器人查数据库）
- 好：AI 直接用 `pnpm install`，不说为什么（像记得你习惯的老搭档）

### 5.6.4 动态上下文中的 Skill 改进提示

```typescript
// 源码第 457-477 行
const skills = getWorkspaceSkills(ctx.workspaceSlug)
const hasSkillCreator = skills.some((s) => s.slug === 'skill-creator')
if (hasSkillCreator) {
  wsLines.push('<skill_improvement_hint>',
    'skill-creator 已启用。在整个对话过程中，留意以下信号：',
    '',
    '**现有 Skill 改进信号：**',
    '- 用户主动修正了某个 Skill 产出的内容 → 该 Skill 可能需要更新',
    '- 某个 Skill 的输出持续需要大量后续调整 → 可能需要重构',
    '',
    '**新 Skill 创建信号：**',
    '- 用户反复描述一类任务但没有匹配的 Skill → 可能值得创建新 Skill',
    '- 你在对话中经历了一个有价值的多步工作流... → 主动建议将其固化为 Skill',
    '',
    '**行动原则：**',
    '- 征得用户同意后通过 skill-creator 执行',
    '- 仅在确实观察到高复用价值的模式时才提出',
    '</skill_improvement_hint>',
  )
}
```

这段动态上下文仅在用户启用了 skill-creator Skill 时才注入。它引导 Agent 在对话中被动观察用户的交互模式，实现**AI 辅助的工具链自我进化**：

```
用户反复说"帮我把这个转成 PDF" → 没有专门的 PDF Skill
  → Agent 识别到这是重复模式
  → Agent 主动建议："我注意到你经常要处理 PDF，要不要创建一个 PDF Skill？"
  → 用户同意 → Agent 调 skill-creator 创建新 Skill
  → 以后用户说"转 PDF"，Agent 自动调这个 Skill
```

### 5.6.5 动态上下文的"实时性"

```typescript
// 源码第 411-417 行注释
/**
 * 构建每条消息的动态上下文
 *
 * 包含当前时间、工作区实时状态（MCP 服务器 + Skills）和工作目录。
 * 每次调用都从磁盘实时读取，确保配置变更后下一条消息即可感知。
 */
export function buildDynamicContext(ctx: DynamicContext): string {
  const mcpConfig = getWorkspaceMcpConfig(ctx.workspaceSlug)  // ← 实时读磁盘
  const skills = getWorkspaceSkills(ctx.workspaceSlug)         // ← 实时读磁盘
  // ...
}
```

**为什么要实时读磁盘而不是缓存？**

```
用户在设置中启用了一个新的 MCP 服务器 "playwright"
  → mcp.json 被写入磁盘
  → 不需要重启 Agent session
  → 下一条消息的 buildDynamicContext() 读到新配置
  → Agent 在动态上下文中看到：
      "MCP 服务器: playwright (stdio, 已启用): npx @playwright/mcp@latest"
  → Agent 开始使用 Playwright 工具
```

如果缓存了 MCP 配置，用户必须重启 session 才能使用新工具——这是一个体验断层。实时读磁盘虽然每次消息多几十毫秒 I/O，但换来了"改完即刻生效"的体验。

---

## 第五阶段总结

**三个交互服务**的比较：

| 维度 | PermissionService | AskUserService | ExitPlanService |
|------|------------------|---------------|----------------|
| 核心模式 | Promise+Map | Promise+Map | Promise+Map |
| 特殊逻辑 | 白名单+危险评估+Worker 跳过 | 问题解析+answers 注入 | 四种 action+targetMode 切换 |
| 用户操作 | 允许/拒绝+记住 | 选择答案 | 批准方式(全自动/手动/拒绝/反馈) |
| SDK 影响 | 返回 allow/deny | 修改 updatedInput | 修改权限模式 |

**Prompt 构建的核心设计**：

| 设计 | 解决的问题 |
|------|----------|
| 三层架构 (preset+append+dynamic) | Prompt Caching 命中率最大化，省 token 费 |
| SubAgent 定制 prompt + 有限工具 | 每个子代理专注于特定任务，不出界 |
| claudeAvailable 判断 | 非 Claude 渠道不设 model，兼容 DeepSeek/Kimi |
| 记忆系统"范例式"引导 | 引导 AI 自然使用记忆，而非机械引用 |
| 动态上下文实时读磁盘 | 配置变更下一条消息即刻感知 |
| skill-creator 自动改进提示 | AI 辅助识别可固化的工具链模式 |
