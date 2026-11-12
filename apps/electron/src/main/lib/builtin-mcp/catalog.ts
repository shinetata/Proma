/**
 * Proma 内置 MCP 能力目录。
 *
 * 元数据来自 default-mcp.json。旧搜索、生图的凭据与开关不再参与能力目录，
 * 外部 MCP 仍由工作区配置管理。`proma-cloud` 一项的可用状态来自本机配置：
 * 用户填了 Proma Cloud API Key 并开启联网检索时可用。
 */

import type { BuiltinMcpServerSummary } from '@proma/shared'
import { getBuiltinMcpDefinitions } from './baseline'
import { getPromaCloudConfigSummary } from '../proma-cloud-config'

export function listBuiltinMcpServers(): BuiltinMcpServerSummary[] {
  return getBuiltinMcpDefinitions().map((item) => {
    if (item.id === 'proma-cloud') {
      const config = getPromaCloudConfigSummary()
      const available = config.configured && config.webResearchEnabled
      return {
        id: item.id,
        name: item.name,
        displayName: item.displayName,
        description: item.description,
        category: item.category,
        tools: item.tools,
        toggleable: item.toggleable,
        enabled: config.webResearchEnabled,
        available,
        ...(available
          ? {}
          : { availabilityReason: config.configured ? '联网检索已关闭' : '未配置 API Key' }),
      }
    }
    return {
      id: item.id,
      name: item.name,
      displayName: item.displayName,
      description: item.description,
      category: item.category,
      tools: item.tools,
      toggleable: item.toggleable,
      enabled: item.defaultEnabled,
      available: item.defaultEnabled,
    }
  })
}
