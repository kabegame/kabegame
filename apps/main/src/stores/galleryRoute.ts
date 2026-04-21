import { createPathRouteStore } from "./pathRoute";
import {
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PATH,
  DEFAULT_GALLERY_FILTER,
  type GalleryFilter,
  type GalleryTimeSort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";

type GalleryRouteState = {
  filter: GalleryFilter;
  sort: GalleryTimeSort;
  page: number;
  pageSize: number;
};

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>(
  "galleryRoute",
  {
    parse: (path) => {
      const parsed = parseGalleryPath(path);
      return {
        filter: parsed.filter,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
    },
    build: (state) => buildGalleryPath(state.filter, state.sort, state.page, state.pageSize),
    defaultState: () => {
      const settings = useSettingsStore();
      const stored = localStorage.getItem(GALLERY_STORAGE_KEY_PATH);
      const parsed = stored ? parseGalleryPath(stored) : null;
      return {
        filter: parsed?.filter ?? DEFAULT_GALLERY_FILTER,
        sort: parsed?.sort ?? "asc",
        page: 1, // 页码不持久化，由当前页面状态/URL 驱动
        pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
      };
    },
    routeName: "Gallery",
    onStateChange: (state) => {
      // 仅持久化 filter/sort（page 不持久化，pageSize 交 settings 统一管理）
      localStorage.setItem(
        GALLERY_STORAGE_KEY_PATH,
        buildGalleryPath(state.filter, state.sort, 1),
      );
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
  await store.navigate({ filter: { type: "all" }, page: 1 });
}
