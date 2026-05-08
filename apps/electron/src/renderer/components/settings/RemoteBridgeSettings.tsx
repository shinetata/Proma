/**
 * RemoteBridgeSettings — 远程协作设置
 *
 * 展示配对码和连接状态，支持连接/断开 Gateway。
 */
import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { Smartphone, Wifi, WifiOff, Copy, Check } from 'lucide-react'
import QRCode from 'qrcode'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'

type ConnState = 'idle' | 'generating' | 'ready' | 'connecting' | 'connected' | 'error'

export function RemoteBridgeSettings() {
  const [gatewayUrl, setGatewayUrl] = useState('ws://localhost:3001')
  const [state, setState] = useState<ConnState>('idle')
  const [pairingCode, setPairingCode] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [token, setToken] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [connected, setConnected] = useState(false)

  // 检查当前连接状态
  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.getRemoteStatus()
      setConnected(status.connected)
      if (status.connected) setState('connected')
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  // 生成配对码
  const handleGenerate = async () => {
    setState('generating')
    setErrorMsg('')
    try {
      const result = await window.electronAPI.generateRemotePairingCode(gatewayUrl)
      setPairingCode(result.code)
      setToken(result.token)
      const dataUrl = await QRCode.toDataURL(result.qrContent, {
        width: 200,
        margin: 2,
        color: { dark: '#000', light: '#fff' },
      })
      setQrDataUrl(dataUrl)
      setState('ready')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '生成失败')
      setState('error')
    }
  }

  // 连接
  const handleConnect = async () => {
    setState('connecting')
    setErrorMsg('')
    try {
      await window.electronAPI.connectRemote(gatewayUrl, token, pairingCode)
      setConnected(true)
      setState('connected')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '连接失败')
      setState('error')
    }
  }

  // 断开
  const handleDisconnect = async () => {
    await window.electronAPI.disconnectRemote()
    setConnected(false)
    setState('idle')
    setPairingCode('')
    setQrDataUrl('')
    setToken('')
  }

  // 复制短码
  const handleCopy = () => {
    navigator.clipboard.writeText(pairingCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="连接手机">
        <SettingsCard>
          {/* Gateway 地址 */}
          <SettingsRow label="Gateway 地址">
            <Input
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="ws://your-gateway:3001"
              disabled={state === 'connected' || state === 'connecting'}
              className="font-mono text-sm"
            />
          </SettingsRow>

          {/* 操作按钮 */}
          <SettingsRow label="操作">
            <div className="flex gap-2">
              {state !== 'connected' ? (
                <>
                  <Button
                    onClick={handleGenerate}
                    disabled={state === 'generating' || state === 'connecting'}
                    variant="outline"
                    size="sm"
                  >
                    生成配对码
                  </Button>
                  {state === 'ready' && (
                    <Button onClick={handleConnect} size="sm">
                      连接
                    </Button>
                  )}
                </>
              ) : (
                <Button onClick={handleDisconnect} variant="destructive" size="sm">
                  断开连接
                </Button>
              )}
            </div>
          </SettingsRow>

          {/* 连接状态 */}
          <SettingsRow label="状态">
            <div className="flex items-center gap-2 text-sm">
              {connected ? (
                <>
                  <Wifi size={14} className="text-green-500" />
                  <span className="text-green-600 dark:text-green-400">已连接</span>
                </>
              ) : (
                <>
                  <WifiOff size={14} className="text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {state === 'connecting' ? '连接中...' : '未连接'}
                  </span>
                </>
              )}
            </div>
          </SettingsRow>

          {/* 配对码展示 */}
          {pairingCode && state !== 'connected' && (
            <SettingsRow label="配对码（5 分钟内有效）">
              <div className="flex items-center gap-2">
                <span className="font-mono text-2xl font-bold tracking-[0.3em] text-primary">
                  {pairingCode}
                </span>
                <Button variant="ghost" size="icon" onClick={handleCopy} title="复制">
                  {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </Button>
              </div>
            </SettingsRow>
          )}

          {/* QR 码 */}
          {qrDataUrl && state !== 'connected' && (
            <SettingsRow label="扫码连接">
              <div className="rounded-lg border bg-white p-2">
                <img src={qrDataUrl} alt="配对 QR 码" className="size-[200px]" />
              </div>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 错误提示 */}
      {errorMsg && (
        <SettingsSection title="错误">
          <SettingsCard>
            <p className="text-sm text-destructive">{errorMsg}</p>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 使用说明 */}
      <SettingsSection title="使用说明">
        <SettingsCard>
          <ol className="list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
            <li>先在终端启动 Gateway：<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">cd services/gateway && bun run dev</code></li>
            <li>点击「生成配对码」获取 6 位短码和 QR 码</li>
            <li>点击「连接」建立与 Gateway 的通道</li>
            <li>在手机 App 中输入短码或扫码完成配对</li>
          </ol>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
