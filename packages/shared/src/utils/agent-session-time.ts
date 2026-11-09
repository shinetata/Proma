/**
 * Agent 会话时间语义
 *
 * 会话元数据里有两个时间字段，语义必须区分：
 * - `lastActivityAt`：用户真正产生活动的时刻（发出了一条用户输入）。侧栏排序、分组、
 *   「最近活跃」展示都以它为准，元数据变更不会抬高它。
 * - `updatedAt`：元数据被写入的时刻（标记已读、改标题、改推理档位、跑完一轮、写校验索引）。
 *   只用于判断元数据新鲜度与并发保护，不代表用户活动。
 *
 * 升级前写入的旧数据可能没有 `lastActivityAt`，读取处统一回退 `updatedAt`。
 */

/** 只需要时间字段的最小结构，便于主进程、渲染层与测试复用。 */
export interface AgentSessionTimeFields {
  lastActivityAt?: number
  updatedAt: number
}

/** 会话的最后活跃时间；缺失时回退元数据写入时间。 */
export function getAgentSessionActivityAt(session: AgentSessionTimeFields): number {
  return session.lastActivityAt ?? session.updatedAt
}

/**
 * 按最后活跃时间降序比较，活跃时间相同时按 id 升序保证顺序稳定。
 *
 * 侧栏、托盘菜单、搜索与页签切换都使用同一个比较器，避免各处排序不一致。
 */
export function compareAgentSessionsByActivityDesc(
  a: AgentSessionTimeFields & { id: string },
  b: AgentSessionTimeFields & { id: string },
): number {
  const delta = getAgentSessionActivityAt(b) - getAgentSessionActivityAt(a)
  return delta !== 0 ? delta : a.id.localeCompare(b.id)
}
