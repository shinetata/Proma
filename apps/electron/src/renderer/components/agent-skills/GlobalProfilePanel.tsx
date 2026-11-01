/**
 * 「关于你」全局画像面板。
 *
 * 与商业版一致：画像跨项目共享，编辑走「关于你」的显式保存（带 revision 校验），
 * 旧画像整合通过创建一个新的 Agent 会话完成，界面不直接合并。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCw, Save, Sparkles } from 'lucide-react'
import type { GlobalProfileSnapshot } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingsCard } from '@/components/settings/primitives'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useSetAtom } from 'jotai'
import { agentPendingPromptAtom } from '@/atoms/agent-atoms'

const PROFILE_INTEGRATION_PROMPT = `请实际整合所有已登记项目中的旧用户画像，不要只说明操作方法。
先读取 Coach 的 knowledge-maintenance 指南，使用 MemoryInspect 检查全局画像、旧画像来源和未完成迁移。项目 AGENTS.md 首次维护完成不代表画像已经整合。
优先用 MemoryMigrateProfile 的 resumeId 恢复中断迁移；恢复因新编辑冲突时使用 replanId 保留当前内容、退役旧计划，然后重新读取版本再合并。再逐份读取并语义合并：跨项目稳定偏好进入唯一的全局 user_profile.md；项目专属偏好进入来源项目的 project-preferences.md，并更新对应 MEMORY.md，移除本次已迁移旧画像的索引，保留其他主题。保留来源与未解决冲突，不按文件时间覆盖，不编造事实，不手工删除源文件。
使用版本校验和可恢复归档。全部处理后再次用 MemoryInspect 核验没有剩余旧画像、未完成记录或 migrationIssues 异常来源，才报告完成；异常来源保持原样，继续处理正常来源，不为消除提醒绕过路径限制；遇到冲突或失败保留数据并说明。遵守当前权限模式，不修改无关项目内容。`

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : '暂无记录'
}

export function hasProfileIntegrationWork(profile: GlobalProfileSnapshot | null): boolean {
  if (!profile) return false
  return profile.legacyCount > 0 || profile.pendingCount > 0 || profile.migrationIssues.length > 0
}

interface GlobalProfilePanelProps {
  workspaceSlug: string
}

export function GlobalProfilePanel({ workspaceSlug }: GlobalProfilePanelProps): React.ReactElement {
  const { createAgent } = useCreateSession()
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const [base, setBase] = React.useState<GlobalProfileSnapshot | null>(null)
  const [latest, setLatest] = React.useState<GlobalProfileSnapshot | null>(null)
  const [text, setText] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [integrating, setIntegrating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const requestIdRef = React.useRef(0)
  const savingRef = React.useRef(false)

  const isDirty = text !== (base?.content ?? '')
  const hasConflict = Boolean(base && latest && base.revision !== latest.revision)
  const profile = latest ?? base

  const load = React.useCallback(async (): Promise<GlobalProfileSnapshot | undefined> => {
    if (savingRef.current) return undefined
    const requestId = ++requestIdRef.current
    try {
      const snapshot = await window.electronAPI.readGlobalProfile(workspaceSlug)
      if (requestId !== requestIdRef.current) return undefined
      setBase((previous) => (previous && previous.content !== snapshot.content ? previous : snapshot))
      setLatest(snapshot)
      setText((previous) => (previous !== (base?.content ?? '') ? previous : snapshot.content ?? ''))
      setError(null)
      return snapshot
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err instanceof Error ? err.message : '读取用户画像失败')
      return undefined
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
    // base 只用于判断草稿是否被改过，不参与重读触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug])

  React.useEffect(() => {
    void load()
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    const unsubscribe = window.electronAPI.onAgentStreamComplete(onFocus)
    return () => {
      requestIdRef.current += 1
      window.removeEventListener('focus', onFocus)
      unsubscribe()
    }
  }, [load])

  const save = async (): Promise<void> => {
    if (!base || !isDirty || hasConflict || savingRef.current || !text.trim() || profile?.pendingCount) return
    savingRef.current = true
    setSaving(true)
    try {
      const snapshot = await window.electronAPI.writeGlobalProfile(workspaceSlug, base.revision, text)
      setBase(snapshot)
      setLatest(snapshot)
      setText(snapshot.content ?? '')
      setError(null)
      toast.success('已保存，所有项目的后续 Agent 请求将使用这份画像')
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败，请重试'
      setError(message)
      toast.error(message)
    } finally {
      savingRef.current = false
      setSaving(false)
      void load()
    }
  }

  const integrate = async (): Promise<void> => {
    if (integrating) return
    if (isDirty) {
      toast.info('请先保存当前画像修改，再整合画像。')
      return
    }
    setIntegrating(true)
    try {
      const snapshot = await load()
      if (!snapshot || !hasProfileIntegrationWork(snapshot)) return
      const sessionId = await createAgent()
      if (!sessionId) {
        toast.error('创建 Agent 会话失败')
        return
      }
      setPendingPrompt({ sessionId, message: PROFILE_INTEGRATION_PROMPT })
      toast.success('已创建画像整合会话')
    } catch (err) {
      toast.error('画像整合启动失败', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setIntegrating(false)
    }
  }

  if (loading && !profile) {
    return <div className="py-20 text-center text-sm text-muted-foreground">读取用户画像中…</div>
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">用户画像</h2>
            <span className="rounded-md bg-foreground/[0.045] px-2 py-0.5 text-xs text-muted-foreground">全局共享</span>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted-foreground">记录你的长期偏好与协作习惯，所有项目共用。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" className="gap-2" disabled={saving} onClick={() => void load()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button
            className="gap-2"
            disabled={!base || !isDirty || !text.trim() || hasConflict || saving || Boolean(profile?.pendingCount)}
            onClick={() => void save()}
          >
            <Save className="size-4" />
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {profile && profile.migrationIssues.length > 0 && (
        <details className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <summary className="cursor-pointer">部分旧画像暂时无法整合，不影响查看当前全局画像。</summary>
          <ul className="mt-2 max-h-32 space-y-2 overflow-y-auto">
            {profile.migrationIssues.map((issue) => (
              <li key={issue.path} className="break-all">{issue.path}：{issue.message}</li>
            ))}
          </ul>
        </details>
      )}

      {hasConflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <span>画像已被其他会话更新。你的修改已保留，请复制后与最新内容合并。</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setBase(latest)
              setText(latest?.content ?? '')
              setError(null)
            }}
          >
            载入最新内容
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <SettingsCard divided={false}>
          <div className="flex flex-col gap-4 p-4">
            <div className="text-sm font-semibold text-foreground">资料状态</div>
            <div>
              <div className="text-xs text-muted-foreground">最近更新</div>
              <div className="mt-1 text-sm font-medium tabular-nums">{formatTime(profile?.modifiedAt)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">最近核验</div>
              <div className="mt-1 text-sm font-medium tabular-nums">{formatTime(profile?.checkedAt)}</div>
            </div>
            {hasProfileIntegrationWork(profile) && (
              <Button className="w-full gap-2" disabled={integrating} onClick={() => void integrate()}>
                {integrating ? <RefreshCw className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                整合画像
              </Button>
            )}
            <p className="text-xs leading-6 text-muted-foreground">全局画像在所有项目中共享。项目专属偏好可在「当前项目」中补充。</p>
          </div>
        </SettingsCard>

        <SettingsCard divided={false} className="min-h-[320px] overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                画像内容
                {isDirty && <span className="ml-2 text-xs font-normal text-muted-foreground">未保存</span>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={profile?.path}>
                {profile?.path}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={!profile?.content}
              onClick={() => profile && void window.electronAPI.showItemInFolder(profile.path)}
            >
              在文件夹中显示
            </Button>
          </div>
          {!profile?.content?.trim() && !isDirty && (
            <p className="px-4 pt-3 text-xs leading-6 text-muted-foreground">
              尚未建立画像。可以写下希望 Agent 记住的偏好，也可以在对话中逐步积累。
            </p>
          )}
          <div className="min-h-[260px] overflow-y-auto">
            <LiveMarkdownEditor
              value={text}
              onChange={setText}
              onSave={() => void save()}
              readOnly={saving || Boolean(profile?.pendingCount)}
              className="live-markdown-external-scroll"
            />
          </div>
        </SettingsCard>
      </div>

      {profile && profile.pendingCount > 0 && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-4 shrink-0" />
          有 {profile.pendingCount} 项画像整合未完成，完成后才能继续编辑画像。
        </div>
      )}
    </div>
  )
}