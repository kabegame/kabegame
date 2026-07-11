import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  type GalleryFilterSet,
  type GallerySort,
} from "@/utils/galleryPath";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";

type AlbumDetailRouteState = {
  albumId: string;
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
};

const SEARCH_PREFIX = "search/display-name/";

function createDefaultState(): AlbumDetailRouteState {
  const settings = useSettingsStore();
  return {
    albumId: "",
    filters: {},
    sort: { field: "by-album-order", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? 100,
    search: "",
  };
}

function extractAlbumIdAndBody(path: string): { albumId: string; body: string } {
  const trimmed = (path || "").trim();
  let segs = trimmed.split("/").filter(Boolean);
  let search = "";
  if (segs.length >= 3 && segs[0] === "search" && segs[1] === "display-name") {
    try {
      search = segs[2] ?? "";
    } catch {
      search = segs[2] ?? "";
    }
    segs = segs.slice(3);
  }
  if (segs.length >= 2 && segs[0] === "album") {
    const albumId = segs[1]!;
    const body = segs.slice(2).join("/");
    const searchPrefix = search
      ? `${SEARCH_PREFIX}${search}/`
      : "";
    return { albumId, body: searchPrefix + body };
  }
  return { albumId: "", body: trimmed };
}

export const useAlbumDetailRouteStore = createPathRouteStore<AlbumDetailRouteState>(
  "albumDetailRoute",
  {
    settingKey: "album-detail-path",
    parse: (path) => {
      const { albumId, body } = extractAlbumIdAndBody(path);
      if (!albumId) return createDefaultState();
      const parsed = parseComposablePath(body, [], "by-album-order");
      return {
        albumId,
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
      };
    },
    build: (state) =>
      buildComposablePath({
        rootPrefix: `album/${state.albumId}`,
        filters: state.filters,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
        search: state.search,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(
        `album/${state.albumId}`,
        state.search,
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
