import { computed } from "vue";
import { useLocalStorage } from "@vueuse/core";
import {
  type GalleryTimeSort,
  buildGalleryPath,
  parseGalleryPath,
  GALLERY_STORAGE_KEY_PAGE,
  GALLERY_STORAGE_KEY_ROOT,
  GALLERY_STORAGE_KEY_SORT,
} from "@/utils/galleryPath";

let singleton: ReturnType<typeof createGalleryPathState> | null = null;

function createGalleryPathState() {
  const root = useLocalStorage<string>(GALLERY_STORAGE_KEY_ROOT, "all");
  const sort = useLocalStorage<GalleryTimeSort>(GALLERY_STORAGE_KEY_SORT, "asc");
  const page = useLocalStorage<number>(GALLERY_STORAGE_KEY_PAGE, 1);

  /** 交给 useProviderPathRoute 的默认 path（无 query.path 时） */
  const providerPath = computed(() =>
    buildGalleryPath(root.value, sort.value, page.value)
  );

  /** 用完整 path 回写三个持久化字段（如 URL 变化后） */
  function applyFromPath(path: string) {
    const p = parseGalleryPath(path);
    root.value = p.root;
    sort.value = p.sort;
    page.value = p.page;
  }

  return {
    root,
    sort,
    page,
    providerPath,
    applyFromPath,
  };
}

/**
 * 画廊：root / sort / page 各为独立 localStorage + ref，providerPath 由三者计算。
 */
export function useGalleryPathState() {
  if (!singleton) singleton = createGalleryPathState();
  return singleton;
}
