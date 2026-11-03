/**
 * CreateAutomationWithAgentButton — 「与 Agent 一起创建」（对齐商业版 0.21.88 g9e，产物 96337 行）
 *
 * 新建一个草稿 Agent 会话并打开，输入框预填「帮我创建一个定时任务：」，由 Agent 生成任务配置。
 * beforeCreate 返回 false 时取消（表单中用于先保存当前草稿）。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Button } from '@/components/ui/button'
import { useCreateSession } from '@/hooks/useCreateSession'
import { agentSessionDraftsAtom, agentSessionDraftSyncVersionsAtom } from '@/atoms/agent-atoms'

const CREATE_AUTOMATION_PROMPT = '帮我创建一个定时任务：'

interface CreateAutomationWithAgentButtonProps {
  className?: string
  label?: string
  beforeCreate?: () => Promise<boolean>
}

export function CreateAutomationWithAgentButton({
  className,
  label = '与 Agent 一起创建',
  beforeCreate,
}: CreateAutomationWithAgentButtonProps): React.ReactElement {
  const { createAgent } = useCreateSession()
  const setDrafts = useSetAtom(agentSessionDraftsAtom)
  const setDraftSyncVersions = useSetAtom(agentSessionDraftSyncVersionsAtom)
  const [pending, setPending] = React.useState(false)
  const pendingRef = React.useRef(false)

  const handleClick = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      if (beforeCreate && !(await beforeCreate())) return
      const sessionId = await createAgent({ draft: true })
      if (!sessionId) return
      setDrafts((previous) => new Map(previous).set(sessionId, CREATE_AUTOMATION_PROMPT))
      setDraftSyncVersions((previous) => {
        const next = new Map(previous)
        next.set(sessionId, (next.get(sessionId) ?? 0) + 1)
        return next
      })
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <Button type="button" className={className} onClick={() => void handleClick()} disabled={pending}>
      {pending ? '正在打开会话…' : label}
    </Button>
  )
}
