export type HelpPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "taskdetail"
  | "pluginbrowser"
  | "settings";

export type HelpItem<PageId extends string> = {
  id: string;
  label: string;
  description?: string;
  /** 用于过滤：哪些页面展示该条帮助 */
  pages: PageId[];
  /** 当前先做“快捷键帮助” */
  kind: "shortcut";
  keys: string[];
};

export type HelpGroup<PageId extends string> = {
  id: string;
  title: string;
  description?: string;
  items: Array<HelpItem<PageId>>;
};

/**
 * 帮助抽屉分组表
 *
 * 约束：
 * - 只收录代码中确实绑定且生效的快捷键，避免误导用户
 * - pages 用于按页面过滤（与 QuickSettingsDrawer 的逻辑一致）
 */
export const HELP_GROUPS: HelpGroup<HelpPageId>[] = [
  {
    id: "global",
    title: "全局",
    items: [
      {
        id: "global-fullscreen",
        label: "切换全屏",
        description: "切换应用的全屏显示模式",
        kind: "shortcut",
        keys: ["F11"],
        pages: [
          "gallery",
          "albums",
          "albumdetail",
          "taskdetail",
          "pluginbrowser",
          "settings",
        ],
      },
    ],
  },
  {
    id: "grid-layout",
    title: "网格布局",
    items: [
      {
        id: "grid-zoom-wheel",
        label: "调整网格列数",
        description: "按住 Ctrl（macOS 为 Cmd）并滚动鼠标滚轮，可快速调整图片网格的列数",
        kind: "shortcut",
        keys: ["Ctrl/Cmd", "滚轮"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "grid-zoom-plus-minus",
        label: "调整网格列数",
        description: "按住 Ctrl（macOS 为 Cmd）并按 +/-（或 =），可调整图片网格的列数",
        kind: "shortcut",
        keys: ["Ctrl/Cmd", "+ / -（或 =）"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
    ],
  },
  {
    id: "grid-selection",
    title: "选择/删除",
    items: [
      {
        id: "grid-select-all",
        label: "全选",
        description: "在图片网格中快速全选当前页面的所有图片",
        kind: "shortcut",
        keys: ["Ctrl/Cmd", "A"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "grid-select-range",
        label: "范围选择",
        description: "在网格中按住 Shift 点击图片，可按上次选择位置进行范围选择",
        kind: "shortcut",
        keys: ["Shift", "点击"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "grid-toggle-select",
        label: "多选/取消选择",
        description: "在网格中按住 Ctrl（macOS 为 Cmd）点击图片，可切换该图片的选择状态",
        kind: "shortcut",
        keys: ["Ctrl/Cmd", "点击"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "grid-clear-selection",
        label: "清空选择",
        description: "清空已选择的图片，并关闭可能打开的右键菜单",
        kind: "shortcut",
        keys: ["Esc"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "grid-delete",
        label: "删除选中图片",
        description: "在图片网格中删除当前选中的图片（会进入应用的删除流程/确认）",
        kind: "shortcut",
        keys: ["Delete / Backspace"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
    ],
  },
  {
    id: "preview",
    title: "预览",
    items: [
      {
        id: "preview-prev-next",
        label: "上一张/下一张",
        description: "在图片预览对话框中切换上一张/下一张",
        kind: "shortcut",
        keys: ["←", "→"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
      {
        id: "preview-delete",
        label: "预览中删除",
        description: "在图片预览对话框中快速删除当前图片（会进入应用的删除流程/确认）",
        kind: "shortcut",
        keys: ["Delete / Backspace"],
        pages: ["gallery", "albumdetail", "taskdetail"],
      },
    ],
  },
];

