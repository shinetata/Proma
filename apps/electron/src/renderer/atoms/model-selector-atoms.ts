/**
 * Model Selector Atoms — 模型选择器打开状态
 *
 * 供错误提示等外部入口拉起选择器使用；选择结果由各视图自行维护。
 */

import { atom } from 'jotai'

/** 模型选择器是否打开（外部入口置 true） */
export const modelSelectorOpenAtom = atom(false)
