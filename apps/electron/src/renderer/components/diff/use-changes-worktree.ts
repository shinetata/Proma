/**
 * 改动 Tab 的 Worktree 选择
 *
 * 「改动」Tab 既可以直接看会话目录的未提交改动，也可以切到某个 worktree 看它相对基准分支的
 * 全量改动。选择状态写回会话记录（activeWorktree），并在本地 atom 里即时反映，避免等待列表刷新。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { WorktreeInfo } from '@proma/shared'
import { agentSelectedWorktreeAtom, agentSessionsAtom } from '@/atoms/agent-atoms'

/** worktree 模式下的 diff 基准分支 */
const WORKTREE_BASE_BRANCH = 'origin/main'

export interface ChangesWorktreeSelection {
  /** 当前选中的 worktree 路径；null 表示看会话目录本身 */
  selectedPath: string | null
  /** 传给数据层的 worktree 描述 */
  worktree: { path: string; baseBranch: string } | undefined
  onSelect: (worktree: WorktreeInfo | null) => void
}

export function useChangesWorktree(sessionId: string): ChangesWorktreeSelection {
  const selectedWorktreeMap = useAtomValue(agentSelectedWorktreeAtom)
  const setSelectedWorktreeMap = useSetAtom(agentSelectedWorktreeAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const setSessions = useSetAtom(agentSessionsAtom)

  const persistedPath = sessions.find((session) => session.id === sessionId)?.activeWorktree?.path ?? null
  const selectedPath = selectedWorktreeMap.get(sessionId) ?? persistedPath

  // 会话记录是持久化的真相；atom 只做即时显示，需要跟随它收敛。
  React.useEffect(() => {
    setSelectedWorktreeMap((prev) => {
      const previous = prev.get(sessionId) ?? null
      if (previous === persistedPath) return prev
      const next = new Map(prev)
      next.set(sessionId, persistedPath)
      return next
    })
  }, [persistedPath, sessionId, setSelectedWorktreeMap])

  const onSelect = React.useCallback(async (worktree: WorktreeInfo | null) => {
    try {
      const updated = await window.electronAPI.setAgentSessionActiveWorktree({
        sessionId,
        worktreePath: worktree?.path ?? null,
      })
      setSessions((previous) => previous.map((session) => session.id === sessionId ? updated : session))
      setSelectedWorktreeMap((prev) => {
        const next = new Map(prev)
        next.set(sessionId, updated.activeWorktree?.path ?? null)
        return next
      })
    } catch (error) {
      console.error('[changes] 保存活动 worktree 失败:', error)
      window.alert(`切换 worktree 失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }, [sessionId, setSelectedWorktreeMap, setSessions])

  const worktree = React.useMemo(
    () => selectedPath ? { path: selectedPath, baseBranch: WORKTREE_BASE_BRANCH } : undefined,
    [selectedPath],
  )

  return { selectedPath, worktree, onSelect }
}
