/**
 * BuiltinMcpDetailSheet — Proma 内置 MCP 的只读详情抽屉。
 *
 * 对应商业版 Ven / Den / SC：内置 MCP 由运行时注入、不写入工作区 mcp.json，
 * 因此只展示名称、分类、注入开关、可用状态、配置来源和工具清单，不提供编辑入口。
 */

import * as React from 'react'
import { ArrowLeft, CheckCircle2, Plug, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { BuiltinMcpCategory, BuiltinMcpServerSummary } from '@proma/shared'
import { PromaCloudConfigPanel } from './PromaCloudConfigPanel'

const CATEGORY_LABELS: Record<BuiltinMcpCategory, string> = {
  system: '系统',
  automation: '自动化',
  collaboration: '协作',
  memory: '记忆',
  media: '媒体',
  browser: '浏览器',
}

function getBuiltinMcpSource(server: BuiltinMcpServerSummary): { source: string; description: string } {
  if (server.id === 'proma-cloud') {
    return {
      source: '本机 API Key',
      description: '联网检索使用你填写的 Proma Cloud API Key，直接在下方本面板配置；Key 只保存在本机。',
    }
  }
  return { source: 'Proma 运行时', description: '该内置能力由 Proma 运行时托管。' }
}

interface BuiltinMcpDetailSheetProps {
  open: boolean
  server: BuiltinMcpServerSummary | null
  onOpenChange: (open: boolean) => void
}

export function BuiltinMcpDetailSheet({ open, server, onOpenChange }: BuiltinMcpDetailSheetProps): React.ReactElement {
  const source = server ? getBuiltinMcpSource(server) : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent hideClose side="right" className="w-[560px] sm:max-w-[560px] p-0 flex flex-col gap-0">
        <SheetTitle className="sr-only">{server ? `MCP 详情 · ${server.displayName}` : 'MCP 详情'}</SheetTitle>
        <div className="flex h-full flex-col min-h-0">
          <div className="shrink-0 border-b border-border/60 px-5 pb-4 pt-5">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={() => onOpenChange(false)}>
                <ArrowLeft size={18} />
              </Button>
              <h3 className="text-lg font-medium text-foreground">MCP 详情</h3>
            </div>
            {server && (
              <div className="mt-4 flex items-start gap-3">
                <div className="rounded-xl bg-blue-500/[0.12] p-2 text-blue-500 shadow-sm shrink-0">
                  <Plug size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-foreground">{server.displayName}</h3>
                    <span className="shrink-0 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                      Proma 内置
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{server.name}</div>
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
            {server && source && (
              <div className="flex flex-col gap-6">
                <SheetDescription>{server.description}</SheetDescription>
                <div className="grid gap-3 sm:grid-cols-2">
                  <InfoTile label="MCP 名称" value={server.name} />
                  <InfoTile label="分类" value={CATEGORY_LABELS[server.category]} />
                  <InfoTile label="注入开关" value={server.enabled ? '允许注入' : '已手动关闭'} tone={server.enabled ? 'success' : 'muted'} />
                  <InfoTile
                    label="可用状态"
                    value={server.available ? '当前可用' : server.availabilityReason ?? '不可用'}
                    tone={server.available ? 'success' : 'muted'}
                  />
                  <InfoTile label="配置来源" value={source.source} />
                </div>
                {server.id === 'proma-cloud' ? (
                  <section className="flex flex-col gap-3">
                    <div className="text-sm font-medium text-foreground">配置</div>
                    <PromaCloudConfigPanel />
                  </section>
                ) : (
                  <section className="rounded-lg bg-muted/45 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">如何配置</div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{source.description}</p>
                      </div>
                    </div>
                  </section>
                )}
                <section className="flex flex-col gap-3">
                  <div className="text-sm font-medium text-foreground">工具</div>
                  <div className="flex flex-col gap-2">
                    {server.tools.map((tool) => (
                      <div key={tool.name} className="rounded-lg bg-muted/45 p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{tool.name}</span>
                          {tool.readOnly && (
                            <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">只读</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tool.description}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function InfoTile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' | 'muted' }): React.ReactElement {
  return (
    <div className="rounded-lg bg-muted/45 p-3">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 flex items-center gap-1.5 text-sm font-medium',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {tone === 'success' && <CheckCircle2 size={14} />}
        {tone === 'muted' && <XCircle size={14} />}
        <span>{value}</span>
      </div>
    </div>
  )
}
