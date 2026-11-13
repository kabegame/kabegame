import type { InjectionKey, Ref } from "vue";

/** 过滤 chip 下拉（FilterDropdown，组件名 KbFilterDropdown）的类型与上下文。 */

export interface KbFilterDropdownOption {
  label: string;
  value: string;
  /** null / undefined 表示不显示；0 是有效计数。 */
  count?: number;
  /** 点它不选中，而是在它下方展开 `option-panel` 插槽（由调用侧在面板里完成选择）。 */
  expandable?: boolean;
}

export interface KbFilterDropdownPanelSlotProps {
  close: () => void;
}

/** `option-panel` 插槽：可展开选项的展开区。`close` 让面板内容在完成选择后关掉整个下拉。 */
export interface KbFilterDropdownOptionPanelSlotProps {
  option: KbFilterDropdownOption;
  close: () => void;
}

/**
 * 面板的承载方式。
 * - `popover`（默认）：chip 下方弹层。
 * - `dialog`：点 chip 弹出对话框，面板内容原样放进对话框主体。窄屏（安卓）上弹层贴着 chip
 *   挤在屏幕一角，不好点也装不下树形面板，改成居中对话框。
 */
export type KbFilterDropdownPanelMode = "popover" | "dialog";

/** 由祖先组件 provide（App.vue 按紧凑布局切换），整棵子树里的过滤 chip 统一切换承载方式。 */
export interface KbFilterDropdownContext {
  panelMode?: Ref<KbFilterDropdownPanelMode> | KbFilterDropdownPanelMode;
}

export const kbFilterDropdownContextKey: InjectionKey<KbFilterDropdownContext> = Symbol("kbFilterDropdownContext");
