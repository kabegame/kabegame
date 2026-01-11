import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import type { ImageInfo } from "../types/image";

export type ImageUrlPair =
  | { thumbnail?: string; original?: string }
  | undefined;

export type BlobUrlInvalidPayload = {
  oldUrl: string;
  newUrl: string;
  newBlob?: Blob;
  imageId: string;
  localPath: string;
};

export type UseImageItemLoaderOptions = {
  image: Ref<ImageInfo>;
  imageUrl: Ref<ImageUrlPair>;
  useOriginal: Ref<boolean | undefined>;
  /** URL 长时间缺失时，避免无限骨架。默认 15s；设为 0/负数表示不启用超时。 */
  missingUrlTimeoutMs?: number;
};

function looksLikeWindowsPath(p: string) {
  return /^[a-zA-Z]:\\/.test(p) || /^[a-zA-Z]:\//.test(p);
}

export function useImageItemLoader(options: UseImageItemLoaderOptions) {
  const missingUrlTimeoutMs = computed(
    () => options.missingUrlTimeoutMs ?? 15000
  );

  const thumbnailUrl = computed(() => options.imageUrl.value?.thumbnail);
  const originalUrl = computed(() => options.imageUrl.value?.original);

  // convertFileSrc 本身是同步的；这里做一层缓存避免同一路径在大量渲染/重算时重复转换
  const assetUrlCache = new Map<string, string>();
  const toAssetUrl = (localPath: string | undefined | null): string => {
    const raw = (localPath || "").trim();
    if (!raw) return "";
    const cached = assetUrlCache.get(raw);
    if (cached) return cached;
    try {
      // 非 Tauri 环境：不要返回 D:\... 给 <img>
      if (!isTauri()) {
        assetUrlCache.set(raw, "");
        return "";
      }
      // 移除 Windows 长路径前缀 \\?\
      const normalizedPath = raw
        .trimStart()
        .replace(/^\\\\\?\\/, "")
        .trim();
      if (!normalizedPath) {
        assetUrlCache.set(raw, "");
        return "";
      }
      const u = convertFileSrc(normalizedPath);
      // 兜底：极端情况下 convertFileSrc 可能返回原路径，避免浏览器尝试加载 Windows 路径并刷屏
      const finalUrl = !u || looksLikeWindowsPath(u) ? "" : u;
      assetUrlCache.set(raw, finalUrl);
      return finalUrl;
    } catch {
      assetUrlCache.set(raw, "");
      return "";
    }
  };

  const computedDisplayUrl = computed(() => {
    // 规则已简化：
    // - thumbnail：上层必须提供 blob url（缺失则显示骨架/失败）
    // - original：上层提供 asset url；若缺失且需要原图，这里做一次同步兜底（convertFileSrc）
    if (options.useOriginal.value) {
      if (originalUrl.value) return originalUrl.value;
      const image = options.image.value;
      const fastOrig = toAssetUrl(image.localPath);
      if (fastOrig) return fastOrig;
    }
    return thumbnailUrl.value || "";
  });

  const isKnownUnavailable = computed(() => {
    const img = options.image.value;
    return img.isTaskFailed || img.localExists === false;
  });

  // 当前尝试加载的 URL（永远不为 "" 才会渲染 <img>，避免出现破裂图）
  const attemptUrl = ref<string>("");

  // 错误处理防抖：避免同一 URL 的 error 事件造成死循环
  const handledErrorForUrl = ref<string | null>(null);
  // 最终失败时显示“走丢了捏”（不再无限骨架）
  const isLost = ref(false);
  // 跟踪图片是否正在加载（用于隐藏 <img>，防止破裂图闪现）
  const isImageLoading = ref(true);

  // 等待 URL 补齐：避免“加载过程中误判为走丢了”
  let missingUrlTimer: number | null = null;
  function clearMissingUrlTimer() {
    if (missingUrlTimer != null) {
      window.clearTimeout(missingUrlTimer);
      missingUrlTimer = null;
    }
  }
  function scheduleMissingUrlTimeout() {
    clearMissingUrlTimer();
    if (isKnownUnavailable.value) return;
    const t = missingUrlTimeoutMs.value;
    if (!t || t <= 0) return;
    missingUrlTimer = window.setTimeout(() => {
      // 仍然没有可用 URL，才认为失败（防止无限骨架）
      if (!computedDisplayUrl.value) {
        isLost.value = true;
        isImageLoading.value = false;
      }
      missingUrlTimer = null;
    }, t);
  }

  onUnmounted(() => {
    clearMissingUrlTimer();
  });

  // URL 或"已知不可用"状态变化：驱动 UI 状态机
  let previousUrl = computedDisplayUrl.value;
  // 用于"asset -> blob" warmup 的取消/去抖
  const warmSeq = ref(0);
  watch(
    [() => computedDisplayUrl.value, () => isKnownUnavailable.value],
    ([newUrl, knownUnavailable], [, oldKnownUnavailable]) => {
      // 仅"不可用状态变化"时也需要更新（例如加载中任务变失败）
      const urlChanged = newUrl !== previousUrl;
      const unavailableChanged = knownUnavailable !== oldKnownUnavailable;
      if (!urlChanged && !unavailableChanged) return;

      const nextUrl = newUrl || "";
      previousUrl = newUrl;

      handledErrorForUrl.value = null;
      isLost.value = false;
      clearMissingUrlTimer();

      if (nextUrl) {
        isImageLoading.value = true;
        attemptUrl.value = nextUrl;
        isLost.value = false;
        return;
      }

      if (knownUnavailable) {
        // 明确失败：任务失败 / 本地缺失
        attemptUrl.value = "";
        isLost.value = true;
        isImageLoading.value = false;
        return;
      }

      // 仍在等待 URL：显示骨架
      attemptUrl.value = "";
      isLost.value = false;
      isImageLoading.value = true;
      scheduleMissingUrlTimeout();
    },
    { immediate: true }
  );

  function handleImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    if (img.complete && img.naturalHeight !== 0) {
      isImageLoading.value = false;
      isLost.value = false;
      handledErrorForUrl.value = null;
      clearMissingUrlTimer();
    }
  }

  async function handleImageError(event: Event) {
    const img = event.target as HTMLImageElement;
    const currentUrl = attemptUrl.value || img.src || "";
    if (!currentUrl) return;

    if (handledErrorForUrl.value === currentUrl) return;
    handledErrorForUrl.value = currentUrl;

    isImageLoading.value = true;
    isLost.value = false;
    clearMissingUrlTimer();

    // 简化策略：不在 item 内做复杂 fallback（IO/重建交给上层 loader + 全局缓存）。
    attemptUrl.value = "";
    isImageLoading.value = false;
    isLost.value = true;
  }

  const lostText = computed(() => {
    const img = options.image.value;
    if (img.isTaskFailed) {
      const e = (img as any).taskFailedError as string | undefined;
      return e ? `下载失败：${e}` : "下载失败（未保存详细原因）";
    }
    if (img.localExists === false) return "图片丢失：本地文件不存在";
    return "图片不可用";
  });

  return {
    attemptUrl,
    isImageLoading,
    isLost,
    lostText,
    thumbnailUrl,
    originalUrl,
    computedDisplayUrl,
    handleImageLoad,
    handleImageError,
  };
}
