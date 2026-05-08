import { WebSocketServer } from 'ws'
import { config } from './config.js'
import { generatePairingCode } from './auth.js'
import { RoomManager, type Room } from './room.js'

const wss = new WebSocketServer({ port: config.port })
const rooms = new RoomManager()

console.log(`[Gateway] 启动于 ws://0.0.0.0:${config.port}`)

// 心跳保活：定期 ping 所有连接
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const alive = ws as unknown as { isAlive?: boolean; terminate: () => void; ping: () => void }
    if (alive.isAlive === false) {
      return alive.terminate()
    }
    alive.isAlive = false
    ws.ping()
  })
}, config.heartbeatInterval)

wss.on('connection', (ws) => {
  let room: Room | null = null
  let role: 'desktop' | 'mobile' | null = null
  const aliveWs = ws as unknown as { isAlive?: boolean }
  aliveWs.isAlive = true

  // 心跳响应
  ws.on('pong', () => {
    aliveWs.isAlive = true
  })

  ws.on('message', (data) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data.toString())
    } catch {
      ws.send(JSON.stringify({ kind: 'error', code: 'invalid_json', message: '消息格式错误' }))
      return
    }

    // 第一条消息必须是认证
    if (!role) {
      if (msg.kind !== 'auth') {
        ws.send(JSON.stringify({ kind: 'auth_error', reason: '请先发送认证消息' }))
        ws.close()
        return
      }

      role = msg.role as 'desktop' | 'mobile'

      if (role === 'desktop') {
        // 桌面端：注册并获取短码
        const token = (msg.token as string) || ''
        const code = generatePairingCode(config.pairingCodeLength)
        room = rooms.createRoom(code, ws, token)
        ws.send(JSON.stringify({ kind: 'auth_ok', code }))
        console.log(`[Gateway] 桌面端已注册 → 短码: ${code}`)
      } else if (role === 'mobile') {
        // 移动端：用短码加入房间
        const code = msg.code as string
        if (!code) {
          ws.send(JSON.stringify({ kind: 'auth_error', reason: '缺少配对码' }))
          ws.close()
          return
        }
        room = rooms.joinRoom(code, ws)
        if (room) {
          // 配对成功，通知桌面端对端已上线
          if (room.desktop?.readyState === WebSocket.OPEN) {
            room.desktop.send(JSON.stringify({ kind: 'peer_status', status: 'online' }))
          }
          ws.send(JSON.stringify({ kind: 'auth_ok', sessionId: room.id }))
          console.log(`[Gateway] 移动端已加入 → 短码: ${code}`)
        } else {
          const reason = rooms.findRoom(ws)
            ? '该配对码已被使用'
            : '配对码无效或已过期'
          ws.send(JSON.stringify({ kind: 'auth_error', reason }))
          ws.close()
        }
      }
      return
    }

    // 后续消息：纯转发到对端
    if (room) {
      rooms.forward(room, msg, role)
    }
  })

  ws.on('close', () => {
    rooms.remove(ws)
  })

  ws.on('error', () => {
    rooms.remove(ws)
  })
})

rooms.startCleanupTimer()

// 健康检查（Bun 原生 HTTP）
const healthServer = Bun.serve({
  port: config.port + 1,
  fetch() {
    return Response.json({
      status: 'ok',
      rooms: rooms.roomCount,
      uptime: process.uptime(),
    })
  },
})
console.log(`[Gateway] 健康检查 → http://0.0.0.0:${config.port + 1}/health`)

// 优雅关闭
function shutdown() {
  console.log('\n[Gateway] 正在关闭...')
  clearInterval(heartbeatInterval)
  wss.close()
  healthServer.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
