/**
 * Proma Cloud 联网检索相关类型定义
 *
 * 开源版没有云端登录，由用户在能力中心填写自己的 Proma Cloud API Key。
 * Key 只在主进程内加密保存与解密使用，任何 IPC 返回值都不包含明文或密文。
 */

/** 给界面使用的配置摘要；不包含任何形式的 API Key。 */
export interface PromaCloudConfigSummary {
  /** 是否已保存 API Key */
  configured: boolean
  /** 明文末 4 位的提示串，形如 `••••abcd`；Key 过短时只有 `••••` */
  keyHint: string
  /** 归一化后的服务地址 */
  baseUrl: string
  /** 是否允许 Agent 使用 WebSearch / WebFetch */
  webResearchEnabled: boolean
  /** 最近一次保存时间（Unix 毫秒） */
  updatedAt: number
}

/**
 * 配置更新输入。
 *
 * - `apiKey` 省略（undefined）时保留原 Key；
 * - `apiKey` 为空字符串或 null 时清除；
 * - 其他值 trim 后加密保存。
 */
export interface PromaCloudConfigUpdateInput {
  apiKey?: string | null
  baseUrl?: string
  webResearchEnabled?: boolean
}

/**
 * 连接测试输入。
 *
 * 不传参数时使用已保存配置；传了参数时用传入的值测试但不写入配置。
 */
export interface PromaCloudConnectionTestInput {
  apiKey?: string
  baseUrl?: string
}

/** 连接测试结果；message 面向用户，不包含 API Key。 */
export interface PromaCloudConnectionTestResult {
  ok: boolean
  message: string
}

/** Proma Cloud 配置相关 IPC 通道常量 */
export const PROMA_CLOUD_IPC_CHANNELS = {
  /** 读取配置摘要 */
  GET_CONFIG: 'proma-cloud:get-config',
  /** 更新配置 */
  UPDATE_CONFIG: 'proma-cloud:update-config',
  /** 测试连接 */
  TEST_CONNECTION: 'proma-cloud:test-connection',
} as const
