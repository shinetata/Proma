/**
 * 项目规则工具组：首次能力维护、读取两侧规则、语义合并、恢复与重规划。
 */

import { Type } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { hasMemoryAssociation, memoryAssociation, type AgentMemoryContext } from '../agent-memory'
import {
  inspectInstructionMigration,
  instructionInspectionRevision,
  mergeProjectInstructions,
  replanProjectInstructions,
  resumeProjectInstructions,
} from '../project-instruction-migration'
import { finishInstructionMaintenance, maintainProjectInstructions } from '../project-instruction-maintenance'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

function textResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
}

const READY_NOTICE = '这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用。'

export function buildInstructionMigrationTools(sdk: PiSdk, ctx: AgentMemoryContext): ToolDefinition[] {
  let inspected: string | undefined

  const finish = () => {
    const record = finishInstructionMaintenance(ctx)
    return { targetPath: record.targetPath }
  }

  return [
    sdk.defineTool({
      name: 'ProjectInstructionsMaintain',
      label: '自动完善项目协作能力',
      description:
        'One-time product-authorized project setup, including a first greeting. Preserve user files; initialize missing AGENTS.md and required memory, migrate unambiguous legacy rules, verify and persist completion. If needs-merge is returned, Inspect and semantically Migrate; ask only for unresolved substantive conflicts. A ready result is already verified: do not repeatedly inspect or initialize. Only announce userFacingNotice if present; changed=false is not a new optimization. Respect explicit read-only requests and plan mode. Never claim completion for needs-merge/deferred/errors.',
      parameters: Type.Object({}),
      async execute() {
        const state = maintainProjectInstructions(ctx)
        return textResult({
          ...state,
          ...(state.status === 'ready' && state.changed ? { userFacingNotice: READY_NOTICE } : {}),
        })
      },
    }),
    sdk.defineTool({
      name: 'ProjectInstructionsInspect',
      label: '读取项目规则与旧外层规则',
      description:
        'Read the canonical project AGENTS.md and all legacy outer workspace AGENTS.md variants, revisions and pending migration IDs. Read both before merging. No writes or automatic conflict resolution. A worktree session reports deferred migration to the original project root.',
      parameters: Type.Object({}),
      async execute() {
        const state = inspectInstructionMigration(ctx)
        inspected = instructionInspectionRevision(ctx)
        return textResult(state)
      },
    }),
    sdk.defineTool({
      name: 'ProjectInstructionsMigrate',
      label: '合并旧规则到项目 AGENTS.md',
      description:
        'After ProjectInstructionsInspect, submit a semantic merge of both rule files: preserve valid requirements, deduplicate, resolve conflicts using evidence or ask the user before committing. Never concatenate contradictory requirements or prefer newer mtime. Retain any existing CLAUDE.md entry when creating AGENTS.md. Provide every source path/revision exactly as inspected. Saves recovery history, writes/verifies the project file, then archives legacy files outside native discovery. Do not manually delete legacy files. Only user project work in the original project checkout may migrate.',
      parameters: Type.Object({
        targetRevision: Type.String({ minLength: 64, maxLength: 64 }),
        sources: Type.Array(
          Type.Object({ path: Type.String(), revision: Type.String({ minLength: 64, maxLength: 64 }) }),
        ),
        content: Type.String({ minLength: 1, maxLength: 524288 }),
        summary: Type.String({ minLength: 1, maxLength: 12000 }),
      }),
      async execute(_id, params) {
        if (!inspected || inspected !== instructionInspectionRevision(ctx)) {
          throw new Error('请先重新使用 ProjectInstructionsInspect 读取当前两侧规则再合并。')
        }
        const proposal = params as {
          targetRevision: string
          sources: Array<{ path: string; revision: string }>
          content: string
          summary: string
        }
        const content = hasMemoryAssociation(ctx, proposal.content)
          ? proposal.content
          : `${proposal.content.trimEnd()}

${memoryAssociation(ctx)}
`
        const id = mergeProjectInstructions(ctx, { ...proposal, content })
        inspected = undefined
        const ready = finish()
        return textResult({ migrationId: id, status: 'ready', ...ready, verified: true, userFacingNotice: READY_NOTICE })
      },
    }),
    sdk.defineTool({
      name: 'ProjectInstructionsResume',
      label: '恢复项目规则迁移',
      description:
        'Resume a pending migration ID returned by ProjectInstructionsInspect. Accepts only original snapshots or already-written results; never overwrites new external edits. Original source and target contents remain archived. If a new edit conflicts, preserve files and explain the conflict instead of overwriting.',
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, params) {
        const id = resumeProjectInstructions(ctx, (params as { id: string }).id)
        const ready = finish()
        return textResult({ migrationId: id, status: 'ready', ...ready, verified: true, userFacingNotice: READY_NOTICE })
      },
    }),
    sdk.defineTool({
      name: 'ProjectInstructionsReplan',
      label: '保留新改动并重新合并规则',
      description:
        'When resuming a pending migration fails because source or target was externally edited, retire the old plan while preserving ALL current target/source edits. Restore only missing legacy source files from the saved original snapshot, keeping previous history. Then use ProjectInstructionsInspect and semantically merge again with current revisions. This does not complete migration and must not be used to overwrite or discard conflicts.',
      parameters: Type.Object({ id: Type.String() }),
      async execute(_id, params) {
        const id = replanProjectInstructions(ctx, (params as { id: string }).id)
        inspected = undefined
        return textResult({ supersededId: id, ...inspectInstructionMigration(ctx) })
      },
    }),
  ].filter(
    (tool) => (ctx.allowProfileMigration !== false && ctx.allowInstructionMaintenance !== false) || tool.name === 'ProjectInstructionsInspect',
  )
}
