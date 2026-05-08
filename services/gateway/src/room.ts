import WebSocket from 'ws'
import { config } from './config.js'

export interface Room {
  id: string
  desktop: WebSocket | null
  mobile: WebSocket | null
  createdAt: number
  /** 由桌面端在 auth 时提供的配对 token（Gateway 验证用） */
  desktopToken: string | null
}

export class RoomManager {
  private rooms = new Map<string, Room>()

  /** 桌面端创建房间（携带配对 token） */
  createRoom(code: string, desktopWs: WebSocket, token: string): Room {
    const room: Room = {
      id: code,
      desktop: desktopWs,
      mobile: null,
      createdAt: Date.now(),
      desktopToken: token,
    }
    this.rooms.set(code, room)
    return room
  }

  /** 移动端用短码加入房间 */
  joinRoom(code: string, mobileWs: WebSocket): Room | null {
    const room = this.rooms.get(code)
    if (!room) return null

    // 防止 5 分钟后的重复配对
    if (Date.now() - room.createdAt > config.unpairedRoomTTL) {
      this.rooms.delete(code)
      return null
    }

    // 防止重复配对（一个短码只能用于一个移动端）
    if (room.mobile !== null) return null

    room.mobile = mobileWs
    return room
  }

  /** 消息转发：根据来源路由到对端 */
  forward(room: Room, message: object, from: 'desktop' | 'mobile'): void {
    const target = from === 'desktop' ? room.mobile : room.desktop
    if (target?.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(message))
    }
  }

  /** 断开时清理房间并通知对端 */
  remove(ws: WebSocket): void {
    for (const [code, room] of this.rooms) {
      if (room.desktop === ws || room.mobile === ws) {
        const peer = room.desktop === ws ? room.mobile : room.desktop
        if (peer?.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ kind: 'peer_status', status: 'offline' }))
        }
        this.rooms.delete(code)
        break
      }
    }
  }

  /** 根据 WebSocket 查找其所在房间 */
  findRoom(ws: WebSocket): Room | null {
    for (const room of this.rooms.values()) {
      if (room.desktop === ws || room.mobile === ws) return room
    }
    return null
  }

  /** 定时清理过期房间 */
  startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now()
      for (const [code, room] of this.rooms) {
        const age = now - room.createdAt
        const expired =
          // 未配对房间（只有桌面端等待连接）：超时清理
          (room.mobile === null && age > config.unpairedRoomTTL) ||
          // 已配对房间：超时清理
          (room.mobile !== null && age > config.pairedRoomTTL)

        if (expired) {
          room.desktop?.close()
          room.mobile?.close()
          this.rooms.delete(code)
        }
      }
    }, config.cleanupInterval)
  }

  /** 获取当前活跃房间数（用于健康检查） */
  get roomCount(): number {
    return this.rooms.size
  }
}
