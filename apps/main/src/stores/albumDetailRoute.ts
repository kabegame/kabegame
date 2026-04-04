import { createPathRouteStore } from "./pathRoute";
import {
  buildAlbumBrowsePath,
  parseAlbumBrowsePath,
  type AlbumBrowseFilter,
  type AlbumBrowseSort,
} from "@/utils/albumPath";

type AlbumDetailRouteState = {
  albumId: string;
  filter: AlbumBrowseFilter;
  sort: AlbumBrowseSort;
  page: number;
};

const defaultState: AlbumDetailRouteState = {
  albumId: "",
  filter: "all",
  sort: "time-asc",
  page: 1,
};

export const useAlbumDetailRouteStore = createPathRouteStore<AlbumDetailRouteState>(
  "albumDetailRoute",
  {
    parse: (path) => parseAlbumBrowsePath(path) ?? { ...defaultState },
    build: (state) =>
      buildAlbumBrowsePath(state.albumId, state.filter, state.sort, state.page),
    defaultState,
  }
);
