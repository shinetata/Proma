/**
 * 连续改动视图中的单个文件区块
 *
 * 文件头固定显示状态、路径、增删行数与操作；展开后按段渲染行：
 * 改动行、上下文行与被折叠的未改动行段（gap）交替排列，宽度不足时可切并排视图。
 */

import * as React from 'react'
import { ChevronRight, ExternalLink, Undo2, UnfoldVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import {
  buildFileSegments,
  getMaxLineNumber,
  pairSplitRows,
  type ChangesFile,
  type UnifiedDiffLine,
} from './continuous-diff-rows'

/** 已展开的文件内容：读取中或读取完成的行数组 */
export type ExpandedFileText = string[] | 'loading'

interface ContinuousDiffFileProps {
  file: ChangesFile
  /** 完整新文件内容，用于就地展开 gap */
  text: ExpandedFileText | undefined
  /** 已展开的 gap 序号 */
  openGaps: ReadonlySet<number>
  onExpandGap: (gapIndex: number) => void
  expanded: boolean
  onToggle: () => void
  /** 大文件：点击「展开 N 行改动」后才渲染 */
  large: boolean
  revealed: boolean
  onReveal: () => void
  split: boolean
  wrap: boolean
  sectionRef: (element: HTMLElement | null) => void
  onOpenFile: () => void
  /** 新文件没有 diff 基线，不提供还原 */
  onRevert?: () => void
}

/** 文件头左侧的状态徽标文案 */
function getStatusLabel(status: ChangesFile['status']): string {
  switch (status) {
    case 'new':
      return '新增'
    case 'deleted':
      return '删除'
    case 'rename-pure':
    case 'rename-changed':
      return '重命名'
    default:
      return ''
  }
}

/** 行首符号（统一视图） */
const LINE_SIGN: Record<UnifiedDiffLine['kind'], string> = { add: '+', del: '-', context: ' ' }

function lineKindClass(kind: UnifiedDiffLine['kind']): string {
  if (kind === 'add') return 'cdv-add'
  if (kind === 'del') return 'cdv-del'
  return 'cdv-context'
}

/** 路径拆成目录与文件名两段，目录弱化显示 */
function FilePathLabel({ path }: { path: string }): React.ReactElement {
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : ''
  const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
  return (
    <span className="min-w-0 truncate font-mono text-[12px]" title={path}>
      <span className="text-muted-foreground">{directory}</span>
      <span className="text-foreground">{fileName}</span>
    </span>
  )
}

function DiffBody({
  file,
  text,
  openGaps,
  onExpandGap,
  split,
  wrap,
}: {
  file: ChangesFile
  text: ExpandedFileText | undefined
  openGaps: ReadonlySet<number>
  onExpandGap: (gapIndex: number) => void
  split: boolean
  wrap: boolean
}): React.ReactElement {
  const expandedContent = Array.isArray(text) ? text : undefined
  const segments = React.useMemo(
    () => buildFileSegments(file, expandedContent, openGaps),
    [file, expandedContent, openGaps],
  )
  // 并排视图只在确实有增删配对时启用，纯新增或纯删除文件保持统一视图。
  const showSplit = split && file.additions > 0 && file.deletions > 0
  const maxLineNumber = getMaxLineNumber(file, expandedContent)
  const numberWidth = { '--cdv-number-width': `calc(${Math.max(2, String(maxLineNumber).length)}ch + 10px)` } as React.CSSProperties
  const loading = text === 'loading'

  if (file.empty) {
    return <p className="cdv-note">该文件没有可展示的行改动（二进制或仅权限变化）。</p>
  }

  return (
    <div className={cn('cdv-code', showSplit && 'cdv-split', wrap && 'cdv-wrap')} style={numberWidth} data-wrap={wrap ? '' : undefined}>
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === 'gap') {
          return (
            <button
              key={`gap-${segment.index}`}
              type="button"
              className="cdv-gap"
              disabled={loading}
              onClick={() => onExpandGap(segment.index)}
            >
              <UnfoldVertical className="size-3" aria-hidden="true" />
              {segment.count === null
                ? (loading ? '正在读取…' : '展开剩余未更改行')
                : `${segment.count.toLocaleString()} 行未更改`}
            </button>
          )
        }

        if (showSplit) {
          return pairSplitRows(segment.rows).map((row, rowIndex) => (
            <div key={`${segmentIndex}-${rowIndex}`} className="cdv-pair">
              {row.left === null
                ? <span className="cdv-cell cdv-cell-empty" />
                : (
                  <span className={cn('cdv-cell', lineKindClass(row.left.kind))}>
                    <span className="cdv-no">{row.left.no}</span>
                    <span className="cdv-text">{row.left.text}</span>
                  </span>
                )}
              {row.right === null
                ? <span className="cdv-cell cdv-cell-empty" />
                : (
                  <span className={cn('cdv-cell', lineKindClass(row.right.kind))}>
                    <span className="cdv-no">{row.right.no}</span>
                    <span className="cdv-text">{row.right.text}</span>
                  </span>
                )}
            </div>
          ))
        }

        return segment.rows.map((row, rowIndex) => (
          <div key={`${segmentIndex}-${rowIndex}`} className={cn('cdv-line', lineKindClass(row.kind))}>
            <span className="cdv-no">{row.old ?? ''}</span>
            <span className="cdv-no">{row.new ?? ''}</span>
            <span className="cdv-sign">{LINE_SIGN[row.kind]}</span>
            <span className="cdv-text">{row.text}</span>
          </div>
        ))
      })}
    </div>
  )
}

export function ContinuousDiffFile({
  file,
  text,
  openGaps,
  onExpandGap,
  expanded,
  onToggle,
  large,
  revealed,
  onReveal,
  split,
  wrap,
  sectionRef,
  onOpenFile,
  onRevert,
}: ContinuousDiffFileProps): React.ReactElement {
  const statusLabel = getStatusLabel(file.status)
  const isLargeCollapsed = large && !revealed

  return (
    <section ref={sectionRef} className="cdv-file" data-expanded={expanded ? '' : undefined}>
      <div className="cdv-file-header">
        <button
          type="button"
          className="cdv-file-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `收起 ${file.path}` : `展开 ${file.path}`}
          onClick={onToggle}
        >
          <ChevronRight className="size-3.5 cdv-chevron" aria-hidden="true" />
        </button>
        <FileTypeIcon name={file.path} isDirectory={false} size={16} className="shrink-0" />
        <button
          type="button"
          className="cdv-file-path group"
          title={`在标签中打开 ${file.path}`}
          onClick={onOpenFile}
        >
          <FilePathLabel path={file.path} />
          <ExternalLink className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" aria-hidden="true" />
        </button>
        {file.previousPath !== null && file.previousPath !== file.path && (
          <span className="cdv-note-inline" title={`原路径 ${file.previousPath}`}>← {file.previousPath}</span>
        )}
        <span className="flex-1" />
        {statusLabel !== '' && <span className="cdv-badge">{statusLabel}</span>}
        <span className="cdv-counts">
          <span className="cdv-added">+{file.additions.toLocaleString()}</span>
          <span className="cdv-deleted">−{file.deletions.toLocaleString()}</span>
        </span>
        {onRevert && (
          <button
            type="button"
            className="cdv-tool"
            title={`还原 ${file.path} 的改动`}
            aria-label={`还原 ${file.path} 的改动`}
            onClick={onRevert}
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {expanded && (isLargeCollapsed ? (
        <button type="button" className="cdv-gap" onClick={onReveal}>
          <UnfoldVertical className="size-3" aria-hidden="true" />
          {`展开 ${file.metadata.unifiedLineCount.toLocaleString()} 行改动`}
        </button>
      ) : (
        <DiffBody file={file} text={text} openGaps={openGaps} onExpandGap={onExpandGap} split={split} wrap={wrap} />
      ))}
    </section>
  )
}
