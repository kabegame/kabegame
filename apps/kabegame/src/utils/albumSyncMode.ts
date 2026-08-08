import type { Component } from "vue";
import { Connection, FolderChecked, Link } from "@kabegame/element-plus-icons";
import { i18n } from "@kabegame/i18n";
import type { AlbumSyncMode } from "@kabegame/core/types/album";

export function syncModeLabel(mode: AlbumSyncMode): string {
  return i18n.global.t(`albums.localFolder.syncMode.${mode}.label`);
}

export function syncModeTooltip(mode: AlbumSyncMode): string {
  return i18n.global.t(`albums.localFolder.syncMode.${mode}.description`);
}

export function syncModeIcon(mode: AlbumSyncMode): Component | null {
  switch (mode) {
    case "shallow":
      return FolderChecked;
    case "recursive":
      return Connection;
    case "delegated":
      return Link;
    default:
      return null;
  }
}

/** 委托态是派生状态，视觉权重低于用户主动选择的两种同步状态。 */
export function syncModeIconClass(mode: AlbumSyncMode): string {
  if (mode === "delegated") {
    return "text-[var(--anime-text-muted)] opacity-55";
  }
  if (mode === "recursive") {
    return "text-[var(--anime-primary)]";
  }
  return "text-[#7c3aed]";
}
