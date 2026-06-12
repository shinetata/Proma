# Cursor CLI Plan 模式契约调研

> 调研日期：2026-06-12  
> CLI 路径：`~/.local/bin/cursor-agent`  
> 参考：`cursor-agent --help`、Proma `CursorAgentAdapter` 实现

## 启动参数

| Proma 权限模式 | cursor-agent 参数 | 说明 |
|----------------|-------------------|------|
| `plan` | `--mode plan`（或 `--plan`） | 只读规划，不执行写操作 |
| `auto` / `bypassPermissions` | `--force --trust` | headless 自动放行 |

`--mode plan` 官方描述：

```text
plan: read-only/planning (analyze, propose plans, no edits)
```

另有 `--mode ask`（Q&A 只读），Proma 暂未映射。

## Headless 调用契约

Proma 使用的标准参数：

```bash
cursor-agent -p \
  --output-format stream-json \
  --trust \
  --mode plan \          # 或省略（配合 --force）
  --workspace=<cwd> \
  --model=<model> \
  --resume=<chatId> \
  "<prompt>"
```

环境变量：`CURSOR_API_KEY`（剥离 `ANTHROPIC_*`）。

## NDJSON 事件类型

| type | subtype | Proma 翻译 |
|------|---------|------------|
| `system` | `init` | `SDKSystemMessage` + 捕获 `session_id` / `model` |
| `user` | — | 跳过（避免重复） |
| `assistant` | — | 文本 `SDKAssistantMessage` |
| `tool_call` | `started` | `tool_use` |
| `tool_call` | `completed` | `tool_result` |
| `result` | `success` / `error` | `SDKResultMessage` |

`result` 事件**不含 token 计数**（`usage` 恒为 0）。

## 工具名归一化

Cursor CLI 工具 key 经 `CursorAgentAdapter.TOOL_NAME_MAP` 映射为 Proma 展示名：

| Cursor key | Proma 名 |
|------------|----------|
| `readToolCall` | `Read` |
| `writeToolCall` | `Write` |
| `grepToolCall` / `globToolCall` | `Grep` / `Glob` |
| `shellToolCall` / `bash` | `Bash` |
| `switchModeToolCall` / `switchmode` | `SwitchMode` |
| `createPlanToolCall` / `createplan` | `CreatePlan` |

## SwitchMode

Cursor Agent 通过 `SwitchMode` 工具切换执行模式（非 Claude SDK 的 `EnterPlanMode` / `ExitPlanMode`）。

典型 input（推断，以实际 NDJSON 为准）：

```json
{
  "target_mode_id": "plan"
}
```

Proma 映射规则：`target_mode_id` 含 `plan` → 进入计划态；否则退出计划态。

## Plan 模式下的工具行为

基于实测（2026-06-12）：

| 工具 | plan 模式 |
|------|-----------|
| Read / Glob / Grep / WebSearch | ✅ 允许 |
| Bash 只读命令 | ✅ 通常允许 |
| **CreatePlan** | ✅ **Cursor 原生计划输出方式**（`input.plan` 含完整 markdown） |
| Write / Edit | ❌ 通常拒绝 |

Proma 处理：从 `CreatePlan` 工具 input 提取 `plan` 字段，自动落盘到 `.context/plan/<name>.md`，再触发计划审批横幅。

## 规划完成信号

Cursor headless **无** `ExitPlanMode` 工具。Proma 采用启发式：

1. 权限模式为 `plan`
2. `result.subtype === 'success'`
3. 存在 `.context/plan/*.md` **或** assistant 末条文本摘要

满足条件 → 触发 `exitPlanService.requestPlanApproval`（`source: cursor_synthetic`）。

## 已知限制

- 单轮单进程：不支持流式追加、软中断、运行中改 CLI flags
- `setPermissionMode`：记录 pending，**下一轮** spawn 生效
- 无 MCP 注入
- 无 token 用量上报
