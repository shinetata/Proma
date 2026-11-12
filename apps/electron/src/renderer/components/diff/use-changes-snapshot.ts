/**
 * 连续改动视图的数据读取
 *
 * 与「列表 + 单个文件 diff」的旧模型不同，这里一次性拿到整仓库的 unified patch：
 * 1. 先按会话或 worktree 读改动文件列表（含未跟踪文件）；
 * 2. 按 gitRoot 分组，逐个仓库读取 `git diff -M` 的完整 patch 并解析成文件行模型；
 * 3. 未跟踪文件不在 patch 里，单独读文件内容构造「全新增」；
 * 4. 展开 gap 时再按需读取完整文件内容，并校验上下文行仍然匹配。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ChangedFileStatus, UnstagedChangesResult } from '@proma/shared'
import {
  changesSnapshotMapAtom,
  EMPTY_CHANGES_SNAPSHOT,
  getChangesSnapshotCacheKey,
  type ChangesRepoSnapshot,
  type ChangesSnapshot,
} from '@/atoms/changes-snapshot-atoms'
import type { SessionFileChange } from '@/lib/session-file-changes'
import {
  areContextLinesMatching,
  buildNewFileChanges,
  looksLikeBinaryContent,
  splitContentLines,
  type ChangesFile,
} from './continuous-diff-rows'
import { parseChangesPatch } from './changes-patch-parse'

interface UseChangesSnapshotOptions {
  sessionId: string
  /** 会话目录或项目根目录（worktree 模式下仅用于路径授权） */
  dirPath: string
  sessionPath?: string
  workspaceFilesPath?: string
  extraPaths?: string[]
  /** worktree 模式：读取该 worktree 相对 baseBranch 的全量改动 */
  worktree?: { path: string; baseBranch: string }
  /** 会话中非 Git 目录的文件变更 */
  nonGitChanges?: SessionFileChange[]
  /** 递增即触发重新读取 */
  refreshVersion?: number
}

interface UseChangesSnapshotResult {
  snapshot: ChangesSnapshot
  /** 首次数据已就绪（含命中缓存） */
  ready: boolean
  /** 正在读取 */
  reading: boolean
  /** 读取改动列表失败 */
  failed: boolean
  refresh: () => void
  /** 读取文件的完整新内容，用于展开未改动行段；内容与 patch 上下文不一致时返回 null */
  readFileLines: (file: ChangesFile) => Promise<string[] | null>
}

/** 改动列表里的文件条目，附带所属仓库根 */
interface ListedFile {
  filePath: string
  status: ChangedFileStatus
  gitRoot: string
}

/** 缓存快照不含非 Git 改动（它们来自内存流水账），读取时统一补齐。 */
function withNonGit(previous: ChangesSnapshot, next: ChangesSnapshot, nonGit: ChangesSnapshot['nonGit']): ChangesSnapshot {
  const merged = next.nonGit === nonGit ? next : { ...next, nonGit }
  if (
    previous.isGit === merged.isGit
    && previous.repos === merged.repos
    && previous.nonGit === merged.nonGit
    && previous.gitRootByPath === merged.gitRootByPath
    && previous.totals === merged.totals
  ) return previous
  return merged
}

function toListedFiles(result: UnstagedChangesResult, fallbackRoot: string): ListedFile[] {
  const files: ListedFile[] = result.files.map((file) => ({
    filePath: file.filePath,
    status: file.status,
    gitRoot: file.gitRoot || fallbackRoot,
  }))
  for (const file of result.untrackedFiles) {
    files.push({ filePath: file.filePath, status: 'untracked', gitRoot: file.gitRoot || fallbackRoot })
  }
  return files
}

/** 按路径排序，保证同一仓库内的文件顺序稳定。 */
function compareByPath(left: ChangesFile, right: ChangesFile): number {
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
}

/** patch 里没有、又不在改动列表里的兜底条目：只保留文件头，不展示虚假行。 */
function createFallbackFile(listed: ListedFile): ChangesFile {
  const placeholder = buildNewFileChanges(listed.filePath, '')
  return {
    ...placeholder,
    status: listed.status === 'deleted' ? 'deleted' : 'change',
    empty: true,
  }
}

export function useChangesSnapshot({
  sessionId,
  dirPath,
  sessionPath,
  workspaceFilesPath,
  extraPaths,
  worktree,
  nonGitChanges,
  refreshVersion = 0,
}: UseChangesSnapshotOptions): UseChangesSnapshotResult {
  const snapshotMap = useAtomValue(changesSnapshotMapAtom)
  const setSnapshotMap = useSetAtom(changesSnapshotMapAtom)

  const cacheKey = getChangesSnapshotCacheKey(sessionId, worktree?.path)
  const cached = snapshotMap.get(cacheKey)

  const [snapshot, setSnapshot] = React.useState<ChangesSnapshot>(() => cached ?? EMPTY_CHANGES_SNAPSHOT)
  /** 首次读取是否已返回：区分 loading 与真正的空状态，避免「没有文件改动」闪现 */
  const [hasFetched, setHasFetched] = React.useState(() => cached !== undefined)
  const [reading, setReading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  /** 单调递增的请求序号，丢弃乱序到达的旧响应 */
  const requestSeqRef = React.useRef(0)
  const [manualRefreshVersion, setManualRefreshVersion] = React.useState(0)

  const baseRef = worktree?.baseBranch
  // extraPaths 是数组，调用方已 memo；这里用内容签名避免引用变化触发重复读取。
  const extraPathsSignature = (extraPaths ?? []).join('\n')

  // 非 Git 改动来自内存流水账，只跟随列表更新，不触发 patch 重新读取。
  const nonGitSnapshot = nonGitChanges ?? EMPTY_CHANGES_SNAPSHOT.nonGit
  // effect 内读取最新值，避免把 nonGitSnapshot 放进依赖后与缓存恢复互相触发。
  const nonGitSnapshotRef = React.useRef(nonGitSnapshot)
  nonGitSnapshotRef.current = nonGitSnapshot

  // 切换会话或 worktree 时先吃缓存，避免空快照误命中「没有文件改动」分支。
  // 只在这里用缓存覆盖状态；不再和下面的非 Git 合并共用 effect，否则每次非 Git 变动都会把
  // hasFetched 重置成加载态。
  React.useEffect(() => {
    const nextCached = snapshotMap.get(cacheKey)
    setSnapshot((prev) => withNonGit(prev, nextCached ?? EMPTY_CHANGES_SNAPSHOT, nonGitSnapshotRef.current))
    setHasFetched(nextCached !== undefined)
  }, [cacheKey, snapshotMap])

  // 非 Git 改动来自内存流水账，只做合并，不触发 patch 重新读取。
  React.useEffect(() => {
    setSnapshot((prev) => {
      if (prev.nonGit === nonGitSnapshot) return prev
      return { ...prev, nonGit: nonGitSnapshot }
    })
  }, [nonGitSnapshot])

  React.useEffect(() => {
    if (!dirPath && !worktree) return
    const requestId = ++requestSeqRef.current
    setReading(true)

    /** 缓存时剔除非 Git 改动，避免把它们固化进快照缓存。 */
    const cacheSnapshot = (next: ChangesSnapshot): void => {
      const cacheable = next.nonGit.length === 0 ? next : { ...next, nonGit: EMPTY_CHANGES_SNAPSHOT.nonGit }
      setSnapshotMap((prev) => {
        const map = new Map(prev)
        map.set(cacheKey, cacheable)
        return map
      })
    }

    const load = async (): Promise<void> => {
      let changes: UnstagedChangesResult
      try {
        changes = worktree
          ? await window.electronAPI.getWorktreeChanges(worktree.path, worktree.baseBranch, sessionId)
          : await window.electronAPI.getUnstagedChanges(dirPath, sessionPath, workspaceFilesPath, extraPaths, sessionId)
      } catch (error) {
        if (requestId !== requestSeqRef.current) return
        console.error('[changes] 读取改动列表失败:', error)
        setFailed(true)
        setReading(false)
        setHasFetched(true)
        return
      }
      if (requestId !== requestSeqRef.current) return

      if (!changes.isGitRepo) {
        const nonGitOnly: ChangesSnapshot = {
          ...EMPTY_CHANGES_SNAPSHOT,
          nonGit: nonGitSnapshotRef.current,
        }
        setSnapshot(nonGitOnly)
        cacheSnapshot(nonGitOnly)
        setFailed(false)
        setReading(false)
        setHasFetched(true)
        return
      }

      const listed = toListedFiles(changes, dirPath)
      const filesByRoot = new Map<string, ListedFile[]>()
      for (const file of listed) {
        const bucket = filesByRoot.get(file.gitRoot)
        if (bucket) bucket.push(file)
        else filesByRoot.set(file.gitRoot, [file])
      }

      const repos: ChangesRepoSnapshot[] = []
      const gitRootByPath = new Map<string, string>()
      for (const [gitRoot, rootFiles] of filesByRoot) {
        let patch = ''
        let truncated = false
        let repoFailed = false
        try {
          const result = await window.electronAPI.getChangesPatch({ dirPath, gitRoot, sessionId, baseRef })
          patch = result.patch
          truncated = result.truncated
        } catch (error) {
          console.error('[changes] 读取 patch 失败:', gitRoot, error)
          repoFailed = true
        }
        if (requestId !== requestSeqRef.current) return

        const patchedByPath = new Map(parseChangesPatch(patch).map((file) => [file.path, file]))
        const files: ChangesFile[] = []
        for (const listedFile of rootFiles) {
          const patched = patchedByPath.get(listedFile.filePath)
          if (patched) {
            files.push(patched)
            continue
          }
          if (listedFile.status === 'untracked') {
            const content = await window.electronAPI
              .getUntrackedContent({ dirPath, filePath: listedFile.filePath, gitRoot, sessionId })
              .catch(() => '')
            if (requestId !== requestSeqRef.current) return
            files.push(content !== '' && !looksLikeBinaryContent(content)
              ? buildNewFileChanges(listedFile.filePath, content)
              : { ...buildNewFileChanges(listedFile.filePath, ''), empty: true })
            continue
          }
          files.push(createFallbackFile(listedFile))
        }
        files.sort(compareByPath)
        for (const file of files) gitRootByPath.set(file.path, gitRoot)

        repos.push({
          gitRoot,
          name: gitRoot.split('/').pop() || gitRoot,
          files,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          truncated,
          failed: repoFailed,
        })
      }
      if (requestId !== requestSeqRef.current) return
      repos.sort((left, right) => left.name.localeCompare(right.name))

      const nextSnapshot: ChangesSnapshot = {
        isGit: true,
        repos,
        nonGit: EMPTY_CHANGES_SNAPSHOT.nonGit,
        gitRootByPath,
        totals: {
          files: repos.reduce((sum, repo) => sum + repo.files.length, 0),
          additions: repos.reduce((sum, repo) => sum + repo.additions, 0),
          deletions: repos.reduce((sum, repo) => sum + repo.deletions, 0),
        },
      }
      setSnapshot(nextSnapshot)
      cacheSnapshot(nextSnapshot)
      setFailed(false)
      setReading(false)
      setHasFetched(true)
    }

    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- extraPaths 用内容签名比较
  }, [
    dirPath,
    sessionId,
    sessionPath,
    workspaceFilesPath,
    extraPathsSignature,
    worktree?.path,
    baseRef,
    refreshVersion,
    manualRefreshVersion,
    cacheKey,
    setSnapshotMap,
  ])

  const refresh = React.useCallback(() => {
    setManualRefreshVersion((version) => version + 1)
  }, [])

  // 展开 gap 是异步回调，用 ref 读取最新的仓库映射，避免闭包捕获旧快照。
  const gitRootByPathRef = React.useRef(snapshot.gitRootByPath)
  gitRootByPathRef.current = snapshot.gitRootByPath

  const readFileLines = React.useCallback(async (file: ChangesFile): Promise<string[] | null> => {
    try {
      const contents = await window.electronAPI.getDiffContents({
        dirPath,
        filePath: file.path,
        gitRoot: gitRootByPathRef.current.get(file.path),
        sessionId,
        baseRef,
      })
      if (contents === null) return null
      const lines = splitContentLines(contents.newContent)
      // patch 可能来自旧快照，上下文行对不上就不展开，避免展示错位内容。
      return areContextLinesMatching(file.metadata, lines) ? lines : null
    } catch (error) {
      console.error('[changes] 读取文件内容失败:', file.path, error)
      return null
    }
  }, [baseRef, dirPath, sessionId])

  return {
    snapshot,
    ready: hasFetched,
    reading,
    failed,
    refresh,
    readFileLines,
  }
}
