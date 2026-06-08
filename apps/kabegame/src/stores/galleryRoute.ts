import { createPathRouteStore } from "./pathRoute";
import {
  buildGalleryContextPrefix,
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PATH,
  DEFAULT_GALLERY_FILTER_SET,
  type GalleryFilterSet,
  type GallerySort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WEB } from "@kabegame/core/env";

type GalleryRouteState = {
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
};

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>(
  "galleryRoute",
  {
    parse: (path) => {
      const parsed = parseGalleryPath(path);
      return {
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
      };
    },
    build: (state) =>
      buildGalleryPath(state.filters, state.sort, state.page, state.pageSize, state.search),
    buildContext: (state) => buildGalleryContextPrefix(state.search),
    defaultState: () => {
      const settings = useSettingsStore();
      const stored = IS_WEB ? null : localStorage.getItem(GALLERY_STORAGE_KEY_PATH);
      const parsed = stored ? parseGalleryPath(stored) : null;
      const defaultSort: GallerySort = { field: "by-id", desc: IS_WEB };
      return {
        filters: parsed?.filters ?? DEFAULT_GALLERY_FILTER_SET,
        sort: parsed?.sort ?? defaultSort,
        page: 1, // 页码不持久化，由当前页面状态/URL 驱动
        pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
        search: "", // 搜索词不持久化
      };
    },
    routeName: "Gallery",
    onStateChange: (state) => {
      // 仅持久化 filter/sort（page / search 不持久化，pageSize 交 settings 统一管理）
      if (!IS_WEB) {
        localStorage.setItem(
          GALLERY_STORAGE_KEY_PATH,
          buildGalleryPath(state.filters, state.sort, 1),
        );
      }
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);

/** 回到默认「全部」第 1 页（用于错误兜底等） */
export async function resetGalleryRouteToDefault() {
  const store = useGalleryRouteStore();
  await store.navigate({ filters: {}, page: 1, search: "" });
}
