import type { TreeRefreshSource } from "@/components/tree/useTreeRefreshHub";

/**
 * 画廊过滤树的默认刷新事件源（= 旧实现语义）：
 * - images-change 全收（节点级再按 pluginIds 等过滤）
 * 隐藏/取消隐藏会额外发送 images-change，因此无需第二条专用事件源。
 */
export function defaultGalleryTreeRefreshSources(): TreeRefreshSource[] {
  return [{ event: "images-change" }];
}

/** 插件列表分支额外关心的事件（旧 PluginsProviderChildrenNode 的裸监听）。 */
export const PLUGIN_LIST_EVENTS = ["plugin-added", "plugin-updated", "plugin-deleted"] as const;

export function pluginListRefreshSources(): TreeRefreshSource[] {
  return PLUGIN_LIST_EVENTS.map((event) => ({ event }));
}
