/** Gateway 运行配置，全部可通过环境变量覆盖 */

export const config = {
  /** WebSocket 服务端口 */
  port: parseInt(process.env.GATEWAY_PORT || '3001', 10),

  /** 未配对房间过期时间（毫秒），默认 5 分钟 */
  unpairedRoomTTL: parseInt(process.env.UNPAIRED_ROOM_TTL || '300000', 10),

  /** 已配对房间过期时间（毫秒），默认 24 小时 */
  pairedRoomTTL: parseInt(process.env.PAIRED_ROOM_TTL || '86400000', 10),

  /** 房间清理定时器间隔（毫秒），默认 60 秒 */
  cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '60000', 10),

  /** 配对短码长度 */
  pairingCodeLength: parseInt(process.env.PAIRING_CODE_LENGTH || '6', 10),

  /** 心跳间隔（毫秒），默认 30 秒 */
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10),
} as const
