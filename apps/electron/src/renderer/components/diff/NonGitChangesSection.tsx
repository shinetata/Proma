/**
 * 连续改动视图末尾的「其他文件变更」区
 *
 * 非 Git 目录里的文件没有 diff 基线，只能列出路径并以纯文件预览打开。
 * 记录是 append-only 的内存流水账：会话未运行期间被删除的文件 watcher 清理不到，
 * 因此展示前对「更早」分组批量校验存在性并剔除。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { FolderSearch } from 'lucide-react'
import type { SessionFileChange } from '@/lib/session-file-changes'
import { agentNonGitFileChangesAtom } from '@/atoms/agent-atoms'
import { arePathsEqual, groupSessionFileChanges } from '@/lib/session-file-changes'
import { detectIsWindows } from '@/lib/platform'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'

interface NonGitChangesSectionProps {
  changes: readonly SessionFileChange[]
  sessionId: string
  /** 当前 Agent run ID：本轮写入的文件排在前面 */
  currentRunId?: string
  /** 点击文件时打开纯文件预览 */
  onOpenFile?: (filePath: string) => void
}

export function NonGitChangesSection({
  changes,
  sessionId,
  currentRunId,
  onOpenFile,
}: NonGitChangesSectionProps): React.ReactElement {
  const setNonGitFileChanges = useSetAtom(agentNonGitFileChangesAtom)
  const { current, earlier } = React.useMemo(
    () => groupSessionFileChanges(changes, currentRunId),
    [changes, currentRunId],
  )
  /** 已校验过存在性的路径；组件存活期内同一路径不重复发起 IPC */
  const existenceCheckedRef = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    const pending = earlier.filter((change) => !existenceCheckedRef.current.has(change.path))
    if (pending.length === 0) return
    for (const change of pending) existenceCheckedRef.current.add(change.path)
    let cancelled = false
    void window.electronAPI
      .filterExistingFilePaths(pending.map((change) => change.path), { sessionId, unrestricted: true })
      .then((existingPaths) => {
        if (cancelled) return
        const isWindows = detectIsWindows()
        const missing = pending.filter(
          (change) => !existingPaths.some((existingPath) => arePathsEqual(existingPath, change.path, isWindows)),
        )
        if (missing.length === 0) return
        setNonGitFileChanges((prev) => {
          const currentChanges = prev.get(sessionId)
          if (!currentChanges) return prev
          const next = currentChanges.filter(
            (change) => !missing.some((item) => arePathsEqual(item.path, change.path, isWindows)),
          )
          if (next.length === currentChanges.length) return prev
          const map = new Map(prev)
          map.set(sessionId, next)
          return map
        })
      })
      .catch(() => {
        // 校验失败不清记录，允许下次渲染重试
        for (const change of pending) existenceCheckedRef.current.delete(change.path)
      })
    return () => {
      cancelled = true
    }
  }, [earlier, sessionId, setNonGitFileChanges])

  /** 本轮文件在前、更早文件在后，同组保持原始顺序 */
  const ordered = React.useMemo(() => [...current, ...earlier], [current, earlier])

  return (
    <section className="cdv-file" aria-label="其他文件变更">
      <div className="cdv-file-header">
        <span className="cdv-file-toggle" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
          其他文件变更
          <span className="ml-1.5 text-muted-foreground">（非 Git 目录，无基线可比较）</span>
        </span>
        <span className="cdv-counts">
          <span className="text-muted-foreground">{ordered.length}</span>
        </span>
      </div>
      {ordered.map((change) => {
        const fileName = change.path.split(/[\\/]/).filter(Boolean).pop() ?? change.path
        return (
          <div key={change.path} className="group/plain flex items-center">
            <button
              type="button"
              className="cdv-plain-file-row flex-1"
              title={`打开 ${change.path}`}
              onClick={() => onOpenFile?.(change.path)}
            >
              <FileTypeIcon name={fileName} isDirectory={false} size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{change.path}</span>
              <span className="cdv-note-inline">{change.kind === 'created' ? '新增' : '已编辑'}</span>
            </button>
            <button
              type="button"
              aria-label="在文件夹中显示"
              className="cdv-tool opacity-0 transition-opacity group-hover/plain:opacity-100"
              onClick={() => {
                void window.electronAPI.showInFolder(change.path, { sessionId, unrestricted: true }).catch((error) => {
                  console.error('[changes] 在文件夹中显示失败:', error)
                })
              }}
            >
              <FolderSearch className="size-3.5" />
            </button>
          </div>
        )
      })}
    </section>
  )
}
