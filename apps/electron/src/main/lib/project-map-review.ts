/**
 * 项目地图（项目根 AGENTS.md）的检查、字符统计、版本与 7 天复查记录。
 *
 * 与商业版一致：检查记录保存在 Proma 工作区元数据
 * `<workspaceRoot>/project-map-reviews/<sha256(realpath(projectRoot))>.json`，
 * 记录里的 revision 必须与当前文件一致才生效；副本不得写回项目文件。
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'

/** 内部复查周期，不暴露给用户配置。 */
export const PROJECT_MAP_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const MIN_MAP_CHARACTERS = 200
const MEMORY_BLOCK_PATTERN = /<!-- proma:memory:start -->[\s\S]*?<!-- proma:memory:end -->/g

export type ProjectMapStatus = '缺失' | '待完善' | '已存在' | '不可安全修改'

export interface ProjectMapState {
  path: string
  content?: string
  characterCount?: number
  modifiedAt?: number
  status: ProjectMapStatus
  revision?: string
}

export interface ProjectMapReviewState extends ProjectMapState {
  checkedAt?: number
  reviewDue?: boolean
}

export interface ProjectMapReviewRecord {
  checkedAt: number
  revision: string
  summary: string
}

/** 读取当前项目地图；AGENTS.md 优先，其次 AGENTS.MD。 */
export function inspectProjectMap(projectRoot: string): ProjectMapState {
  for (const name of ['AGENTS.md', 'AGENTS.MD']) {
    const path = join(projectRoot, name)
    try {
      const stats = lstatSync(path)
      if (!stats.isFile()) return { path, status: '不可安全修改' }
      const content = readFileSync(path, 'utf-8')
      // 通用记忆区块不计入项目事实的 200 字门槛。
      const projectContent = content.replace(MEMORY_BLOCK_PATTERN, '')
      const characterCount = Array.from(projectContent.replace(/\s/g, '')).length
      return {
        path,
        content,
        characterCount,
        modifiedAt: stats.mtimeMs,
        status: characterCount < MIN_MAP_CHARACTERS ? '待完善' : '已存在',
        revision: createHash('sha256').update(`${name}\0${stats.mtimeMs}\0${content}`).digest('hex'),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { path, status: '不可安全修改' }
    }
  }
  return { path: join(projectRoot, 'AGENTS.md'), status: '缺失' }
}

function reviewRecordPath(workspaceRoot: string, projectRoot: string): string {
  let identity = resolve(projectRoot)
  try {
    identity = realpathSync.native(projectRoot)
  } catch {
    // 项目根不可用时退回逻辑路径，保证记录位置稳定。
  }
  const key = createHash('sha256').update(identity).digest('hex')
  return join(workspaceRoot, 'project-map-reviews', `${key}.json`)
}

/** 读取项目地图与上一次实际检查时间；只有 revision 匹配的检查记录才生效。 */
export function readProjectMapReviewState(
  workspaceRoot: string,
  projectRoot: string,
  now = Date.now(),
): ProjectMapReviewState {
  const map = inspectProjectMap(projectRoot)
  let checkedAt: number | undefined
  try {
    const record = JSON.parse(readFileSync(reviewRecordPath(workspaceRoot, projectRoot), 'utf-8')) as Partial<ProjectMapReviewRecord>
    if (
      record &&
      typeof record === 'object' &&
      record.revision === map.revision &&
      typeof record.checkedAt === 'number' &&
      Number.isFinite(record.checkedAt) &&
      record.checkedAt > 0 &&
      record.checkedAt <= now
    ) {
      checkedAt = record.checkedAt
    }
  } catch {
    // 记录缺失或损坏时按“尚无检查记录”处理。
  }
  return {
    ...map,
    checkedAt,
    reviewDue: map.modifiedAt !== undefined && now - Math.max(map.modifiedAt, checkedAt ?? 0) > PROJECT_MAP_REVIEW_INTERVAL_MS,
  }
}

/** 记录一次实际完成的项目地图核验；不修改 AGENTS.md。 */
export function completeProjectMapReview(
  workspaceRoot: string,
  projectRoot: string,
  revision: string,
  summary: string,
  now = Date.now(),
): ProjectMapReviewRecord {
  if (!summary.trim()) throw new Error('请说明实际核验的内容、依据以及更新或无需更新的结论。')
  const map = inspectProjectMap(projectRoot)
  if (!map.revision || map.status === '不可安全修改') throw new Error('项目地图缺失或不可安全修改，不能记录检查完成。')
  if (map.revision !== revision) throw new Error('AGENTS.md 已发生变化，请重新读取并核验后再记录检查完成。')

  const record: ProjectMapReviewRecord = { checkedAt: now, revision, summary: summary.trim() }
  const path = reviewRecordPath(workspaceRoot, projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}

/** 每轮注入的“本轮项目地图行动”；无行动时返回 undefined。 */
export function buildProjectMapActionPrompt(map: ProjectMapReviewState): string | undefined {
  const actions: string[] = []
  if (map.status === '不可安全修改') return undefined

  if (map.status === '缺失') {
    actions.push('当前项目 AGENTS.md 缺失。本轮若在此项目开展工作，请根据已核验事实，在任务结束前建立项目地图。')
  } else if (map.characterCount === 0) {
    actions.push('当前项目 AGENTS.md 已存在，但内容为空（0 个非空白字符）。本轮若在此项目开展工作，请根据已核验事实，在任务结束前补全该文件。')
  } else if (map.characterCount !== undefined && map.characterCount < MIN_MAP_CHARACTERS) {
    actions.push(`当前项目 AGENTS.md 仅有 ${map.characterCount} 个非空白字符，对项目要求、结构或使用方式的描述可能明显不足。本轮项目任务中必须核验并确定需要补充或更新的内容，在收尾前完成有事实依据的更新；保留已有有效规则。若现有内容已足够或证据不足以补充，应说明判断，不为凑字数扩写。`)
  }

  if (map.reviewDue) {
    const formatTime = (time: number): string => new Date(time).toLocaleString('zh-CN', { hour12: false })
    actions.push(
      `当前项目 AGENTS.md 上次修改于 ${formatTime(map.modifiedAt ?? 0)}，${map.checkedAt ? `上次实际检查于 ${formatTime(map.checkedAt)}` : '尚无当前版本的检查记录'}；距最近修改或检查已超过一周。部分要求或项目描述可能已经发生变化，请结合本轮项目任务检查是否仍然适用，必要时局部更新，并在实际完成核验后记录检查时间。`,
    )
  }

  if (actions.length === 0) return undefined

  return `## 本轮项目地图行动
目标路径：\`${map.path}\`（${map.status}）。
${actions.join('\n')}
先读取 Coach 的 project-map reference；使用 ProjectMapInspect 读取当前文件与版本，结合本轮事实核验。若修改文件，写后再次调用 ProjectMapInspect 回读验证，再用返回的 revision 调用 ProjectMapReviewComplete，说明核验依据及更新或无需更新的结论。仅看到提醒、尚未核验或证据不足时，不得记录检查完成。检查时间由工具保存到 Proma 元数据，禁止通过 touch 或改写 AGENTS.md 日期代替。
计划模式、只读要求与用户明确禁止写入仍优先，此时不修改文件或记录检查时间；普通问答和打开页面不触发项目事实核验；运行时要求的一次性基础能力维护仍按专用工具自动完成，无需扫描项目或记录事实周检。无需单独的初始化授权，不为凑字数填充内容。`
}
