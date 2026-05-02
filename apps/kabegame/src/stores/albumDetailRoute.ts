import { createPathRouteStore } from "./pathRoute";
import {
  buildAlbumBrowsePath,
  parseAlbumBrowsePath,
  type AlbumBrowseFilter,
  type AlbumBrowseSort,
} from "@/utils/albumPath";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";

type AlbumDetailRouteState = {
  albumId: string;
  filter: AlbumBrowseFilter;
  sort: AlbumBrowseSort;
  page: number;
  pageSize: number;
  search: string;
};

function createDefaultState(): AlbumDetailRouteState {
  const settings = useSettingsStore();
  return {
    albumId: "",
    filter: "all",
    sort: "join-asc",
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
    search: "",
  };
}

export const useAlbumDetailRouteStore = createPathRouteStore<AlbumDetailRouteState>(
  "albumDetailRoute",
  {
    parse: (path) => {
      const parsed = parseAlbumBrowsePath(path);
      if (!parsed) return createDefaultState();
      return parsed;
    },
    build: (state) =>
      buildAlbumBrowsePath(
        state.albumId,
        state.filter,
        state.sort,
        state.page,
        state.pageSize,
        state.search
      ),
    defaultState: createDefaultState,
    routeName: "AlbumDetail",
    // HIDDEN 画册内部永远不套 `hide/` 前缀，否则 HideGate 会剔除其成员
    ignoreHide: (s) => s.albumId === HIDDEN_ALBUM_ID,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
