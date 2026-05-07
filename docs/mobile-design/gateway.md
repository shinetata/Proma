# Gateway 中继服务器设计

## 定位

Gateway 是一个极薄的 WebSocket 消息路由层，**不处理任何业务逻辑**。它只做三件事：认证、房间管理、消息转发。

## 技术选型

Node.js + `ws` 库即可，无数据库依赖。房间状态全部在内存中（重启丢失可以接受，因为两端会自动重连）。

## 核心代码结构

```
proma-gateway/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          ← 入口，启动 WS server
│   ├── room.ts           ← 房间管理
│   ├── auth.ts           ← 配对认证
│   └── config.ts         ← 端口、超时等配置
└── Dockerfile            ← 可选容器化部署
```

## 房间管理

```typescript
// src/room.ts

interface Room {
  id: string                    // 配对 short code
  desktop: WebSocket | null
  mobile: WebSocket | null
  createdAt: number
}

class RoomManager {
  private rooms = new Map<string, Room>()

  // 桌面端注册（携带生成的随机 token）
  createRoom(code: string, desktopWs: WebSocket): Room {
    const room: Room = {
      id: code,
      desktop: desktopWs,
      mobile: null,
      createdAt: Date.now(),
    }
    this.rooms.set(code, room)
    return room
  }

  // 移动端加入（使用短码）
  joinRoom(code: string, mobileWs: WebSocket): Room | null {
    const room = this.rooms.get(code)
    if (!room) return null

    // 防止 5 分钟后的重复配对
    if (Date.now() - room.createdAt > 5 * 60 * 1000) {
      this.rooms.delete(code)
      return null
    }

    room.mobile = mobileWs
    return room
  }

  // 消息转发：只负责路由
  forward(room: Room, message: object, from: 'desktop' | 'mobile'): void {
    const target = from === 'desktop' ? room.mobile : room.desktop
    if (target?.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(message))
    }
  }

  // 清理
  remove(ws: WebSocket): void {
    for (const [code, room] of this.rooms) {
      if (room.desktop === ws || room.mobile === ws) {
        // 通知另一端
        const peer = room.desktop === ws ? room.mobile : room.desktop
        if (peer?.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ kind: 'peer_status', status: 'offline' }))
        }
        this.rooms.delete(code)
        break
      }
    }
  }

  // 定时清理过期房间
  startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now()
      for (const [code, room] of this.rooms) {
        // 5 分钟未配对的房间 + 24 小时已配对的房间 → 清理
        if ((room.mobile === null && now - room.createdAt > 5 * 60 * 1000) ||
            (room.mobile !== null && now - room.createdAt > 24 * 60 * 60 * 1000)) {
          room.desktop?.close()
          room.mobile?.close()
          this.rooms.delete(code)
        }
      }
    }, 60_000)
  }
}
```

## WebSocket 服务器

```typescript
// src/index.ts
import { WebSocketServer } from 'ws'

const wss = new WebSocketServer({ port: 3001 })
const rooms = new RoomManager()

wss.on('connection', (ws) => {
  let room: Room | null = null
  let role: 'desktop' | 'mobile' | null = null

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())

    // 第一条消息必须是认证
    if (!role) {
      if (msg.kind === 'auth') {
        role = msg.role
        if (role === 'desktop') {
          // 桌面端：生成短码
          const code = generatePairingCode()
          room = rooms.createRoom(code, ws)
          ws.send(JSON.stringify({ kind: 'auth_ok', code }))
        } else if (role === 'mobile') {
          // 移动端：用短码加入
          room = rooms.joinRoom(msg.code, ws)
          if (room) {
            ws.send(JSON.stringify({ kind: 'auth_ok', sessionId: room.id }))
          } else {
            ws.send(JSON.stringify({ kind: 'auth_error', reason: '配对码无效或已过期' }))
            ws.close()
          }
        }
      }
      return
    }

    // 后续消息：纯转发
    if (room) {
      rooms.forward(room, msg, role)
    }
  })

  ws.on('close', () => {
    rooms.remove(ws)
  })
})

rooms.startCleanupTimer()
```

## 部署选项

| 方案 | 说明 |
|------|------|
| 用户自建 VPS | `node dist/index.js` 或 `docker compose up` |
| 后期托管 | Proma Cloud Gateway，免部署 |

Gateway 总共约 150 行逻辑代码，可运行在任何 Node.js 环境。

## 安全边界

1. **不存任何数据**：消息纯转发，不持久化
2. **短码一次性**：配对后短码即失效
3. **Token 认证**：桌面端和移动端各自持有随机 token
4. **WSS 传输加密**：生产环境强制 `wss://`
5. **过期清理**：未配对房间 5 分钟过期，已配对 24 小时后自动断开
