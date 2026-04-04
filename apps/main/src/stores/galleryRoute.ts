import { createPathRouteStore } from "./pathRoute";
import {
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PAGE,
  GALLERY_STORAGE_KEY_ROOT,
  GALLERY_STORAGE_KEY_SORT,
  type GalleryTimeSort,
} from "@/utils/galleryPath";

type GalleryRouteState = {
  root: string;
  sort: GalleryTimeSort;
  page: number;
};

function createGalleryDefaultState(): GalleryRouteState {
  const rootRaw = localStorage.getItem(GALLERY_STORAGE_KEY_ROOT) ?? "all";
  const sortRaw = localStorage.getItem(GALLERY_STORAGE_KEY_SORT);
  const pageRaw = Number(localStorage.getItem(GALLERY_STORAGE_KEY_PAGE));
  const root = rootRaw.trim() || "all";
  const sort: GalleryTimeSort = sortRaw === "desc" ? "desc" : "asc";
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { root, sort, page };
}

export const useGalleryRouteStore = createPathRouteStore<GalleryRouteState>(
  "galleryRoute",
  {
    parse: (path) => parseGalleryPath(path),
    build: (state) => buildGalleryPath(state.root, state.sort, state.page),
    defaultState: createGalleryDefaultState(),
    routePath: "/gallery",
    onStateChange: (state) => {
      localStorage.setItem(GALLERY_STORAGE_KEY_ROOT, state.root);
      localStorage.setItem(GALLERY_STORAGE_KEY_SORT, state.sort);
      localStorage.setItem(GALLERY_STORAGE_KEY_PAGE, String(state.page));
    },
  }
);
