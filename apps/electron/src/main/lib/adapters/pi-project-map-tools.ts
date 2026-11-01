/**
 * 项目地图工具组：读取项目 AGENTS.md 的版本与状态，以及记录一次实际完成的复查。
 */

import { Type } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { hasMemoryAssociation, type AgentMemoryContext } from '../agent-memory'
import { completeProjectMapReview, readProjectMapReviewState } from '../project-map-review'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

function textResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
}

export function buildProjectMapTools(
  sdk: PiSdk,
  workspaceRoot: string,
  projectRoot: string,
  memoryContext?: AgentMemoryContext,
): ToolDefinition[] {
  let inspectedRevision: string | undefined

  return [
    sdk.defineTool({
      name: 'ProjectMapInspect',
      label: '读取项目地图',
      description:
        'Read the current project AGENTS.md, its character count, modification/review times and revision. Does not write files or mark a review complete. Read the Coach project-map reference and verify relevant project facts before completing a review.',
      parameters: Type.Object({}),
      async execute() {
        const state = readProjectMapReviewState(workspaceRoot, projectRoot)
        inspectedRevision = state.revision
        return textResult(state)
      },
    }),
    sdk.defineTool({
      name: 'ProjectMapReviewComplete',
      label: '记录项目地图检查完成',
      description:
        'Record an actually completed project-map review in Proma metadata without modifying AGENTS.md. First use ProjectMapInspect and verify project facts. After edits, inspect and verify the updated file again. Do not call for a reminder alone, insufficient evidence, ordinary Q&A, plan mode or read-only tasks. Short or empty maps remain flagged even after a review.',
      parameters: Type.Object({
        revision: Type.String({ minLength: 64, maxLength: 64, description: 'Exact revision returned by the latest ProjectMapInspect in this run.' }),
        summary: Type.String({
          minLength: 1,
          maxLength: 2000,
          description: 'What was actually checked, supporting facts and what was updated or why no update was necessary.',
        }),
      }),
      async execute(_toolCallId, params) {
        const args = params as { revision: string; summary: string }
        if (!inspectedRevision || args.revision !== inspectedRevision) {
          throw new Error('请先使用 ProjectMapInspect 读取并核验当前项目地图，再确认检查完成。')
        }
        if (memoryContext && !hasMemoryAssociation(memoryContext, readProjectMapReviewState(workspaceRoot, projectRoot).content ?? '')) {
          throw new Error('项目地图缺少记忆维护方案或 MEMORY.md / 全局 user_profile.md 位置。请使用 MemoryInitialize 补齐，再重新读取核验。')
        }
        const record = completeProjectMapReview(workspaceRoot, projectRoot, args.revision, args.summary)
        inspectedRevision = undefined
        return textResult(record)
      },
    }),
  ]
}