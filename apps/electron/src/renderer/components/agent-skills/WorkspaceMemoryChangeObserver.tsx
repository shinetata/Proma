import * as React from 'react'
import { useSetAtom } from 'jotai'
import { workspaceMemoryChangesAtom } from '@/atoms/memory-change-atoms'
import { changeKey } from './WorkspaceMemoryChangeShelf'

/** Keeps the selected workspace observed even while its right file panel is closed. */
export function WorkspaceMemoryChangeObserver({ workspaceSlug }: { workspaceSlug: string }): null {
  const setUpdatesByWorkspace = useSetAtom(workspaceMemoryChangesAtom)

  React.useEffect(() => {
    return window.electronAPI.subscribeWorkspaceMemoryChanges(workspaceSlug, (change) => {
      setUpdatesByWorkspace((previous) => {
        const next = new Map(previous)
        const existing = next.get(workspaceSlug) ?? []
        next.set(workspaceSlug, [
          change,
          ...existing.filter((item) => changeKey(item) !== changeKey(change)),
        ].slice(0, 8))
        return next
      })
    })
  }, [setUpdatesByWorkspace, workspaceSlug])

  return null
}
