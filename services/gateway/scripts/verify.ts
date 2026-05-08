/**
 * Gateway 异常场景验证脚本
 * 使用 Gateway 已有的 ws 依赖，不额外安装任何包
 */
import WebSocket from 'ws'

const GATEWAY = 'ws://localhost:3001'
const results: { scenario: string; passed: boolean; detail: string }[] = []

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function connect(): Promise<{ ws: WebSocket; nextMsg: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY)
    const messages: any[] = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    ws.on('open', () => resolve({
      ws,
      nextMsg: () => new Promise(r => {
        const check = () => { if (messages.length) r(messages.shift()); else setTimeout(check, 50) }
        check()
      }),
    }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('连接超时')), 5000)
  })
}

async function main() {
  // === 场景 1: 无效短码 ===
  try {
    const { ws, nextMsg } = await connect()
    ws.send(JSON.stringify({ kind: 'auth', role: 'mobile', code: 'WRONG1' }))
    const resp = await nextMsg()
    const ok = resp.kind === 'auth_error' && resp.reason.includes('无效')
    results.push({ scenario: '无效短码', passed: ok, detail: JSON.stringify(resp) })
    ws.close()
  } catch (e) {
    results.push({ scenario: '无效短码', passed: false, detail: String(e) })
  }

  // === 场景 2: 重复配对 ===
  try {
    // 先创建桌面端房间
    const desk = await connect()
    desk.ws.send(JSON.stringify({ kind: 'auth', role: 'desktop', token: 't1' }))
    const deskAuth = await desk.nextMsg()
    const code = deskAuth.code as string

    // 第一个移动端成功加入
    const mob1 = await connect()
    mob1.ws.send(JSON.stringify({ kind: 'auth', role: 'mobile', code }))
    const m1resp = await mob1.nextMsg()

    // 第二个移动端尝试用同一code — 应被拒绝
    const mob2 = await connect()
    mob2.ws.send(JSON.stringify({ kind: 'auth', role: 'mobile', code }))
    const m2resp = await mob2.nextMsg()

    const ok = m1resp.kind === 'auth_ok' && m2resp.kind === 'auth_error'
    results.push({
      scenario: '重复配对',
      passed: ok,
      detail: `mobile1: ${JSON.stringify(m1resp)} / mobile2: ${JSON.stringify(m2resp)}`,
    })

    desk.ws.close(); mob1.ws.close(); mob2.ws.close()
  } catch (e) {
    results.push({ scenario: '重复配对', passed: false, detail: String(e) })
  }

  // === 场景 3: 健康检查 ===
  try {
    const resp = await fetch('http://localhost:3002/health')
    const data = await resp.json()
    const ok = data.status === 'ok' && typeof data.rooms === 'number' && typeof data.uptime === 'number'
    results.push({ scenario: '健康检查', passed: ok, detail: JSON.stringify(data) })
  } catch (e) {
    results.push({ scenario: '健康检查', passed: false, detail: String(e) })
  }

  // === 场景 4: 断线通知 ===
  try {
    const desk = await connect()
    desk.ws.send(JSON.stringify({ kind: 'auth', role: 'desktop', token: 't2' }))
    const deskAuth = await desk.nextMsg()
    const code = deskAuth.code as string

    const mob = await connect()
    mob.ws.send(JSON.stringify({ kind: 'auth', role: 'mobile', code }))
    const mauth = await mob.nextMsg()
    // 配对成功后关闭桌面端
    desk.ws.close()
    const notification = await mob.nextMsg()
    const ok = notification.kind === 'peer_status' && notification.status === 'offline'
    results.push({ scenario: '断线通知', passed: ok, detail: JSON.stringify(notification) })
    mob.ws.close()
  } catch (e) {
    results.push({ scenario: '断线通知', passed: false, detail: String(e) })
  }

  // === 输出结果 ===
  console.log('\n========== Gateway 异常场景验证结果 ==========\n')
  let allPassed = true
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌'
    if (!r.passed) allPassed = false
    console.log(`${icon}  ${r.scenario}`)
    console.log(`   ${r.detail}\n`)
  }
  console.log(allPassed ? '全部通过 🎉' : '存在失败，请检查')
  process.exit(allPassed ? 0 : 1)
}

main()
