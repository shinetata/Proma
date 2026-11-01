/**
 * 把 Agent 工具造成的记忆/规则变更推送到界面。
 *
 * 外部编辑由 workspace-memory-change-watcher 的目录监听负责；这里只处理
 * 工具调用前后的快照 diff，避免两种来源重复或漏报。
 */

import { AGENT_IPC_CHANNELS } from '@proma/shared'
import { getMainWindow } from './main-window-store'
import type { KnowledgeFileChange } from './knowledge-change-tracker'

export function broadcastKnowledgeChanges(workspaceSlug: string, changes: KnowledgeFileChange[]): void {
  if (changes.length === 0) return
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  for (const change of changes) {
    win.webContents.send(AGENT_IPC_CHANNELS.WORKSPACE_MEMORY_FILE_CHANGED, { workspaceSlug, change })
  }
}
