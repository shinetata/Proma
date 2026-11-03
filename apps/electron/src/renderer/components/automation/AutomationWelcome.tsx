/**
 * AutomationWelcome — 定时任务视图无选中会话时的主区欢迎页（对齐商业版 0.21.88 eJt / CT，产物 96352-96357 行）
 */

import * as React from 'react'
import { ArrowLeft, Bell, Clock, MessageSquare, Repeat2, type LucideIcon } from 'lucide-react'
import { CreateAutomationWithAgentButton } from './CreateAutomationWithAgentButton'

export function AutomationWelcome(): React.ReactElement {
  return (
    <div className="flex flex-1 min-h-0 overflow-y-auto titlebar-no-drag">
      <section className="m-auto w-full max-w-xl px-8 py-12" aria-labelledby="automation-welcome-title">
        <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-primary/[0.08] text-primary">
          <Clock size={24} aria-hidden="true" />
        </div>
        <h1 id="automation-welcome-title" className="text-2xl font-semibold tracking-tight text-balance">
          把重复的工作交给定时任务
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground text-pretty">
          按你设定的时间，让 Agent 自动执行工作，并将过程和结果保存在会话里。执行时需要 Proma 保持运行，且模型与所需工具可用。
        </p>
        <div className="mt-8 space-y-6">
          <WelcomeFeature icon={MessageSquare} title="用对话创建，不必手动配置">
            告诉 Agent 要做什么、什么时候做。例如：“每个工作日上午 9 点检查项目进展，连续运行 5 次。”Agent 会帮你创建定时任务。
          </WelcomeFeature>
          <WelcomeFeature icon={Clock} title="按间隔、日期或指定次数运行">
            支持固定间隔、每天、每周、每月，也可以指定时间只运行一次，或设置最多运行几次。
          </WelcomeFeature>
          <WelcomeFeature icon={Bell} title="将执行结果通知到飞书">
            支持在任务结束后，将结果推送到已绑定的飞书聊天，不必一直守在 Proma 前查看。
          </WelcomeFeature>
          <WelcomeFeature icon={Repeat2} title="在结果会话里，继续迭代任务">
            任务结束不是终点。直接在它的会话里要求 Agent 调整后续任务，例如：“以后只报告异常，改成每两小时检查一次。”
          </WelcomeFeature>
        </div>
        <CreateAutomationWithAgentButton className="mt-8 min-h-10 active:scale-[0.96]" label="与 Agent 创建定时任务" />
        <p className="mt-8 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
          <ArrowLeft size={14} className="shrink-0" aria-hidden="true" />
          左侧任务列表已展开，选择运行会话即可查看结果。
        </p>
      </section>
    </div>
  )
}

function WelcomeFeature({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex gap-3">
      <Icon size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground text-pretty">{children}</p>
      </div>
    </div>
  )
}
