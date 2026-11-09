/**
 * 网络失败分类与用户可见说明
 *
 * 底层 fetch / Chromium / Node 抛出的网络错误形态很杂（AbortError、ERR_*、
 * ECONNRESET、纯文本 "Failed to fetch" 等），直接透传给用户既看不懂也无法处置。
 * 这里把网络失败归到固定的八类，每类配一句可执行的中文说明；对外只暴露这些
 * 固定文案与安全错误码（形如 ERR_NAME_NOT_RESOLVED / ECONNRESET），不泄漏
 * 代理地址、内部域名等完整报错内容。
 */

/** 网络失败类别 */
export type NetworkFailureKind =
  /** 系统代理 / 隧道 / SOCKS 不可达 */
  | 'proxy-unreachable'
  /** 域名解析失败 */
  | 'dns'
  /** 证书校验失败 */
  | 'tls'
  /** TCP 连接建立失败 */
  | 'connect'
  /** 网络操作超时 */
  | 'timeout'
  /** 已建立连接后传输中断 */
  | 'stream-interrupted'
  /** 请求被主动取消 */
  | 'cancelled'
  /** 无法进一步归因 */
  | 'unknown'

/** 各类网络失败的用户可见说明 */
export const NETWORK_FAILURE_MESSAGES: Record<NetworkFailureKind, string> = {
  'proxy-unreachable': '当前系统代理不可达，请检查系统网络；登录状态已保留。',
  dns: '域名解析失败，请检查系统网络。',
  tls: '网络证书验证失败，请检查系统证书或代理。',
  connect: '网络连接失败，请检查系统网络后重试。',
  timeout: '网络操作超时，请稍后重试。',
  'stream-interrupted': '响应传输中断，已收到的内容已保留。',
  cancelled: '请求已取消。',
  unknown: '网络请求未完成，请检查系统网络后重试。',
}

/** 安全错误码白名单：Chromium 的 ERR_* 与 Node 的 E* 系统错误码 */
const SAFE_ERROR_CODE_PATTERN = /^(ERR_[A-Z0-9_]+|E[A-Z0-9_]{2,40})$/

/**
 * 提取可安全展示的错误码
 *
 * 只接受形如 ERR_XXX / ECONNRESET 的代码，其余内容一律丢弃，避免把包含域名、
 * 代理地址的完整报错原文带到用户侧。
 */
export function safeNetworkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined

  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (SAFE_ERROR_CODE_PATTERN.test(code)) return code

  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return message.match(/\bERR_[A-Z0-9_]{1,80}\b/)?.[0]
}

/**
 * 把任意网络错误归到固定类别
 *
 * 判定顺序：已包装的 NetworkRequestError → error.name（Abort / Timeout）→
 * 错误码正则 → 错误消息兜底。先看具体错误码再看消息，因为消息里常同时包含
 * 多种线索，按码定位更准。
 */
export function classifyNetworkError(error: unknown): NetworkFailureKind {
  if (error instanceof NetworkRequestError) return error.kind

  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'AbortError') return 'cancelled'
  if (name === 'TimeoutError') return 'timeout'

  const code = safeNetworkErrorCode(error) ?? ''
  if (/PROXY|TUNNEL/.test(code)) return 'proxy-unreachable'
  if (/NAME_NOT_RESOLVED|DNS_|ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns'
  if (/CERT_|SSL_|TLS_/.test(code)) return 'tls'
  if (/TIMED_OUT|ETIMEDOUT/.test(code)) return 'timeout'
  if (/CONNECTION_RESET|ECONNRESET|INCOMPLETE_CHUNKED/.test(code)) return 'stream-interrupted'
  if (/CONNECTION_|ECONNREFUSED|NETWORK_CHANGED|INTERNET_DISCONNECTED/.test(code)) return 'connect'

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/connect(?:ion)? error|failed to fetch|fetch failed|network error/i.test(message)) return 'connect'
  return 'unknown'
}

/**
 * 带分类结果的网络请求错误
 *
 * 抛出点已经知道自己失败在哪一类，包装后上层不必再解析底层报错。
 * `scope` 是不透明的传输分组标识，仅用于把同一分组的失败归到一起。
 */
export class NetworkRequestError extends Error {
  readonly kind: NetworkFailureKind
  readonly scope?: string
  /** 底层错误的安全错误码，可用于展示与日志定位 */
  readonly causeCode?: string
  override name = 'NetworkRequestError'

  constructor(kind: NetworkFailureKind, scope?: string, causeCode?: string) {
    super(NETWORK_FAILURE_MESSAGES[kind])
    this.kind = kind
    this.scope = scope
    this.causeCode = causeCode
  }
}

/**
 * 从已序列化的文案反向还原失败类别
 *
 * 错误文案要跨进程、跨会话持久化，中途会丢掉 Error 对象；回读时靠固定说明
 * 反查类别，避免重新解析原始报错。
 */
export function networkFailureKindFromMessage(text: string): NetworkFailureKind | undefined {
  for (const [kind, message] of Object.entries(NETWORK_FAILURE_MESSAGES)) {
    if (text.includes(message)) return kind as NetworkFailureKind
  }
  return undefined
}