import { computed, ref, watch, type Ref } from "vue";
import type { ImageInfo } from "../types/image";
import { CONTENT_URI_PROXY_PREFIX, IS_ANDROID } from "../env";
import { fileToUrl, thumbnailToUrl } from "../httpServer";
import {
  getImageStateCache,
  setImageStateCache,
  type CachedImageState,
} from "./useImageStateCache";

type UrlKind = "thumbnail" | "original";

type UseImageItemLoaderOptions = {
  image: Ref<ImageInfo>;
  gridColumns: Ref<number | undefined>;
};

function normalizeDesktopPath(path: string | undefined): string {
  return (path || "").trimStart().replace(/^\\\\\?\\/, "").trim();
}

function toDesktopUrl(path: string | undefined): string {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return fileToUrl(normalized);
}

function toDesktopThumbnailUrl(path: string | undefined): string {
  const normalized = normalizeDesktopPath(path);
  if (!normalized) return "";
  return thumbnailToUrl(normalized);
}

function toAndroidProxyUrl(path: string | undefined): string {
  const raw = (path || "").trim();
  if (!raw.startsWith("content://")) return "";
  return raw.replace("content://", CONTENT_URI_PROXY_PREFIX);
}

export function useImageItemLoader(options: UseImageItemLoaderOptions) {
  const displayUrl = ref("");
  const isImageLoading = ref(true);
  const isLost = ref(false);
  const originalMissing = ref(false);

  const currentStage = ref<"primary" | "fallback">("primary");
  /** 桌面双图：缩略图已加载 */
  const thumbnailLoaded = ref(false);
  /** 桌面双图：原图已加载；非双图时与单图 load 同步 */
  const originalLoaded = ref(false);
  /** 桌面双图：缩略图加载失败（仍显示原图层） */
  const thumbnailLoadFailed = ref(false);

  const urlPlan = computed(() => {
    const image = options.image.value;
    if (IS_ANDROID) {
      return {
        primaryUrl: toAndroidProxyUrl(image.localPath),
        fallbackUrl: "",
        primaryKind: "original" as UrlKind,
        thumbnailUrl: "",
        originalUrl: toAndroidProxyUrl(image.localPath),
        useDesktopLayers: false,
      };
    }

    const thumbnailUrl = toDesktopThumbnailUrl(image.thumbnailPath || image.localPath);
    const originalUrl = toDesktopUrl(image.localPath);
    const cols = options.gridColumns.value ?? 0;
    // 列数 >= 3：只显示缩略图（失败回退原图）；列数 1、2：双图策略（先缩略图再原图淡入）
    const thumbnailOnly = cols >= 3;
    const useDesktopLayers =
      !thumbnailOnly &&
      thumbnailUrl !== originalUrl &&
      !!thumbnailUrl &&
      !!originalUrl;

    if (thumbnailOnly) {
      return {
        primaryUrl: thumbnailUrl,
        fallbackUrl: thumbnailUrl !== originalUrl ? originalUrl : "",
        primaryKind: "thumbnail" as UrlKind,
        thumbnailUrl,
        originalUrl,
        useDesktopLayers: false,
      };
    }
    return {
      primaryUrl: originalUrl,
      fallbackUrl: thumbnailUrl !== originalUrl ? thumbnailUrl : "",
      primaryKind: "original" as UrlKind,
      thumbnailUrl,
      originalUrl,
      useDesktopLayers,
    };
  });

  const persistStableStateToCache = () => {
    const imageId = options.image.value.id;
    if (!imageId) return;
    const { primaryUrl, fallbackUrl, primaryKind } = urlPlan.value;
    const nextState: CachedImageState = {
      primaryUrl,
      fallbackUrl,
      primaryKind,
      displayUrl: displayUrl.value,
      isLost: isLost.value,
      originalMissing: originalMissing.value,
      stage: currentStage.value,
      originalLoaded: urlPlan.value.useDesktopLayers ? originalLoaded.value : undefined,
    };
    setImageStateCache(imageId, nextState);
  };

  watch(
    [
      () => options.image.value.id,
      () => urlPlan.value.primaryUrl,
      () => urlPlan.value.fallbackUrl,
      () => urlPlan.value.primaryKind,
      () => urlPlan.value.thumbnailUrl,
      () => urlPlan.value.originalUrl,
      () => urlPlan.value.useDesktopLayers,
      () => options.image.value.localExists,
    ],
    () => {
      const { primaryUrl, primaryKind, fallbackUrl, thumbnailUrl, originalUrl, useDesktopLayers } =
        urlPlan.value;
      const cached = getImageStateCache(options.image.value.id);
      if (
        cached &&
        cached.primaryUrl === primaryUrl &&
        cached.fallbackUrl === fallbackUrl &&
        cached.primaryKind === primaryKind
      ) {
        currentStage.value = cached.stage;
        isLost.value = cached.isLost;
        originalMissing.value = cached.originalMissing;
        displayUrl.value = cached.displayUrl;
        isImageLoading.value = false;
        if (useDesktopLayers) {
          thumbnailLoaded.value = true;
          originalLoaded.value = cached.originalLoaded === true;
        } else {
          originalLoaded.value = true;
        }
        return;
      }

      currentStage.value = "primary";
      isLost.value = false;
      thumbnailLoaded.value = false;
      originalLoaded.value = false;
      thumbnailLoadFailed.value = false;
      isImageLoading.value = true;

      // 桌面双图：用缩略图 URL 作为“有内容”依据，以便先显示缩略图层
      displayUrl.value = useDesktopLayers ? thumbnailUrl : primaryUrl;

      // localExists=false 表示原图缺失，若当前能展示缩略图则显示红色感叹号
      originalMissing.value =
        !IS_ANDROID &&
        options.image.value.localExists === false &&
        primaryKind === "thumbnail" &&
        !!primaryUrl;

      if (!primaryUrl && !useDesktopLayers) {
        if (fallbackUrl) {
          currentStage.value = "fallback";
          displayUrl.value = fallbackUrl;
          originalMissing.value =
            !IS_ANDROID && (options.image.value.localExists === false || primaryKind === "original");
          return;
        }
        isImageLoading.value = false;
        isLost.value = true;
      }
    },
    { immediate: true }
  );

  function handleImageLoad(_event: Event) {
    const img = _event.target as HTMLImageElement;
    if (img.complete && img.naturalHeight !== 0) {
      isImageLoading.value = false;
      isLost.value = false;
      originalLoaded.value = true;
      persistStableStateToCache();
    }
  }

  /** 桌面双图：缩略图 load 时隐藏骨架 */
  function handleThumbnailLoad() {
    thumbnailLoaded.value = true;
    isImageLoading.value = false;
    isLost.value = false;
  }

  /** 桌面双图：原图 load 时淡入完成，写缓存 */
  function handleOriginalLoad() {
    originalLoaded.value = true;
    persistStableStateToCache();
  }

  function handleThumbnailError() {
    if (!urlPlan.value.useDesktopLayers) return;
    thumbnailLoadFailed.value = true;
    isImageLoading.value = false;
    isLost.value = false;
  }

  function handleOriginalError() {
    if (!urlPlan.value.useDesktopLayers) {
      handleImageError();
      return;
    }
    originalMissing.value = true;
    originalLoaded.value = false;
    persistStableStateToCache();
  }

  function handleImageError() {
    if (IS_ANDROID) {
      displayUrl.value = "";
      isImageLoading.value = false;
      isLost.value = true;
      persistStableStateToCache();
      return;
    }

    const { fallbackUrl, primaryKind } = urlPlan.value;
    if (currentStage.value === "primary" && fallbackUrl) {
      currentStage.value = "fallback";
      displayUrl.value = fallbackUrl;
      isImageLoading.value = true;
      isLost.value = false;
      if (primaryKind === "original") {
        originalMissing.value = true;
      }
      return;
    }

    displayUrl.value = "";
    isImageLoading.value = false;
    isLost.value = true;
    persistStableStateToCache();
  }

  return {
    displayUrl,
    isImageLoading,
    isLost,
    originalMissing,
    thumbnailUrl: computed(() => urlPlan.value.thumbnailUrl),
    originalUrl: computed(() => urlPlan.value.originalUrl),
    useDesktopLayers: computed(() => urlPlan.value.useDesktopLayers),
    thumbnailLoaded,
    originalLoaded,
    thumbnailLoadFailed,
    handleImageLoad,
    handleImageError,
    handleThumbnailLoad,
    handleOriginalLoad,
    handleThumbnailError,
    handleOriginalError,
  };
}
