import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  DEFAULT_GALLERY_SEARCH_MODE,
  type GalleryQuery,
  type GallerySearchMode,
  type GallerySort,
  querySearchTerm,
} from "@/utils/galleryPath";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useAlbumIdPathState, lastAlbumIdOf } from "@/composables/useAlbumIdPathState";

/** 会话内记忆的搜索模式，搜索词清空后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
export const albumDetailStickySearchMode = ref<GallerySearchMode>(
  DEFAULT_GALLERY_SEARCH_MODE,
);

export function rememberAlbumDetailSearchMode(mode: GallerySearchMode): void {
  albumDetailStickySearchMode.value = mode;
}

/**
 * 当前选中画册 id：真源是 `albumIdPath`（见 useAlbumIdPathState），不再是本 store
 * 的 state 字段——避免「path 里塞一份、树选中态塞另一份」两处真源打架。
 */
function currentAlbumId(): string {
  return lastAlbumIdOf(useAlbumIdPathState().albumIdPath.value);
}

type AlbumDetailRouteState = {
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
  page: number;
  pageSize: number;
};

function createDefaultState(): AlbumDetailRouteState {
  const settings = useSettingsStore();
  return {
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
    // 存储 path 即查询体：画册身份已搬到独立的 albumIdPath，不再 extractRootIdAndBody
    // 剥 `album/<id>/` 前缀。
    parse: (path) => {
      const parsed = parseComposablePath(path, [], "by-album-order");
      const term = querySearchTerm(parsed.query);
      if (term?.query.trim()) {
        albumDetailStickySearchMode.value = term.mode;
      }
      return {
        query: parsed.query,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
    },
    // 持久化形态（settingKey 实际写入值）：无 album/<id> 前缀，只存查询体本身。
    build: (state, { noAlbum }) =>
      buildComposablePath({
        noAlbum,
        query: state.query,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
      }),
    // 查询出口：computedPath / computeTargetPath 等 pathql 消费方（ImageGrid 等）
    // 仍需要完整 album/<id> 前缀，从 currentAlbumId() 动态拼回——与持久化形态
    // 读的是同一份 albumIdPath 真源，不会出现「path 里一个 id、树选中态另一个 id」。
    queryBuild: (state, { noAlbum }) =>
      buildComposablePath({
        rootPrefix: `album/${currentAlbumId()}`,
        noAlbum,
        query: state.query,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(`album/${currentAlbumId()}`, state.query),
    defaultState: createDefaultState,
    ignoreHide: () => currentAlbumId() === HIDDEN_ALBUM_ID,
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
