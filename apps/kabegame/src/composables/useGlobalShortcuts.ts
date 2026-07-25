import { onBeforeUnmount, onMounted } from "vue";
import { IS_MACOS } from "@kabegame/core/env";
import { usePageBridgeStore } from "@/stores/pageBridge";

/**
 * 全局工具箱那几项动作的键盘入口。
 *
 * 只收录**确实绑定且生效**的组合，避免工具箱里显示一堆按不动的文案：
 * 设计稿里的 ⌘J（任务）/ F1（帮助文档）不在此列——任务入口没进工具箱，
 * 帮助文档已下线。
 */
export type ShortcutId = "openSettings" | "refresh";

interface ShortcutDef {
  /** macOS 上的展示文案；其余平台把 ⌘ 映射成 Ctrl */
  macLabel: string;
  otherLabel: string;
  match: (event: KeyboardEvent) => boolean;
}

/** 主修饰键：macOS 用 ⌘，其余平台用 Ctrl */
const primaryModifier = (event: KeyboardEvent) => (IS_MACOS ? event.metaKey : event.ctrlKey);

const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  openSettings: {
    macLabel: "⌘ ,",
    otherLabel: "Ctrl ,",
    match: (e) => primaryModifier(e) && !e.shiftKey && !e.altKey && e.key === ",",
  },
  refresh: {
    macLabel: "⇧ ⌘ R",
    otherLabel: "Ctrl Shift R",
    // 与浏览器/CEF 的硬刷新同键位，命中后 preventDefault 交给应用自己的刷新
    match: (e) => primaryModifier(e) && e.shiftKey && !e.altKey && (e.key === "R" || e.key === "r"),
  },
};

export function shortcutLabel(id: ShortcutId): string {
  const def = SHORTCUTS[id];
  return IS_MACOS ? def.macLabel : def.otherLabel;
}

/** 输入态不吃快捷键，否则在搜索框里打逗号会弹设置 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * 注册全局快捷键。挂在 App.vue 上，全应用只应有一份。
 * `openSettings` 的桌面弹窗 / 紧凑路由分流由调用方决定。
 */
export function useGlobalShortcuts(handlers: { openSettings: () => void }) {
  const pageBridge = usePageBridgeStore();

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || isTypingTarget(event.target)) return;

    if (SHORTCUTS.openSettings.match(event)) {
      event.preventDefault();
      handlers.openSettings();
      return;
    }

    if (SHORTCUTS.refresh.match(event)) {
      // 当前页面没注册刷新桥接时不拦截，让默认行为（整页重载）继续
      const refresh = pageBridge.refresh;
      if (!refresh) return;
      event.preventDefault();
      refresh();
    }
  };

  onMounted(() => window.addEventListener("keydown", onKeyDown));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeyDown));
}
