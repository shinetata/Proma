/**
 * useOpenPreview — 统一的预览入口 Hook
 *
 * 把分散在 SidePanel / PreviewOpenButton / AgentView 等处的「打开预览」逻辑收敛到一处。
 * 文件、Markdown 与 Diff 一律在右侧工作区的预览 Tab 打开，不再占用主内容区。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import {
  getPreviewFileId,
  previewFileMapAtom,
  previewFilesMapAtom,
  previewPanelOpenMapAtom,
  type PreviewFile,
} from '@/atoms/preview-atoms'
import {
  activeTabIdAtom,
  closeTab,
  isPreviewTab,
  sessionViewStateMapAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, getPreviewSidePanelTab } from '@/atoms/agent-atoms'
import { inlinePreviewMapAtom, type InlinePreviewSource } from './inline-preview'
import { isAbsoluteFilePath } from './preview-open-path'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/**
 * `inline` 在「文件 / 文件改动」页签内就地预览（需同时给出 source）；
 * 其余取值兼容旧调用方，均打开独立的预览 Tab。
 */
export interface OpenPreviewOptions {
  mode?: 'tab' | 'split' | 'inline'
  source?: InlinePreviewSource
}

/**
 * 在指定会话的右侧工作区中打开并聚焦文件预览。
 *
 * 供 React Hook 和 IPC 事件处理器共同复用，保证计划审批等外部事件不会绕过预览 Tab 的状态约定。
 */
export function openPreviewInStore(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  const previewId = getPreviewFileId(file)
  store.set(previewFilesMapAtom, (prev) => {
    const next = new Map(prev)
    const files = next.get(sessionId) ?? []
    // 同一预览身份再次打开时保留 Tab 顺序，但采用最新权限、根目录与解析上下文。
    // 否则先以只读/Skill 上下文打开后会永久复用过期元数据。
    const existingIndex = files.findIndex((item) => getPreviewFileId(item) === previewId)
    next.set(sessionId, existingIndex === -1
      ? [...files, file]
      : files.map((item, index) => index === existingIndex ? file : item))
    return next
  })
  store.set(previewFileMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, file)
    return next
  })
  store.set(previewPanelOpenMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  // 所有入口都复用同一右侧工作区，并以会话为粒度隔离预览状态。
  store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  store.set(agentDiffPanelTabAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, getPreviewSidePanelTab(previewId))
    return next
  })
  enrichPreviewFileWithSessionRef(store, sessionId, file)
}

/**
 * 给绝对路径预览补上「相对会话检出根」的文件引用。
 *
 * worktree 被删除或重建到别处后，绝对路径会失效；带上相对引用后，主进程可以按当前
 * 检出根重新拼出路径。解析是异步的，只在预览仍活着且仍是同一文件时回写，
 * 并且由于 PreviewFile 的身份不含 sessionFileRef，回写不会影响预览 Tab 去重。
 */
function enrichPreviewFileWithSessionRef(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  if (file.sessionFileRef || !isAbsoluteFilePath(file.filePath)) return
  const previewId = getPreviewFileId(file)
  void window.electronAPI.resolveFilePath(file.filePath, {
    sessionId,
    unrestricted: file.unrestricted === true,
    ...(file.basePaths?.length ? { candidateBasePaths: file.basePaths } : {}),
  }).then((resolved) => {
    const relPath = resolved?.relPath
    if (!relPath) return
    const patch = (item: PreviewFile): PreviewFile => (
      getPreviewFileId(item) === previewId && item.filePath === file.filePath
        ? { ...item, sessionFileRef: { sessionId, path: relPath } }
        : item
    )
    store.set(previewFilesMapAtom, (prev) => {
      const files = prev.get(sessionId)
      if (!files?.some((item) => getPreviewFileId(item) === previewId && !item.sessionFileRef)) return prev
      const next = new Map(prev)
      next.set(sessionId, files.map(patch))
      return next
    })
    store.set(previewFileMapAtom, (prev) => {
      const current = prev.get(sessionId)
      if (!current || getPreviewFileId(current) !== previewId || current.sessionFileRef) return prev
      const next = new Map(prev)
      next.set(sessionId, patch(current))
      return next
    })
  }).catch(() => { /* 补不到相对引用时继续使用绝对路径与失效路径重定位 */ })
}

/** 在「文件 / 文件改动」页签内就地打开预览（商业版 WIt）。 */
export function openInlinePreviewInStore(store: JotaiStore, sessionId: string, source: InlinePreviewSource, file: PreviewFile): void {
  store.set(inlinePreviewMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, { source, file })
    return next
  })
  store.set(previewFileMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, file)
    return next
  })
  store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  store.set(agentDiffPanelTabAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, source)
    return next
  })
}

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile, options?: OpenPreviewOptions) => {
      if (options?.mode === 'inline' && options.source) {
        openInlinePreviewInStore(store, sessionId, options.source, file)
        return
      }
      openPreviewInStore(store, sessionId, file)
    },
    [store],
  )
}

/**
 * tearOffPreviewToSplit — 兼容旧 preview Tab：将其迁入右侧工作区预览。
 *
 * 保留此导出供旧的拖拽和预览 Tab 操作调用；新预览不会再创建主内容区 Tab。
 */
export function tearOffPreviewToSplit(store: JotaiStore, tabId: string): void {
  const tabs = store.get(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab || !isPreviewTab(tab)) return

  const sessionId = tab.sessionId

  const agentTab = tabs.find((t) => t.type === 'agent' && t.sessionId === sessionId)
  if (!agentTab) return

  // 关闭旧 preview Tab，并激活对应 Agent 会话，让右侧工作区可见
  const closed = closeTab(store.get(tabsAtom), store.get(activeTabIdAtom), tabId)
  store.set(tabsAtom, closed.tabs)
  store.set(activeTabIdAtom, agentTab.id)

  // 标记会话视图为 session，避免切走再切回时重建 preview Tab
  store.set(sessionViewStateMapAtom, (prev) => {
    const m = new Map(prev)
    m.set(sessionId, { previewTabOpen: false, lastView: 'session' })
    return m
  })

  store.set(previewPanelOpenMapAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, true)
    return next
  })
  store.set(agentSidePanelOpenAtomFamily(sessionId), true)
  store.set(agentDiffPanelTabAtom, (prev) => {
    const next = new Map(prev)
    next.set(sessionId, 'preview')
    return next
  })
}
