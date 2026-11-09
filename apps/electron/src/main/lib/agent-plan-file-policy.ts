/**
 * 计划文档路径策略
 *
 * 当前挂载状态：计划模式已下线，编排层不再调用本模块，调用点随 ExitPlanMode 审批
 * 拦截一同下线。保留能力以便日后恢复计划模式（只允许写入会话私有 plan/ 目录）。
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'

function isPathInside(root: string, candidate: string, allowRoot = false): boolean {
  const relativePath = relative(root, candidate)
  return (allowRoot && relativePath.length === 0)
    || (relativePath.length > 0
      && relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath))
}

/**
 * Plan 模式的 Markdown 写入必须明确指向当前会话的 plan/ 目录。
 *
 * 相对路径由底层工具按 Agent cwd 解析，不能可靠地映射到计划目录，因此一律拒绝。
 * 已存在文件及其父目录同时以 realpath 复核，并拒绝任何符号链接，避免写入逃逸到项目或用户文件。
 */
export function isSessionPlanMarkdownPath(filePath: string, planDirectory: string | undefined): boolean {
  if (!planDirectory || !isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.md') return false

  try {
    if (!existsSync(planDirectory) || lstatSync(planDirectory).isSymbolicLink()) return false
    const declaredPlanDirectory = resolve(planDirectory)
    const resolvedPlanDirectory = realpathSync(declaredPlanDirectory)
    const resolvedFilePath = resolve(filePath)
    if (!isPathInside(declaredPlanDirectory, resolvedFilePath)) return false

    if (existsSync(resolvedFilePath)) {
      const fileStat = lstatSync(resolvedFilePath)
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return false
      return isPathInside(resolvedPlanDirectory, realpathSync(resolvedFilePath))
    }

    // 新文件只能创建在既有、非符号链接的 plan/ 子目录中；不允许隐式穿过符号链接父目录。
    const parentDirectory = dirname(resolvedFilePath)
    if (!existsSync(parentDirectory) || lstatSync(parentDirectory).isSymbolicLink()) return false
    return isPathInside(resolvedPlanDirectory, realpathSync(parentDirectory), true)
  } catch {
    return false
  }
}
