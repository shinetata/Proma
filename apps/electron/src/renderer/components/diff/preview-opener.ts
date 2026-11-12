/**
 * useOpenPreview — 统一的预览入口 Hook
 *
 * 把分散在 SidePanel / PreviewOpenButton / AgentView 等处的「打开预览」逻辑收敛到一处。
 * 文件、Markdown 与 Diff 一律在右侧工作区的预览标签打开，不再占用主内容区或文件页签内联区域。
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
import { agentDiffPanelTabAtom, agentSidePanelOpenAtomFamily, getPreviewSidePanelTab } from '@/atoms/agent-atoms'

/** Jotai store 类型（从 useStore 推导，避免直接 import 内部 Store 类型） */
type JotaiStore = ReturnType<typeof useStore>

/**
 * 在指定会话的右侧工作区中打开并聚焦文件预览。
 *
 * 供 React Hook 和 IPC 事件处理器共同复用，保证计划审批等外部事件不会绕过预览标签的状态约定。
 */
export function openPreviewInStore(store: JotaiStore, sessionId: string, file: PreviewFile): void {
  const previewId = getPreviewFileId(file)
  store.set(previewFilesMapAtom, (prev) => {
    const next = new Map(prev)
    const files = next.get(sessionId) ?? []
    // 同一预览身份再次打开时保留标签顺序，但采用最新权限、根目录与解析上下文。
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
}

export function useOpenPreview() {
  const store = useStore()

  return React.useCallback(
    (sessionId: string, file: PreviewFile) => {
      openPreviewInStore(store, sessionId, file)
    },
    [store],
  )
}
