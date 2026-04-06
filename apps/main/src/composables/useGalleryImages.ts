import { nextTick, ref, shallowRef, unref, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "@kabegame/core/types/image";

type AlbumBrowseInfo = {
  id: string;
  name: string;
  imageCount: number;
  previewImages: ImageInfo[];
};

type GalleryBrowseEntry =
  | { kind: "dir"; name: string }
  | { kind: "image"; image: ImageInfo }
  | { kind: "album"; album: AlbumBrowseInfo };

type GalleryBrowseResult = {
  total: number;
  baseOffset: number;
  rangeTotal: number;
  entries: GalleryBrowseEntry[];
};

/**
 * 画廊图片列表管理（基于路径的查询）。
 * @param pageSize SimplePage 每页条数（与设置一致）
 * @param onBeforeFetch 每次 `browse_gallery_provider` 拉取前调用（如清空 per-page metadata 缓存）
 */
export function useGalleryImages(
  galleryContainerRef: Ref<HTMLElement | null>,
  pageSize: Ref<number>,
  onBeforeFetch?: () => void,
) {
  // 本地图片列表：由视图直接消费，避免引入额外全局同步开销
  const displayedImages = shallowRef<ImageInfo[]>([]);
  let displayedImageIds = new Set<string>();
  const setDisplayedImages = (next: ImageInfo[]) => {
    displayedImages.value = next;
    displayedImageIds = new Set(next.map((i) => i.id));
  };

  // 当前 leaf 的完整图片列表（最多 pageSize；最后一页可能更少）
  let leafAllImages: ImageInfo[] = [];

  const totalImages = ref(0);
  const loadedKey = ref("");

  const setLeafAndResetDisplay = async (images: ImageInfo[]) => {
    leafAllImages = images;
    // 直接显示整个 leaf
    setDisplayedImages(images);
    await nextTick();
  };

  /**
   * 根据路径加载图片列表
   * @returns { total: number, baseOffset: number } - 直接返回图片数据
   */
  const fetchByPath = async (
    path: string,
    opts?: { loadKey?: string },
  ) => {
    onBeforeFetch?.();
    const res = await invoke<GalleryBrowseResult>("browse_gallery_provider", {
      path,
      pageSize: unref(pageSize),
    });
    totalImages.value = res.total ?? 0;

    // 直接处理图片条目（新路径格式总是返回图片）
    const images = (res.entries || [])
      .filter((e) => e.kind === "image")
      .map((e) => (e as any).image as ImageInfo);

    await setLeafAndResetDisplay(images);
    loadedKey.value = opts?.loadKey ?? path;
 
    return {
      total: totalImages.value,
      baseOffset: res.baseOffset ?? 0,
    };
  };

  /**
   * 刷新列表并尽量复用已有项，避免全量图片重新加载。
   * @param path 要加载的路径
   * @param opts.preserveScroll 是否保留当前滚动位置
   * @param opts.skipScrollReset 是否跳过滚动处理
   */
  const refreshImagesPreserveCache = async (
    path: string,
    opts: {
      preserveScroll?: boolean;
      skipScrollReset?: boolean;
    } = {},
  ) => {
    const preserveScroll = opts.preserveScroll ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;

    const container = preserveScroll ? galleryContainerRef.value : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    await fetchByPath(path);

    if (!skipScrollReset) {
      if (preserveScroll && container) {
        container.scrollTop = prevScrollTop;
      } else {
        const c = container ?? galleryContainerRef.value;
        if (c) c.scrollTop = 0;
      }
    }
  };

  return {
    displayedImages,
    fetchByPath,
    refreshImagesPreserveCache,
    totalImages,
    loadedKey,
  };
}
