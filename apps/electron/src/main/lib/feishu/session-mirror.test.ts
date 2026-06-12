import { describe, expect, test } from 'bun:test'
import type { FeishuBotConfig } from '@proma/shared'
import {
  buildSessionMirrorGroupName,
  formatDesktopMirrorUserMessage,
  normalizeFeishuSessionMirrorSettings,
  resolveSessionMirrorBot,
  shouldMirrorDesktopUserMessage,
  stripPromaInjectedBlocks,
} from './session-mirror'

const enabledBot: FeishuBotConfig = {
  id: 'bot-enabled',
  name: '研发助手',
  enabled: true,
  appId: 'cli_enabled',
  appSecret: 'encrypted',
}

const disabledBot: FeishuBotConfig = {
  id: 'bot-disabled',
  name: '归档助手',
  enabled: false,
  appId: 'cli_disabled',
  appSecret: 'encrypted',
}

describe('飞书 Session 镜像设置', () => {
  test('Given 未配置镜像 When 读取设置 Then 默认关闭', () => {
    expect(normalizeFeishuSessionMirrorSettings(undefined)).toEqual({ mode: 'off' })
  })

  test('Given 旧版通知配置 When 读取设置 Then 归一化为关闭', () => {
    expect(normalizeFeishuSessionMirrorSettings({
      mode: 'completion',
      botId: enabledBot.id,
    } as unknown as Parameters<typeof normalizeFeishuSessionMirrorSettings>[0])).toEqual({ mode: 'off' })
  })

  test('Given 多个 Bot When 实时同步指定一个 Bot Then 只选择该 Bot', () => {
    const bot = resolveSessionMirrorBot(
      { mode: 'stream', botId: enabledBot.id },
      [disabledBot, enabledBot],
    )

    expect(bot?.id).toBe(enabledBot.id)
  })

  test('Given 指定 Bot 未启用 When 解析同步 Bot Then 不创建镜像', () => {
    const bot = resolveSessionMirrorBot(
      { mode: 'stream', botId: disabledBot.id },
      [disabledBot, enabledBot],
    )

    expect(bot).toBeNull()
  })

  test('Given 新 Agent 会话 When 构造群名 Then 使用短 ID 避免空泛标题', () => {
    expect(buildSessionMirrorGroupName({
      id: '1234567890abcdef',
      title: '新 Agent 会话',
    })).toBe('Proma - 新会话 12345678')
  })
})

describe('桌面端消息镜像', () => {
  test('Given 含 attached_files When 格式化 Then 剥离 XML 并保留正文', () => {
    const raw = '<attached_files>\n- screenshot.png: /tmp/a.png\n</attached_files>\n\n请分析这张图'
    expect(stripPromaInjectedBlocks(raw)).toBe('请分析这张图')
    expect(formatDesktopMirrorUserMessage(raw)).toBe(
      '📱 Proma 桌面\n请分析这张图\n📎 附带 1 个文件（请在 Proma 桌面查看）',
    )
  })

  test('Given 仅附件无正文 When 格式化 Then 回退附件标签', () => {
    const raw = '<attached_files>\n- report.pdf: /tmp/report.pdf\n</attached_files>\n\n'
    expect(formatDesktopMirrorUserMessage(raw)).toBe(
      '📱 Proma 桌面\n[附件] report\n📎 附带 1 个文件（请在 Proma 桌面查看）',
    )
  })

  test('Given stream 关闭 When 判断是否镜像 Then 返回 false', () => {
    expect(shouldMirrorDesktopUserMessage(
      { sessionId: 's1', userMessage: 'hello', channelId: 'c1' },
      { mode: 'off' },
    )).toBe(false)
  })

  test('Given 定时任务 When 判断是否镜像 Then 返回 false', () => {
    expect(shouldMirrorDesktopUserMessage(
      {
        sessionId: 's1',
        userMessage: 'run task',
        channelId: 'c1',
        triggeredBy: 'automation',
      },
      { mode: 'stream', botId: enabledBot.id },
    )).toBe(false)
  })

  test('Given 计划自动续跑 When 判断是否镜像 Then 返回 false', () => {
    expect(shouldMirrorDesktopUserMessage(
      {
        sessionId: 's1',
        userMessage: '请执行该计划\n\n计划文件：.context/plan/a.md',
        channelId: 'c1',
      },
      { mode: 'stream', botId: enabledBot.id },
    )).toBe(false)
  })

  test('Given 普通桌面消息 When 判断是否镜像 Then 返回 true', () => {
    expect(shouldMirrorDesktopUserMessage(
      { sessionId: 's1', userMessage: '你好', channelId: 'c1' },
      { mode: 'stream', botId: enabledBot.id },
    )).toBe(true)
  })
})
