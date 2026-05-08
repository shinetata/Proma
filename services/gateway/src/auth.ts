/** 配对短码字符集（排除易混淆字符：0/O、1/I/L） */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 生成指定长度的随机配对短码
 */
export function generatePairingCode(length = 6): string {
  const chars = new Array(length)
  const randomBytes = new Uint8Array(length)
  crypto.getRandomValues(randomBytes)
  for (let i = 0; i < length; i++) {
    chars[i] = CODE_ALPHABET[randomBytes[i] % CODE_ALPHABET.length]
  }
  return chars.join('')
}

/**
 * 生成随机 Token（64 字符 hex）
 */
export function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
