/**
 * 消息时间格式化
 *
 * 今年：02/12 14:30；跨年：2025/02/12 14:30。
 */

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()

  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const time = `${hh}:${mm}`

  if (date.getFullYear() === now.getFullYear()) {
    return `${month}/${day} ${time}`
  }

  return `${date.getFullYear()}/${month}/${day} ${time}`
}
