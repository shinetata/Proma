/**
 * Proma Cloud 配置存储单测
 *
 * electron 的 safeStorage 与 homedir 都被替换：不接触真实钥匙串，也不写入用户目录。
 * 目录保持存在不清理，避免模块 mock 的生命周期影响同进程的其他测试。
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(os.tmpdir(), 'proma-cloud-config-'))
const ORIGINAL_KEY = 'sk-test-0123456789abcdef'
const NEW_KEY = 'sk-test-ffffffffffffffff'
let configPath = ''

mock.module('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // 模拟真实加密：磁盘上不会出现明文前缀。
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf-8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempDir,
}))

type PromaCloudConfigModule = typeof import('./proma-cloud-config')
type ConfigPathsModule = typeof import('./config-paths')
let config: PromaCloudConfigModule

beforeAll(async () => {
  const configPaths: ConfigPathsModule = await import('./config-paths')
  configPath = configPaths.getPromaCloudConfigPath()
  config = await import('./proma-cloud-config')
})

beforeEach(() => {
  rmSync(configPath, { force: true })
})

describe('normalizePromaCloudBaseUrl', () => {
  test('Given no value When normalizing Then it falls back to the official base URL', () => {
    expect(config.normalizePromaCloudBaseUrl('')).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl('   ')).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl(undefined)).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl(null)).toBe('https://api.proma.cool')
  })

  test('Given an /api/v1 suffix or trailing slash When normalizing Then it is stripped and idempotent', () => {
    expect(config.normalizePromaCloudBaseUrl('https://api.proma.cool/api/v1')).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl('https://api.proma.cool/api/v1/')).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl('https://api.proma.cool/')).toBe('https://api.proma.cool')
    expect(config.normalizePromaCloudBaseUrl('  https://api.proma.cool/api/v1  ')).toBe('https://api.proma.cool')
    // 连续归一化不再变化
    const once = config.normalizePromaCloudBaseUrl('https://gateway.example.com/cloud/api/v1')
    expect(once).toBe('https://gateway.example.com/cloud')
    expect(config.normalizePromaCloudBaseUrl(once)).toBe(once)
  })

  test('Given a public http address When normalizing Then it is rejected', () => {
    expect(() => config.normalizePromaCloudBaseUrl('http://api.proma.cool')).toThrow()
    expect(() => config.normalizePromaCloudBaseUrl('http://gateway.example.com:8080')).toThrow()
  })

  test('Given a loopback http address When normalizing Then it is allowed', () => {
    expect(config.normalizePromaCloudBaseUrl('http://localhost:8080')).toBe('http://localhost:8080')
    expect(config.normalizePromaCloudBaseUrl('http://127.0.0.1:3000/api/v1')).toBe('http://127.0.0.1:3000')
  })

  test('Given embedded credentials or query/hash When normalizing Then it is rejected', () => {
    expect(() => config.normalizePromaCloudBaseUrl('https://user:pass@api.proma.cool')).toThrow()
    expect(() => config.normalizePromaCloudBaseUrl('https://api.proma.cool?token=1')).toThrow()
    expect(() => config.normalizePromaCloudBaseUrl('https://api.proma.cool#x')).toThrow()
  })

  test('Given a non-URL string or unsupported protocol When normalizing Then it is rejected', () => {
    expect(() => config.normalizePromaCloudBaseUrl('not a url')).toThrow()
    expect(() => config.normalizePromaCloudBaseUrl('ftp://api.proma.cool')).toThrow()
  })
})

describe('buildKeyHint', () => {
  test('Given a long key When building the hint Then only the last four characters are visible', () => {
    expect(config.buildKeyHint(ORIGINAL_KEY)).toBe('••••cdef')
  })

  test('Given a short key or empty value When building the hint Then it shows only the mask', () => {
    expect(config.buildKeyHint('abc1234')).toBe('••••')
    expect(config.buildKeyHint('')).toBe('')
    expect(config.buildKeyHint(undefined)).toBe('')
  })
})

describe('配置读写', () => {
  test('Given no config file When reading the summary Then it reports unconfigured defaults', () => {
    const summary = config.getPromaCloudConfigSummary()
    expect(summary.configured).toBe(false)
    expect(summary.keyHint).toBe('')
    expect(summary.baseUrl).toBe('https://api.proma.cool')
    expect(summary.webResearchEnabled).toBe(true)
    expect(config.isPromaCloudWebResearchAvailable()).toBe(false)
    expect(config.resolvePromaCloudCredentials()).toBeNull()
  })

  test('Given a saved key When reading the summary Then the plaintext never leaves the module', () => {
    const summary = config.updatePromaCloudConfig({ apiKey: ORIGINAL_KEY })
    expect(summary.configured).toBe(true)
    expect(summary.keyHint).toBe('••••cdef')
    expect(JSON.stringify(summary)).not.toContain(ORIGINAL_KEY)

    // 磁盘上只有密文
    const raw = readFileSync(configPath, 'utf-8')
    expect(raw).not.toContain(ORIGINAL_KEY)

    expect(config.resolvePromaCloudCredentials()).toEqual({
      apiKey: ORIGINAL_KEY,
      apiRoot: 'https://api.proma.cool',
    })
    expect(config.isPromaCloudWebResearchAvailable()).toBe(true)
  })

  test('Given an omitted apiKey When updating Then the stored key is preserved', () => {
    config.updatePromaCloudConfig({ apiKey: ORIGINAL_KEY })
    const summary = config.updatePromaCloudConfig({ baseUrl: 'https://gateway.example.com/api/v1' })
    expect(summary.configured).toBe(true)
    expect(summary.baseUrl).toBe('https://gateway.example.com')
    expect(config.resolvePromaCloudCredentials()?.apiKey).toBe(ORIGINAL_KEY)
  })

  test('Given an empty or null apiKey When updating Then the key is cleared', () => {
    config.updatePromaCloudConfig({ apiKey: ORIGINAL_KEY })
    expect(config.updatePromaCloudConfig({ apiKey: null }).configured).toBe(false)
    expect(config.resolvePromaCloudCredentials()).toBeNull()

    config.updatePromaCloudConfig({ apiKey: NEW_KEY })
    expect(config.updatePromaCloudConfig({ apiKey: '   ' }).configured).toBe(false)
    expect(config.isPromaCloudWebResearchAvailable()).toBe(false)
  })

  test('Given the switch is turned off When checking availability Then tools stay unavailable', () => {
    config.updatePromaCloudConfig({ apiKey: ORIGINAL_KEY })
    const summary = config.updatePromaCloudConfig({ webResearchEnabled: false })
    expect(summary.webResearchEnabled).toBe(false)
    expect(summary.configured).toBe(true)
    expect(config.isPromaCloudWebResearchAvailable()).toBe(false)
    // 凭据本身仍在：开关只影响是否注入工具
    expect(config.resolvePromaCloudCredentials()?.apiKey).toBe(ORIGINAL_KEY)
  })

  test('Given an invalid base URL When updating Then it throws and the old value is kept', () => {
    config.updatePromaCloudConfig({ apiKey: ORIGINAL_KEY, baseUrl: 'https://api.proma.cool' })
    expect(() => config.updatePromaCloudConfig({ baseUrl: 'http://api.proma.cool' })).toThrow()
    expect(config.getPromaCloudConfigSummary().baseUrl).toBe('https://api.proma.cool')
  })
})
