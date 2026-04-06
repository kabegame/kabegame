import { createPathRouteStore } from "./pathRoute";
import {
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PAGE,
  GALLERY_STORAGE_KEY_ROOT,
  GALLERY_STORAGE_KEY_SORT,
  parseFilter,
  serializeFilter,
  type GalleryFilter,
  type GalleryTimeSort,
} from "@/utils/galleryPath";

type GalleryRouteState = {
  filter: GalleryFilter;
  sort: GalleryTimeSort;
  page: number;
};

function createGalleryDefaultState(): GalleryRouteState {
  const rootRaw = localStorage.getItem(GALLERY_STORAGE_KEY_ROOT) ?? "all";
  const sortRaw = localStorage.getItem(GALLERY_STORAGE_KEY_SORT);
  const pageRaw = Number(localStorage.getItem(GALLERY_STORAGE_KEY_PAGE));
  const filter = parseFilter(rootRaw.trim() || "all");
  const sort: GalleryTimeSort = sortRaw === "desc" ? "desc" : "asc";
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { filter, sort, page };
}

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>(
  "galleryRoute",
  {
    parse: (path) => parseGalleryPath(path),
    build: (state) => buildGalleryPath(state.filter, state.sort, state.page),
    defaultState: createGalleryDefaultState(),
    routePath: "/gallery",
    onStateChange: (state) => {
      localStorage.setItem(GALLERY_STORAGE_KEY_ROOT, serializeFilter(state.filter));
      localStorage.setItem(GALLERY_STORAGE_KEY_SORT, state.sort);
      localStorage.setItem(GALLERY_STORAGE_KEY_PAGE, String(state.page));
    },
  }
);

/** 回到默认「全部」第 1 页（用于错误兜底等） */
export async function resetGalleryRouteToDefault() {
  const store = useGalleryRouteStore();
  await store.navigate({ filter: { type: "all" }, page: 1 });
}
