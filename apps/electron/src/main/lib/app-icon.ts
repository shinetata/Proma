/**
 * 应用图标：运行期 Dock 图标 + App bundle 图标持久化
 *
 * macOS 的 app.dock.setIcon() 只改「当前进程」的 Dock 图标。进程退出后，Dock 里固定的
 * 应用图标、Finder / Launchpad / Spotlight 的图标都来自 App bundle 的
 * Contents/Resources/<CFBundleIconFile>（electron-builder 产物固定为 icon.icns）。
 * 所以要让用户选择的图标在退出后依然生效，必须把所选 PNG 转成 .icns 写进 bundle，
 * 并刷新 LaunchServices 与 Dock 的图标缓存。
 *
 * 写入策略：
 * - 首次写入前把打包产物自带的 icon.icns 备份到 userData，选择「默认」时原样还原；
 * - 记录本次写入内容的哈希，重建打包产物后（bundle 被覆盖）启动时自动按偏好回写；
 * - 任何一步失败都只降级为「本次运行生效」，不阻塞图标切换本身。
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileAsync } from './async-command'

/** iconset 需要的基础尺寸，@2x 由脚本翻倍生成，覆盖 16pt～512pt 全档 */
const ICONSET_SIZES = [16, 32, 64, 128, 256, 512] as const

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export interface AppBundleIconResult {
  /** 是否真的改写了 bundle 内的图标文件 */
  applied: boolean
  /** 未改写时的原因，用于日志排查 */
  reason?: string
}

interface AppIconState {
  variant?: string
  /** 上次写入 bundle 的 icns 哈希，用于判断 bundle 是否被重新打包覆盖 */
  bakedHash?: string
}

/**
 * 打包内置资源目录
 * dev: __dirname/resources（build:resources 阶段拷贝）
 * prod: process.resourcesPath（electron-builder extraResources 产物）
 */
export function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/**
 * 解析应用图标变体的文件路径
 */
export function resolveAppIconPath(variantId: string): string | null {
  const resourcesDir = getBundledResourcesDir()
  if (!variantId || variantId === 'default') {
    return join(resourcesDir, 'icon.png')
  }
  return join(resourcesDir, 'proma-logos', `proma-${variantId}.png`)
}

/**
 * 当前进程所属的 .app bundle 路径。
 * 未打包（bunx electron .）或非 macOS 时返回 null，此时没有 bundle 可以改写。
 */
export function resolveAppBundlePath(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null

  // .../Foo.app/Contents/MacOS/Foo → .../Foo.app
  const bundlePath = dirname(dirname(dirname(app.getPath('exe'))))
  if (!bundlePath.endsWith('.app')) return null
  if (!existsSync(join(bundlePath, 'Contents', 'Info.plist'))) return null
  return bundlePath
}

function sha256OfFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function resolveCacheDir(bundlePath: string): string {
  // 同一 userData 下可能对应多个 bundle（例如同时装着两个构建），按 bundle 路径区分
  const key = createHash('sha1').update(bundlePath).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'app-icon', key)
}

function readState(statePath: string): AppIconState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as AppIconState
  } catch {
    return {}
  }
}

function writeState(statePath: string, state: AppIconState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state))
  } catch (error) {
    console.warn('[图标] 写入状态文件失败:', error)
  }
}

/**
 * 从 1024px 的 PNG 生成多档位 .icns。
 * macOS 自带 sips + iconutil，不额外引入图片处理依赖。
 */
async function generateIcns(sourcePngPath: string, outputIcnsPath: string): Promise<void> {
  const workingDir = join(dirname(outputIcnsPath), `iconset-${process.pid}-${Date.now()}.iconset`)
  mkdirSync(workingDir, { recursive: true })
  try {
    for (const size of ICONSET_SIZES) {
      const targets: Array<[number, string]> = [
        [size, `icon_${size}x${size}.png`],
        [size * 2, `icon_${size}x${size}@2x.png`],
      ]
      for (const [pixels, filename] of targets) {
        await execFileAsync(
          'sips',
          ['-z', String(pixels), String(pixels), sourcePngPath, '--out', join(workingDir, filename)],
          { timeout: 20_000 },
        )
      }
    }
    await execFileAsync('iconutil', ['-c', 'icns', workingDir, '-o', outputIcnsPath], { timeout: 20_000 })
  } finally {
    rmSync(workingDir, { recursive: true, force: true })
  }
}

/**
 * 让 LaunchServices / Dock 重新读取 bundle 图标。
 * 只 touch 不够：Dock 的固定图标走 LaunchServices 图标缓存，需要重载 Dock 才会刷新。
 */
async function refreshIconCaches(bundlePath: string): Promise<void> {
  const now = new Date()
  try {
    utimesSync(bundlePath, now, now)
  } catch {
    // 忽略：touch 只是辅助触发，核心是下面的 lsregister
  }

  try {
    await execFileAsync(LSREGISTER, ['-f', bundlePath], { timeout: 20_000 })
  } catch (error) {
    console.warn('[图标] lsregister 刷新失败:', error)
  }

  try {
    await execFileAsync('killall', ['Dock'], { timeout: 10_000 })
  } catch (error) {
    // Dock 未运行或权限不足时忽略；下次登录也会刷新
    console.warn('[图标] 重启 Dock 失败:', error)
  }
}

/**
 * 把图标变体写入 App bundle，使退出 App 后 Dock / Finder / Launchpad 仍显示该样式。
 *
 * @param variantId 图标变体 id，'default' 表示还原打包产物自带的图标
 * @param sourcePngPath 变体对应的 PNG 路径（由 resolveAppIconPath 解析）
 */
export async function applyAppBundleIcon(
  variantId: string,
  sourcePngPath: string | null,
): Promise<AppBundleIconResult> {
  const bundlePath = resolveAppBundlePath()
  if (!bundlePath) return { applied: false, reason: 'not-packaged-macos-app' }

  const bundleIconPath = join(bundlePath, 'Contents', 'Resources', 'icon.icns')
  if (!existsSync(bundleIconPath)) return { applied: false, reason: 'bundle-icon-missing' }

  const cacheDir = resolveCacheDir(bundlePath)
  mkdirSync(cacheDir, { recursive: true })
  const statePath = join(cacheDir, 'state.json')
  const originalPath = join(cacheDir, 'icon-original.icns')
  const state = readState(statePath)
  const currentHash = sha256OfFile(bundleIconPath)

  // 选择「默认」：还原首次改写前的 bundle 图标
  if (!variantId || variantId === 'default') {
    if (!existsSync(originalPath)) {
      return { applied: false, reason: 'nothing-to-restore' }
    }
    const originalHash = sha256OfFile(originalPath)
    if (currentHash === originalHash) {
      writeState(statePath, { variant: 'default' })
      return { applied: false, reason: 'already-default' }
    }
    copyFileSync(originalPath, bundleIconPath)
    writeState(statePath, { variant: 'default' })
    await refreshIconCaches(bundlePath)
    console.log('[图标] 已还原 bundle 默认图标')
    return { applied: true }
  }

  if (!sourcePngPath || !existsSync(sourcePngPath)) {
    return { applied: false, reason: 'variant-png-missing' }
  }

  // 已经是上次写入的那份图标（含重新打包后启动 replay 的场景），无需重复生成
  if (state.variant === variantId && state.bakedHash === currentHash) {
    return { applied: false, reason: 'already-applied' }
  }

  const bakedPath = join(cacheDir, `baked-${variantId}.icns`)
  try {
    await generateIcns(sourcePngPath, bakedPath)
  } catch (error) {
    console.warn('[图标] 生成 icns 失败:', error)
    return { applied: false, reason: 'icns-generation-failed' }
  }

  const bakedHash = sha256OfFile(bakedPath)

  // 当前 bundle 图标不是我们上次写入的内容 → 视为打包产物自带图标，先备份再覆盖。
  // 这样「重新打包覆盖 bundle」后仍能正确回到默认样式。
  if (state.bakedHash !== currentHash) {
    try {
      copyFileSync(bundleIconPath, originalPath)
    } catch (error) {
      console.warn('[图标] 备份原始图标失败:', error)
    }
  }

  try {
    copyFileSync(bakedPath, bundleIconPath)
  } catch (error) {
    console.warn('[图标] 写入 bundle 图标失败（可能需要写权限）:', error)
    return { applied: false, reason: 'bundle-write-failed' }
  }

  writeState(statePath, { variant: variantId, bakedHash })
  await refreshIconCaches(bundlePath)
  console.log(`[图标] 已写入 bundle 图标: ${variantId}`)
  return { applied: true }
}

/**
 * 启动时按保存的偏好回写 bundle 图标。
 * 重新打包会重置 bundle 内的 icon.icns，这里补一次，避免用户以为设置丢了。
 */
export async function syncAppBundleIconWithSettings(variantId: string | undefined): Promise<void> {
  const normalized = variantId && variantId !== 'default' ? variantId : 'default'
  try {
    const result = await applyAppBundleIcon(normalized, resolveAppIconPath(normalized))
    if (!result.applied && result.reason && result.reason !== 'already-applied') {
      console.log(`[图标] 启动同步跳过: ${result.reason}`)
    }
  } catch (error) {
    console.warn('[图标] 启动同步失败:', error)
  }
}
