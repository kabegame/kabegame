import { ref } from "vue";
import { createPathRouteStore } from "./pathRoute";
import {
  buildComposablePath,
  buildGalleryContextPrefix,
  DEFAULT_GALLERY_SEARCH_MODES,
  GALLERY_STORAGE_KEY_PATH,
  type GalleryQuery,
  type GallerySearchPathMode,
  type GallerySort,
  newRandomSortSeed,
  parseGalleryPath,
  querySearchTerm,
} from "@/utils/galleryPath";
import { IS_WEB } from "@/env";

/**
 * web 版默认随机排序的种子：每次加载页面换一批图，但整个会话内保持同一次洗牌
 * （defaultState 在 path 为空时会被反复求值，每次现生成会让翻页乱序）。
 */
let cachedWebRandomSeed: string | null = null;
const webRandomSeed = () => (cachedWebRandomSeed ??= newRandomSortSeed());

/**
 * 会话内记忆的搜索维度勾选。搜索是查询原子的一个维度，query 为空时原子不存在，
 * 模式自然不进 path（后端 `normalize_segments` 会丢空段、空 query 的 LIKE 又
 * 恒非真，不能为纯 UI 偏好去动引擎）。所以模式在搜索词清空后由这个 ref 兜底：
 * 搜索下拉展示时读它，用户改勾选时写它（`rememberGallerySearchModes`）。
 */
export const galleryStickySearchModes = ref<GallerySearchPathMode[]>([...DEFAULT_GALLERY_SEARCH_MODES]);

/** 手动记住当前勾选的搜索维度，供下拉框勾选变化时调用（见 galleryStickySearchModes 注释）。 */
export function rememberGallerySearchModes(modes: readonly GallerySearchPathMode[]): void {
  galleryStickySearchModes.value = [...modes];
}

type GalleryRouteState = {
  /** 唯一查询对象：简单过滤只是单原子查询的退化形态。 */
  query: GalleryQuery;
  sort: GallerySort;
};

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>("galleryRoute", {
  settingKey: "gallery-path",
  parse: (path) => {
    const parsed = parseGalleryPath(path);
    const term = querySearchTerm(parsed.query);
    if (term?.query.trim()) {
      galleryStickySearchModes.value = [...term.modes];
    }
    // parsed.noAlbum 丢弃：no-album 与 hide 一样是全局路由参数，值只由
    // globalPathRoute 决定（见 pathRoute.ts 的 parse 契约）。
    return {
      query: parsed.query,
      sort: parsed.sort,
    };
  },
  build: (state, { noAlbum }) =>
    buildComposablePath({
      noAlbum,
      query: state.query,
      sort: state.sort,
    }),
  buildContext: (state) => buildGalleryContextPrefix(state.query),
  defaultState: () => {
    const stored = IS_WEB ? null : localStorage.getItem(GALLERY_STORAGE_KEY_PATH);
    const parsed = stored ? parseGalleryPath(stored) : null;
    const defaultSort: GallerySort = IS_WEB
      ? { field: "random", desc: false, seed: webRandomSeed() }
      : { field: "by-id", desc: false };
    return {
      query: parsed?.query ?? [],
      sort: parsed?.sort ?? defaultSort,
    };
  },
  onStateChange: (state) => {
    // 仅持久化 query/sort；分页由 usePagedGallery 本地持有，页大小由 settings 管理。
    // noAlbum 由全局 store 自己的 localStorage 承担，不再进这条路径。
    if (!IS_WEB) {
      localStorage.setItem(
        GALLERY_STORAGE_KEY_PATH,
        buildComposablePath({
          query: state.query,
          sort: state.sort,
        }),
      );
    }
  },
});

/** 回到默认「全部」第 1 页（用于错误兜底等） */
export async function resetGalleryRouteToDefault() {
  const store = useGalleryRouteStore();
  rememberGallerySearchModes(DEFAULT_GALLERY_SEARCH_MODES);
  await store.navigate({
    query: [],
  });
}
