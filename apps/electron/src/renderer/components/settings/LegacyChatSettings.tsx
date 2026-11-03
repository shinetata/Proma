/**
 * LegacyChatSettings - 历史 Chat 设置页
 *
 * Chat 模式已移除，本机遗留的对话记录与自定义工具不再产生新数据，但仍会保留。
 * 本页只做两件事：说明现状、把旧资料交给 Agent 处理（检索旧对话或整理为 Skills）。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Archive, Loader2, RotateCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { LegacyChatSummary } from '@proma/shared'
import { SettingsCard, SettingsSection } from './primitives'
import { Button } from '@/components/ui/button'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'
import { useCreateSession } from '@/hooks/useCreateSession'
import { formatMessageTime } from '@/lib/message-time'

const HANDOFF_PROMPT = `请帮我整理本机的历史 Chat 资料。

步骤：
1. 读取 ~/.proma/conversations.json 与 ~/.proma/conversations/ 下的 .jsonl 文件，了解旧对话的内容与主题；
2. 按主题归纳这些旧对话，指出其中仍然有用的结论、决策与待办；
3. 如果发现有价值的重复工作流，提议把它们整理成 Skills 或提醒我新建。

原始文件只读，不要修改或删除。`

export function LegacyChatSettings(): React.ReactElement {
  const [summary, setSummary] = React.useState<LegacyChatSummary | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [handingOff, setHandingOff] = React.useState(false)
  const setAgentPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const { createAgent } = useCreateSession()

  const refresh = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setSummary(await window.electronAPI.getLegacyChatSummary())
    } catch (error) {
      console.error('[历史 Chat] 读取存量失败:', error)
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleHandoff = React.useCallback(async (): Promise<void> => {
    setHandingOff(true)
    try {
      const sessionId = await createAgent({ draft: true })
      if (!sessionId) {
        toast.error('无法创建 Agent 会话')
        return
      }
      setAgentPendingPrompt({ sessionId, message: HANDOFF_PROMPT })
      toast.success('已把历史资料交给 Agent', { description: '确认后发送即可，原始文件保持不变。' })
    } catch (error) {
      console.error('[历史 Chat] 交给 Agent 失败:', error)
      toast.error('交给 Agent 失败，请重试')
    } finally {
      setHandingOff(false)
    }
  }, [createAgent, setAgentPendingPrompt])

  const conversationsDirLabel = summary?.conversationsDir ?? '~/.proma/conversations'

  return (
    <div className="space-y-6">
      <SettingsSection
        title="历史 Chat"
        description="此设备上的历史记录仍会保留。Chat 模式已移除，这些数据不再新增，只供查阅或交给 Agent 整理。"
      >
        <SettingsCard>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1 text-sm">
              {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>正在读取本机资料…</span>
                </div>
              ) : summary ? (
                <>
                  <p className="text-foreground">
                    {summary.conversationCount} 个历史对话
                    {summary.archivedCount > 0 ? `（其中 ${summary.archivedCount} 个已归档）` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {summary.lastUpdatedAt > 0
                      ? `最近更新：${formatMessageTime(summary.lastUpdatedAt)}`
                      : '没有找到历史对话'}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">存放目录：{conversationsDirLabel}</p>
                </>
              ) : (
                <p className="text-muted-foreground">暂时无法读取本机资料。</p>
              )}
            </div>
            <Button variant="ghost" size="icon" aria-label="刷新历史 Chat 资料" onClick={() => void refresh()} disabled={loading}>
              <RotateCw className={loading ? 'animate-spin' : undefined} />
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => void handleHandoff()} disabled={handingOff || loading}>
              {handingOff ? <Loader2 className="animate-spin" /> : <Sparkles />}
              让 Agent 整理历史资料
            </Button>
          </div>

          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <Archive className="mt-0.5 size-3.5 shrink-0" />
            <span>只会准备资料并填入提示词，由你确认后发送；原始对话文件不会被修改或删除。</span>
          </p>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
