import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildGalleryContextPrefix,
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PATH,
  DEFAULT_GALLERY_FILTER_SET,
  DEFAULT_GALLERY_SEARCH_MODE,
  newRandomSortSeed,
  type GalleryFilterSet,
  type GallerySearchMode,
  type GallerySort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WEB } from "@kabegame/core/env";

/**
 * web 版默认随机排序的种子：每次加载页面换一批图，但整个会话内保持同一次洗牌
 * （defaultState 在 path 为空时会被反复求值，每次现生成会让翻页乱序）。
 */
let cachedWebRandomSeed: string | null = null;
const webRandomSeed = () => (cachedWebRandomSeed ??= newRandomSortSeed());

/**
 * 会话内记忆的搜索模式。`search/<mode>/<query>/` 只有 query 非空才会进 path——
 * 清空搜索框后 query 变空，若仍想把 mode 编进 path 会撞上两个后端限制：
 * pathql-rs 的 `normalize_segments` 会丢弃空字符串路径段（下一个真实过滤词会被
 * 误当成 query 文本），且 metadata/native-metadata 的 `LEFT JOIN` 列在空 query 下
 * `NULL LIKE '%%'` 恒非真，等于把没有该元数据的图片全部滤掉。两者都不该动引擎/
 * WHERE 表达式去迁就一个纯 UI 偏好，所以 mode 在 query 清空后不再由 path 承载，
 * 改用这个 ref 兜底——`parse()` 读它，下拉框选择时直接写它。
 */
const stickySearchMode = ref<GallerySearchMode>(DEFAULT_GALLERY_SEARCH_MODE);

/** 手动记住当前搜索模式，供下拉框切换时调用（见 stickySearchMode 注释）。 */
export function rememberGallerySearchMode(mode: GallerySearchMode): void {
  stickySearchMode.value = mode;
}

type GalleryRouteState = {
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
  searchMode: GallerySearchMode;
};

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>(
  "galleryRoute",
  {
    settingKey: "gallery-path",
    parse: (path) => {
      const parsed = parseGalleryPath(path);
      if (parsed.search.trim()) {
        stickySearchMode.value = parsed.searchMode;
      }
      return {
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
        searchMode: parsed.search.trim() ? parsed.searchMode : stickySearchMode.value,
      };
    },
    build: (state) =>
      buildGalleryPath(
        state.filters,
        state.sort,
        state.page,
        state.pageSize,
        state.search,
        state.searchMode,
      ),
    buildContext: (state) => buildGalleryContextPrefix(state.search, state.searchMode),
    defaultState: () => {
      const settings = useSettingsStore();
      const stored = IS_WEB ? null : localStorage.getItem(GALLERY_STORAGE_KEY_PATH);
      const parsed = stored ? parseGalleryPath(stored) : null;
      const defaultSort: GallerySort = IS_WEB
        ? { field: "random", desc: false, seed: webRandomSeed() }
        : { field: "by-id", desc: false };
      return {
        filters: parsed?.filters ?? DEFAULT_GALLERY_FILTER_SET,
        sort: parsed?.sort ?? defaultSort,
        page: 1, // 页码不持久化，由当前页面状态/URL 驱动
        pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
        search: "", // 搜索词/模式不持久化
        searchMode: DEFAULT_GALLERY_SEARCH_MODE,
      };
    },
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
  rememberGallerySearchMode(DEFAULT_GALLERY_SEARCH_MODE);
  await store.navigate({ filters: {}, page: 1, search: "", searchMode: DEFAULT_GALLERY_SEARCH_MODE });
}
