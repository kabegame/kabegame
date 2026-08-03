import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  extractRootIdAndBody,
  DEFAULT_GALLERY_SEARCH_MODE,
  type GalleryFilterSet,
  type GallerySearchMode,
  type GallerySort,
} from "@/utils/galleryPath";
import type { GalleryAdvancedQuery } from "@/utils/galleryQuery";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";

/** 会话内记忆的搜索模式，清空搜索框后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
const stickySearchMode = ref<GallerySearchMode>(DEFAULT_GALLERY_SEARCH_MODE);

export function rememberAlbumDetailSearchMode(mode: GallerySearchMode): void {
  stickySearchMode.value = mode;
}

type AlbumDetailRouteState = {
  albumId: string;
  filters: GalleryFilterSet;
  /** 高级查询树；与 filters 在路由上互斥（见 GalleryQueryBar） */
  advanced: GalleryAdvancedQuery | undefined;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
  searchMode: GallerySearchMode;
};

function createDefaultState(): AlbumDetailRouteState {
  const settings = useSettingsStore();
  return {
    albumId: "",
    filters: {},
    advanced: undefined,
    sort: { field: "by-album-order", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
    search: "",
    searchMode: DEFAULT_GALLERY_SEARCH_MODE,
  };
}

export const useAlbumDetailRouteStore = createPathRouteStore<AlbumDetailRouteState>(
  "albumDetailRoute",
  {
    settingKey: "album-detail-path",
    parse: (path) => {
      const { id: albumId, body } = extractRootIdAndBody(path, "album");
      if (!albumId) return createDefaultState();
      const parsed = parseComposablePath(body, [], "by-album-order");
      if (parsed.search.trim()) {
        stickySearchMode.value = parsed.searchMode;
      }
      return {
        albumId,
        filters: parsed.filters,
        advanced: parsed.advanced,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
        searchMode: parsed.search.trim() ? parsed.searchMode : stickySearchMode.value,
      };
    },
    build: (state) =>
      buildComposablePath({
        rootPrefix: `album/${state.albumId}`,
        filters: state.filters,
        advanced: state.advanced,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
        search: state.search,
        searchMode: state.searchMode,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(
        `album/${state.albumId}`,
        state.search,
        state.searchMode,
      ),
    defaultState: createDefaultState,
    ignoreHide: (s) => s.albumId === HIDDEN_ALBUM_ID,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
