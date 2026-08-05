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
import { useSettingsStore } from "@kabegame/core/stores/settings";

const DEFAULT_PAGE_SIZE = 100;

/** 会话内记忆的搜索模式，搜索词清空后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
export const surfImagesStickySearchMode = ref<GallerySearchMode>(
  DEFAULT_GALLERY_SEARCH_MODE,
);

export function rememberSurfImagesSearchMode(mode: GallerySearchMode): void {
  surfImagesStickySearchMode.value = mode;
}

type SurfImagesRouteState = {
  host: string;
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
  page: number;
  pageSize: number;
};

function createDefaultState(): SurfImagesRouteState {
  const settings = useSettingsStore();
  return {
    host: "",
    query: [],
    sort: { field: "by-time", desc: false },
    page: 1,
    pageSize: (settings.values.galleryPageSize as number | undefined) ?? DEFAULT_PAGE_SIZE,
  };
}

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>(
  "surfImagesRoute",
  {
    settingKey: "surf-images-path",
    parse: (path) => {
      const { id: host, body } = extractRootIdAndBody(path, "surf");
      if (!host) return createDefaultState();
      const parsed = parseComposablePath(body);
      const term = querySearchTerm(parsed.query);
      if (term?.query.trim()) {
        surfImagesStickySearchMode.value = term.mode;
      }
      return {
        host,
        query: parsed.query,
        sort: parsed.sort,
        page: parsed.page,
        pageSize: parsed.pageSize,
      };
    },
    build: (state, { noAlbum }) =>
      buildComposablePath({
        rootPrefix: `surf/${state.host}`,
        noAlbum,
        query: state.query,
        sort: state.sort,
        page: state.page,
        pageSize: state.pageSize,
      }),
    buildContext: (state) =>
      buildComposableContextPrefix(`surf/${state.host}`, state.query),
    defaultState: createDefaultState,
    onStateChange: (state) => {
      const settings = useSettingsStore();
      if (state.pageSize !== settings.values.galleryPageSize) {
        void settings.save("galleryPageSize", state.pageSize);
      }
    },
  }
);
