import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import type { TreeRefreshSource } from "@/components/tree/useTreeRefreshHub";

/**
 * 画廊过滤树的默认刷新事件源（= 旧实现语义）：
 * - images-change 全收（节点级再按 pluginIds 等过滤）
 * - album-images-change 只认隐藏画册的增删（隐藏语义影响 gallery 计数）
 *
 * HIDDEN_ALBUM_ID 依赖留在 app 层，树基座不认识任何业务 ID。
 */
export function defaultGalleryTreeRefreshSources(): TreeRefreshSource[] {
  return [
    { event: "images-change" },
    {
      event: "album-images-change",
      filter: (payload) =>
        (((payload as AlbumImagesChangePayload)?.albumIds) ?? []).includes(HIDDEN_ALBUM_ID),
    },
  ];
}

/** 插件列表分支额外关心的事件（旧 PluginsProviderChildrenNode 的裸监听）。 */
export const PLUGIN_LIST_EVENTS = [
  "plugin-added",
  "plugin-updated",
  "plugin-deleted",
] as const;

export function pluginListRefreshSources(): TreeRefreshSource[] {
  return PLUGIN_LIST_EVENTS.map((event) => ({ event }));
}
