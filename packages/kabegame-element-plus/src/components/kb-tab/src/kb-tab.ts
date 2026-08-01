import type { Component } from 'vue'

/**
 * 类型单独放 .ts 而不是留在 .vue 里：
 * 包内 env.d.ts 的 `declare module '*.vue'` 会盖掉 SFC 的具名导出，
 * 从 .vue 再导出类型会报 TS2614（上游组件也一律走这个模式）。
 */
export interface KbTabItem<T extends string = string> {
  /** 唯一标识，也是 v-model 的值 */
  name: T
  label: string
  /** 右上角计数；null/undefined 表示不显示（区别于「数量为 0」） */
  count?: number | null
  icon?: Component
  /** 只渲染图标（如末尾的「添加」按钮） */
  iconOnly?: boolean
  /** 显示删除叉号，点击 emit('close', name) 而不切换选中 */
  closable?: boolean
  /**
   * 点击时不切换选中，只 emit('select', name)。
   * 用于「添加源」这类点了要开弹窗、本身不是一个内容页的项。
   */
  action?: boolean
}
