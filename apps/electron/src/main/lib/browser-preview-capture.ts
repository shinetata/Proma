/**
 * 受管浏览器标签缩略图捕获
 *
 * 后台标签不在任何 BrowserSlot 中挂载，`webContents.capturePage()` 在隐藏视图上
 * 可能返回空图或零尺寸。这里改为对目标标签单独 attach 一个扁平 CDP 会话：
 * 先确认文档已进入 interactive/complete 且视口有尺寸，再截取视口范围 JPEG。
 *
 * 缓存按 tabId + url + generation 绑定，页面一旦导航或观察代际失效即作废，
 * 保证 renderer 拿到的缩略图不会停留在上一个页面。
 */

import { nativeImage } from 'electron'
import type { BrowserPreviewFrame } from '@proma/shared'
import { throwIfBrowserOperationAborted, withBrowserCdpTimeout } from './browser-cdp'

const PREVIEW_CACHE_TTL_MS = 700
const PREVIEW_TIMEOUT_MS = 3_000
const PREVIEW_MAX_WIDTH = 640
const PREVIEW_MAX_HEIGHT = 400
const PREVIEW_JPEG_QUALITY = 65

export interface BrowserPreviewTarget {
  tabId: string
  url: string
  generation: number
}

interface BrowserPreviewCaptureDependencies {
  /** 目标标签已 attach 的 debugger；未 attach 时由调用方返回空目标。 */
  debugger: Electron.Debugger
  /** 返回当前可截图的标签；标签已关闭或不可用时返回 null。 */
  getTarget: () => BrowserPreviewTarget | null
  timeoutMs?: number
}

function sameTarget(left: BrowserPreviewTarget, right: BrowserPreviewTarget | null): boolean {
  return !!right && left.tabId === right.tabId && left.url === right.url && left.generation === right.generation
}

export class BrowserPreviewCapture {
  private pending?: { target: BrowserPreviewTarget; controller: AbortController; promise: Promise<BrowserPreviewFrame | null> }
  private cache?: { target: BrowserPreviewTarget; at: number; frame: BrowserPreviewFrame }

  constructor(private readonly dependencies: BrowserPreviewCaptureDependencies) {}

  /** 页面文档失效（导航、关闭、调试器重连）时作废进行中的捕获与缓存。 */
  invalidate(): void {
    this.pending?.controller.abort()
    this.pending = undefined
    this.cache = undefined
  }

  get(): Promise<BrowserPreviewFrame | null> {
    const target = this.dependencies.getTarget()
    if (!target || !target.url || target.url === 'about:blank') {
      this.invalidate()
      return Promise.resolve(null)
    }
    if (this.pending && !sameTarget(this.pending.target, target)) this.invalidate()
    if (this.cache && sameTarget(this.cache.target, target) && Date.now() - this.cache.at < PREVIEW_CACHE_TTL_MS) {
      return Promise.resolve(this.cache.frame)
    }
    if (this.pending) return this.pending.promise

    const controller = new AbortController()
    const pending: { target: BrowserPreviewTarget; controller: AbortController; promise: Promise<BrowserPreviewFrame | null> } = {
      target,
      controller,
      promise: Promise.resolve(null),
    }
    this.pending = pending
    pending.promise = withBrowserCdpTimeout(
      () => this.capture(controller.signal),
      'Browser.preview',
      this.dependencies.timeoutMs ?? PREVIEW_TIMEOUT_MS,
      controller.signal,
    )
      .then((base64) => {
        // 捕获期间标签可能已导航或被关闭，只有目标未变才写缓存。
        if (!base64 || this.pending !== pending || !sameTarget(target, this.dependencies.getTarget())) return null
        const imageDataUrl = encodePreviewImage(base64)
        if (!imageDataUrl) return null
        const frame: BrowserPreviewFrame = { tabId: target.tabId, url: target.url, imageDataUrl }
        this.cache = { target, at: Date.now(), frame }
        return frame
      })
      .catch(() => null)
      .finally(() => {
        controller.abort()
        if (this.pending === pending) this.pending = undefined
      })
    return pending.promise
  }

  private async capture(signal: AbortSignal): Promise<string | null> {
    const client = this.dependencies.debugger
    let sessionId: string | undefined
    const detach = (): void => {
      if (!sessionId) return
      const released = sessionId
      sessionId = undefined
      try {
        void client.sendCommand('Target.detachFromTarget', { sessionId: released }).catch(() => undefined)
      } catch { /* 调试通道已断开 */ }
    }
    signal.addEventListener('abort', detach, { once: true })
    try {
      throwIfBrowserOperationAborted(signal)
      const info = await client.sendCommand('Target.getTargetInfo')
      throwIfBrowserOperationAborted(signal)
      const targetInfo = info?.targetInfo as { targetId?: unknown } | undefined
      if (typeof targetInfo?.targetId !== 'string') return null
      const attached = await client.sendCommand('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true })
      if (typeof attached?.sessionId !== 'string') return null
      sessionId = attached.sessionId
      throwIfBrowserOperationAborted(signal)
      // 只截真正有内容的页面：readyState 未离开 loading 或视口为 0 时截图必然空白。
      const readiness = await client.sendCommand(
        'Runtime.evaluate',
        {
          expression: "(document.readyState === 'interactive' || document.readyState === 'complete') && !!document.documentElement && innerWidth > 0 && innerHeight > 0",
          returnByValue: true,
        },
        sessionId,
      )
      throwIfBrowserOperationAborted(signal)
      if (readiness?.result?.value !== true) return null
      const screenshot = await client.sendCommand(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: PREVIEW_JPEG_QUALITY, fromSurface: true, captureBeyondViewport: false },
        sessionId,
      )
      throwIfBrowserOperationAborted(signal)
      return typeof screenshot?.data === 'string' ? screenshot.data : null
    } finally {
      signal.removeEventListener('abort', detach)
      detach()
    }
  }
}

/** 缩略图只用于标签预览，等比缩到 640×400 以内并转 JPEG data URL。 */
function encodePreviewImage(base64: string): string | null {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
  if (image.isEmpty()) return null
  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) return null
  const scale = Math.min(1, PREVIEW_MAX_WIDTH / size.width, PREVIEW_MAX_HEIGHT / size.height)
  const thumbnail = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  })
  return `data:image/jpeg;base64,${thumbnail.toJPEG(PREVIEW_JPEG_QUALITY).toString('base64')}`
}
