import type { Component } from "vue";

/**
 * Context passed to action visibility/label/icon/suffix resolvers.
 * Used by ActionRenderer: desktop ContextMenu and Android ActionSheet share this abstraction.
 */
export interface ActionContext<T = unknown> {
  target: T | null;
  selectedIds: ReadonlySet<string>;
  selectedCount: number;
}

/**
 * Single action item for context menu / action sheet.
 * Supports optional children (e.g. "更多" submenu on Android/Windows).
 */
export interface ActionItem<T = unknown> {
  key: string;
  label: string | ((ctx: ActionContext<T>) => string);
  icon?: Component | ((ctx: ActionContext<T>) => Component);
  command?: string;
  visible?: (ctx: ActionContext<T>) => boolean;
  /** Show divider before this item */
  dividerBefore?: boolean | ((ctx: ActionContext<T>) => boolean);
  suffix?: string | ((ctx: ActionContext<T>) => string);
  className?: string;
  /** Sub-items (e.g. "更多" submenu). Rendered as submenu in ContextMenu, expandable panel in ActionSheet. */
  children?: ActionItem<T>[];
}
