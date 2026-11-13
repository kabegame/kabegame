import type { Component } from "vue";

/**
 * Tabs 的条目。类型单独放 .ts：从 .vue 具名导出类型在部分工具链里会被 `declare module '*.vue'` 盖掉。
 * 接口沿用 vendored KbTab，四处调用只换导入。
 */
export interface TabItem<T extends string = string> {
  /** 唯一标识，也是 v-model 的值 */
  name: T;
  label: string;
  /** 文字后的计数；null / undefined 不显示（区别于「数量为 0」） */
  count?: number | null;
  /** 右上角角标（CountBadge）；0 / null 不显示 */
  badge?: number | null;
  icon?: Component;
  /** 只渲染图标（如末尾的「添加」），label 进 aria-label 与提示 */
  iconOnly?: boolean;
  /** 显示删除叉号，点击 emit('close', name) 而不切换选中 */
  closable?: boolean;
  /** 不是一个内容页：点击只 emit('select', name)，不切换选中（如「添加源」） */
  action?: boolean;
}
