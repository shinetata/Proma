/**
 * 写前/轮末文件内容副本
 *
 * 非 Git 覆盖范围（仓库外、被 ignore、非 Git 目录）的改动无法用快照树比较，
 * 因此对每个被文件工具触及的路径，在本轮第一次修改前把内容按 SHA-1 存进会话
 * 私有 scratch 目录；轮末再 capture 一次并与写前副本比较。
 */

import { createHash } from 'node:crypto'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 判定二进制时探测的字节数 */
const BINARY_PROBE_BYTES = 8_000

export type CaptureResult =
  | { kind: 'absent' }
  | { kind: 'oversized' }
  | { kind: 'file'; file: string; binary: boolean }

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

function isMissingError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && MISSING_CODES.has(code)
}

/**
 * 把文件内容按 SHA-1 存进 directory，返回内容定位信息。
 *
 * @returns undefined 表示该路径不是普通文件（目录、设备等），不需要比较
 */
export async function captureFile(
  absolute: string,
  directory: string,
  maxBytes: number,
): Promise<CaptureResult | undefined> {
  let handle
  try {
    handle = await open(absolute, 'r')
  } catch (error) {
    if (!isMissingError(error)) throw error
    return { kind: 'absent' }
  }

  let bytes: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile()) return undefined
    if (info.size > maxBytes) return { kind: 'oversized' }

    // 多读 1 字节用于识别「读取过程中文件变大」的超限情况
    const probe = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < probe.length) {
      const { bytesRead } = await handle.read(probe, length, probe.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) return { kind: 'oversized' }
    bytes = probe.subarray(0, length)
  } finally {
    await handle.close()
  }

  const file = join(directory, createHash('sha1').update(bytes).digest('hex'))
  await mkdir(directory, { recursive: true })
  // 同内容文件在 scratch 内只存一份，已存在即复用
  await writeFile(file, bytes, { flag: 'wx' }).catch((error) => {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
  })

  return {
    kind: 'file',
    file,
    binary: bytes.subarray(0, BINARY_PROBE_BYTES).includes(0),
  }
}

/** 两次捕获是否代表同一份内容。 */
export function sameCapture(a: CaptureResult, b: CaptureResult): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind
  return a.kind === 'file' && b.kind === 'file' && a.file === b.file
}
