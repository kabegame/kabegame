import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  parseComposablePath,
  buildComposableContextPrefix,
  extractRootIdAndBody,
  DEFAULT_GALLERY_SEARCH_MODES,
  type GalleryQuery,
  type GallerySearchPathMode,
  type GallerySort,
  querySearchTerm,
} from "@/utils/galleryPath";

/** 会话内记忆的搜索维度勾选，搜索词清空后兜底用——原理见 galleryRoute.ts 里同名机制的注释。 */
export const surfImagesStickySearchModes = ref<GallerySearchPathMode[]>([...DEFAULT_GALLERY_SEARCH_MODES]);

export function rememberSurfImagesSearchModes(modes: readonly GallerySearchPathMode[]): void {
  surfImagesStickySearchModes.value = [...modes];
}

type SurfImagesRouteState = {
  host: string;
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
};

function createDefaultState(): SurfImagesRouteState {
  return {
    host: "",
    query: [],
    sort: { field: "by-time", desc: false },
  };
}

export const useSurfImagesRouteStore = createPathRouteStore<SurfImagesRouteState>("surfImagesRoute", {
  settingKey: "surf-images-path",
  parse: (path) => {
    const { id: host, body } = extractRootIdAndBody(path, "surf");
    if (!host) return createDefaultState();
    const parsed = parseComposablePath(body);
    const term = querySearchTerm(parsed.query);
    if (term?.query.trim()) {
      surfImagesStickySearchModes.value = [...term.modes];
    }
    return {
      host,
      query: parsed.query,
      sort: parsed.sort,
    };
  },
  build: (state, { noAlbum }) =>
    buildComposablePath({
      rootPrefix: `surf/${state.host}`,
      noAlbum,
      query: state.query,
      sort: state.sort,
    }),
  buildContext: (state) => buildComposableContextPrefix(`surf/${state.host}`, state.query),
  defaultState: createDefaultState,
});
