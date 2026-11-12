/**
 * Proma Cloud 配置存储
 *
 * 开源版没有云端登录，联网检索所需的 API Key 由用户在能力中心手动填写。
 * 本模块负责：
 * - 读写 ~/.proma/proma-cloud.json（Dev 共用目录时为 proma-cloud.dev.json）；
 * - 用 Electron safeStorage 加密 API Key，磁盘上只保存密文；
 * - 向界面提供不含任何 Key 的摘要，以及主进程内部使用的解密凭据。
 *
 * Key 绝不写入日志、错误信息、工具结果或 IPC 返回值。日志只输出「已配置/未配置」。
 */

import { existsSync, readFileSync } from 'node:fs'
import { BrowserWindow, safeStorage } from 'electron'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type {
  PromaCloudConfigSummary,
  PromaCloudConfigUpdateInput,
} from '@proma/shared'
import { getPromaCloudConfigPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'

/** 默认服务地址；用户可在能力中心改写。 */
export const DEFAULT_PROMA_CLOUD_BASE_URL = 'https://api.proma.cool'

/** 磁盘格式版本，后续结构变更时据此迁移。 */
const CONFIG_VERSION = 1

interface PromaCloudConfigFile {
  version: number
  /** safeStorage 加密后的 base64 密文；空串表示未配置 */
  apiKey: string
  baseUrl: string
  webResearchEnabled: boolean
  updatedAt: number
}

const EMPTY_CONFIG: PromaCloudConfigFile = {
  version: CONFIG_VERSION,
  apiKey: '',
  baseUrl: DEFAULT_PROMA_CLOUD_BASE_URL,
  webResearchEnabled: true,
  updatedAt: 0,
}

// ===== 加解密 =====

/** 加密明文 Key；safeStorage 不可用时降级为明文存储（与飞书配置一致）。 */
function encryptSecret(plainSecret: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[Proma Cloud] safeStorage 加密不可用，API Key 将以明文存储')
    return plainSecret
  }
  return safeStorage.encryptString(plainSecret).toString('base64')
}

/**
 * 解密磁盘上的 Key。
 *
 * 失败时不抛出：返回空串，由调用方按「未配置」处理，避免把密文或异常细节带进工具结果。
 */
function decryptSecret(encryptedSecret: string): string {
  if (!encryptedSecret) return ''
  if (!safeStorage.isEncryptionAvailable()) return encryptedSecret
  try {
    return safeStorage.decryptString(Buffer.from(encryptedSecret, 'base64'))
  } catch (error) {
    console.error('[Proma Cloud] 解密 API Key 失败:', error instanceof Error ? error.message : '未知错误')
    return ''
  }
}

// ===== 地址归一化 =====

/** 本机回环主机允许 http，其余必须 https。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * 归一化服务地址。
 *
 * - 空值回到默认地址；
 * - 去掉末尾的 `/` 与 `/api/v1`（幂等）；
 * - 必须能被 `new URL` 解析，协议只允许 https，或 http 且主机为 localhost/127.0.0.1；
 * - 不允许带用户名、密码、query、hash。
 */
export function normalizePromaCloudBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return DEFAULT_PROMA_CLOUD_BASE_URL

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('服务地址格式不正确，请填写完整 URL，例如 https://api.proma.cool')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务地址必须使用 https；只有 localhost 允许 http')
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('服务地址必须使用 https；只有 localhost 或 127.0.0.1 允许 http')
  }
  if (url.username || url.password) {
    throw new Error('服务地址不能包含用户名或密码')
  }
  if (url.search || url.hash) {
    throw new Error('服务地址不能包含查询参数或锚点')
  }

  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

// ===== 读写 =====

function readConfigFile(): PromaCloudConfigFile {
  const configPath = getPromaCloudConfigPath()
  if (!existsSync(configPath)) return { ...EMPTY_CONFIG }

  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<PromaCloudConfigFile>
    // 地址按当前规则重新归一化；历史文件里的旧值非法时回落到默认值，不阻断使用。
    let baseUrl = DEFAULT_PROMA_CLOUD_BASE_URL
    try {
      baseUrl = normalizePromaCloudBaseUrl(typeof data.baseUrl === 'string' ? data.baseUrl : undefined)
    } catch {
      baseUrl = DEFAULT_PROMA_CLOUD_BASE_URL
    }
    return {
      version: CONFIG_VERSION,
      apiKey: typeof data.apiKey === 'string' ? data.apiKey : '',
      baseUrl,
      webResearchEnabled: data.webResearchEnabled !== false,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    }
  } catch (error) {
    console.error('[Proma Cloud] 读取配置失败:', error instanceof Error ? error.message : '未知错误')
    return { ...EMPTY_CONFIG }
  }
}

function writeConfigFile(config: PromaCloudConfigFile): void {
  writeJsonFileAtomic(getPromaCloudConfigPath(), config)
}

/** 生成 Key 提示串：保留明文末 4 位（不足 8 位时只显示掩码）。 */
export function buildKeyHint(apiKey: string | undefined | null): string {
  const trimmed = (apiKey ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.length < 8) return '••••'
  return `••••${trimmed.slice(-4)}`
}

function toSummary(config: PromaCloudConfigFile): PromaCloudConfigSummary {
  const plainKey = decryptSecret(config.apiKey)
  return {
    configured: plainKey.length > 0,
    keyHint: plainKey ? buildKeyHint(plainKey) : '',
    baseUrl: config.baseUrl,
    webResearchEnabled: config.webResearchEnabled,
    updatedAt: config.updatedAt,
  }
}

/** 向所有窗口推送能力变更，让能力中心的内置 MCP 卡片刷新可用状态。 */
function broadcastCapabilitiesChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED)
  }
}

// ===== 对外 API =====

/** 读取给界面使用的配置摘要；不返回明文或密文 Key。 */
export function getPromaCloudConfigSummary(): PromaCloudConfigSummary {
  return toSummary(readConfigFile())
}

/**
 * 更新配置并返回最新摘要。
 *
 * `apiKey` 省略时保留原值；为空串或 null 时清除；其他值 trim 后加密保存。
 */
export function updatePromaCloudConfig(input: PromaCloudConfigUpdateInput): PromaCloudConfigSummary {
  const current = readConfigFile()
  const next: PromaCloudConfigFile = {
    version: CONFIG_VERSION,
    apiKey: current.apiKey,
    baseUrl: current.baseUrl,
    webResearchEnabled: current.webResearchEnabled,
    updatedAt: current.updatedAt,
  }

  if (input.apiKey !== undefined) {
    const trimmed = (input.apiKey ?? '').trim()
    next.apiKey = trimmed ? encryptSecret(trimmed) : ''
  }
  if (input.baseUrl !== undefined) {
    next.baseUrl = normalizePromaCloudBaseUrl(input.baseUrl)
  }
  if (input.webResearchEnabled !== undefined) {
    next.webResearchEnabled = input.webResearchEnabled
  }

  next.updatedAt = Date.now()
  writeConfigFile(next)
  broadcastCapabilitiesChanged()
  return toSummary(next)
}

/**
 * 解析主进程内部使用的凭据。
 *
 * 未配置、解密失败或地址非法时返回 null，调用方按不可用处理。
 */
export function resolvePromaCloudCredentials(): { apiKey: string; apiRoot: string } | null {
  const config = readConfigFile()
  const apiKey = decryptSecret(config.apiKey).trim()
  if (!apiKey) return null
  let apiRoot: string
  try {
    apiRoot = normalizePromaCloudBaseUrl(config.baseUrl)
  } catch {
    return null
  }
  return { apiKey, apiRoot }
}

/** 已配置 Key 且联网检索开关为真时，Agent 才获得 WebSearch / WebFetch。 */
export function isPromaCloudWebResearchAvailable(): boolean {
  const config = readConfigFile()
  if (!config.webResearchEnabled) return false
  return decryptSecret(config.apiKey).trim().length > 0
}
