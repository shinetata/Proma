/**
 * RemoteAuth — 配对认证模块
 *
 * 生成短码和 Token，供桌面端与移动端通过 Gateway 配对。
 * 短码有效期 5 分钟，用完即失效。
 */
import crypto from 'node:crypto'

/** 短码字符集（排除易混淆字符：0/O、1/I/L） */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 配对记录 */
interface PairingRecord {
  /** 桌面端连接 Gateway 用的 token */
  desktopToken: string
  createdAt: number
}

/** 默认短码长度 */
const DEFAULT_CODE_LENGTH = 6

/** 配对有效期（毫秒），默认 5 分钟 */
const PAIRING_TTL_MS = 5 * 60 * 1000

class RemoteAuth {
  private pairingTokens = new Map<string, PairingRecord>()

  /**
   * 生成配对短码和关联的 token
   */
  generatePairingCode(gatewayUrl: string, length = DEFAULT_CODE_LENGTH): {
    code: string
    qrContent: string
    token: string
  } {
    const bytes = crypto.randomBytes(length)
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    const token = crypto.randomBytes(32).toString('hex')

    this.pairingTokens.set(code, { desktopToken: token, createdAt: Date.now() })

    // QR 码内容：含 Gateway 地址和配对短码
    const qrContent = `proma-remote://pair?gateway=${encodeURIComponent(gatewayUrl)}&code=${code}`

    return { code, qrContent, token }
  }

  /**
   * 验证配对短码，返回对应的桌面端 token
   */
  validatePairing(code: string): { desktopToken: string } | null {
    const record = this.pairingTokens.get(code)
    if (!record) return null

    if (Date.now() - record.createdAt > PAIRING_TTL_MS) {
      this.pairingTokens.delete(code)
      return null
    }

    this.pairingTokens.delete(code)
    return { desktopToken: record.desktopToken }
  }

  /** 清理过期记录 */
  cleanup(): void {
    const now = Date.now()
    for (const [code, record] of this.pairingTokens) {
      if (now - record.createdAt > PAIRING_TTL_MS) {
        this.pairingTokens.delete(code)
      }
    }
  }
}

export const remoteAuth = new RemoteAuth()
