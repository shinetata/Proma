import { describe, expect, test } from 'bun:test'
import { findReusablePreviewTab, selectDraftTabsToReclaim, selectExcessTabsToReclaim } from './browser-tab-lifecycle'
import type { BrowserTabLifecycleInfo } from './browser-tab-lifecycle'

function tab(id: string, overrides: Partial<BrowserTabLifecycleInfo> = {}): BrowserTabLifecycleInfo {
  return { tabId: id, retained: false, lastActivityAt: 1, localPreviewPath: null, ...overrides }
}

describe('浏览器标签轮末回收', () => {
  test('草稿标签全部回收，Agent 工作标签与保留标签保留', () => {
    const tabs = [tab('draft-1'), tab('work'), tab('kept', { retained: true }), tab('draft-2')]

    expect(selectDraftTabsToReclaim(tabs, 'work')).toEqual(['draft-1', 'draft-2'])
  })

  test('没有 Agent 工作标签时只按保留标记判断', () => {
    const tabs = [tab('a'), tab('b', { retained: true })]

    expect(selectDraftTabsToReclaim(tabs, null)).toEqual(['a'])
  })
})

describe('浏览器标签超限回收', () => {
  test('未超限时不回收', () => {
    expect(selectExcessTabsToReclaim([tab('a'), tab('b')], { activeTabId: 'a', agentTabId: 'b', maxTabs: 3 })).toEqual([])
  })

  test('优先回收最久未使用的草稿，且跳过前台与工作标签', () => {
    const tabs = [
      tab('oldest', { lastActivityAt: 10 }),
      tab('active', { lastActivityAt: 5 }),
      tab('work', { lastActivityAt: 1 }),
      tab('kept', { retained: true, lastActivityAt: 2 }),
      tab('newer', { lastActivityAt: 50 }),
    ]

    // 5 个标签上限为 3，需要回收 2 个；只有 oldest 与 newer 是安全候选。
    expect(selectExcessTabsToReclaim(tabs, { activeTabId: 'active', agentTabId: 'work', maxTabs: 3 })).toEqual(['oldest', 'newer'])
  })

  test('没有安全候选时宁可超限也不关闭用户内容', () => {
    const tabs = [tab('active'), tab('work'), tab('kept', { retained: true }), tab('kept-2', { retained: true })]

    expect(selectExcessTabsToReclaim(tabs, { activeTabId: 'active', agentTabId: 'work', maxTabs: 2 })).toEqual([])
  })
})

describe('本地预览标签复用', () => {
  test('同一文件复用已有预览标签，不会重复创建', () => {
    const tabs = [tab('other', { localPreviewPath: '/work/a.html' }), tab('target', { localPreviewPath: '/work/report.html' })]

    expect(findReusablePreviewTab(tabs, '/work/report.html', null)).toBe('target')
  })

  test('同时匹配多个时优先 Agent 工作标签', () => {
    const tabs = [
      tab('first', { localPreviewPath: '/work/report.html', lastActivityAt: 90 }),
      tab('work', { localPreviewPath: '/work/report.html', lastActivityAt: 1 }),
    ]

    expect(findReusablePreviewTab(tabs, '/work/report.html', 'work')).toBe('work')
  })

  test('没有同一文件的标签时返回 null', () => {
    expect(findReusablePreviewTab([tab('a', { localPreviewPath: '/work/a.html' })], '/work/b.html', null)).toBeNull()
  })
})
