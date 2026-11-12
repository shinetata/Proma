/**
 * 工作区内可预览的 Proma 托管子目录
 *
 * 项目记忆（memory/）、项目 Skill（skills/）与定时任务产物（automation/）由 Proma 管理，
 * 不在项目文件目录内，但属于本项目的会话可见内容；对齐商业版 0.22.28，
 * 预览授权把它们和项目根下的 AGENTS.md 一并视为显式授权位置。
 */

import { join } from 'node:path'

/** 工作区目录下允许预览的子目录名。 */
export const WORKSPACE_PREVIEW_SUBDIRECTORIES = ['memory', 'skills', 'automation'] as const

/** 返回某个工作区目录下允许预览的子目录绝对路径。 */
export function getWorkspacePreviewRoots(workspacePath: string): string[] {
  return WORKSPACE_PREVIEW_SUBDIRECTORIES.map((subdirectory) => join(workspacePath, subdirectory))
}
