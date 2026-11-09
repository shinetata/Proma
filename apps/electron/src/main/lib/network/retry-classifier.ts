/**
 * 模型请求失败的重试判定与用户可见文案
 *
 * 同一次失败需要回答两个问题：还值不值得自动重试、以及重试没用时怎么向用户解释。
 * `classifyModelFailure` 给出前者（可重试 + 原因类别 + 安全错误码），
 * `describeModelFailure` 把分类结果翻成标题与可执行说明。
 *
 * 两侧共用同一套 `RetryReasonKind`：agent-runtime 侧用它决定是否重试并带上
 * reasonKind 给 UI 展示重试状态，main 侧用它生成终态错误文案。
 *
 * 判定顺序是有意为之，改动前先确认为什么某一类要先于另一类：
 * 账单类 > 4xx（除 408/425/429）> 流排水超时 > Chromium 错误码 >
 * 已序列化的网络失败文案 > Node 连接码 > 文本兜底。
 */

import type { RetryReasonKind } from '@proma/shared'
import { networkFailureKindFromMessage } from './network-errors'

/** 额度 / 账单类错误：重试不会恢复，必须先处理额度 */
const BILLING_PATTERN = /insufficient_quota|payment_required|积分不足|余额不足|out of budget|quota exceeded|usage limit reached|available balance/i

/** 重试无意义的 Chromium 错误码：证书、URL、重定向、代理鉴权等确定性失败 */
const NON_RETRYABLE_CHROMIUM = /^ERR_(?:CERT_[A-Z_]+|ABORTED|UNSAFE_PORT|INVALID_URL|BLOCKED_[A-Z_]+|DISALLOWED_URL_SCHEME|PROXY_AUTH_[A-Z_]+|PROXY_CERTIFICATE_INVALID|SSL_CLIENT_AUTH_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT|ACCESS_DENIED|NETWORK_ACCESS_DENIED|TOO_MANY_REDIRECTS|UNSAFE_REDIRECT|HTTP2_INADEQUATE_TRANSPORT_SECURITY|SSL_VERSION_OR_CIPHER_MISMATCH)$/

/** 传输过程中断的 Chromium 错误码：重试通常可以恢复 */
const STREAM_CHROMIUM = /^ERR_(?:INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH|HTTP2_STREAM_ERROR|HTTP2_STREAM_CLOSED|QUIC_PROTOCOL_ERROR|SPDY_PROTOCOL_ERROR)$/

/** 连接层失败的 Chromium 错误码：重试通常可以恢复 */
const CONNECTION_CHROMIUM = /^ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|ADDRESS_IN_USE|TIMED_OUT|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|SSL_PROTOCOL_ERROR|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_[A-Z_]+|CONNECTION_[A-Z_]+|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_[A-Z_]+|HTTP2_[A-Z_]+|SPDY_[A-Z_]+|QUIC_[A-Z_]+)$/

/** Node / undici 的连接层系统错误码 */
const NODE_CONNECTION = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\b/

/** 流排水超时：上游迟迟不排空响应，与连接中断同类处理 */
const STREAM_DRAIN_TIMEOUT = /drain exceeded (?:configured stream drain duration|stream_drain_max_seconds)/i

/** 连接层失败的细分原因，用于挑选更具体的文案 */
export type ConnectionFailureDetail = 'proxy' | 'dns' | 'offline' | 'network-changed' | 'timeout'

/** 失败分类结果 */
export interface ModelFailureClassification {
  /** 是否值得继续自动重试 */
  retryable: boolean
  reasonKind: RetryReasonKind
  /** 仅 reasonKind 为 connection 时可能出现，用于细分文案 */
  detail?: ConnectionFailureDetail
  /** 可安全展示的错误码，例如 ERR_NAME_NOT_RESOLVED / ECONNRESET / HTTP 529 */
  safeCode?: string
}

/**
 * describeModelFailure 的入参
 *
 * 只需要文案相关信息；`retryable` 允许传进来但文案不使用，方便直接把
 * classifyModelFailure 的结果或手工拼的分类对象交给这里。
 */
export interface ModelFailureCopyInput {
  reasonKind: RetryReasonKind
  detail?: ConnectionFailureDetail
  safeCode?: string
  retryable?: boolean
}

/** 从文本里取 Chromium 风格错误码 */
function chromiumCode(text: string): string | undefined {
  return text.match(/\bERR_[A-Z0-9_]{2,80}\b/)?.[0]
}

/** Chromium 错误码 → 连接层细分原因 */
function chromiumDetail(code: string): ConnectionFailureDetail | undefined {
  if (/PROXY|TUNNEL|SOCKS/.test(code)) return 'proxy'
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION|DNS_/.test(code)) return 'dns'
  if (/INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED/.test(code)) return 'offline'
  if (code === 'ERR_NETWORK_CHANGED' || code === 'ERR_ADDRESS_UNREACHABLE') return 'network-changed'
  if (/TIMED_OUT/.test(code)) return 'timeout'
  return undefined
}

/**
 * 提取显式 HTTP 状态码
 *
 * 覆盖三家常见形态：SDK 的 "API Error: (529)"、结构化文本的 "status: 502"、
 * 以及带原因短语的 "429 Too Many Requests"。只接受 4xx/5xx，避免把模型名里的
 * 数字当成状态码。
 */
export function explicitHttpStatus(text: string): number | undefined {
  const patterns = [
    /^\s*(?:[A-Za-z][\w ]{0,40}?(?:error|Error)\s*[:(]?\s*)?\(?(\d{3})\)?(?=[\s:,{])/,
    /\b(?:http|status|statusCode|status code|error code)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:too many requests|internal server error|bad gateway|service unavailable|gateway timeout|unauthorized|forbidden|not found|bad request|payment required)\b/i,
  ]

  for (const pattern of patterns) {
    const value = Number(pattern.exec(text)?.[1])
    if (value >= 400 && value <= 599) return value
  }
  return undefined
}

/** 文本兜底归因：没有可用的错误码与状态码时按措辞判断 */
function reasonKindFromText(text: string, httpStatus?: number): RetryReasonKind {
  const lower = text.toLowerCase()
  if (httpStatus === 429 || /rate.?limit|too many requests|overloaded|resourceexhausted|high demand/.test(lower)) {
    return 'rate_limited'
  }
  if (httpStatus !== undefined && httpStatus >= 500) return 'service'
  if (/stream.*(?:ended|interrupted|closed)|(?:ended|interrupted|closed).*stream|incomplete chunked|terminal (?:event|response)|stream_read_error|ended without|other side closed|premature close/.test(lower)) {
    return 'stream_interrupted'
  }
  if (/unexpected (?:token|non-whitespace|end of json)|invalid (?:json|response)|json.*(?:parse|syntax)|is not valid json/.test(lower)) {
    return 'response_malformed'
  }
  if (/service.?unavailable|bad gateway|gateway timeout|server.?error|internal.?error/.test(lower)) return 'service'
  if (/connect(?:ion)?|network|failed to fetch|fetch failed|socket|econn|etimedout|enotfound|dns|peer closed|timed? ?out|timeout|websocket/.test(lower)) {
    return 'connection'
  }
  return 'unknown'
}

/**
 * 给一次模型请求失败定性
 *
 * @param errorMessage 上游返回的错误文本（assistant.error 的 message 或 SDK 异常文本）
 * @param piRetryable Pi 自身的重试判定结果。只有在 Proma 无法从文本得出结论时
 *   才会采用它，作为最后的兜底。
 */
export function classifyModelFailure(errorMessage?: string, piRetryable = false): ModelFailureClassification {
  const text = errorMessage ?? ''
  const httpStatus = explicitHttpStatus(text)
  const code = chromiumCode(text)
  const safeCode = code ?? (httpStatus !== undefined ? `HTTP ${httpStatus}` : text.match(NODE_CONNECTION)?.[1])

  // 额度类错误即便带 429/5xx 也不该重试：重试只会继续失败，要先让用户充值或换渠道。
  if (BILLING_PATTERN.test(text)) return { retryable: false, reasonKind: 'unknown', safeCode }

  // 4xx 里只有请求超时、过早、限流三种值得重试；其余是参数或鉴权问题。
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && ![408, 425, 429].includes(httpStatus)) {
    return { retryable: false, reasonKind: 'unknown', safeCode }
  }

  if (STREAM_DRAIN_TIMEOUT.test(text)) {
    return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
  }

  if (code) {
    if (NON_RETRYABLE_CHROMIUM.test(code)) return { retryable: false, reasonKind: 'connection', safeCode }
    if (STREAM_CHROMIUM.test(code)) return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
    if (CONNECTION_CHROMIUM.test(code)) {
      return { retryable: true, reasonKind: 'connection', detail: chromiumDetail(code), safeCode }
    }
  }

  // 已经被 Proma 包装过的网络失败，文案里能反查出类别，比文本正则更可靠。
  const networkKind = networkFailureKindFromMessage(text)
  if (networkKind) {
    switch (networkKind) {
      case 'proxy-unreachable':
        return { retryable: true, reasonKind: 'connection', detail: 'proxy', safeCode }
      case 'dns':
        return { retryable: true, reasonKind: 'connection', detail: 'dns', safeCode }
      case 'connect':
        return { retryable: true, reasonKind: 'connection', safeCode }
      case 'timeout':
        return { retryable: true, reasonKind: 'connection', detail: 'timeout', safeCode }
      case 'stream-interrupted':
        return { retryable: true, reasonKind: 'stream_interrupted', safeCode }
      default:
        // cancelled / tls / unknown：不自动重试，但仍按连接问题展示。
        return { retryable: false, reasonKind: 'connection', safeCode }
    }
  }

  const nodeCode = text.match(NODE_CONNECTION)?.[1]
  if (nodeCode) {
    const detail = nodeCode === 'ENOTFOUND' || nodeCode === 'EAI_AGAIN'
      ? 'dns'
      : nodeCode === 'ETIMEDOUT' ? 'timeout' : undefined
    return { retryable: true, reasonKind: 'connection', detail, safeCode }
  }

  return { retryable: piRetryable, reasonKind: reasonKindFromText(text, httpStatus), safeCode }
}

/**
 * 把分类结果翻成用户可见的标题与说明
 *
 * 文案要同时说清「发生了什么」和「能做什么」，所以每一条都带下一步动作。
 * 有安全错误码时追加在末尾，便于用户反馈问题时定位，但不展示原始报错。
 */
export function describeModelFailure(classification: ModelFailureCopyInput): { title: string; message: string } {
  const copy = ((): { title: string; message: string } => {
    if (classification.reasonKind === 'connection') {
      switch (classification.detail) {
        case 'proxy':
          return {
            title: '代理不可用',
            message: '无法连接到系统代理，代理软件可能已退出或正在切换。请确认代理软件正常运行，或在系统设置中关闭代理后重试。',
          }
        case 'dns':
          return {
            title: '域名解析失败',
            message: '无法解析模型服务地址。请检查网络或代理设置后重试。',
          }
        case 'offline':
          return {
            title: '网络已断开',
            message: '设备当前处于离线状态。恢复网络后重试即可。',
          }
        case 'network-changed':
          return {
            title: '网络已切换',
            message: '请求过程中网络发生了切换（例如开关 VPN 或代理），自动重连未能恢复。请确认网络稳定后重试。',
          }
        case 'timeout':
          return {
            title: '网络连接超时',
            message: '连接模型服务超时，自动重连未能恢复。请检查网络或代理线路后重试。',
          }
        default:
          return {
            title: '网络连接中断',
            message: '与模型服务的连接中断，自动重连未能恢复。请检查网络或代理设置后重试。',
          }
      }
    }

    if (classification.reasonKind === 'stream_interrupted') {
      return {
        title: '响应传输中断',
        message: '模型回复在传输过程中断开，自动恢复未能完成。已完成的步骤已保留，请检查网络后重试。',
      }
    }

    if (classification.reasonKind === 'rate_limited') {
      return {
        title: '模型服务繁忙',
        message: '模型服务持续繁忙，自动重试未能恢复。请稍后重试。',
      }
    }

    if (classification.reasonKind === 'service') {
      return {
        title: '模型服务暂时不可用',
        message: '模型服务持续返回异常，自动重试未能恢复。请稍后重试，或切换其他模型。',
      }
    }

    if (classification.reasonKind === 'response_malformed') {
      return {
        title: '响应解析失败',
        message: '上游返回了无法解析的响应，通常为网关瞬时异常，请重试。',
      }
    }

    return {
      title: '请求未完成',
      message: '模型请求未能完成，请稍后重试。',
    }
  })()

  return classification.safeCode
    ? { ...copy, message: `${copy.message}\n错误代码：${classification.safeCode}` }
    : copy
}