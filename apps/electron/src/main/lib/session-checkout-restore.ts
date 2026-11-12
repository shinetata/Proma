/**
 * 恢复被删除的会话检出 worktree
 *
 * 会话历史记录过 worktree 的路径、分支和基准提交。目录被删除后可以用
 * `git worktree prune` + `git worktree add` 重建：分支还在就检出同名分支，
 * 分支已删但有基准提交则按该提交重建分支。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 20_000
const GIT_MAX_BUFFER = 1024 * 1024

/** 可恢复的 worktree 记录：路径必须绝对，分支名必须能安全传给 git。 */
export interface RestorableWorktreeRecord {
  path: string
  branch: string
  baseCommit?: string
}

/** 恢复计划；reason 直接映射到用户可见错误。 */
export type WorktreeRestorePlan =
  | { ok: true; branchRecreated: boolean }
  | { ok: false; reason: 'invalid-record' | 'branch-unavailable' }

export interface RestoreWorktreeRequest extends RestorableWorktreeRecord {
  /** worktree 所属主仓库目录 */
  repoPath: string
}

export interface RestoreWorktreeResult {
  restored: true
  path: string
  branch: string
  branchRecreated: boolean
}

/**
 * 校验历史记录能否用于恢复。
 *
 * 分支名会被拼进 git 参数，因此按 git 的 ref 命名规则做白名单式拒绝：
 * 空值、超长、含 NUL、`..`、以 `-` 开头（会被当成选项）、首尾斜杠、连续斜杠、
 * 空白与控制字符一律拒绝。
 */
export function isRestorableWorktreeRecord(input: Partial<RestorableWorktreeRecord>): input is RestorableWorktreeRecord {
  if (typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0')) return false
  if (typeof input.branch !== 'string' || input.branch.length === 0 || input.branch.length > 255) return false
  if (input.branch.includes('\0') || input.branch.includes('..') || input.branch.startsWith('-')) return false
  if (input.branch.startsWith('/') || input.branch.endsWith('/') || input.branch.includes('//')) return false
  // git ref 不允许空白与这些元字符（`~ ^ : ? * [ \`）。
  if (/[\s~^:?*[\\]/.test(input.branch)) return false
  if (input.baseCommit !== undefined && !/^[0-9a-f]{7,64}$/i.test(input.baseCommit)) return false
  return true
}

/** 分支仍在时直接检出；分支已删但记录了基准提交时按它重建分支。 */
export function planWorktreeRestore(input: RestorableWorktreeRecord & { branchExists: boolean }): WorktreeRestorePlan {
  if (!isRestorableWorktreeRecord(input)) return { ok: false, reason: 'invalid-record' }
  if (input.branchExists) return { ok: true, branchRecreated: false }
  if (input.baseCommit) return { ok: true, branchRecreated: true }
  return { ok: false, reason: 'branch-unavailable' }
}

async function git(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      // 恢复流程不允许因为凭据或终端提示卡住主进程。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      ...(signal ? { signal } : {}),
    })
    return { ok: true, stdout: String(stdout), stderr: String(stderr) }
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读取 worktree 当前 HEAD，作为分支被删后重建的基准提交。
 *
 * 读取失败只意味着没有基准提交，不影响选择 worktree 本身，因此返回 undefined。
 */
export async function readWorktreeHeadCommit(worktreePath: string): Promise<string | undefined> {
  if (typeof worktreePath !== 'string' || !isAbsolute(worktreePath)) return undefined
  const result = await git(['rev-parse', 'HEAD'], worktreePath)
  if (!result.ok) return undefined
  const sha = result.stdout.trim()
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined
}

/**
 * 重建被删除的 worktree。
 *
 * 失败一律抛错，错误文案直接面向用户；调用方把这些文案放进 IPC 结果。
 */
export async function restoreWorktree(
  request: RestoreWorktreeRequest,
  options: { signal?: AbortSignal } = {},
): Promise<RestoreWorktreeResult> {
  const { path, branch, baseCommit, repoPath } = request
  if (typeof repoPath !== 'string' || !isAbsolute(repoPath)) {
    throw new Error('无法确定 worktree 所属仓库，不能恢复')
  }
  if (!isRestorableWorktreeRecord({ path, branch, baseCommit })) {
    throw new Error('worktree 记录无效，不能恢复')
  }
  if (existsSync(path)) {
    throw new Error('worktree 目录已存在，无需恢复')
  }
  if (!existsSync(repoPath)) {
    throw new Error('worktree 所属仓库目录已不存在')
  }

  const prune = await git(['worktree', 'prune'], repoPath, options.signal)
  if (!prune.ok) throw new Error(`清理 worktree 登记失败：${prune.stderr}`)

  const branchCheck = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoPath, options.signal)
  const plan = planWorktreeRestore({ path, branch, baseCommit, branchExists: branchCheck.ok })
  if (!plan.ok) {
    throw new Error(plan.reason === 'branch-unavailable'
      ? `分支 ${branch} 已删除且缺少基准提交，无法恢复`
      : 'worktree 记录无效，不能恢复')
  }

  const add = plan.branchRecreated
    ? await git(['worktree', 'add', '-b', branch, path, baseCommit!], repoPath, options.signal)
    : await git(['worktree', 'add', path, branch], repoPath, options.signal)
  if (!add.ok) throw new Error(`恢复 worktree 失败：${add.stderr}`)

  return { restored: true, path, branch, branchRecreated: plan.branchRecreated }
}