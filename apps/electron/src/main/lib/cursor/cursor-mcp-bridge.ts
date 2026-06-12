/**
 * Cursor MCP 配置桥接
 *
 * cursor-agent headless 不接受进程内 SDK MCP（automation/mem/nano-banana 等 createSdkMcpServer 对象，
 * 其在编排层 mcpServers 中类型为 'sdk'），但支持从工作区 `.cursor/mcp.json` 加载 stdio/http/sse 类型的
 * 外部 MCP（配合 `--approve-mcps` 自动放行审批）。
 *
 * 本模块把编排层构建的 mcpServers 中【可序列化的外部 MCP】物化为会话 cwd 下的 `.cursor/mcp.json`，
 * 使 Cursor 渠道也能使用用户在工作区配置的外部 MCP 工具。进程内 SDK MCP（type: 'sdk'）跳过，
 * 由后续阶段（独立 stdio MCP server 进程）解决。
 *
 * 注意：会话 cwd 是 Proma 专属的会话工作目录，`.cursor/mcp.json` 的 `mcpServers` 字段由 Proma 完全
 * 管理（覆盖写），以保证用户在工作区禁用某个 MCP 后不会残留。文件中其它字段（如非 mcpServers 配置）保留。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** cursor `.cursor/mcp.json` 的单个 server 条目（stdio 用 command，远端用 url） */
interface CursorMcpEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/**
 * 从编排层 mcpServers 提取可序列化的外部 MCP（跳过进程内 SDK MCP）。
 *
 * 编排层 buildMcpServers 给外部 MCP 打 `type: 'stdio' | 'http' | 'sse'` 标签，
 * 内置 createSdkMcpServer 对象为 `type: 'sdk'`，据此区分。
 */
export function extractExternalMcpServers(
  mcpServers: Record<string, Record<string, unknown>> | undefined,
): Record<string, CursorMcpEntry> {
  const out: Record<string, CursorMcpEntry> = {}
  if (!mcpServers) return out

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!entry || typeof entry !== 'object') continue
    const type = entry.type

    if (type === 'stdio' && typeof entry.command === 'string') {
      const e: CursorMcpEntry = { command: entry.command }
      if (Array.isArray(entry.args) && entry.args.length > 0) e.args = entry.args as string[]
      if (entry.env && typeof entry.env === 'object') e.env = entry.env as Record<string, string>
      out[name] = e
    } else if ((type === 'http' || type === 'sse') && typeof entry.url === 'string') {
      const e: CursorMcpEntry = { url: entry.url }
      if (entry.headers && typeof entry.headers === 'object') e.headers = entry.headers as Record<string, string>
      out[name] = e
    }
    // type === 'sdk'（automation/mem/nano-banana 等进程内工具）跳过
  }

  return out
}

/** 物化结果：是否写入了至少一个外部 MCP（决定是否需要 `--approve-mcps`） */
export interface MaterializeResult {
  wrote: boolean
  names: string[]
}

/**
 * 把外部 MCP 物化为 cwd 的 `.cursor/mcp.json`。
 *
 * - 有外部 MCP：写入 `{ mcpServers: <external> }`（保留文件中其它字段），返回 wrote=true。
 * - 无外部 MCP：若已存在且残留 Proma 旧注入，则清空 mcpServers 字段，返回 wrote=false。
 */
export function materializeCursorMcpConfig(
  cwd: string | undefined,
  mcpServers: Record<string, Record<string, unknown>> | undefined,
): MaterializeResult {
  if (!cwd) return { wrote: false, names: [] }

  const external = extractExternalMcpServers(mcpServers)
  const names = Object.keys(external)
  const cursorDir = join(cwd, '.cursor')
  const mcpPath = join(cursorDir, 'mcp.json')

  let existing: Record<string, unknown> = {}
  if (existsSync(mcpPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }

  if (names.length === 0) {
    // 无外部 MCP：清理可能残留的旧注入，避免已禁用的 MCP 仍被 cursor-agent 加载
    const prev = existing.mcpServers
    if (existsSync(mcpPath) && prev && typeof prev === 'object' && Object.keys(prev).length > 0) {
      try {
        writeFileSync(mcpPath, JSON.stringify({ ...existing, mcpServers: {} }, null, 2), 'utf8')
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
    return { wrote: false, names: [] }
  }

  const merged = { ...existing, mcpServers: external }
  try {
    mkdirSync(cursorDir, { recursive: true })
    writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf8')
    console.log(`[Cursor MCP 桥接] 已物化 ${names.length} 个外部 MCP 到 ${mcpPath}: ${names.join(', ')}`)
    return { wrote: true, names }
  } catch (err) {
    console.error('[Cursor MCP 桥接] 写入 .cursor/mcp.json 失败:', err)
    return { wrote: false, names: [] }
  }
}
