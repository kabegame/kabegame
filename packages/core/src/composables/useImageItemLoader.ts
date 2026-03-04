import { computed, ref, watch, type Ref } from "vue";
import type { ImageInfo } from "../types/image";
import { CONTENT_URI_PROXY_PREFIX, IS_ANDROID } from "../env";
import { fileToUrl } from "../fileServer";
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

  const urlPlan = computed(() => {
    const image = options.image.value;
    if (IS_ANDROID) {
      return {
        primaryUrl: toAndroidProxyUrl(image.localPath),
        fallbackUrl: "",
        primaryKind: "original" as UrlKind,
      };
    }

    const thumbnailUrl = toDesktopUrl(image.thumbnailPath || image.localPath);
    const originalUrl = toDesktopUrl(image.localPath);

    // 桌面端：始终优先原图，失败则回退缩略图（列数无关）
    return {
      primaryUrl: originalUrl,
      fallbackUrl: thumbnailUrl !== originalUrl ? thumbnailUrl : "",
      primaryKind: "original" as UrlKind,
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
    };
    setImageStateCache(imageId, nextState);
  };

  watch(
    [
      () => options.image.value.id,
      () => urlPlan.value.primaryUrl,
      () => urlPlan.value.fallbackUrl,
      () => urlPlan.value.primaryKind,
      () => options.image.value.localExists,
    ],
    () => {
      const { primaryUrl, primaryKind, fallbackUrl } = urlPlan.value;
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
        return;
      }

      currentStage.value = "primary";
      isLost.value = false;
      isImageLoading.value = true;

      displayUrl.value = primaryUrl;

      // localExists=false 表示原图缺失，若当前能展示缩略图则显示红色感叹号
      originalMissing.value =
        !IS_ANDROID &&
        options.image.value.localExists === false &&
        primaryKind === "thumbnail" &&
        !!primaryUrl;

      if (!primaryUrl) {
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

  function handleImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    if (img.complete && img.naturalHeight !== 0) {
      isImageLoading.value = false;
      isLost.value = false;
      persistStableStateToCache();
    }
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
    handleImageLoad,
    handleImageError,
  };
}
