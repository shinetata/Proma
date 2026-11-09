import { describe, expect, test } from 'bun:test'
import {
  classifyModelFailure,
  describeModelFailure,
  explicitHttpStatus,
} from './retry-classifier'
import {
  NetworkRequestError,
  classifyNetworkError,
  networkFailureKindFromMessage,
  safeNetworkErrorCode,
} from './network-errors'

describe('explicitHttpStatus', () => {
  test.each([
    ['API Error: (402) payment required', 402],
    ['API Error: (529) overloaded', 529],
    ['status: 503', 503],
    ['429 Too Many Requests', 429],
  ])('Given 带状态码的报错 "%s" Then 提取到 %i', (text, expected) => {
    expect(explicitHttpStatus(text)).toBe(expected)
  })

  test('Given 没有状态码的报错 Then 返回 undefined', () => {
    expect(explicitHttpStatus('net::ERR_NAME_NOT_RESOLVED')).toBeUndefined()
  })
})

describe('classifyModelFailure 判定顺序', () => {
  test('Given 额度不足 Then 不可重试，即使同时带 429', () => {
    const result = classifyModelFailure('HTTP 429 insufficient_quota: you exceeded your current quota')
    expect(result.retryable).toBe(false)
    expect(result.safeCode).toBe('HTTP 429')
  })

  test('Given 4xx 非超时类错误 Then 不可重试', () => {
    expect(classifyModelFailure('API Error: (400) bad request').retryable).toBe(false)
    expect(classifyModelFailure('API Error: (401) unauthorized').retryable).toBe(false)
  })

  // 408/425/429 只是不走「4xx 一律不可重试」，最终仍取 Pi 的判定；
  // Pi 对超时与限流判为可重试，因此这里应保留可重试。
  test.each([408, 425, 429])('Given %i Then 不被硬性判定为不可重试', (status) => {
    expect(classifyModelFailure(`API Error: (${status}) retryable`, true).retryable).toBe(true)
    expect(classifyModelFailure(`API Error: (400) bad request`, true).retryable).toBe(false)
  })

  test('Given 流排水超时 Then 归为传输中断且可重试', () => {
    const result = classifyModelFailure('drain exceeded configured stream drain duration')
    expect(result).toEqual({ retryable: true, reasonKind: 'stream_interrupted', safeCode: undefined })
  })

  test('Given 证书类 Chromium 码 Then 不可重试', () => {
    const result = classifyModelFailure('net::ERR_CERT_DATE_INVALID')
    expect(result.retryable).toBe(false)
    expect(result.safeCode).toBe('ERR_CERT_DATE_INVALID')
  })

  test('Given 传输中断的 Chromium 码 Then 可重试且归为传输中断', () => {
    const result = classifyModelFailure('net::ERR_INCOMPLETE_CHUNKED_ENCODING')
    expect(result.retryable).toBe(true)
    expect(result.reasonKind).toBe('stream_interrupted')
  })

  test('Given 代理不可达的 Chromium 码 Then 可重试并细分到 proxy', () => {
    const result = classifyModelFailure('net::ERR_PROXY_CONNECTION_FAILED')
    expect(result.retryable).toBe(true)
    expect(result.reasonKind).toBe('connection')
    expect(result.detail).toBe('proxy')
  })

  test('Given 域名解析失败的 Chromium 码 Then 细分到 dns', () => {
    const result = classifyModelFailure('net::ERR_NAME_NOT_RESOLVED')
    expect(result.detail).toBe('dns')
    expect(result.safeCode).toBe('ERR_NAME_NOT_RESOLVED')
  })

  test('Given 网络失败文案 Then 从文案反查类别并细分', () => {
    const proxyCopy = new NetworkRequestError('proxy-unreachable').message
    expect(classifyModelFailure(proxyCopy)).toEqual({
      retryable: true,
      reasonKind: 'connection',
      detail: 'proxy',
      safeCode: undefined,
    })

    const cancelledCopy = new NetworkRequestError('cancelled').message
    expect(classifyModelFailure(cancelledCopy).retryable).toBe(false)
  })

  test.each([
    ['read ECONNRESET', '连接中断可重试'],
    ['connect ETIMEDOUT 1.2.3.4:443', '超时可重试'],
    ['getaddrinfo ENOTFOUND api.example.com', 'DNS 失败可重试'],
  ])('Given Node 连接码 "%s" Then %s', (text) => {
    const result = classifyModelFailure(text)
    expect(result.retryable).toBe(true)
    expect(result.reasonKind).toBe('connection')
  })

  test('Given Node 连接码 ENOTFOUND Then 细分到 dns', () => {
    expect(classifyModelFailure('getaddrinfo ENOTFOUND api.example.com').detail).toBe('dns')
  })

  test('Given 无法归因的报错 Then 采用 Pi 的判定结果', () => {
    expect(classifyModelFailure('完全未知的报错', true).retryable).toBe(true)
    expect(classifyModelFailure('完全未知的报错', false).retryable).toBe(false)
  })

  test('Given 无参数 Then 不抛错且不可重试', () => {
    expect(classifyModelFailure()).toEqual({ retryable: false, reasonKind: 'unknown', safeCode: undefined })
  })
})

describe('describeModelFailure', () => {
  test('Given 连接层细分原因 Then 给出对应标题', () => {
    expect(describeModelFailure({ reasonKind: 'connection', detail: 'proxy' }).title).toBe('代理不可用')
    expect(describeModelFailure({ reasonKind: 'connection', detail: 'dns' }).title).toBe('域名解析失败')
    expect(describeModelFailure({ reasonKind: 'connection', detail: 'offline' }).title).toBe('网络已断开')
    expect(describeModelFailure({ reasonKind: 'connection', detail: 'network-changed' }).title).toBe('网络已切换')
    expect(describeModelFailure({ reasonKind: 'connection', detail: 'timeout' }).title).toBe('网络连接超时')
    expect(describeModelFailure({ reasonKind: 'connection' }).title).toBe('网络连接中断')
  })

  test('Given 其他原因类别 Then 给出对应标题', () => {
    expect(describeModelFailure({ reasonKind: 'stream_interrupted' }).title).toBe('响应传输中断')
    expect(describeModelFailure({ reasonKind: 'rate_limited' }).title).toBe('模型服务繁忙')
    expect(describeModelFailure({ reasonKind: 'service' }).title).toBe('模型服务暂时不可用')
    expect(describeModelFailure({ reasonKind: 'response_malformed' }).title).toBe('响应解析失败')
    expect(describeModelFailure({ reasonKind: 'unknown' }).title).toBe('请求未完成')
  })

  test('Given 有安全错误码 Then 文案末尾追加错误代码', () => {
    const copy = describeModelFailure({ reasonKind: 'connection', detail: 'dns', safeCode: 'ERR_NAME_NOT_RESOLVED' })
    expect(copy.message.endsWith('\n错误代码：ERR_NAME_NOT_RESOLVED')).toBe(true)
  })

  test('Given 没有安全错误码 Then 不追加错误代码', () => {
    expect(describeModelFailure({ reasonKind: 'connection' }).message).not.toContain('错误代码')
  })
})

describe('network-errors', () => {
  test.each([
    ['ERR_NAME_NOT_RESOLVED', 'dns'],
    ['ECONNREFUSED', 'connect'],
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy-unreachable'],
    ['ERR_CERT_DATE_INVALID', 'tls'],
    ['ETIMEDOUT', 'timeout'],
  ] as const)('Given 错误码 "%s" Then 归类为 %s', (code, expected) => {
    expect(classifyNetworkError({ code })).toBe(expected)
  })

  test('Given AbortError / TimeoutError Then 分别归类为取消与超时', () => {
    expect(classifyNetworkError({ name: 'AbortError' })).toBe('cancelled')
    expect(classifyNetworkError({ name: 'TimeoutError' })).toBe('timeout')
  })

  test('Given 纯文本连接失败 Then 归类为连接失败', () => {
    expect(classifyNetworkError('TypeError: Failed to fetch')).toBe('connect')
  })

  test('Given 已包装的网络错误 Then 直接采用其类别', () => {
    expect(classifyNetworkError(new NetworkRequestError('stream-interrupted'))).toBe('stream-interrupted')
  })

  test('Given 非安全错误码 Then 不对外暴露', () => {
    expect(safeNetworkErrorCode({ code: 'some internal detail' })).toBeUndefined()
    expect(safeNetworkErrorCode('boom')).toBeUndefined()
    expect(safeNetworkErrorCode({ message: 'connect to http://127.0.0.1:7890 failed with ERR_BLOCKED_BY_CLIENT' }))
      .toBe('ERR_BLOCKED_BY_CLIENT')
  })

  test('Given 已序列化的网络失败文案 Then 能反查出类别', () => {
    expect(networkFailureKindFromMessage(new NetworkRequestError('dns').message)).toBe('dns')
    expect(networkFailureKindFromMessage('不相干的报错')).toBeUndefined()
  })

  test('Given NetworkRequestError Then 携带 kind / scope / causeCode', () => {
    const error = new NetworkRequestError('timeout', 'model', 'ETIMEDOUT')
    expect(error.name).toBe('NetworkRequestError')
    expect(error.kind).toBe('timeout')
    expect(error.scope).toBe('model')
    expect(error.causeCode).toBe('ETIMEDOUT')
    expect(error instanceof Error).toBe(true)
  })
})