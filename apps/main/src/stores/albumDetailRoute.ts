import { createPathRouteStore } from "./pathRoute";
import {
  buildAlbumBrowsePath,
  parseAlbumBrowsePath,
  type AlbumBrowseFilter,
  type AlbumBrowseSort,
} from "@/utils/albumPath";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";

type AlbumDetailRouteState = {
  albumId: string;
  filter: AlbumBrowseFilter;
  sort: AlbumBrowseSort;
  page: number;
};

const defaultState: AlbumDetailRouteState = {
  albumId: "",
  filter: "all",
  sort: "join-asc",
  page: 1,
};

export const useAlbumDetailRouteStore = createPathRouteStore<AlbumDetailRouteState>(
  "albumDetailRoute",
  {
    parse: (path) => {
      const parsed = parseAlbumBrowsePath(path);
      if (!parsed) return { ...defaultState };
      return parsed;
    },
    build: (state) =>
      buildAlbumBrowsePath(state.albumId, state.filter, state.sort, state.page),
    defaultState,
    routeName: "AlbumDetail",
    // HIDDEN 画册内部永远不套 `hide/` 前缀，否则 HideGate 会剔除其成员
    ignoreHide: (s) => s.albumId === HIDDEN_ALBUM_ID,
  }
);
