/**
 * 工具执行前后的知识文件快照包装器，用于生成带分类标签的变更事件。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createKnowledgeChangeTracker, type KnowledgeFileChange } from '../knowledge-change-tracker'
import type { AgentMemoryContext } from '../agent-memory'

export function wrapSynchronousKnowledgeTools<T extends ToolDefinition>(
  tools: T[],
  memoryContext: AgentMemoryContext,
  onChanges: (changes: KnowledgeFileChange[]) => void = () => {},
): T[] {
  const tracker = createKnowledgeChangeTracker({ memoryContext, cwd: memoryContext.projectRoot, onChanges })
  return tools.map((tool) => ({
    ...tool,
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, extra?: unknown) {
      return tracker.runSynchronous(tool.name, params, () =>
        (tool.execute as (...callArgs: unknown[]) => unknown)(toolCallId, params, signal, onUpdate, extra),
      )
    },
  })) as T[]
}
