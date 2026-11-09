/**
 * 记忆工具组：全局画像与项目记忆的读写、归档、初始化与旧画像迁移。
 *
 * 工具名、参数与描述必须与商业版一致：模型据此决定是否写入，描述变化会直接改变行为。
 */

import { Type } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  ProfileBudgetExceededError,
  PROFILE_MAX_CHARS,
  archiveMemoryTheme,
  discoverLegacyProfiles,
  ensureMemoryFiles,
  inspectLegacyProfileLocations,
  linkProjectMemory,
  listMemoryHistory,
  memoryPaths,
  memoryTarget,
  pendingMemoryMigrations,
  readMemoryFile,
  readMemoryReview,
  updateMemory,
  updateMemoryEntries,
  withMemoryLock,
  type AgentMemoryContext,
} from '../agent-memory'
import type { MemoryEntryOperation } from '../memory-entries'
import { searchMemory } from '../memory-search'
import { migrateProfile, resumeProfileMigration, replanProfileMigration, type ProfileMigrationProposal } from '../agent-memory-migration'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

function textResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
}

function profileBudget(value: string | null) {
  return {
    chars: value?.length ?? 0,
    maxChars: PROFILE_MAX_CHARS,
    remainingChars: Math.max(0, PROFILE_MAX_CHARS - (value?.length ?? 0)),
    unit: 'utf16',
  }
}

function reconciliation(error: ProfileBudgetExceededError, operation: 'update' | 'migration') {
  return {
    status: 'reconciliation_required',
    saved: false,
    operation,
    attemptedChars: error.attemptedChars,
    maxChars: PROFILE_MAX_CHARS,
    next:
      operation === 'update'
        ? '本次更新未保存。可写用户主会话应主动调用 collaboration.start_profile_maintenance，传入本次待记录事实及依据；后台子会话负责整理、版本校验、重试和回读。已有整理运行时本次事实未被接收，必须保留并在其结束后更新核验。只读、计划模式、自动化及子会话不得主动派发；子会话应自行整理并安全重试。'
        : '迁移未执行。重新读取来源和画像，保留本次待合并事实及来源，整理至约 4000–4500 字符，再提交新的迁移提案。无法安全整理时保留原文并说明未完成。',
  }
}

export function buildMemoryTools(sdk: PiSdk, ctx: AgentMemoryContext): ToolDefinition[] {
  const revision = () => Type.String({ minLength: 64, maxLength: 64 })
  const content = () => Type.String({ minLength: 1, maxLength: 524288 })

  return [
    sdk.defineTool({
      name: 'MemoryInspect',
      label: '读取记忆与迁移状态',
      description:
        'Read the global Profile, project memory and review status. Profile includes its 5000-character budget and remaining space. Use target for a project theme or global-profile; sourceId reads a legacy profile and its project context. Read-only; does not mark reviewed.',
      parameters: Type.Object({ target: Type.Optional(Type.String()), sourceId: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const args = params as { target?: string; sourceId?: string }
        if (args.target) {
          const file = readMemoryFile(memoryTarget(ctx, args.target))
          return textResult({
            ...file,
            ...readMemoryReview(ctx, file),
            ...(args.target === 'global-profile' ? { budget: profileBudget(file.content) } : {}),
          })
        }

        const { sources, issues } = inspectLegacyProfileLocations(ctx)
        const source = args.sourceId ? discoverLegacyProfiles(ctx, args.sourceId)[0] : undefined
        if (args.sourceId && !source) throw new Error('未找到已登记的旧画像来源，请重新读取迁移列表。')

        const paths = memoryPaths(source ? { ...ctx, workspaceRoot: source.workspace.root } : ctx)
        const files = [paths.profile, paths.index, paths.preferences].map((path) => {
          const file = readMemoryFile(path)
          return { ...file, ...readMemoryReview(ctx, file), ...(path === paths.profile ? { budget: profileBudget(file.content) } : {}) }
        })
        return textResult({
          files,
          source,
          legacyProfiles: sources.map((item) => ({ id: item.id, workspace: item.workspace.slug, path: item.path })),
          migrationIssues: issues,
          pendingMigrations: pendingMemoryMigrations(ctx),
        })
      },
    }),
    sdk.defineTool({
      name: 'MemoryInitialize',
      label: '建立必需记忆与项目关联',
      description:
        'Ensure the global user_profile.md and current project MEMORY.md exist with truthful scaffolding; append an explicit memory maintenance section and absolute links to the current project AGENTS.md, preserving existing rules and CLAUDE.md entry. Use during writable project work, not read-only/plan tasks. Afterwards fill project facts and confirmed user facts; do not invent a profile.',
      parameters: Type.Object({}),
      async execute() {
        ensureMemoryFiles(ctx)
        withMemoryLock(ctx, () => linkProjectMemory(ctx))
        return textResult(memoryPaths(ctx))
      },
    }),
    sdk.defineTool({
      name: 'MemoryUpdate',
      label: '更新或核验记忆',
      description:
        'Version-checked memory update. Prefer `operations` to add/update/remove single `- ` entries so unrelated text is preserved; use `content` only for a full rewrite or review pass. For global-profile, write concise core user facts: one short fact per item, at most 100 facts and 5000 UTF-16 code units; merge duplicates, retain necessary scope and sources, and correct outdated facts without guessing. Project-only facts belong to the authorized project. If reconciliation_required, nothing was saved: retain the pending facts, inspect, reconcile to about 4000–4500 characters, retry with the latest revision and verify. Preserve unrelated facts and history; report if unsafe to reconcile. Unchanged content records review; update MEMORY.md when theme routes change. Do not use for profile migration.',
      parameters: Type.Object({
        target: Type.String(),
        revision: revision(),
        content: Type.Optional(content()),
        // 单条操作：避免整篇重写丢掉无关事实。`content` 与 `operations` 二选一。
        operations: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Object({
                op: Type.Literal('add'),
                entry: Type.String({ minLength: 1, maxLength: 2000 }),
                after: Type.Optional(Type.String({ maxLength: 500 })),
              }),
              Type.Object({
                op: Type.Literal('update'),
                match: Type.String({ minLength: 1, maxLength: 500 }),
                entry: Type.String({ minLength: 1, maxLength: 2000 }),
              }),
              Type.Object({
                op: Type.Literal('remove'),
                match: Type.String({ minLength: 1, maxLength: 500 }),
                all: Type.Optional(Type.Boolean()),
              }),
            ]),
            { minItems: 1, maxItems: 50 },
          ),
        ),
        summary: Type.String({ minLength: 1, maxLength: 4000 }),
      }),
      async execute(_id, params) {
        const args = params as {
          target: string
          revision: string
          content?: string
          operations?: MemoryEntryOperation[]
          summary: string
        }
        if (!args.content?.trim() && !args.operations?.length) {
          throw new Error('请提供 content 或至少一条条目操作。')
        }
        if (args.content?.trim() && args.operations?.length) {
          throw new Error('content 与 operations 只能二选一：整篇替换或条目操作。')
        }
        const entryOperations = args.operations ?? []
        const fullContent = args.content ?? ''
        try {
          return textResult(
            entryOperations.length
              ? updateMemoryEntries(ctx, args.target, args.revision, entryOperations, args.summary)
              : updateMemory(ctx, args.target, args.revision, fullContent, args.summary),
          )
        } catch (error) {
          if (error instanceof ProfileBudgetExceededError) return textResult(reconciliation(error, 'update'))
          throw error
        }
      },
    }),
    sdk.defineTool({
      name: 'MemorySearch',
      label: '检索记忆片段',
      description:
        'Search the global profile and current project memory/*.md by keywords and return line-level snippets with file, line and score. Use it when the MEMORY.md index is long or you are unsure which topic file holds a fact; read the full file only when the snippet is insufficient. Read-only.',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
      }),
      async execute(_id, params) {
        const args = params as { query: string; limit?: number }
        return textResult(searchMemory(ctx, args.query, args.limit))
      },
    }),
    sdk.defineTool({
      name: 'MemoryHistory',
      label: '查看记忆历史版本',
      description:
        'List saved versions of a memory target (global-profile, MEMORY.md or a memory/*.md theme) with time, write summary and size. Read-only; restoring a version is a user action in the Memory page.',
      parameters: Type.Object({
        target: Type.String(),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      }),
      async execute(_id, params) {
        const args = params as { target: string; limit?: number }
        return textResult({ target: args.target, versions: listMemoryHistory(ctx, args.target, args.limit ?? 20) })
      },
    }),
    sdk.defineTool({
      name: 'MemoryMigrateProfile',
      label: '合并旧画像并更新原项目索引',
      description:
        'Read the knowledge-maintenance guide and MemoryInspect sourceId, then semantically merge ONE legacy profile. Keep concise core user facts in global-profile (at most 100 facts and 5000 UTF-16 code units); preserve provenance, unrelated facts and indexes, and put project-only facts in the source project. Never resolve conflicts by mtime. On reconciliation_required, retain pending facts, reorganize and resubmit. For a pending migration use resumeId; on conflict use replanId, re-inspect and merge again. Do not claim completion while migrationIssues, sources or pending records remain.',
      parameters: Type.Object({
        resumeId: Type.Optional(Type.String()),
        replanId: Type.Optional(Type.String()),
        proposal: Type.Optional(
          Type.Object({
            sourceId: Type.String(),
            sourceRevision: revision(),
            globalRevision: revision(),
            globalContent: content(),
            preferencesRevision: revision(),
            preferencesContent: Type.Union([content(), Type.Null()]),
            sourceIndexRevision: revision(),
            sourceIndexContent: content(),
            indexRevision: revision(),
            indexContent: content(),
            rationale: Type.String({ minLength: 1, maxLength: 12000 }),
          }),
        ),
      }),
      async execute(_id, params) {
        const args = params as { resumeId?: string; replanId?: string; proposal?: ProfileMigrationProposal }
        if ([args.resumeId, args.replanId, args.proposal].filter(Boolean).length !== 1) {
          throw new Error('请提供 proposal、resumeId 或 replanId 中的一个。')
        }
        if (args.replanId) {
          return textResult({
            supersededId: replanProfileMigration(ctx, args.replanId),
            status: 'needs-merge',
            next: '使用 MemoryInspect 重新读取当前来源和版本，保留新编辑后再次语义合并；原计划和 before/after 历史保留在 superseded.json。',
          })
        }
        try {
          return textResult({
            migrationId: args.resumeId ? resumeProfileMigration(ctx, args.resumeId) : migrateProfile(ctx, args.proposal!),
          })
        } catch (error) {
          if (error instanceof ProfileBudgetExceededError) return textResult(reconciliation(error, 'migration'))
          throw error
        }
      },
    }),
    sdk.defineTool({
      name: 'MemoryArchive',
      label: '归档过期记忆主题',
      description:
        'Recoverably archive an actually expired or superseded non-core current-project theme, while replacing MEMORY.md with a version-checked index that removes its active route. Preserve unrelated index entries. Use only after verifying evidence; age alone is not expiry. Core profile/index/preferences must be revised by entry using MemoryUpdate instead.',
      parameters: Type.Object({
        target: Type.String(),
        revision: revision(),
        indexRevision: revision(),
        indexContent: content(),
      }),
      async execute(_id, params) {
        const args = params as { target: string; revision: string; indexRevision: string; indexContent: string }
        return textResult({
          archive: archiveMemoryTheme(ctx, args.target, args.revision, args.indexRevision, args.indexContent),
        })
      },
    }),
  ].filter(
    (tool) =>
      (ctx.allowProfileMigration !== false && ctx.allowInstructionMaintenance !== false) || tool.name !== 'MemoryMigrateProfile',
  )
}