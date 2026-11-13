import type { Component } from "vue";

/**
 * Context passed to action visibility/label/icon/suffix resolvers.
 * Used by ActionRenderer: desktop ContextMenu and Android ActionSheet share this abstraction.
 */
export interface ActionContext<T = unknown> {
  target: T | null;
  selectedIds: ReadonlySet<string>;
  selectedCount: number;
  /** Optional: total item count (e.g. grid images). Used by Android ActionSheet for select-all/deselect-all. */
  totalCount?: number;
}

const ICON_RESOLVER = Symbol("kb-action-icon-resolver");

/** 按上下文挑图标的解析器（收藏 / 已收藏、隐藏 / 取消隐藏这类两态项），用 iconBy 包出来。 */
export type ActionIconResolver<T = unknown> = ((ctx: ActionContext<T>) => Component) & { [ICON_RESOLVER]: true };

/**
 * 包一个图标解析器。不能靠 `typeof icon === "function"` 区分「解析器」与「图标组件」：
 * lucide 的图标是函数式组件，本身就是函数，会被当成解析器调用。
 */
export function iconBy<T>(resolve: (ctx: ActionContext<T>) => Component): ActionIconResolver<T> {
  return Object.assign(resolve, { [ICON_RESOLVER]: true as const });
}

/** 取一个菜单项此刻要显示的图标：解析器按上下文解析，图标组件原样返回。 */
export function resolveActionIcon<T>(icon: ActionItem<T>["icon"], ctx: ActionContext<T>): Component | undefined {
  if (typeof icon === "function" && ICON_RESOLVER in icon) return (icon as ActionIconResolver<T>)(ctx);
  return icon as Component | undefined;
}

/**
 * Single action item for context menu / action sheet.
 * Supports optional children (e.g. "更多" submenu on Android/Windows).
 */
export interface ActionItem<T = unknown> {
  key: string;
  label: string | ((ctx: ActionContext<T>) => string);
  /** 图标组件，或 iconBy(...) 包出来的按上下文解析器 */
  icon?: Component | ActionIconResolver<T>;
  command?: string;
  visible?: (ctx: ActionContext<T>) => boolean;
  disabled?: boolean | ((ctx: ActionContext<T>) => boolean);
  /** Show divider before this item */
  dividerBefore?: boolean | ((ctx: ActionContext<T>) => boolean);
  suffix?: string | ((ctx: ActionContext<T>) => string);
  className?: string;
  /** Sub-items (e.g. "更多" submenu). Rendered as submenu in ContextMenu, expandable panel in ActionSheet. */
  children?: ActionItem<T>[];
}
