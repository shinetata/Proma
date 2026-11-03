/**
 * 右侧工作区「文件 / 文件改动」页签内的内联预览。
 *
 * 对齐商业版 0.21.88（`Mx` atom 与 `WIt`）：从文件树或改动列表打开文件时，不再新开预览 Tab，
 * 而是在当前页签内展示预览，原列表收进右侧可折叠栏（窄宽度下为弹出抽屉）。
 */

import { atom } from 'jotai'
import type { PreviewFile } from '@/atoms/preview-atoms'

export type InlinePreviewSource = 'files' | 'changes'

export interface InlinePreviewState {
  source: InlinePreviewSource
  file: PreviewFile
}

/** sessionId → 当前内联预览；每个会话最多一个。 */
export const inlinePreviewMapAtom = atom<Map<string, InlinePreviewState>>(new Map())

/** 只有在非并排状态、且当前页签与预览来源一致时才展示内联预览。 */
export function shouldShowInlinePreview(
  activeTab: string,
  source: InlinePreviewSource | undefined,
  isSplit: boolean,
): boolean {
  return !isSplit && (activeTab === 'files' || activeTab === 'changes') && activeTab === source
}

const INLINE_PREVIEW_LIST_WIDTH = 300
const INLINE_PREVIEW_DRAWER_BREAKPOINT = INLINE_PREVIEW_LIST_WIDTH + 500
const INLINE_PREVIEW_DRAWER_MAX_WIDTH = 300
const INLINE_PREVIEW_DRAWER_GUTTER = 24

/** 预览区宽度不足 800px 时，文件列表改为弹出抽屉。 */
export function getInlinePreviewLayout(width: number): { drawer: boolean; listWidth: number } {
  const drawer = width < INLINE_PREVIEW_DRAWER_BREAKPOINT
  return {
    drawer,
    listWidth: drawer
      ? Math.max(0, Math.min(INLINE_PREVIEW_DRAWER_MAX_WIDTH, width - INLINE_PREVIEW_DRAWER_GUTTER))
      : INLINE_PREVIEW_LIST_WIDTH,
  }
}
