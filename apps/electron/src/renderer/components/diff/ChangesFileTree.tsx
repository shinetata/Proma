/**
 * 连续改动视图的左侧文件树
 *
 * 按 Git 仓库分组展示改动文件；目录只保留有改动的路径，并压缩没有分支的连续目录。
 * 点击文件滚动到对应的 diff 区块，仓库行提供终端与「在文件夹中显示」入口。
 */

import * as React from 'react'
import { ChevronRight, FolderSearch, Terminal } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'
import { buildDiffFileTree, type DiffFileTreeNode } from './diff-file-tree'
import type { ChangesFile } from './continuous-diff-rows'

export interface ChangesFileTreeRepo {
  gitRoot: string
  name: string
  files: ChangesFile[]
  additions: number
  deletions: number
}

interface ChangesFileTreeProps {
  repos: readonly ChangesFileTreeRepo[]
  /** 当前定位到的文件路径 */
  selectedPath: string | null
  /** 已折叠目录的 key（`gitRoot:path`） */
  collapsedDirs: ReadonlySet<string>
  onToggleDirectory: (key: string) => void
  onSelect: (filePath: string) => void
  /** 搜索词：有搜索词时目录强制展开，保证命中文件可见 */
  searchQuery: string
  onOpenDirectoryTerminal?: (directoryPath: string, directoryName: string) => void
  onShowDirectoryInFolder?: (directoryPath: string) => void
}

/** 文件树行末的改动状态字母 */
const STATUS_MARK: Record<ChangesFile['status'], string> = {
  new: 'A',
  deleted: 'D',
  'rename-pure': 'R',
  'rename-changed': 'R',
  change: 'M',
}

interface TreeEntry {
  filePath: string
  additions: number
  deletions: number
  status: ChangesFile['status']
}

interface RepoTree {
  repo: ChangesFileTreeRepo
  entries: TreeEntry[]
  tree: Array<DiffFileTreeNode<TreeEntry>>
}

export function ChangesFileTree({
  repos,
  selectedPath,
  collapsedDirs,
  onToggleDirectory,
  onSelect,
  searchQuery,
  onOpenDirectoryTerminal,
  onShowDirectoryInFolder,
}: ChangesFileTreeProps): React.ReactElement {
  const query = searchQuery.trim().toLowerCase()
  const trees = React.useMemo<RepoTree[]>(() => repos.map((repo) => {
    const files = query ? repo.files.filter((file) => file.path.toLowerCase().includes(query)) : repo.files
    const entries: TreeEntry[] = files.map((file) => ({
      filePath: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
    }))
    return { repo, entries, tree: buildDiffFileTree(entries) }
  }), [repos, query])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pb-2">
        {trees.map(({ repo, entries, tree }) => entries.length === 0 ? null : (
          <div key={repo.gitRoot} className="py-0.5">
            <div
              className="mx-2 flex min-h-7 items-center gap-1.5 px-2 text-[12px] text-muted-foreground"
              title={repo.gitRoot}
            >
              <span className="min-w-0 flex-1 truncate">{repo.name}</span>
              <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                <span>{entries.length}</span>
                {repo.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{repo.additions}</span>}
                {repo.deletions > 0 && <span className="text-red-600 dark:text-red-400">−{repo.deletions}</span>}
              </span>
              {onOpenDirectoryTerminal && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`在 ${repo.name} 打开终端`}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                      onClick={() => onOpenDirectoryTerminal(repo.gitRoot, repo.name)}
                    >
                      <Terminal className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">在右侧标签中打开终端</TooltipContent>
                </Tooltip>
              )}
              {onShowDirectoryInFolder && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`在文件夹中显示 ${repo.name}`}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                      onClick={() => onShowDirectoryInFolder(repo.gitRoot)}
                    >
                      <FolderSearch className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">在文件夹中显示</TooltipContent>
                </Tooltip>
              )}
            </div>
            {tree.map((node) => (
              <ChangesFileTreeRow
                key={`${repo.gitRoot}:${node.path}`}
                node={node}
                depth={0}
                directoryKeyPrefix={repo.gitRoot}
                selectedPath={selectedPath}
                collapsedDirs={collapsedDirs}
                forceExpanded={query.length > 0}
                onToggleDirectory={onToggleDirectory}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function ChangesFileTreeRow({
  node,
  depth,
  directoryKeyPrefix,
  selectedPath,
  collapsedDirs,
  forceExpanded,
  onToggleDirectory,
  onSelect,
}: {
  node: DiffFileTreeNode<TreeEntry>
  depth: number
  directoryKeyPrefix: string
  selectedPath: string | null
  collapsedDirs: ReadonlySet<string>
  forceExpanded: boolean
  onToggleDirectory: (key: string) => void
  onSelect: (filePath: string) => void
}): React.ReactElement {
  const paddingLeft = 8 + depth * 12

  if (node.kind === 'directory') {
    const stateKey = `${directoryKeyPrefix}:${node.path}`
    const collapsed = !forceExpanded && collapsedDirs.has(stateKey)
    return (
      <div>
        <button
          type="button"
          aria-expanded={!collapsed}
          title={node.name}
          className="flex min-h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-[12px] text-foreground/80 transition-colors hover:bg-accent/40"
          style={{ paddingLeft }}
          onClick={() => onToggleDirectory(stateKey)}
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-150', !collapsed && 'rotate-90')}
          />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        {!collapsed && node.children.map((child) => (
          <ChangesFileTreeRow
            key={`${directoryKeyPrefix}:${child.path}`}
            node={child}
            depth={depth + 1}
            directoryKeyPrefix={directoryKeyPrefix}
            selectedPath={selectedPath}
            collapsedDirs={collapsedDirs}
            forceExpanded={forceExpanded}
            onToggleDirectory={onToggleDirectory}
            onSelect={onSelect}
          />
        ))}
      </div>
    )
  }

  const isSelected = node.path === selectedPath
  return (
    <button
      type="button"
      title={node.path}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'flex min-h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-[12px] transition-colors',
        isSelected ? 'bg-accent/70 text-foreground' : 'text-foreground/80 hover:bg-accent/40',
      )}
      style={{ paddingLeft: paddingLeft + 14 }}
      onClick={() => onSelect(node.path)}
    >
      <FileTypeIcon name={node.name} isDirectory={false} size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
        {node.entry.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{node.entry.additions}</span>}
        {node.entry.deletions > 0 && <span className="text-red-600 dark:text-red-400">−{node.entry.deletions}</span>}
        <span className="w-3 text-center text-muted-foreground/70">{STATUS_MARK[node.entry.status]}</span>
      </span>
    </button>
  )
}
