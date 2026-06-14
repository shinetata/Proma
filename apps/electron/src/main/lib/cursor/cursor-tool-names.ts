/**
 * Cursor ACP toolCall.kind → Proma 标准工具名映射
 *
 * ACP 协议用 kind 字段标识工具类型（如 `read`、`shell` 等），
 * 本模块将其映射为 Proma/Claude 风格的工具名（如 `Read`、`Bash`），
 * 供 canUseTool 权限决策与 UI 展示使用。
 */

/** ACP toolCall.kind → Proma 标准工具名 */
export const CURSOR_TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  shell: 'Bash',
  write: 'Write',
  edit: 'Edit',
  search_replace: 'Edit',
  multiedit: 'Edit',
  notebook_edit: 'NotebookEdit',
  notebook_read: 'NotebookRead',
  task: 'Task',
  todo_write: 'TodoWrite',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  ask_user_question: 'AskUserQuestion',
  exit_plan_mode: 'ExitPlanMode',
  enter_plan_mode: 'EnterPlanMode',
  switch_mode: 'SwitchMode',
  create_plan: 'CreatePlan',
  list_files: 'Glob',
  search_file: 'Glob',
  search_content: 'Grep',
  run_terminal_cmd: 'Bash',
  file_read: 'Read',
  file_write: 'Write',
  file_edit: 'Edit',
  codebase_search: 'Grep',
  lsp: 'Tool',
  other: 'Tool',
}

/**
 * 将 ACP toolCall kind 解析为 Proma 标准工具名。
 * 已知 kind → 查表返回；未知 kind → 自动 camelCase → Title Case 转换并 console.warn。
 */
export function resolveToolName(acpKind: string, title?: string): string {
  const known = CURSOR_TOOL_NAME_MAP[acpKind]
  if (known) return known

  // 启发式转换：camelCase/snake_case → Title Case
  const heuristic = title
    || acpKind
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase())

  console.warn(`[Cursor ACP] 未知工具 kind "${acpKind}"，启发式转换为 "${heuristic}"，建议补充分映射到 CURSOR_TOOL_NAME_MAP`)
  return heuristic
}
