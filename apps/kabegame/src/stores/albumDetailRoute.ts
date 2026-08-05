import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  extractRootIdAndBody,
  DEFAULT_GALLERY_SEARCH_MODE,
  type GalleryQuery,
  type GallerySearchMode,
  type GallerySort,
  querySearchTerm,
} from "@/utils/galleryPath";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";

/** 会话内记忆的搜索模式，搜索词清空后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
export const albumDetailStickySearchMode = ref<GallerySearchMode>(
  DEFAULT_GALLERY_SEARCH_MODE,
);

export function rememberAlbumDetailSearchMode(mode: GallerySearchMode): void {
  albumDetailStickySearchMode.value = mode;
}

type AlbumDetailRouteState = {
  albumId: string;
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
  page: number;
  pageSize: number;
};

function createDefaultState(): AlbumDetailRouteState {
  const settings = useSettingsStore();
  return {
    albumId: "",
    query: [],
    sort: { field: "by-album-order", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
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
      const term = querySearchTerm(parsed.query);
      if (term?.query.trim()) {
        albumDetailStickySearchMode.value = term.mode;
      }
      return {
        albumId,
        query: parsed.query,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
    },
    build: (state, { noAlbum }) =>
      buildComposablePath({
        rootPrefix: `album/${state.albumId}`,
        noAlbum,
        query: state.query,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(`album/${state.albumId}`, state.query),
    defaultState: createDefaultState,
    ignoreHide: (s) => s.albumId === HIDDEN_ALBUM_ID,
    // 画册里的图必然属于画册，再叠「不属于任何画册」自相矛盾：整个画册详情都赦免
    ignoreNoAlbum: () => true,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
