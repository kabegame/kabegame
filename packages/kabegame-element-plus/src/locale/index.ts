// 仅保留 kabegame 支持的 5 种语言，与 packages/kabegame-i18n/src/locales 对齐。
// 上游 element-plus 原本 re-export 全部 67 种，其余已随 lang/ 一并删除。
export { default as en } from './lang/en'
export { default as ja } from './lang/ja'
export { default as ko } from './lang/ko'
export { default as zhCn } from './lang/zh-cn'
export { default as zhTw } from './lang/zh-tw'

export type TranslatePair = {
  [key: string]: string | string[] | TranslatePair
}

export type Language = {
  name: string
  el: TranslatePair
}
