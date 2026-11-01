/**
 * 首次项目能力维护：建立必需的 AGENTS.md / MEMORY.md / 全局画像，并把明确的旧规则合并掉。
 *
 * 这是产品已授权的一次性维护，普通问候也会触发；只读与计划模式不执行。
 */

import { memoryPaths } from './agent-memory'
import {
  ensureMemoryFiles,
  hasMemoryAssociation,
  linkProjectMemory,
  readMemoryFile,
  withMemoryLock,
  type AgentMemoryContext,
} from './agent-memory'
import {
  inspectInstructionMigration,
  inspectLegacyProjectInstructions,
  mergeProjectInstructions,
  projectInstructionsPath,
  resumeProjectInstructions,
} from './project-instruction-migration'
import { readInstructionReadyRecord, writeInstructionReadyRecord } from './project-instruction-state'

export type InstructionMaintenanceState =
  | { status: 'ready'; changed: boolean; targetPath: string; completedAt?: number }
  | { status: 'blocked' | 'deferred' | 'needs-merge'; [key: string]: unknown }

function assertWritable(ctx: AgentMemoryContext): void {
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) {
    throw new Error('当前只读、计划或无人值守会话不执行项目能力维护。')
  }
}

export function finishInstructionMaintenance(ctx: AgentMemoryContext, changed = true) {
  assertWritable(ctx)
  ensureMemoryFiles(ctx)
  return withMemoryLock(ctx, () => {
    const state = inspectInstructionMigration(ctx)
    if (state.needed) throw new Error('旧项目规则尚未合并，不能记录项目能力维护完成。')
    linkProjectMemory(ctx)
    const target = readMemoryFile(projectInstructionsPath(ctx.projectRoot))
    if (!hasMemoryAssociation(ctx, target.content ?? '')) throw new Error('项目规则记忆关联未就绪。')
    return writeInstructionReadyRecord(ctx, target.path, changed)
  })
}

export function maintainProjectInstructions(ctx: AgentMemoryContext): InstructionMaintenanceState {
  assertWritable(ctx)

  const ready = readInstructionReadyRecord(ctx)
  if (ready) return { status: 'ready', changed: false, targetPath: ready.targetPath }

  let state = inspectInstructionMigration(ctx)
  if (state.issues.length) return { status: 'blocked', ...state }
  if (state.deferred && state.needed) return { status: 'deferred', ...state }

  for (const id of state.pendingIds) resumeProjectInstructions(ctx, id)
  state = inspectInstructionMigration(ctx)

  const contents = [
    ...new Set([state.target, ...state.sources].map((file) => file.content?.trim()).filter((value): value is string => Boolean(value))),
  ]
  if (state.sources.length && contents.length > 1) return { status: 'needs-merge', ...state }

  const paths = memoryPaths(ctx)
  const changed =
    state.sources.length > 0 ||
    !hasMemoryAssociation(ctx, state.target.content ?? '') ||
    !readMemoryFile(paths.index).content?.trim() ||
    !readMemoryFile(paths.profile).content?.trim()

  if (state.sources.length) {
    mergeProjectInstructions(ctx, {
      targetRevision: state.target.revision,
      sources: state.sources.map((file) => ({ path: file.path, revision: file.revision })),
      content:
        contents[0] ??
        '# 项目约定\n\n项目事实随实际任务按已核验信息补充，不编造项目架构、命令或用户偏好。',
      summary: '首次能力维护：保留唯一非空正文或去重相同正文；无规则冲突。空文件仅建立真实的基础说明。',
    })
  }

  const record = finishInstructionMaintenance(ctx, changed)
  return { status: 'ready', changed, targetPath: record.targetPath, completedAt: record.completedAt }
}

/** 首次项目能力维护的本轮提示；已完成或不可写时返回 undefined。 */
export function instructionMaintenancePrompt(ctx: AgentMemoryContext): string | undefined {
  const ready = readInstructionReadyRecord(ctx)
  if (ready) return undefined
  if (ctx.allowInstructionMaintenance === false || ctx.allowProfileMigration === false) return undefined
  if (inspectLegacyProjectInstructions(ctx).issues.length) return undefined

  return `## 首次项目能力维护（本轮自动完成）
这是产品已授权的一次性项目基础维护，用户只说 hi、你好或普通问答也触发，不需要用户选择或再次确认是否初始化。
这是后台基础维护，不是用户请求的迁移报告。维护前和工具之间不要输出说明、计划、路径或能力清单；先直接调用 ProjectInstructionsMaintain：工具会保留原文、建立缺少的 AGENTS.md / MEMORY.md / 全局 user_profile.md、关联维护方案，并自动处理空文件或唯一正文的迁移。不要把“建立规则”列为供用户选择的能力，也不要仅回复目录为空。
若返回 needs-merge，使用 ProjectInstructionsInspect 读取双方并调用 ProjectInstructionsMigrate 语义合并；只对无法凭证据解决的实质冲突询问用户。不要为这次基础维护运行全项目调查或为了 200 字编造事实。
完成工具会回读核验并记录持久状态；无需再调用项目规则 Inspect/MemoryInitialize/周检工具验证同一结果；这不限制独立待处理的旧画像整合及其 MemoryInspect/MemoryMigrateProfile。成功后正常回答用户，维护结果只允许在回复末尾附一句“这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用”。用户仅问候时，整条最终回复最多两句；不要列举能做什么，不要说项目目录为空，不要讲 AGENTS/MEMORY、迁移或初始化术语。未成功不能声称已优化。
这条一次性维护优先于普通问答不写知识的通用提示；用户明确只读/禁止写入、计划模式和无人值守仍不执行。worktree 如有公共旧规则待迁移，保留并延后到原项目会话。`
}
