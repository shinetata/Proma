/**
 * AgentSkillsView — Skills/MCP 能力中心（对应商业版 Otn / Etn / Ttn）
 *
 * 全屏模式（activeView === 'agent-skills'，左侧只有 rail）：
 * - 左栏 220px：chrome 条「Skills/MCP」+ 列表表面上的 Skills / MCP 页面导航（带计数）
 * - 主区：h-10 chrome 页头（图标、标题、计数、项目选择器、添加服务器）
 *   + 内容表面上的搜索工具条与卡片网格
 * 嵌入模式（会话右侧面板）：锁定单一能力域，只渲染主区。
 * 记忆已是独立页面（activeView === 'memory'），这里不再提供记忆 Tab。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { toast } from 'sonner'
import { Blocks, ChevronDown, ChevronRight, Search, Plus, ServerCog, FolderOpen, Check, Sparkles, Loader2, PowerOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { agentPendingPromptAtom, agentSessionDraftHtmlAtom, agentSessionDraftsAtom, agentSessionDraftSyncVersionsAtom, currentAgentSessionIdAtom, skillDetailNavigationAtomFamily, workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { agentSkillsTabAtom } from '@/atoms/active-view'
import { useProjectActions } from '@/hooks/useProjectActions'
import { useCreateSession } from '@/hooks/useCreateSession'
import { McpServerForm } from '@/components/settings/McpServerForm'
import { LocalProjectBadge } from '@/components/agent/LocalProjectBadge'
import { AgentActionHint } from '@/components/agent/AgentActionHint'
import { queuedTextToParagraphHtml } from '@/lib/agent-message-queue'
import { detectIsMac } from '@/lib/platform'
import type { BuiltinMcpServerSummary, McpServerEntry, SkillMeta, SkillUsageSummary } from '@proma/shared'
import { useAgentSkillsData } from './useAgentSkillsData'
import { SkillCard } from './SkillCard'
import { McpCard } from './McpCard'
import { SkillDetailView } from './SkillDetailView'
import { McpDetailView } from './McpDetailView'
import { ImportSkillDialog } from './ImportSkillDialog'
import { BuiltinMcpDetailSheet } from './BuiltinMcpDetailSheet'
import { CapabilityPageHeader } from './CapabilityPageHeader'
import { groupSkills } from './skillGrouping'
import { getSkillGroupAccent } from './skillVisual'
import { SKILL_IDLE_DAYS, isIdleSkill } from './skillUsage'
import { EMBEDDED_CATALOG_TWO_COLUMN_MIN_WIDTH, IntegrationCatalog } from './IntegrationCatalog'
import { CredentialDialog } from './CredentialDialog'
import { OAuthClientSecretDialog } from './OAuthClientSecretDialog'
import { buildCatalogMcpGuidePrompt, MCP_INTEGRATION_CATALOG, getCatalogServerNames, isCatalogIntegrationVisible, matchesCatalogSearch, type CatalogCliIntegration, type CatalogCliProbeState, type CatalogCredentialIntegration, type CatalogGuidedIntegration, type CatalogMcpIntegration } from './integration-catalog'

type CapabilityPageTab = 'skills' | 'mcp'

/** 技能列表的状态筛选值；idle 即「30 天未用」视图。 */
type SkillStatusFilter = 'all' | 'enabled' | 'disabled' | 'update' | 'idle'

interface SkillStatusCounts {
  all: number
  enabled: number
  disabled: number
  update: number
  idle: number
}

/** 状态筛选 chip 的定义与顺序，对齐商业版。 */
const SKILL_STATUS_FILTERS: ReadonlyArray<{ value: SkillStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已启用' },
  { value: 'disabled', label: '已关闭' },
  { value: 'update', label: '可更新' },
  { value: 'idle', label: `${SKILL_IDLE_DAYS} 天未用` },
]

/** 各能力域的页头说明，文案对齐商业版。 */
const PAGE_DESCRIPTIONS: Record<CapabilityPageTab, string> = {
  skills: '按用途分组管理这个项目的 Skill：启用、更新、导入，或进入详情编辑 SKILL.md。',
  mcp: '连接外部服务：从目录安装、配置凭据，并通过真实握手验证可用。',
}

/** 主区内容的水平内边距，与页头 chrome 条对齐（商业版 jR）。 */
const PAGE_GUTTER_CLASS = 'px-5 sm:px-6 xl:px-8'

function getCapabilityPageInfo(tab: CapabilityPageTab, counts: { skills: number; mcps: number }): { title: string; contextLabel: string; searchLabel: string } {
  return tab === 'mcp'
    ? { title: 'MCP', contextLabel: `${counts.mcps} 个服务器`, searchLabel: '搜索 MCP 服务器' }
    : { title: 'Skills', contextLabel: `${counts.skills} 个 Skills`, searchLabel: '搜索 Skills' }
}

const embeddedMcpSectionContainerQuery = `
  @container (min-width: ${EMBEDDED_CATALOG_TWO_COLUMN_MIN_WIDTH}) {
    .mcp-section-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`

function buildSkillClassificationPrompt(input: {
  workspaceName: string
  skillsDir: string
  skills: SkillMeta[]
}): string {
  const skillList = input.skills
    .map((skill) => {
      const meta: string[] = []
      if (skill.group) meta.push(`group=${skill.group}`)
      return `- ${skill.slug} (${skill.name})${meta.length > 0 ? ` [${meta.join('; ')}]` : ''}`
    })
    .join('\n')

  return `请帮我整理当前项目在 Proma 工作区中保存的 Skills 的分组。

项目：${input.workspaceName || '当前项目'}
Skills 目录：${input.skillsDir}

当前已安装 Skills：
${skillList || '- 暂无'}

目标：
1. 逐个读取 Skills 目录下每个子目录的 SKILL.md，基于实际 description 和正文内容判断用途，不要只靠 slug、文件夹名或固定前缀猜分类。
2. 为每个 Skill 补全或修正 frontmatter 中的 group：
   - group 是一个简短、稳定的一级分组，直接用人类可读名称，例如 "Lark"、"文档"、"演示文稿"、"规划协作"。这些只是例子，不是固定枚举；请根据实际内容归纳。
   - 分组数量要克制，优先让用户能快速折叠/浏览，不要把每个细分场景都做成新组。
3. 只修改每个 SKILL.md 的 YAML frontmatter；保留 name、description、version、license、icon 等已有字段，不要改正文内容。
4. 对已有 group 做增量修订：明显准确的保留，不准确、缺失或过粗的再调整。
5. 同一平台或同一能力域的 Skills 应该归到同一个 group。
6. 如果某个 Skill 内容证据不足，放入 "未分组"，不要编造用途。
7. 只处理上述 Skills 目录内的 Skill，不要修改仓库 bundled default-skills、README、AGENTS.md 或其他 unrelated 文件。

写入格式示例：

---
name: example
description: ...
group: Lark
version: "1.0.0"
---

完成后请回复：
- 修改了多少个 Skill
- 使用了哪些 group，各自包含哪些 Skill
- 哪些 Skill 的分类不确定，以及原因
- 是否有需要用户确认或后续合并同类项的建议`
}

export function AgentSkillsView({
  embedded = false,
  componentTab,
  workspaceId,
  sessionId,
}: { embedded?: boolean; componentTab?: 'skills' | 'mcp'; workspaceId?: string; sessionId?: string } = {}): React.ReactElement {
  const data = useAgentSkillsData(workspaceId)
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const store = useStore()
  const setDrafts = useSetAtom(agentSessionDraftsAtom)
  const setDraftHtml = useSetAtom(agentSessionDraftHtmlAtom)
  const setDraftSyncVersions = useSetAtom(agentSessionDraftSyncVersionsAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const skillDetailNavigation = useAtomValue(skillDetailNavigationAtomFamily(sessionId ?? ''))
  const setSkillDetailNavigation = useSetAtom(skillDetailNavigationAtomFamily(sessionId ?? ''))
  const { workspaces, currentWorkspaceId: selectedWorkspaceId, selectProject } = useProjectActions()
  const { createAgent } = useCreateSession()
  const currentWorkspace = workspaces.find((workspace) => workspace.id === (workspaceId ?? selectedWorkspaceId))

  const fillCurrentAgentPrompt = React.useCallback((message: string): boolean => {
    const targetSessionId = sessionId ?? currentAgentSessionId
    if (!targetSessionId) {
      toast.error('请先打开一个 Agent 会话')
      return false
    }

    const currentDraft = store.get(agentSessionDraftsAtom).get(targetSessionId) ?? ''
    const currentDraftHtml = store.get(agentSessionDraftHtmlAtom).get(targetSessionId) ?? ''
    const hasDraft = currentDraft.trim().length > 0
    const nextDraft = hasDraft ? `${currentDraft.trimEnd()}\n\n${message}` : message

    setDrafts((previous) => {
      const next = new Map(previous)
      next.set(targetSessionId, nextDraft)
      return next
    })
    setDraftHtml((previous) => {
      const next = new Map(previous)
      if (hasDraft) {
        const draftHtml = currentDraftHtml.trim().length > 0
          ? currentDraftHtml
          : queuedTextToParagraphHtml(currentDraft)
        next.set(targetSessionId, `${draftHtml}${queuedTextToParagraphHtml(message)}`)
      } else {
        // Preserve normal RichTextInput rendering for a previously empty draft.
        next.delete(targetSessionId)
      }
      return next
    })
    setDraftSyncVersions((previous) => {
      const next = new Map(previous)
      next.set(targetSessionId, (next.get(targetSessionId) ?? 0) + 1)
      return next
    })
    return true
  }, [currentAgentSessionId, sessionId, setDraftHtml, setDraftSyncVersions, setDrafts, store])

  const [storedTab, setTab] = useAtom(agentSkillsTabAtom)
  // 右侧组件锁定能力域，避免其内部的总览 Tab 与右侧工作区标签产生两套导航。
  // 记忆已迁出为独立页面；残留的 'memory' 值按 Skills 展示。
  const tab: CapabilityPageTab = embedded && componentTab
    ? componentTab
    : storedTab === 'mcp' ? 'mcp' : 'skills'
  const isMac = React.useMemo(() => detectIsMac(), [])
  const [search, setSearch] = React.useState('')
  const [statusFilter, setStatusFilter] = React.useState<SkillStatusFilter>('all')
  const [disablingIdleSkills, setDisablingIdleSkills] = React.useState(false)
  const [selectedSkillSlug, setSelectedSkillSlug] = React.useState<string | null>(null)
  const [selectedSkillWorkspaceSlug, setSelectedSkillWorkspaceSlug] = React.useState<string | null>(null)
  const [showCreateMcp, setShowCreateMcp] = React.useState(false)
  const [selectedMcpName, setSelectedMcpName] = React.useState<string | null>(null)
  const [selectedBuiltinMcp, setSelectedBuiltinMcp] = React.useState<BuiltinMcpServerSummary | null>(null)
  const [showImport, setShowImport] = React.useState(false)
  const [wsPopoverOpen, setWsPopoverOpen] = React.useState(false)
  const [pendingDeleteSkill, setPendingDeleteSkill] = React.useState<SkillMeta | null>(null)
  const [pendingDeleteMcpName, setPendingDeleteMcpName] = React.useState<string | null>(null)
  const [isDeletingSkill, setIsDeletingSkill] = React.useState(false)
  const [isDeletingMcp, setIsDeletingMcp] = React.useState(false)
  const [classifyingSkills, setClassifyingSkills] = React.useState(false)
  const [installingCatalogMcpId, setInstallingCatalogMcpId] = React.useState<string | null>(null)
  const [pendingCredentialIntegration, setPendingCredentialIntegration] = React.useState<CatalogCredentialIntegration | null>(null)
  const [pendingOAuthClientSecret, setPendingOAuthClientSecret] = React.useState<{ name: string; entry: McpServerEntry } | null>(null)
  const savedOAuthClientSecretsRef = React.useRef(new Set<string>())

  const selectSkill = React.useCallback((slug: string): void => {
    setSelectedSkillSlug(slug)
    setSelectedSkillWorkspaceSlug(data.workspaceSlug)
  }, [data.workspaceSlug])
  const closeSkill = React.useCallback((): void => {
    setSelectedSkillSlug(null)
    setSelectedSkillWorkspaceSlug(null)
  }, [])

  const q = search.trim().toLowerCase()

  const filteredSkills = React.useMemo(() => {
    return data.skills.filter((s) => {
      if (!q) return true
      return s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        (s.group ?? '').toLowerCase().includes(q)
    })
  }, [data.skills, q])

  // 闲置列表只在统计就绪后计算，否则会把所有 Skill 当成从未使用过。
  const idleSkills = React.useMemo(() => {
    if (!data.skillUsageReady) return []
    return data.skills
      .filter((skill) => isIdleSkill({ usage: data.skillUsage[skill.slug], isBuiltin: data.defaultSkillSlugs.has(skill.slug) }))
      .sort((a, b) => (data.skillUsage[a.slug]?.lastUsedAt ?? 0) - (data.skillUsage[b.slug]?.lastUsedAt ?? 0))
  }, [data.defaultSkillSlugs, data.skillUsage, data.skillUsageReady, data.skills])

  const statusCounts = React.useMemo<SkillStatusCounts>(() => ({
    all: data.skills.length,
    enabled: data.skills.filter((skill) => skill.enabled).length,
    disabled: data.skills.filter((skill) => !skill.enabled).length,
    update: data.skills.filter((skill) => skill.hasUpdate).length,
    idle: idleSkills.length,
  }), [data.skills, idleSkills.length])

  /** 搜索与状态筛选叠加：先按关键词收窄，再按状态过滤（闲置列表本身已排除内置）。 */
  const visibleSkills = React.useMemo(() => {
    switch (statusFilter) {
      case 'enabled':
        return filteredSkills.filter((skill) => skill.enabled)
      case 'disabled':
        return filteredSkills.filter((skill) => !skill.enabled)
      case 'update':
        return filteredSkills.filter((skill) => skill.hasUpdate)
      case 'idle': {
        const visibleSlugs = new Set(filteredSkills.map((skill) => skill.slug))
        return idleSkills.filter((skill) => visibleSlugs.has(skill.slug))
      }
      default:
        return filteredSkills
    }
  }, [filteredSkills, idleSkills, statusFilter])

  const idleEnabledCount = React.useMemo(
    () => idleSkills.filter((skill) => skill.enabled).length,
    [idleSkills],
  )

  /** 一键关闭闲置 Skill：只关仍启用的，逐个写入后由数据层更新卡片开关。 */
  const disableIdleSkills = React.useCallback(async (): Promise<void> => {
    if (disablingIdleSkills) return
    const targets = idleSkills.filter((skill) => skill.enabled)
    if (targets.length === 0) return
    setDisablingIdleSkills(true)
    try {
      for (const skill of targets) {
        await data.toggleSkill(skill.slug, false)
      }
      toast.success(`已关闭 ${targets.length} 个闲置 Skill`, {
        description: '随时可以在「已关闭」里重新打开。',
      })
    } finally {
      setDisablingIdleSkills(false)
    }
  }, [data, disablingIdleSkills, idleSkills])

  const customSkills = visibleSkills.filter((s) => !data.defaultSkillSlugs.has(s.slug))
  const builtinSkills = visibleSkills.filter((s) => data.defaultSkillSlugs.has(s.slug))

  const catalogServerNames = React.useMemo(() => getCatalogServerNames(), [])

  const userMcpEntries = React.useMemo(() => {
    return Object.entries(data.mcpConfig.servers ?? {})
      .filter(([name]) => !catalogServerNames.has(name))
      .filter(([name]) => !q || name.toLowerCase().includes(q))
  }, [catalogServerNames, data.mcpConfig, q])

  const builtinMcpServers = React.useMemo(() => {
    if (!q) return data.builtinMcpServers
    return data.builtinMcpServers.filter((server) =>
      server.name.toLowerCase().includes(q) ||
      server.displayName.toLowerCase().includes(q) ||
      server.description.toLowerCase().includes(q) ||
      server.tools.some((tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q)),
    )
  }, [data.builtinMcpServers, q])

  const catalogMcps = React.useMemo(() => {
    return MCP_INTEGRATION_CATALOG.filter((integration): integration is CatalogMcpIntegration =>
      isCatalogIntegrationVisible(integration) && integration.kind === 'mcp' && matchesCatalogSearch(integration, q),
    )
  }, [q])

  const catalogClis = React.useMemo(() => {
    return MCP_INTEGRATION_CATALOG.filter((integration): integration is CatalogCliIntegration =>
      isCatalogIntegrationVisible(integration) && integration.kind === 'cli' && matchesCatalogSearch(integration, q),
    )
  }, [q])

  const catalogGuided = React.useMemo(() => {
    return MCP_INTEGRATION_CATALOG.filter((integration): integration is CatalogGuidedIntegration =>
      isCatalogIntegrationVisible(integration) && integration.kind === 'guided' && matchesCatalogSearch(integration, q),
    )
  }, [q])

  const catalogCredentials = React.useMemo(() => {
    return MCP_INTEGRATION_CATALOG.filter((integration): integration is CatalogCredentialIntegration =>
      isCatalogIntegrationVisible(integration) && integration.kind === 'credential' && matchesCatalogSearch(integration, q),
    )
  }, [q])

  // 不含搜索过滤的 MCP 总数（导航计数与页头上下文）：工作区服务器 + Proma 内置能力
  const mcpCount = React.useMemo(
    () => Object.keys(data.mcpConfig.servers ?? {}).length + data.builtinMcpServers.length,
    [data.mcpConfig, data.builtinMcpServers],
  )
  const pageInfo = getCapabilityPageInfo(tab, { skills: data.skills.length, mcps: mcpCount })
  const PageIcon = tab === 'mcp' ? ServerCog : Blocks

  const selectedSkill = selectedSkillWorkspaceSlug === data.workspaceSlug
    && data.loadedWorkspaceSlug === data.workspaceSlug
    ? data.skills.find((s) => s.slug === selectedSkillSlug) ?? null
    : null
  const selectedIsBuiltin = selectedSkill ? data.defaultSkillSlugs.has(selectedSkill.slug) : false
  const selectedMcp = selectedMcpName ? data.mcpConfig.servers[selectedMcpName] ?? null : null

  React.useEffect(() => {
    if (!skillDetailNavigation || data.loading) return
    if (skillDetailNavigation.workspaceSlug && skillDetailNavigation.workspaceSlug !== data.workspaceSlug) {
      toast.error('该 Skill 属于另一个项目，无法在当前 Skills 中打开')
      setSkillDetailNavigation(null)
      return
    }
    if (!data.skills.some((skill) => skill.slug === skillDetailNavigation.skillSlug)) {
      toast.error('当前项目未找到该 Skill')
      setSkillDetailNavigation(null)
      return
    }
    selectSkill(skillDetailNavigation.skillSlug)
    setSkillDetailNavigation(null)
  }, [data.loading, data.skills, data.workspaceSlug, selectSkill, setSkillDetailNavigation, skillDetailNavigation])

  const openSkillFolder = (slug: string): void => {
    if (!data.workspaceSlug) return
    void window.electronAPI.openWorkspaceSkillFolder(data.workspaceSlug, slug).catch((error) => {
      console.error('[Agent 技能] 打开 Skill 目录失败:', error)
      toast.error('打开 Skill 目录失败')
    })
  }

  const guideCatalogMcp = React.useCallback((integration: CatalogMcpIntegration): void => {
    if (fillCurrentAgentPrompt(buildCatalogMcpGuidePrompt(integration))) {
      toast.success(`已填入 ${integration.name} 配置提示词`)
    }
  }, [fillCurrentAgentPrompt])

  const installCatalogMcp = React.useCallback(async (integration: CatalogMcpIntegration): Promise<void> => {
    if (installingCatalogMcpId) return
    if (integration.authentication !== 'none' && !integration.oauthProvider) {
      await guideCatalogMcp(integration)
      return
    }
    if (integration.authentication === 'oauth' && integration.oauthProvider && integration.entry.url) {
      setInstallingCatalogMcpId(integration.id)
      try {
        const existing = data.mcpConfig.servers[integration.serverName]
        if (!existing) {
          const installed = await data.installMcp(integration.serverName, integration.entry)
          if (!installed) return
        }
        const configuredEntry = data.mcpConfig.servers[integration.serverName]
        const serverUrl = configuredEntry?.type === 'http' || configuredEntry?.type === 'sse'
          ? configuredEntry.url
          : integration.entry.url
        if (!serverUrl) throw new Error('当前 MCP 缺少可授权的远程地址')
        const oauth = configuredEntry?.oauth ?? integration.entry.oauth
        if (oauth && !oauth.clientId && !oauth.registrationEndpoint) {
          throw new Error('OAuth 配置缺少公开 clientId 或 registrationEndpoint；请让 Agent 根据官方文档补全后再授权')
        }
        await window.electronAPI.startMcpOAuth({
          workspaceSlug: data.workspaceSlug,
          serverName: integration.serverName,
          provider: oauth?.provider ?? integration.oauthProvider,
          serverUrl,
          ...(oauth ? { oauth } : {}),
        })
        const verification = await data.toggleMcp(integration.serverName, true)
        if (!verification.success) {
          throw new Error(verification.message || 'MCP 握手或工具发现失败，请检查授权后重试')
        }
        toast.success(`${integration.name} 已完成授权`, { description: 'OAuth token 已安全保存，MCP 已启用。' })
      } catch (error) {
        console.error(`[Agent 技能] ${integration.name} OAuth 失败:`, error)
        toast.error(`${integration.name} 授权失败`, { description: error instanceof Error ? error.message : '请稍后重试' })
      } finally {
        setInstallingCatalogMcpId(null)
      }
      return
    }

    const existing = data.mcpConfig.servers[integration.serverName]
    if (existing) {
      setSelectedMcpName(integration.serverName)
      return
    }
    setInstallingCatalogMcpId(integration.id)
    try {
      const installed = await data.installMcp(integration.serverName, integration.entry)
      if (!installed) return
      toast.success(`已添加 ${integration.name}`, {
        description: integration.authentication === 'none' ? '已启用，可在「我的 MCP」中测试连接。' : '已写入待配置模板。需要时可从卡片打开配置，不会自动跳转浏览器。',
      })
      return
    } finally {
      setInstallingCatalogMcpId(null)
    }
  }, [data, guideCatalogMcp, installingCatalogMcpId])

  const authorizeMcp = React.useCallback(async (name: string, entry: McpServerEntry): Promise<void> => {
    if (installingCatalogMcpId) return
    if ((entry.type !== 'http' && entry.type !== 'sse') || !entry.url || !entry.oauth) {
      toast.error('当前 MCP 没有可用的 OAuth 配置')
      return
    }
    if (!entry.oauth.clientId && !entry.oauth.registrationEndpoint) {
      toast.error('OAuth 参数待补全', { description: '请让 Agent 根据官方文档写入公开 clientId 或 registrationEndpoint；token 和 client secret 不会写入配置。' })
      return
    }
    if (entry.oauth.clientSecretRequired && !savedOAuthClientSecretsRef.current.has(name)) {
      setPendingOAuthClientSecret({ name, entry })
      return
    }
    setInstallingCatalogMcpId(`oauth:${name}`)
    try {
      await window.electronAPI.startMcpOAuth({
        workspaceSlug: data.workspaceSlug,
        serverName: name,
        provider: entry.oauth.provider ?? name,
        serverUrl: entry.url,
        oauth: entry.oauth,
      })
      const verification = await data.toggleMcp(name, true)
      if (!verification.success) throw new Error(verification.message || 'OAuth 已完成，但 MCP 握手或工具发现失败')
      toast.success(`${name} 已完成授权`, { description: 'OAuth token 已安全保存，并已通过真实连接验证。' })
    } catch (error) {
      console.error(`[Agent 技能] ${name} OAuth 失败:`, error)
      toast.error(`${name} 授权失败`, { description: error instanceof Error ? error.message : '请检查 OAuth 配置后重试' })
    } finally {
      setInstallingCatalogMcpId(null)
    }
  }, [data, installingCatalogMcpId])

  const connectCredentialIntegration = React.useCallback(async (integration: CatalogCredentialIntegration, value: string): Promise<void> => {
    if (installingCatalogMcpId) return
    setInstallingCatalogMcpId(integration.id)
    try {
      const existing = data.mcpConfig.servers[integration.serverName]
      if (!existing) {
        const installed = await data.installMcp(integration.serverName, integration.entry)
        if (!installed) throw new Error('无法创建连接配置')
      }
      const rawValue = value.trim()
      const valuePrefix = integration.credential.valuePrefix ?? ''
      // 用户可能从控制台直接复制了带前缀的完整头部值（如 "Bearer abc"）；
      // 保存前剥离已知前缀，避免拼出 "Bearer Bearer ..." 导致 401 且凭据已写入 Keychain。
      const bareValue = valuePrefix && rawValue.toLowerCase().startsWith(valuePrefix.trim().toLowerCase())
        ? rawValue.slice(valuePrefix.trim().length).trimStart()
        : rawValue
      await window.electronAPI.saveMcpApiKey({
        workspaceSlug: data.workspaceSlug,
        serverName: integration.serverName,
        serverUrl: integration.credential.credentialStorageUrl,
        headerName: integration.credential.headerName,
        ...(integration.credential.envName ? { envName: integration.credential.envName } : {}),
        ...(integration.entry.command
          ? { stdioBinding: { command: integration.entry.command, args: integration.entry.args ?? [] } }
          : {}),
        value: `${valuePrefix}${bareValue}`,
      })
      const verification = await data.toggleMcp(integration.serverName, true)
      if (!verification.success) {
        throw new Error(verification.message || 'MCP 握手或工具发现失败，请检查 Token 和空间权限后重试')
      }
      toast.success(`${integration.name} 已连接`, { description: 'MCP Token 已加密保存到系统 Keychain，并已通过真实握手和工具发现验证。' })
    } catch (error) {
      console.error(`[Agent 技能] ${integration.name} 凭据配置失败:`, error)
      toast.error(`${integration.name} 连接失败`, { description: error instanceof Error ? error.message : '请检查凭据后重试' })
      throw error
    } finally {
      setInstallingCatalogMcpId(null)
    }
  }, [data, installingCatalogMcpId])

  const guideCatalogCli = React.useCallback(async (integration: CatalogCliIntegration): Promise<void> => {
    try {
      // “配置”是重新授予 Proma 使用此 CLI 的入口，不会影响 CLI 自己的登录或授权。
      await data.setCliIntegrationEnabled(integration.id, true)
    } catch {
      toast.error(`无法启用 ${integration.name} 集成`)
      return
    }

    if (fillCurrentAgentPrompt(integration.agentPrompt)) {
      toast.success(`已填入 ${integration.name} 配置提示词`)
    }
  }, [data, fillCurrentAgentPrompt])

  const disconnectCatalogCli = React.useCallback(async (integration: CatalogCliIntegration): Promise<void> => {
    try {
      await data.setCliIntegrationEnabled(integration.id, false)
      toast.success(`已断开 ${integration.name}`, { description: '仅停止 Proma 使用该 CLI，不会登出或撤销第三方授权。' })
    } catch {
      toast.error(`无法断开 ${integration.name}`)
    }
  }, [data])

  const guideCatalogIntegration = React.useCallback((integration: CatalogGuidedIntegration): void => {
    if (fillCurrentAgentPrompt(integration.agentPrompt)) {
      toast.success(`已填入 ${integration.name} 配置提示词`)
    }
  }, [fillCurrentAgentPrompt])

  const handleClassifySkills = React.useCallback(async (): Promise<void> => {
    if (classifyingSkills) return
    if (!data.skillsDir) {
      toast.error('无法定位当前项目的 Proma 工作区 Skills 目录')
      return
    }
    setClassifyingSkills(true)
    try {
      const sessionId = await createAgent()
      if (!sessionId) {
        toast.error('创建 Agent 会话失败')
        return
      }
      setPendingPrompt({
        sessionId,
        message: buildSkillClassificationPrompt({
          workspaceName: data.workspaceName,
          skillsDir: data.skillsDir,
          skills: data.skills,
        }),
      })
      toast.success('已创建 Skills 分类整理会话')
    } catch (error) {
      console.error('[Agent 技能] 创建 Skills 分类会话失败:', error)
      toast.error(error instanceof Error ? error.message : '创建 Skills 分类会话失败')
    } finally {
      setClassifyingSkills(false)
    }
  }, [classifyingSkills, createAgent, data.skills, data.skillsDir, data.workspaceName, setPendingPrompt])

  const skillDeleteDialog = (
    <ConfirmDialog
      open={pendingDeleteSkill !== null}
      onOpenChange={(open) => { if (!open) setPendingDeleteSkill(null) }}
      title={`确认删除 Skill「${pendingDeleteSkill?.name}」？`}
      description="删除后将无法恢复，确定要卸载这个 Skill 吗？"
      confirmLabel="删除"
      loadingLabel="删除中..."
      loading={isDeletingSkill}
      onConfirm={async () => {
        if (!pendingDeleteSkill || isDeletingSkill) return
        setIsDeletingSkill(true)
        const ok = await data.deleteSkill(pendingDeleteSkill.slug, pendingDeleteSkill.name)
        setIsDeletingSkill(false)
        setPendingDeleteSkill(null)
        if (ok) closeSkill()
      }}
    />
  )

  if (!data.hasWorkspace) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-foreground/[0.04]">
          <Blocks className="size-8 text-foreground/30" />
        </div>
        <div className="text-[15px] font-medium text-foreground/80">未选择项目</div>
        <div className="max-w-sm text-[13px] text-foreground/50">
          请先在 Agent 模式下选择或创建一个项目，再来管理它的 Skills 与 MCP。
        </div>
      </div>
    )
  }

  if (selectedSkill) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <SkillDetailView
          key={`${data.workspaceSlug}:${selectedSkill.slug}`}
          skill={selectedSkill}
          workspaceSlug={data.workspaceSlug}
          contentVersion={data.skillsRevision}
          isBuiltin={selectedIsBuiltin}
          updating={data.updatingSkill === selectedSkill.slug}
          usage={data.skillUsage[selectedSkill.slug]}
          onBack={closeSkill}
          onToggle={(enabled) => data.toggleSkill(selectedSkill.slug, enabled)}
          onUpdate={() => data.updateSkill(selectedSkill.slug)}
          onRequestDelete={() => setPendingDeleteSkill(selectedSkill)}
          onOpenFolder={() => openSkillFolder(selectedSkill.slug)}
        />
        {skillDeleteDialog}
      </div>
    )
  }

  if (showCreateMcp) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-3xl p-5">
            <McpServerForm
              server={null}
              workspaceSlug={data.workspaceSlug}
              onSaved={() => {
                setShowCreateMcp(false)
                void data.refreshMcpConfig()
                bumpCapabilities((v) => v + 1)
              }}
              onChanged={data.refreshMcpConfig}
              onCancel={() => setShowCreateMcp(false)}
            />
          </div>
        </div>
      </div>
    )
  }

  if (selectedMcpName && selectedMcp) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <McpDetailView
          key={selectedMcpName}
          name={selectedMcpName}
          entry={selectedMcp}
          workspaceSlug={data.workspaceSlug}
          onBack={() => setSelectedMcpName(null)}
          onChanged={async () => {
            await data.refreshMcpConfig()
            bumpCapabilities((v) => v + 1)
          }}
        />
      </div>
    )
  }

  const addServerButton = (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setShowCreateMcp(true)}
      title="在 MCP 管理界面添加服务器"
      className="relative inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-sm transition-[transform,background-color] hover:bg-primary/90 active:scale-[0.96] disabled:cursor-wait disabled:opacity-60 after:absolute after:-inset-1 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <Plus size={14} /> 添加服务器
    </button>
  )

  return (
    <div
      className={cn('flex h-full min-h-0 overflow-hidden', embedded ? 'skills-embedded-container bg-content-area' : 'proma-chrome-surface')}
      // Container query keeps the catalog responsive to this resizable SidePanel.
      style={embedded ? { containerType: 'inline-size' } : undefined}
    >
      {/* 左栏：Skills / MCP 页面导航（仅全屏能力中心） */}
      {!embedded && (
        <aside className="flex w-[220px] shrink-0 flex-col proma-chrome-surface">
          <header className={cn('titlebar-drag-region flex h-10 shrink-0 items-center', isMac ? 'px-5 sm:px-6 xl:px-8' : 'px-3')}>
            <span className="pointer-events-none text-[13px] font-semibold tracking-tight text-[hsl(var(--sidebar-primary-foreground))]">Skills/MCP</span>
          </header>
          <nav className="proma-sidebar-list-surface min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-5 scrollbar-thin" aria-label="能力中心页面">
            {([
              { value: 'skills' as const, label: 'Skills', icon: Blocks, count: data.skills.length },
              { value: 'mcp' as const, label: 'MCP', icon: ServerCog, count: mcpCount },
            ]).map(({ value, label, icon: Icon, count }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition-[background-color,color,transform] hover:bg-foreground/[0.055] active:scale-[0.98]',
                  tab === value ? 'bg-foreground/[0.085] text-foreground' : 'text-foreground/65',
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="text-[11px] tabular-nums text-foreground/40">{count}</span>
              </button>
            ))}
          </nav>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {embedded ? (
          <div className="titlebar-no-drag mx-auto flex w-full max-w-6xl shrink-0 items-center justify-between px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.045] text-foreground/70">
                <PageIcon className="size-4" />
              </span>
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{pageInfo.title}</h1>
            </div>
          </div>
        ) : (
          <CapabilityPageHeader
            icon={<PageIcon size={16} />}
            title={pageInfo.title}
            subtitle={PAGE_DESCRIPTIONS[tab]}
            draggable
            context={<span className="rounded-md bg-foreground/[0.045] px-2 py-1 text-xs text-muted-foreground">{pageInfo.contextLabel}</span>}
            actions={(
              <>
                <Popover open={wsPopoverOpen} onOpenChange={setWsPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="切换能力中心项目"
                      className="titlebar-no-drag flex h-8 items-center gap-2 rounded-md border border-border/60 bg-content-area px-2.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04]"
                    >
                      <FolderOpen size={14} className="text-foreground/45" />
                      <span className="max-w-[180px] truncate text-left">{data.workspaceName}</span>
                      <LocalProjectBadge
                        projectRootPath={currentWorkspace?.projectRootPath}
                        projectRootStatus={currentWorkspace?.projectRootStatus}
                      />
                      <ChevronDown size={14} className="text-foreground/45" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="max-h-[320px] w-56 overflow-y-auto scrollbar-thin p-1">
                    {workspaces.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => {
                          if (w.id !== selectedWorkspaceId) {
                            selectProject(w.id, { resetView: false })
                            toast.success(`已切换到项目「${w.name}」`)
                          }
                          setWsPopoverOpen(false)
                        }}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
                          w.id === selectedWorkspaceId
                            ? 'bg-accent text-accent-foreground'
                            : 'text-foreground/80 hover:bg-accent/50',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate text-left">{w.name}</span>
                        <LocalProjectBadge
                          projectRootPath={w.projectRootPath}
                          projectRootStatus={w.projectRootStatus}
                        />
                        {w.id === selectedWorkspaceId && <Check size={14} className="shrink-0 text-primary" />}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                {tab === 'mcp' && addServerButton}
              </>
            )}
          />
        )}

        {embedded && (
          <div className="titlebar-no-drag mx-auto w-full max-w-6xl shrink-0 px-3 pb-3">
            <AgentActionHint action={tab === 'skills' ? '创建、整理、更新或删除 Skills' : '查找、配置或移除 MCP'} />
          </div>
        )}

        {/* 页头说明：能力中心全屏模式下展示当前能力域的用途说明 */}
        {!embedded && (
          <div className={cn('w-full shrink-0 bg-content-area pt-3', PAGE_GUTTER_CLASS)}>
            <p className="text-[13px] leading-relaxed text-foreground/55">{PAGE_DESCRIPTIONS[tab]}</p>
          </div>
        )}

        {/* 工具条：搜索 + Skills 操作 */}
        <div className={cn('titlebar-no-drag flex w-full shrink-0 items-center gap-3', embedded ? 'mx-auto max-w-6xl px-3 pb-3' : cn('bg-content-area pb-4 pt-2', PAGE_GUTTER_CLASS))}>
          <div className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 transition-colors focus-within:border-primary/40">
            <Search size={14} className="shrink-0 text-foreground/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={pageInfo.searchLabel}
              placeholder={`${pageInfo.searchLabel}...`}
              className="w-full bg-transparent text-[13px] text-foreground placeholder:text-foreground/35 focus:outline-none"
            />
          </div>

          {tab === 'skills' && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void handleClassifySkills()}
                    disabled={classifyingSkills || data.skills.length === 0}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-3 text-[13px] font-medium text-foreground/80 shadow-sm transition-colors hover:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {classifyingSkills ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    <span>AI 分类</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">创建 Agent 会话，读取 SKILL.md 内容并补全 group</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-content-area px-3 text-[13px] font-medium text-foreground/80 shadow-sm transition-colors hover:bg-foreground/[0.04]"
              >
                <Plus size={14} />
                <span>导入</span>
              </button>
            </>
          )}

          {embedded && tab === 'mcp' && addServerButton}
        </div>

        {/* 内容 */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto scrollbar-thin', !embedded && 'bg-content-area')}>
          <div className={cn('mx-auto w-full max-w-6xl', embedded ? 'px-3 pb-4' : cn('pb-10', PAGE_GUTTER_CLASS))}>
            {data.loading ? (
              <div className="py-20 text-center text-sm text-muted-foreground">加载中...</div>
            ) : tab === 'skills' ? (
              <SkillsTab
                customSkills={customSkills}
                builtinSkills={builtinSkills}
                embedded={embedded}
                total={data.skills.length}
                visibleCount={visibleSkills.length}
                statusFilter={statusFilter}
                statusCounts={statusCounts}
                onStatusFilterChange={setStatusFilter}
                searchQuery={search}
                updatingSkill={data.updatingSkill}
                skillUsage={data.skillUsage}
                isBuiltin={(slug) => data.defaultSkillSlugs.has(slug)}
                idleEnabledCount={idleEnabledCount}
                disablingIdleSkills={disablingIdleSkills}
                onDisableIdleSkills={() => { void disableIdleSkills() }}
                onOpen={selectSkill}
                onToggle={data.toggleSkill}
                onUpdate={data.updateSkill}
              />
            ) : (
              <McpTab
                userEntries={userMcpEntries}
                builtinServers={builtinMcpServers}
                catalogMcps={catalogMcps}
                catalogClis={catalogClis}
                catalogGuided={catalogGuided}
                catalogCredentials={catalogCredentials}
                embedded={embedded}
                installedMcpNames={new Set(Object.keys(data.mcpConfig.servers ?? {}))}
                enabledMcpNames={new Set(Object.entries(data.mcpConfig.servers ?? {}).filter(([, entry]) => entry.enabled === true).map(([name]) => name))}
                // 后台复检期间保留上一次成功的握手证据；只有刷新返回新的失败结果时才降级状态。
                verifiedMcpNames={new Set(Object.entries(data.mcpConfig.servers ?? {}).filter(([, entry]) => entry.lastTestResult?.success).map(([name]) => name))}
                // getWorkspaceSkills() 仅返回当前工作区 skills/ 下的 active Skill；不让
                // 其他工作区或 inactive Skill 误把目录卡标为可用。
                activeSkillSlugs={new Set(data.skills.filter((skill) => skill.enabled).map((skill) => skill.slug))}
                connectedCliIds={new Set(data.cliIntegrationStatuses.filter((status) => status.connected && status.enabled).map((status) => status.id))}
                cliIntegrationProbeState={data.cliIntegrationProbeState}
                installingCatalogMcpId={installingCatalogMcpId}
                onOpen={(name) => setSelectedMcpName(name)}
                onOpenBuiltin={setSelectedBuiltinMcp}
                onToggle={data.toggleMcp}
                onRequestDelete={setPendingDeleteMcpName}
                onAuthorize={authorizeMcp}
                onInstallCatalogMcp={(integration) => { void installCatalogMcp(integration) }}
                onGuideCatalogCli={guideCatalogCli}
                onDisconnectCatalogCli={(integration) => { void disconnectCatalogCli(integration) }}
                onGuideCatalogIntegration={(integration) => { void guideCatalogIntegration(integration) }}
                onRequestCredential={setPendingCredentialIntegration}
              />
            )}
          </div>
        </div>

        {skillDeleteDialog}

        {/* MCP 删除确认 */}
        <ConfirmDialog
          open={pendingDeleteMcpName !== null}
          onOpenChange={(open) => { if (!open) setPendingDeleteMcpName(null) }}
          title={`确认删除 MCP 服务器「${pendingDeleteMcpName}」？`}
          description="删除后将无法恢复，确定要删除这个 MCP 服务器吗？"
          confirmLabel="删除"
          loadingLabel="删除中..."
          loading={isDeletingMcp}
          onConfirm={async () => {
            if (!pendingDeleteMcpName || isDeletingMcp) return
            setIsDeletingMcp(true)
            await data.deleteMcp(pendingDeleteMcpName)
            setIsDeletingMcp(false)
            setPendingDeleteMcpName(null)
          }}
        />

        <CredentialDialog
          integration={pendingCredentialIntegration}
          onOpenChange={(open) => { if (!open) setPendingCredentialIntegration(null) }}
          onSave={connectCredentialIntegration}
        />

        <OAuthClientSecretDialog
          serverName={pendingOAuthClientSecret?.name ?? null}
          onOpenChange={(open) => { if (!open) setPendingOAuthClientSecret(null) }}
          onSave={async (clientSecret) => {
            const pending = pendingOAuthClientSecret
            if (!pending || !pending.entry.url) return
            await window.electronAPI.saveMcpOAuthClientSecret({
              workspaceSlug: data.workspaceSlug,
              serverName: pending.name,
              serverUrl: pending.entry.url,
              clientSecret,
            })
            savedOAuthClientSecretsRef.current.add(pending.name)
            // 先关闭秘密输入弹窗，再由同一张 MCP 卡片继续用户显式的浏览器授权。
            queueMicrotask(() => { void authorizeMcp(pending.name, pending.entry) })
          }}
        />

        <ImportSkillDialog
          open={showImport}
          onOpenChange={setShowImport}
          workspaceSlug={data.workspaceSlug}
          installedSkills={data.skills}
          onImported={() => bumpCapabilities((v) => v + 1)}
        />

        <BuiltinMcpDetailSheet
          open={selectedBuiltinMcp !== null}
          server={selectedBuiltinMcp}
          onOpenChange={(open) => { if (!open) setSelectedBuiltinMcp(null) }}
        />
      </div>
    </div>
  )
}

// ===== Skills Tab =====

interface SkillsTabProps {
  customSkills: SkillMeta[]
  builtinSkills: SkillMeta[]
  embedded: boolean
  total: number
  visibleCount: number
  statusFilter: SkillStatusFilter
  statusCounts: SkillStatusCounts
  onStatusFilterChange: (filter: SkillStatusFilter) => void
  searchQuery: string
  updatingSkill: string | null
  skillUsage: SkillUsageSummary
  isBuiltin: (slug: string) => boolean
  idleEnabledCount: number
  disablingIdleSkills: boolean
  onDisableIdleSkills: () => void
  onOpen: (slug: string) => void
  onToggle: (slug: string, enabled: boolean) => void
  onUpdate: (slug: string) => void
}

function SkillsTab({
  customSkills,
  builtinSkills,
  embedded,
  total,
  visibleCount,
  statusFilter,
  statusCounts,
  onStatusFilterChange,
  searchQuery,
  updatingSkill,
  skillUsage,
  isBuiltin,
  idleEnabledCount,
  disablingIdleSkills,
  onDisableIdleSkills,
  onOpen,
  onToggle,
  onUpdate,
}: SkillsTabProps): React.ReactElement {
  const hasVisibleSkills = customSkills.length > 0 || builtinSkills.length > 0
  // 筛选或搜索生效时，折叠的分组会藏住匹配项，因此强制展开。
  const filterActive = statusFilter !== 'all' || searchQuery.trim().length > 0

  return (
    <div className={cn('flex flex-col', embedded ? 'gap-4' : 'gap-6')}>
      {/* Proma Coach 由应用内置加载，不在工作区 skills/ 目录中，始终启用 */}
      <div
        className={cn(
          'flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20',
          embedded ? 'px-3 py-2' : 'px-4 py-3',
        )}
      >
        <Sparkles size={embedded ? 13 : 16} className="shrink-0 text-foreground/45" />
        <span className={cn('shrink-0 font-medium text-foreground/85', embedded ? 'text-[12px]' : 'text-[15px]')}>Proma Coach</span>
        <span className={cn('min-w-0 flex-1 truncate text-foreground/55', embedded ? 'text-[12px]' : 'text-[13px]')}>
          每轮任务自动使用：能力选择、结果验证与项目知识维护
        </span>
        <span
          className={cn(
            'shrink-0 rounded-md bg-primary/10 font-medium text-primary',
            embedded ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[12px]',
          )}
        >
          始终启用
        </span>
      </div>

      {total > 0 && (
        <div className={cn('flex flex-wrap items-center', embedded ? 'gap-1.5' : 'gap-2')}>
          {SKILL_STATUS_FILTERS.map(({ value, label }) => {
            const count = statusCounts[value]
            const active = statusFilter === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => onStatusFilterChange(value)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border transition-colors',
                  embedded ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3.5 text-[13px]',
                  active
                    ? 'border-transparent bg-foreground/[0.09] font-medium text-foreground'
                    : 'border-border/60 text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground/80',
                  count === 0 && value !== 'all' && 'opacity-45',
                )}
              >
                <span>{label}</span>
                <span className="tabular-nums text-foreground/40">{count}</span>
              </button>
            )
          })}
          {filterActive && (
            <span className={cn('ml-auto tabular-nums text-foreground/40', embedded ? 'text-[11px]' : 'text-[13px]')}>
              {visibleCount} / {total} 个匹配
            </span>
          )}
        </div>
      )}

      {statusFilter === 'idle' && statusCounts.idle > 0 && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-muted/25',
            embedded ? 'px-3 py-2' : 'px-4 py-3',
          )}
        >
          <span className={cn('min-w-0 flex-1 text-foreground/55', embedded ? 'text-[12px]' : 'text-[13px]')}>
            这 {statusCounts.idle} 个 Skill 超过 {SKILL_IDLE_DAYS} 天没有被加载过（不含 Proma 内置）。关掉后它们不再进入能力候选；确认不再需要时再进详情删除。
          </span>
          {idleEnabledCount > 0 && (
            <button
              type="button"
              onClick={onDisableIdleSkills}
              disabled={disablingIdleSkills}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-60',
                embedded ? 'h-8 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
              )}
            >
              {disablingIdleSkills ? <Loader2 size={14} className="animate-spin" /> : <PowerOff size={14} />}
              关闭这 {idleEnabledCount} 个
            </button>
          )}
        </div>
      )}

      {total === 0 ? (
        <EmptyState icon={<Blocks className="size-8 text-foreground/30" />} title="暂无专业 Skill" hint="可以在 Agent 模式下让 Proma 帮你联网查找并安装 Skill，或从其他项目导入。" />
      ) : hasVisibleSkills ? null : statusFilter === 'idle' && searchQuery.trim().length === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-8 text-foreground/30" />}
          title="没有闲置 Skill"
          hint={`最近 ${SKILL_IDLE_DAYS} 天用过的 Skill 不会出现在这里。`}
        />
      ) : (
        <EmptyState
          icon={<Search className="size-8 text-foreground/30" />}
          title="没有匹配的 Skill"
          hint="试试更换关键词，或把筛选切回「全部」。"
        />
      )}

      {customSkills.length > 0 && (
        <SkillSection
          title="我的 Skills"
          skills={customSkills}
          embedded={embedded}
          isBuiltin={isBuiltin}
          updatingSkill={updatingSkill}
          skillUsage={skillUsage}
          forceExpand={filterActive}
          onOpen={onOpen}
          onToggle={onToggle}
          onUpdate={onUpdate}
        />
      )}
      {builtinSkills.length > 0 && (
        <SkillSection
          title="PROMA 内置"
          skills={builtinSkills}
          embedded={embedded}
          isBuiltin={isBuiltin}
          updatingSkill={updatingSkill}
          skillUsage={skillUsage}
          forceExpand={filterActive}
          onOpen={onOpen}
          onToggle={onToggle}
          onUpdate={onUpdate}
        />
      )}
    </div>
  )
}

interface SkillSectionProps {
  title: string
  skills: SkillMeta[]
  embedded: boolean
  isBuiltin: (slug: string) => boolean
  updatingSkill: string | null
  skillUsage: SkillUsageSummary
  /** 筛选/搜索生效时强制展开所有分组 */
  forceExpand: boolean
  onOpen: (slug: string) => void
  onToggle: (slug: string, enabled: boolean) => void
  onUpdate: (slug: string) => void
}

function SkillSection({ title, skills, embedded, isBuiltin, updatingSkill, skillUsage, forceExpand, onOpen, onToggle, onUpdate }: SkillSectionProps): React.ReactElement {
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set())
  const groups = React.useMemo(() => groupSkills(skills), [skills])

  const toggleGroup = React.useCallback((groupId: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className={cn('flex items-center gap-2.5', embedded ? 'px-1' : 'px-0.5')}>
        <span className={cn('font-medium text-foreground/75', embedded ? 'text-[13px]' : 'text-[15px]')}>{title}</span>
        <span className={cn('tabular-nums text-foreground/35', embedded ? 'text-[12px]' : 'text-[15px]')}>{skills.length}</span>
      </div>
      <div className={cn('flex flex-col', embedded ? 'gap-3' : 'gap-5')}>
        {groups.map((group) => {
          const collapsed = !forceExpand && collapsedGroups.has(group.id)
          return (
            <div key={group.id} className={cn('flex flex-col', embedded ? 'gap-2' : 'gap-3')}>
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg text-left font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.04] hover:text-foreground',
                  embedded ? 'h-7 px-1 text-[13px]' : 'h-8 px-1 text-[15px]',
                )}
              >
                <ChevronRight
                  size={embedded ? 14 : 16}
                  className={cn('text-foreground/35 transition-transform', !collapsed && 'rotate-90')}
                />
                <span className={cn('shrink-0 rounded-full', embedded ? 'size-1.5' : 'size-2', getSkillGroupAccent(group.title).dot)} />
                <span>{group.title}</span>
                <span className={cn('tabular-nums text-foreground/35', embedded ? 'text-[12px]' : 'text-[15px]')}>{group.skills.length}</span>
              </button>
              {!collapsed && (
                <div className={cn('grid gap-3', embedded ? 'skills-embedded-card-grid' : 'gap-4 grid-cols-[repeat(auto-fill,minmax(21rem,1fr))]')}>
                  {group.skills.map((skill) => (
                    <SkillCard
                      key={skill.slug}
                      skill={skill}
                      isBuiltin={isBuiltin(skill.slug)}
                      updating={updatingSkill === skill.slug}
                      usage={skillUsage[skill.slug]}
                      embedded={embedded}
                      onOpen={() => onOpen(skill.slug)}
                      onToggle={(enabled) => onToggle(skill.slug, enabled)}
                      onUpdate={() => onUpdate(skill.slug)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== MCP Tab =====

interface McpTabProps {
  userEntries: Array<[string, McpServerEntry]>
  builtinServers: BuiltinMcpServerSummary[]
  catalogMcps: CatalogMcpIntegration[]
  catalogClis: CatalogCliIntegration[]
  catalogGuided: CatalogGuidedIntegration[]
  catalogCredentials: CatalogCredentialIntegration[]
  embedded: boolean
  installedMcpNames: Set<string>
  enabledMcpNames: Set<string>
  verifiedMcpNames: Set<string>
  activeSkillSlugs: Set<string>
  connectedCliIds: Set<string>
  cliIntegrationProbeState: CatalogCliProbeState
  installingCatalogMcpId: string | null
  onOpen: (name: string, entry: McpServerEntry) => void
  onOpenBuiltin: (server: BuiltinMcpServerSummary) => void
  onToggle: (name: string, enabled: boolean) => void
  onRequestDelete: (name: string) => void
  onAuthorize: (name: string, entry: McpServerEntry) => void
  onInstallCatalogMcp: (integration: CatalogMcpIntegration) => void
  onGuideCatalogCli: (integration: CatalogCliIntegration) => void
  onDisconnectCatalogCli: (integration: CatalogCliIntegration) => void
  onGuideCatalogIntegration: (integration: CatalogGuidedIntegration) => void
  onRequestCredential: (integration: CatalogCredentialIntegration) => void
}

function McpTab({ userEntries, builtinServers, catalogMcps, catalogClis, catalogGuided, catalogCredentials, embedded, installedMcpNames, enabledMcpNames, verifiedMcpNames, activeSkillSlugs, connectedCliIds, cliIntegrationProbeState, installingCatalogMcpId, onOpen, onOpenBuiltin, onToggle, onRequestDelete, onAuthorize, onInstallCatalogMcp, onGuideCatalogCli, onDisconnectCatalogCli, onGuideCatalogIntegration, onRequestCredential }: McpTabProps): React.ReactElement {
  if (userEntries.length === 0 && builtinServers.length === 0 && catalogMcps.length === 0 && catalogClis.length === 0 && catalogGuided.length === 0 && catalogCredentials.length === 0) {
    return <EmptyState icon={<Search className="size-8 text-foreground/30" />} title="没有匹配的 MCP 服务器" hint="试试更换搜索关键词。" />
  }

  return (
    <div className="flex flex-col gap-8">
      {userEntries.length > 0 && (
        <McpSection title="我的 MCP" count={userEntries.length} embedded={embedded}>
          {userEntries.map(([name, entry]) => (
            <McpCard
              key={name}
              name={name}
              entry={entry}
              onOpen={() => onOpen(name, entry)}
              onToggle={(enabled) => onToggle(name, enabled)}
              onRequestDelete={() => onRequestDelete(name)}
              onAuthorize={entry.oauth ? () => { void onAuthorize(name, entry) } : undefined}
              statusLabel={entry.enabled
                ? '已启用'
                : entry.lastTestResult?.success === false
                  ? '待配置'
                  : '待验证'}
              statusTone={entry.enabled ? 'success' : entry.lastTestResult?.success === false ? 'warning' : 'muted'}
            />
          ))}
        </McpSection>
      )}

      {builtinServers.length > 0 && (
        <McpSection title="Proma 集成能力" count={builtinServers.length} embedded={embedded}>
          {builtinServers.map((server) => {
            const status = getBuiltinMcpStatus(server)
            return (
              <McpCard
                key={server.id}
                name={server.displayName}
                entry={{ type: 'stdio', command: 'Proma 运行时注入', enabled: server.enabled, isBuiltin: true }}
                description={server.description}
                targetLabel={server.availabilityReason ?? 'Proma 运行时注入'}
                statusLabel={status.label}
                statusTone={status.tone}
                readOnly
                onOpen={() => onOpenBuiltin(server)}
              />
            )
          })}
        </McpSection>
      )}

      <IntegrationCatalog
        mcps={catalogMcps}
        clis={catalogClis}
        guided={catalogGuided}
        credentials={catalogCredentials}
        embedded={embedded}
        installedMcpNames={installedMcpNames}
        enabledMcpNames={enabledMcpNames}
        verifiedMcpNames={verifiedMcpNames}
        activeSkillSlugs={activeSkillSlugs}
        connectedCliIds={connectedCliIds}
        cliIntegrationProbeState={cliIntegrationProbeState}
        installingMcpId={installingCatalogMcpId}
        onInstallMcp={onInstallCatalogMcp}
        onGuideCli={onGuideCatalogCli}
        onDisconnectCli={onDisconnectCatalogCli}
        onGuide={onGuideCatalogIntegration}
        onRequestCredential={onRequestCredential}
        onToggleMcp={onToggle}
      />
    </div>
  )
}

function getBuiltinMcpStatus(server: BuiltinMcpServerSummary): { label: string; tone: 'success' | 'warning' | 'muted' } {
  if (!server.enabled) return { label: '已关闭', tone: 'muted' }
  return server.available ? { label: '可用', tone: 'success' } : { label: '需配置', tone: 'warning' }
}

function McpSection({ title, count, children, embedded }: { title: string; count: number; children: React.ReactNode; embedded: boolean }): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {embedded && <style>{embeddedMcpSectionContainerQuery}</style>}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[13px] font-medium text-foreground/55">{title}</span>
        <span className="text-[12px] tabular-nums text-foreground/35">{count}</span>
      </div>
      <div className={cn('grid grid-cols-1 gap-4', embedded ? 'mcp-section-grid' : 'md:grid-cols-2')}>
        {children}
      </div>
    </div>
  )
}

// ===== Empty State =====

function EmptyState({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint: string; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-24 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-foreground/[0.04]">{icon}</div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[15px] font-medium text-foreground/85">{title}</div>
        <div className="text-[13px] leading-relaxed text-foreground/50">{hint}</div>
      </div>
      {action}
    </div>
  )
}
