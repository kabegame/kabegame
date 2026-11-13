/**
 * 新界面组件（UI 重构）：行为与无障碍来自 reka-ui（无头原语），样式用 UnoCSS + tokens.css。
 * 逐步取代 @kabegame/element-plus；新写的界面优先从这里取。
 */
export { default as Button } from "./Button.vue";
export { default as CountBadge } from "./CountBadge.vue";
export { default as DropdownMenu } from "./DropdownMenu.vue";
export { default as DropdownMenuContent } from "./DropdownMenuContent.vue";
export { default as DropdownMenuItem } from "./DropdownMenuItem.vue";
export { default as DropdownMenuSeparator } from "./DropdownMenuSeparator.vue";
export { default as Empty } from "./Empty.vue";
export { default as Popover } from "./Popover.vue";
export { default as PopoverContent } from "./PopoverContent.vue";
export { default as Progress } from "./Progress.vue";
export { default as Switch } from "./Switch.vue";
export { default as Tabs } from "./Tabs.vue";
export type { TabItem } from "./tabs";
export { default as Tooltip } from "./Tooltip.vue";
// 触发器 / 锚点没有样式，直接用 Reka 的：<DropdownMenuTrigger as-child><Button …/></DropdownMenuTrigger>
export { DropdownMenuTrigger, PopoverAnchor, PopoverTrigger } from "reka-ui";
