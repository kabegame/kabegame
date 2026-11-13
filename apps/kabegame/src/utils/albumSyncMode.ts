import type { Component } from "vue";
import { FolderCheck, FolderTree, Link } from "@lucide/vue";
import { i18n } from "@kabegame/i18n";
import type { AlbumSyncMode } from "@/types/album";

export function syncModeLabel(mode: AlbumSyncMode): string {
  return i18n.global.t(`albums.localFolder.syncMode.${mode}.label`);
}

export function syncModeTooltip(mode: AlbumSyncMode): string {
  return i18n.global.t(`albums.localFolder.syncMode.${mode}.description`);
}

export function syncModeIcon(mode: AlbumSyncMode): Component | null {
  switch (mode) {
    case "shallow":
      return FolderCheck;
    case "recursive":
      return FolderTree;
    case "delegated":
      return Link;
    default:
      return null;
  }
}

/**
 * 委托态是派生状态，视觉权重低于用户主动选择的两种同步状态。两种主动状态靠图标形状区分，不再各给一个颜色。
 * 类名要被 UnoCSS 生成，调用处的 .vue 里有同样的字面量（.ts 默认不扫描）：AlbumTreeView / AlbumDetailPanel。
 */
export function syncModeIconClass(mode: AlbumSyncMode): string {
  return mode === "delegated" ? "text-kb-fg-subtle opacity-70" : "text-kb-fg-muted";
}
