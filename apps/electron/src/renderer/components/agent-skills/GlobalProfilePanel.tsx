/**
 * 「关于你」全局画像面板（对齐商业版 0.21.88 Ltn）。
 *
 * 画像跨项目共享，编辑走显式保存（带 revision 校验）；草稿保存在模块级 atom 中，
 * 切换记忆页 Tab 或离开记忆页再回来不会丢失未保存的修改。
 * 旧画像整合通过创建一个新的 Agent 会话完成，界面不直接合并。
 */

import * as React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { FolderOpen, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react'
import type { GlobalProfileSnapshot } from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { SettingsCard } from '@/components/settings/primitives'
import { LiveMarkdownEditor } from '@/components/markdown/LiveMarkdownEditor'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useOpenSession } from '@/hooks/useOpenSession'
import {
  agentPendingPromptAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'

const PROFILE_INTEGRATION_PROMPT = `请实际整合所有已登记项目中的旧用户画像，不要只说明操作方法。
先读取 Coach 的 knowledge-maintenance 指南，使用 MemoryInspect 检查全局画像、旧画像来源和未完成迁移。项目 AGENTS.md 首次维护完成不代表画像已经整合。
优先用 MemoryMigrateProfile 的 resumeId 恢复中断迁移；恢复因新编辑冲突时使用 replanId 保留当前内容、退役旧计划，然后重新读取版本再合并。再逐份读取并语义合并：跨项目稳定偏好进入唯一的全局 user_profile.md；项目专属偏好进入来源项目的 project-preferences.md，并更新对应 MEMORY.md，移除本次已迁移旧画像的索引，保留其他主题。保留来源与未解决冲突，不按文件时间覆盖，不编造事实，不手工删除源文件。
使用版本校验和可恢复归档。全部处理后再次用 MemoryInspect 核验没有剩余旧画像、未完成记录或 migrationIssues 异常来源，才报告完成；异常来源保持原样，继续处理正常来源，不为消除提醒绕过路径限制；遇到冲突或失败保留数据并说明。遵守当前权限模式，不修改无关项目内容。`

interface ProfileDraftState {
  base: GlobalProfileSnapshot | null
  latest: GlobalProfileSnapshot | null
  text: string
}

/** 画像草稿（商业版 Rtn）：base 为编辑基线，latest 为磁盘最新快照。 */
const globalProfileDraftAtom = atom<ProfileDraftState>({ base: null, latest: null, text: '' })
/** 已创建的画像整合会话（商业版 Itn），再次点击直接打开而不是重复创建。 */
const profileIntegrationSessionAtom = atom<{ id: string; title: string } | null>(null)

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : '暂无记录'
}

export function hasProfileIntegrationWork(profile: GlobalProfileSnapshot | null): boolean {
  if (!profile) return false
  return profile.legacyCount > 0 || profile.pendingCount > 0 || profile.migrationIssues.length > 0
}

interface GlobalProfilePanelProps {
  /** Dev 的画像 IPC 需要一个项目上下文来扫描旧画像来源。 */
  workspaceSlug: string
}

export function GlobalProfilePanel({ workspaceSlug }: GlobalProfilePanelProps): React.ReactElement {
  const [draft, setDraft] = useAtom(globalProfileDraftAtom)
  const [integrationSession, setIntegrationSession] = useAtom(profileIntegrationSessionAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const openSession = useOpenSession()
  const { createAgent } = useCreateSession()
  const [integrating, setIntegrating] = React.useState(false)
  const integratingRef = React.useRef(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const requestIdRef = React.useRef(0)
  const savingRef = React.useRef(false)

  const isDirty = draft.text !== (draft.base?.content ?? '')
  const hasConflict = Boolean(draft.base && draft.latest && draft.base.revision !== draft.latest.revision)
  const profile = draft.latest ?? draft.base

  const load = React.useCallback(async (): Promise<GlobalProfileSnapshot | undefined> => {
    if (savingRef.current) return undefined
    const requestId = ++requestIdRef.current
    try {
      const snapshot = await window.electronAPI.readGlobalProfile(workspaceSlug)
      if (requestId !== requestIdRef.current) return undefined
      // 有未保存草稿时只更新 latest，由冲突提示让用户决定是否载入最新内容。
      setDraft((previous) => (previous.text !== (previous.base?.content ?? '')
        ? { ...previous, latest: snapshot }
        : { base: snapshot, latest: snapshot, text: snapshot.content ?? '' }))
      setError(null)
      if (!hasProfileIntegrationWork(snapshot)) setIntegrationSession(null)
      return snapshot
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err instanceof Error ? err.message : '读取用户画像失败')
      return undefined
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [setDraft, setIntegrationSession, workspaceSlug])

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
    if (!draft.base || !isDirty || hasConflict || savingRef.current || !draft.text.trim() || profile?.pendingCount) return
    savingRef.current = true
    requestIdRef.current += 1
    setSaving(true)
    try {
      const snapshot = await window.electronAPI.writeGlobalProfile(workspaceSlug, draft.base.revision, draft.text)
      setDraft({ base: snapshot, latest: snapshot, text: snapshot.content ?? '' })
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
    if (integratingRef.current) return
    const existingSession = integrationSession ? sessions.find((session) => session.id === integrationSession.id) : undefined
    if (existingSession) {
      openSession('agent', existingSession.id, existingSession.title)
      return
    }
    if (isDirty || saving) {
      toast.info('请先保存当前画像修改，再整合画像。')
      return
    }
    const workspace = workspaces.find((item) => item.id === currentWorkspaceId)
    if (!workspace || (workspace.projectRootStatus && workspace.projectRootStatus !== 'available')) {
      toast.error('请先选择一个可用项目，再整合画像。')
      return
    }
    integratingRef.current = true
    setIntegrating(true)
    try {
      const snapshot = await load()
      if (!snapshot || !hasProfileIntegrationWork(snapshot)) return
      const sessionId = await createAgent()
      if (!sessionId) throw new Error('创建 Agent 会话失败')
      setIntegrationSession({ id: sessionId, title: '整合画像' })
      // Dev 的会话页会把待发送提示词填入输入框，由用户确认后发送。
      setPendingPrompt({ sessionId, message: PROFILE_INTEGRATION_PROMPT })
    } catch (err) {
      toast.error('画像整合启动失败', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      integratingRef.current = false
      setIntegrating(false)
    }
  }

  if (loading && !profile) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">读取用户画像中…</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto md:overflow-hidden">
      <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">用户画像</h2>
            <span className="rounded-md bg-foreground/[0.045] px-2.5 py-1 text-sm text-muted-foreground">全局共享</span>
          </div>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">记录你的长期偏好与协作习惯，所有项目共用。</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="outline" className="h-11 gap-2 rounded-lg px-5 text-[15px]" disabled={saving} onClick={() => void load()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button
            className="h-11 min-w-28 gap-2 rounded-lg px-5 text-[15px]"
            disabled={!draft.base || !isDirty || !draft.text.trim() || hasConflict || saving || Boolean(profile?.pendingCount)}
            onClick={() => void save()}
          >
            <Save className="size-4" />
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {Boolean(profile?.migrationIssues.length) && (
        <details className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <summary className="cursor-pointer">部分旧画像暂时无法整合，不影响查看当前全局画像。</summary>
          <ul className="mt-2 max-h-32 space-y-2 overflow-y-auto">
            {profile?.migrationIssues.map((issue) => (
              <li key={issue.path} className="break-all">{issue.path}：{issue.message}</li>
            ))}
          </ul>
        </details>
      )}

      {hasConflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <span>画像已被其他会话更新。你的修改已保留，请复制后与最新内容合并。</span>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">载入最新内容</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>放弃当前草稿？</AlertDialogTitle>
                <AlertDialogDescription>请先复制需要保留的修改。载入最新画像会替换当前未保存的内容。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>保留草稿</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setDraft((previous) => ({ base: previous.latest, latest: previous.latest, text: previous.latest?.content ?? '' }))
                    void load()
                  }}
                >
                  载入最新内容
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {profile && (
        <div className="grid shrink-0 flex-1 gap-5 md:min-h-0 md:grid-rows-[minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)]">
          <section aria-label="画像状态" className="min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-foreground/[0.02]">
            <h3 className="border-b border-border/60 px-5 py-4 text-base font-semibold">资料状态</h3>
            <dl className="grid divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0 md:grid-cols-1 md:divide-x-0 md:divide-y">
              <div className="px-5 py-4">
                <dt className="text-sm text-muted-foreground">最近更新</dt>
                <dd className="mt-2 text-[15px] font-medium tabular-nums">{formatTime(profile.modifiedAt)}</dd>
              </div>
              <div className="px-5 py-4">
                <dt className="text-sm text-muted-foreground">最近核验</dt>
                <dd className="mt-2 text-[15px] font-medium tabular-nums">{formatTime(profile.checkedAt)}</dd>
              </div>
            </dl>
            {hasProfileIntegrationWork(profile) && (
              <div className="border-t border-border/60 px-5 py-4">
                <Button
                  className="h-11 w-full gap-2 rounded-lg text-[15px]"
                  disabled={integrating || saving}
                  title={integrationSession ? '打开已有整合会话' : '由 Agent 合并旧画像并更新原项目记忆索引'}
                  onClick={() => void integrate()}
                >
                  {integrating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  整合画像
                </Button>
              </div>
            )}
            <p className="px-5 py-4 text-sm leading-7 text-muted-foreground">全局画像在所有项目中共享。项目专属偏好可在「当前项目」中补充。</p>
          </section>

          <SettingsCard divided={false} className="flex min-h-[320px] flex-1 flex-col overflow-hidden border border-border/60 md:min-h-0">
            <div className="flex items-center justify-between gap-4 border-b border-border/50 px-6 py-4">
              <div className="min-w-0">
                <div className="text-lg font-semibold">
                  画像内容
                  {isDirty && <span className="ml-3 text-sm font-normal text-muted-foreground">未保存</span>}
                </div>
                <div className="mt-1 truncate font-mono text-[13px] text-muted-foreground" title={profile.path}>
                  {profile.path}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0 rounded-lg"
                aria-label="在文件夹中显示用户画像"
                disabled={profile.content === null}
                onClick={() => void window.electronAPI.showItemInFolder(profile.path)}
              >
                <FolderOpen className="size-5" />
              </Button>
            </div>
            {!profile.content?.trim() && !isDirty && (
              <p className="px-5 pt-4 text-sm leading-6 text-muted-foreground">
                尚未建立画像。可以写下希望 Agent 记住的偏好，也可以在对话中逐步积累。
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <LiveMarkdownEditor
                value={draft.text}
                onChange={(value) => setDraft((previous) => ({ ...previous, text: value }))}
                onSave={() => void save()}
                readOnly={saving || integrating || Boolean(profile.pendingCount)}
                className="live-markdown-external-scroll memory-page-editor"
              />
            </div>
          </SettingsCard>
        </div>
      )}
    </div>
  )
}
