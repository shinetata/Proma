/**
 * 受管浏览器标签生命周期策略
 *
 * 只做纯数据判定，便于单独测试：
 * - 保留标签（用户看过、用户创建、Agent 主动展示）永不被自动回收。
 * - Agent 的草稿标签在轮次结束时回收，避免一次搜索留下大量临时页面。
 * - 本地预览按文件路径复用，同一文件反复打开不会堆出重复标签。
 */

export interface BrowserTabLifecycleInfo {
  tabId: string
  /** 保留标签不参与任何自动回收。 */
  retained: boolean
  lastActivityAt: number
  /** 本地预览文件路径；非预览标签为 null。 */
  localPreviewPath: string | null
}

/** 轮末回收：关闭该会话全部草稿标签，Agent 当前工作标签始终保留。 */
export function selectDraftTabsToReclaim(tabs: BrowserTabLifecycleInfo[], agentTabId: string | null): string[] {
  return tabs.filter((tab) => !tab.retained && tab.tabId !== agentTabId).map((tab) => tab.tabId)
}

/**
 * 超出上限时回收最久未使用的草稿标签。
 * 保留标签、当前前台标签和 Agent 工作标签一律跳过；没有安全候选时宁可暂时超限。
 */
export function selectExcessTabsToReclaim(
  tabs: BrowserTabLifecycleInfo[],
  options: { activeTabId: string | null; agentTabId: string | null; maxTabs: number },
): string[] {
  const excess = tabs.length - options.maxTabs
  if (excess <= 0) return []
  return tabs
    .filter((tab) => !tab.retained && tab.tabId !== options.activeTabId && tab.tabId !== options.agentTabId)
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
    .slice(0, excess)
    .map((tab) => tab.tabId)
}

/** 复用已在预览同一文件的标签；Agent 工作标签优先，避免把用户的标签挪作预览。 */
export function findReusablePreviewTab(
  tabs: BrowserTabLifecycleInfo[],
  filePath: string,
  agentTabId: string | null,
): string | null {
  const matches = tabs.filter((tab) => tab.localPreviewPath === filePath)
  return (matches.find((tab) => tab.tabId === agentTabId) ?? matches[0])?.tabId ?? null
}
