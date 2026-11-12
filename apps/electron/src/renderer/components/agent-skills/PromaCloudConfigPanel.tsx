/**
 * PromaCloudConfigPanel — Proma Cloud 联网检索配置面板
 *
 * 开源版没有云端登录，WebSearch / WebFetch 所需的 API Key 由用户在此填写。
 * 面板自己读取最新配置，不依赖能力中心抽屉打开时的 server 快照；
 * 所有写入都经主进程归一化与加密，明文 Key 不在组件状态中长期保留。
 */

import * as React from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { PromaCloudConfigSummary } from '@proma/shared'

const BASE_URL_PLACEHOLDER = 'https://api.proma.cool'

interface TestResult {
  ok: boolean
  message: string
}

/** 去掉 IPC 包装前缀，只保留主进程返回的正文，便于直接展示。 */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
}

export function PromaCloudConfigPanel(): React.ReactElement {
  const [config, setConfig] = React.useState<PromaCloudConfigSummary | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [keyDraft, setKeyDraft] = React.useState('')
  const [editingKey, setEditingKey] = React.useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = React.useState('')
  const [savingKey, setSavingKey] = React.useState(false)
  const [savingBaseUrl, setSavingBaseUrl] = React.useState(false)
  const [savingToggle, setSavingToggle] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<TestResult | null>(null)
  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false)

  const applyConfig = React.useCallback((next: PromaCloudConfigSummary) => {
    setConfig(next)
    setBaseUrlDraft(next.baseUrl)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.getPromaCloudConfig()
      .then((next) => {
        if (cancelled) return
        applyConfig(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        toast.error(`读取 Proma Cloud 配置失败：${errorText(error)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [applyConfig])

  const handleSaveKey = async (): Promise<void> => {
    const apiKey = keyDraft.trim()
    if (!apiKey) {
      toast.error('请先填写 API Key')
      return
    }
    setSavingKey(true)
    try {
      const next = await window.electronAPI.updatePromaCloudConfig({ apiKey })
      applyConfig(next)
      // 保存后立即清空，避免明文长期留在组件状态里。
      setKeyDraft('')
      setEditingKey(false)
      setTestResult(null)
      toast.success('API Key 已保存')
    } catch (error) {
      toast.error(`保存 API Key 失败：${errorText(error)}`)
    } finally {
      setSavingKey(false)
    }
  }

  const handleClearKey = async (): Promise<void> => {
    try {
      const next = await window.electronAPI.updatePromaCloudConfig({ apiKey: null })
      applyConfig(next)
      setKeyDraft('')
      setEditingKey(false)
      setTestResult(null)
      toast.success('已清除 API Key')
    } catch (error) {
      toast.error(`清除 API Key 失败：${errorText(error)}`)
    } finally {
      setConfirmClearOpen(false)
    }
  }

  const handleSaveBaseUrl = async (): Promise<void> => {
    setSavingBaseUrl(true)
    try {
      const next = await window.electronAPI.updatePromaCloudConfig({ baseUrl: baseUrlDraft })
      applyConfig(next)
      setTestResult(null)
      toast.success('服务地址已保存')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setSavingBaseUrl(false)
    }
  }

  const handleRestoreDefaultBaseUrl = async (): Promise<void> => {
    setSavingBaseUrl(true)
    try {
      const next = await window.electronAPI.updatePromaCloudConfig({ baseUrl: '' })
      applyConfig(next)
      setTestResult(null)
      toast.success('已恢复默认服务地址')
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setSavingBaseUrl(false)
    }
  }

  const handleToggleWebResearch = async (enabled: boolean): Promise<void> => {
    setSavingToggle(true)
    try {
      const next = await window.electronAPI.updatePromaCloudConfig({ webResearchEnabled: enabled })
      applyConfig(next)
    } catch (error) {
      toast.error(`更新联网检索开关失败：${errorText(error)}`)
    } finally {
      setSavingToggle(false)
    }
  }

  const handleTestConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      // 有未保存的 Key 或地址时先测这两项，方便「先测试再保存」。
      const input: { apiKey?: string; baseUrl?: string } = {}
      const draftKey = keyDraft.trim()
      if (draftKey) input.apiKey = draftKey
      const draftBaseUrl = baseUrlDraft.trim()
      if (draftBaseUrl && draftBaseUrl !== config?.baseUrl) input.baseUrl = draftBaseUrl
      const result = await window.electronAPI.testPromaCloudConnection(
        Object.keys(input).length > 0 ? input : undefined,
      )
      setTestResult(result)
    } catch (error) {
      toast.error(`测试连接失败：${errorText(error)}`)
    } finally {
      setTesting(false)
    }
  }

  const configured = config?.configured ?? false

  return (
    <div className="flex flex-col gap-5">
      {/* API Key */}
      <section className="rounded-lg bg-muted/45 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">API Key</div>
            {configured && !editingKey ? (
              <div className="mt-1 text-xs text-muted-foreground">已配置 · {config?.keyHint}</div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">
                {configured ? '填写新的 Key 覆盖当前配置。' : '填写你的 Proma Cloud API Key 后即可使用联网检索。'}
              </div>
            )}
          </div>
          {configured && !editingKey && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" type="button" onClick={() => setEditingKey(true)}>
                更换
              </Button>
              <Button variant="ghost" size="sm" type="button" onClick={() => setConfirmClearOpen(true)}>
                清除
              </Button>
            </div>
          )}
        </div>

        {(!configured || editingKey) && (
          <div className="mt-3 flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴 Proma Cloud API Key"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              disabled={savingKey}
            />
            <Button size="sm" type="button" onClick={() => void handleSaveKey()} disabled={savingKey}>
              {savingKey ? '保存中…' : '保存'}
            </Button>
            {editingKey && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => { setEditingKey(false); setKeyDraft('') }}
                disabled={savingKey}
              >
                取消
              </Button>
            )}
          </div>
        )}
      </section>

      {/* 服务地址 */}
      <section className="rounded-lg bg-muted/45 p-3">
        <div className="text-sm font-medium text-foreground">服务地址</div>
        <div className="mt-1 text-xs text-muted-foreground">仅需在自建或代理网关时修改。</div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            placeholder={BASE_URL_PLACEHOLDER}
            value={baseUrlDraft}
            onChange={(event) => setBaseUrlDraft(event.target.value)}
            disabled={savingBaseUrl || loading}
          />
          <Button size="sm" type="button" onClick={() => void handleSaveBaseUrl()} disabled={savingBaseUrl || loading}>
            保存
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => void handleRestoreDefaultBaseUrl()}
            disabled={savingBaseUrl || loading}
          >
            恢复默认
          </Button>
        </div>
      </section>

      {/* 联网检索开关 */}
      <section className="flex items-center justify-between gap-3 rounded-lg bg-muted/45 p-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">允许 Agent 使用 WebSearch / WebFetch</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {configured ? '关闭后 Agent 只能使用受管浏览器检索公开网页。' : '需要先配置 API Key。'}
          </div>
        </div>
        <Switch
          checked={configured && (config?.webResearchEnabled ?? false)}
          onCheckedChange={(checked) => void handleToggleWebResearch(checked)}
          disabled={!configured || savingToggle || loading}
        />
      </section>

      {/* 测试连接 */}
      <section className="rounded-lg bg-muted/45 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">测试连接</div>
            <div className="mt-1 text-xs text-muted-foreground">只验证 Key 与服务地址，不扣积分。</div>
          </div>
          <Button variant="outline" size="sm" type="button" onClick={() => void handleTestConnection()} disabled={testing || loading}>
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {testing ? '测试中…' : '测试连接'}
          </Button>
        </div>
        {testResult && (
          <div
            className={
              testResult.ok
                ? 'mt-3 flex items-start gap-1.5 text-xs text-emerald-600 dark:text-emerald-400'
                : 'mt-3 flex items-start gap-1.5 text-xs text-destructive'
            }
          >
            {testResult.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <XCircle className="mt-0.5 size-3.5 shrink-0" />}
            <span>{testResult.message}</span>
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Key 经系统钥匙串加密后保存在本机，只在主进程发起请求时解密，不会出现在会话记录或工具结果里。搜索与抓取按成功请求扣 Proma Cloud 积分，空结果、失败和测试连接不扣费。保存后从下一条消息开始生效。
      </p>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="清除 Proma Cloud API Key？"
        description="清除后，Agent 从下一条消息开始不再有 WebSearch / WebFetch，需要重新填写 Key 才能恢复。"
        confirmLabel="清除"
        onConfirm={() => void handleClearKey()}
      />
    </div>
  )
}
