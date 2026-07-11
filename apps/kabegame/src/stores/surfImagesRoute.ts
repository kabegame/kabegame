import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  type GalleryFilterSet,
  type GallerySort,
} from "@/utils/galleryPath";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_PREFIX = "search/display-name/";

type SurfImagesRouteState = {
  host: string;
  filters: GalleryFilterSet;
  sort: GallerySort;
  page: number;
  pageSize: number;
  search: string;
};

function createDefaultState(): SurfImagesRouteState {
  const settings = useSettingsStore();
  return {
    host: "",
    filters: {},
    sort: { field: "by-time", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
    search: "",
  };
}

function extractHostAndBody(path: string): { host: string; body: string } {
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
  if (segs.length >= 2 && segs[0] === "surf") {
    const host = segs[1]!;
    const body = segs.slice(2).join("/");
    const searchPrefix = search
      ? `${SEARCH_PREFIX}${search}/`
      : "";
    return { host, body: searchPrefix + body };
  }
  return { host: "", body: trimmed };
}

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>(
  "surfImagesRoute",
  {
    settingKey: "surf-images-path",
    parse: (path) => {
      const { host, body } = extractHostAndBody(path);
      if (!host) return createDefaultState();
      const parsed = parseComposablePath(body);
      return {
        host,
        filters: parsed.filters,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
        search: parsed.search,
      };
    },
    build: (state) =>
      buildComposablePath({
        rootPrefix: `surf/${state.host}`,
        filters: state.filters,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
        search: state.search,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(
        `surf/${state.host}`,
        state.search,
      ),
    defaultState: createDefaultState,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
