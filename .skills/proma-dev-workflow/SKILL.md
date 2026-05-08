---
name: proma-dev-workflow
description: "Proma Electron 桌面应用开发调试工作流。当用户需要启动 Proma 应用、排查构建问题、或进行日常开发时使用此 Skill。记录已知问题、分步启动方式和快速诊断方法。"
version: "1.0.0"
---
# Proma 桌面应用开发调试工作流

## 已知问题

### `bun run dev` 在 Windows 上偶发失败

**症状**：
```
[preload] bun run watch:preload exited with code 1
--> Sending SIGTERM to other processes..
error: script "dev:electron" exited with code 1
```

**根因**：`concurrently -k` + `esbuild --watch=forever` 组合在 Windows 下不稳定。`watch:preload` 先异常退出，触发 `-k`（kill others on exit）连锁关闭全部进程。

**重要**：此问题与代码改动无关——即使没有改过源码，Windows 上也偶发。esbuild watch 的 `forever` 模式在 Windows 文件系统上有已知稳定性问题。

## 分步启动（推荐日常开发方式）

避免使用 `bun run dev`（内部 `concurrently` 并发 watch），改为分步启动。

### 快速启动

```bash
# 终端 1：一次性构建 + Vite 开发服务器
cd apps/electron && bun run build:main && bun run build:preload && bun run build:preview-preload && bun run build:resources && bun run dev:vite

# 终端 2：Electron（electronmon 监听 dist 变化自动重启）
cd apps/electron && bunx electronmon .
```

### 改动代码后

根据改动层级选择性重建：

| 改动层 | 重建命令 | 热重载 |
|--------|---------|--------|
| 主进程（`src/main/**`） | `bun run build:main` | electronmon 自动重启 Electron |
| Preload（`src/preload/**`） | `bun run build:preload` | electronmon 自动重启 Electron |
| 渲染进程（`src/renderer/**`） | 无需手动操作 | Vite HMR 即时生效 |
| Shared 类型（`packages/shared/**`） | `bun run build:main && bun run build:preload` | electronmon 自动重启 Electron |
| 资源文件 | `bun run build:resources` | electronmon 自动重启 Electron |

### 最快重建（改了 main + preload）

```bash
bun run build:main && bun run build:preload
```

electronmon 检测到 `dist/` 变化后自动重启 Electron 进程，渲染进程 Vite HMR 保持在线。

## 快速诊断

### 验证构建是否通过（不改动文件时排查）

```bash
# 单独验证每步构建
cd apps/electron
bun run build:main        # 主进程 esbuild
bun run build:preload     # preload esbuild
bun run typecheck         # TypeScript 类型检查
bun run build:renderer    # Vite 生产构建（耗时较长）
```

### 确认完整构建链

```bash
cd apps/electron && bun run build
```

- `dist/main.cjs` ~22MB（含 Agent SDK external）
- `dist/preload.cjs` ~59KB
- `dist/renderer/` — Vite 产物

### 确认 Electron 启动正常

启动日志中应看到：

```
[运行时初始化] 初始化完成
[配置] 配置目录: ~/.proma-dev/
[IPC] 正在注册 IPC 处理器...
[IPC] IPC 处理器注册完成
[更新 IPC] 正在注册更新 IPC 处理器...
```

如果出现 `[IPC] IPC 处理器注册完成` 则说明所有 handler（包括 RemoteBridge）注册成功。

## 多端联调

需要同时运行 Gateway + Electron：

```bash
# 终端 1：Gateway
cd services/gateway && bun run dev

# 终端 2：构建 + Vite
cd apps/electron && bun run build:main && bun run build:preload && bun run build:preview-preload && bun run build:resources && bun run dev:vite

# 终端 3：Electron
cd apps/electron && bunx electronmon .
```

然后打开设置 → 远程协作 → 输入 `ws://localhost:3001` → 生成配对码 → 连接。
