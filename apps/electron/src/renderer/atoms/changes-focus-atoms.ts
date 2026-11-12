/**
 * 改动 Tab 定位请求
 *
 * 轮次改动卡等入口把要查看的文件绝对路径按会话写入这里，
 * 改动 Tab 的连续视图滚动到该文件后清除对应条目。
 */
import { atom } from 'jotai'

/** sessionId → 待定位文件的绝对路径 */
export const changesFocusPathMapAtom = atom<Map<string, string>>(new Map())
