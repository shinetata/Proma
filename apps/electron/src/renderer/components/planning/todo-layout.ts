export type TodoWorkspaceLayoutMode = 'three-column' | 'two-column' | 'single-column'

/** 三栏同时保持可读性所需的容器宽度（商业版 QJt）。 */
export const TODO_THREE_COLUMN_MIN_WIDTH = 1120
/** 低于此宽度时，详情改为覆盖式全宽视图（商业版 GJt）。 */
export const TODO_TWO_COLUMN_MIN_WIDTH = 920

export function getTodoWorkspaceLayoutMode(width: number): TodoWorkspaceLayoutMode {
  if (width >= TODO_THREE_COLUMN_MIN_WIDTH) return 'three-column'
  if (width >= TODO_TWO_COLUMN_MIN_WIDTH) return 'two-column'
  return 'single-column'
}

/** Todo 工作区网格列定义（商业版 XJt）。 */
export function getTodoWorkspaceGridTemplate(mode: TodoWorkspaceLayoutMode, hasSelection: boolean): string {
  if (mode === 'three-column') {
    return hasSelection
      ? 'minmax(10rem, 12rem) minmax(22rem, 1fr) clamp(28rem, 38%, 42rem)'
      : 'minmax(10rem, 12rem) minmax(0, 1fr)'
  }
  if (mode === 'two-column' && hasSelection) return 'minmax(22rem, 1fr) clamp(28rem, 48%, 42rem)'
  return 'minmax(0, 1fr)'
}
