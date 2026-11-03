/**
 * Channel Atoms — 渠道列表状态
 *
 * 启动时加载一次，设置变更时刷新。Agent 与设置页共享同一份渠道缓存。
 */

import { atom } from 'jotai'
import type { Channel } from '@proma/shared'

/** 全局渠道列表缓存 */
export const channelsAtom = atom<Channel[]>([])

/** 渠道列表是否已完成首次加载 */
export const channelsLoadedAtom = atom(false)
