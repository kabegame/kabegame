import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ImageInfo } from "../types/image";
import { useBlobUrlLruCache } from "./useBlobUrlLruCache";

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
  onBlobUrlInvalid?: (payload: BlobUrlInvalidPayload) => void;
};

function withCacheBust(url: string, n: number) {
  if (!url) return "";
  if (url.startsWith("blob:")) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("kg-retry", String(n));
    u.searchParams.set("kg-ts", String(Date.now()));
    return u.toString();
  } catch {
    // 非标准 URL（例如某些协议/相对路径），保守不改写，直接返回
    return url;
  }
}

function isSameResourceUrl(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

// 通过读取文件重新创建 Blob URL（返回 url + blob，用于上层持有引用，避免被 GC 后 URL 失效）
async function recreateBlobUrl(
  localPath: string
): Promise<{ url: string; blob: Blob | null }> {
  if (!localPath) return { url: "", blob: null };
  try {
    let normalizedPath = localPath
      .trimStart()
      .replace(/^\\\\\?\\/, "")
      .trim();
    if (!normalizedPath) return { url: "", blob: null };

    const fileData = await readFile(normalizedPath);
    if (!fileData || fileData.length === 0) return { url: "", blob: null };

    const ext = normalizedPath.split(".").pop()?.toLowerCase();
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    else if (ext === "gif") mimeType = "image/gif";
    else if (ext === "webp") mimeType = "image/webp";
    else if (ext === "bmp") mimeType = "image/bmp";

    const blob = new Blob([fileData], { type: mimeType });
    if (blob.size === 0) return { url: "", blob: null };

    const blobUrl = URL.createObjectURL(blob);
    return { url: blobUrl, blob };
  } catch {
    // 文件不存在/暂时不可读时很常见（例如用户删除/移动文件），这里不要刷屏
    return { url: "", blob: null };
  }
}

export function useImageItemLoader(options: UseImageItemLoaderOptions) {
  const missingUrlTimeoutMs = computed(
    () => options.missingUrlTimeoutMs ?? 15000
  );

  const thumbnailUrl = computed(() => options.imageUrl.value?.thumbnail);
  const originalUrl = computed(() => options.imageUrl.value?.original);

  // convertFileSrc 本身是同步的；这里做一层缓存避免同一路径在大量渲染/重算时重复转换
  const assetUrlCache = new Map<string, string>();
  const blobCache = useBlobUrlLruCache();
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
      const looksLikeWindowsPath =
        /^[a-zA-Z]:\\/.test(u) || /^[a-zA-Z]:\//.test(u);
      const finalUrl = !u || looksLikeWindowsPath ? "" : u;
      assetUrlCache.set(raw, finalUrl);
      return finalUrl;
    } catch {
      assetUrlCache.set(raw, "");
      return "";
    }
  };

  const computedDisplayUrl = computed(() => {
    if (options.useOriginal.value && originalUrl.value)
      return originalUrl.value;
    // 原图按需：需要原图但 map 里还没给时，直接用 asset 原图（不走 blob/LRU，也不预热）
    if (options.useOriginal.value) {
      const image = options.image.value;
      const fastOrig = toAssetUrl(image.localPath);
      if (fastOrig) return fastOrig;
      // 没有原图路径：退回缩略图策略，避免空白
    }

    // 关键修复：优先使用 imageUrlMap（如果上层已提供），不再走 LRU cache 查询
    // - 这样可以避免 imageSrcMap 批量更新导致的闪烁（20个一组）
    // - LRU cache 仍然用于 warmup 优化（asset 加载中时切到 blob），但不影响已有 URL
    const fromMap = thumbnailUrl.value || originalUrl.value || "";
    if (fromMap) return fromMap;

    const image = options.image.value;

    // LRU 优先：命中则直接用 blob url（避免 asset protocol 抖动/500，也减少重复 IO）
    // 注意：只有当 imageUrlMap 未提供时才走这里（前端加速场景）
    const thumbPath = (image.thumbnailPath || "").trim();
    const thumbKey = thumbPath
      ? `thumb:${thumbPath
          .trimStart()
          .replace(/^\\\\\?\\/, "")
          .trim()}`
      : "";
    const cachedThumb = thumbKey ? blobCache.get(thumbKey) : "";
    if (cachedThumb) return cachedThumb;

    // 未命中：降级用 asset url（首选缩略图）
    const fastThumb = toAssetUrl(image.thumbnailPath);
    if (fastThumb) return fastThumb;
    const fastOrig = toAssetUrl(image.localPath);
    if (fastOrig) return fastOrig;
    return "";
  });

  const isKnownUnavailable = computed(() => {
    const img = options.image.value;
    return img.isTaskFailed || img.localExists === false;
  });

  // 当前尝试加载的 URL（永远不为 "" 才会渲染 <img>，避免出现破裂图）
  const attemptUrl = ref<string>("");

  // “asset -> blob” 的延迟应用：挂载期间不切换，交由上层在“虚拟滚动卸载（= 视口外）”时替换
  const pendingWarmBlobUrl = ref<string>("");
  const pendingWarmSeq = ref<number>(0);
  // 错误处理防抖：避免同一 URL 的 error 事件造成死循环
  const handledErrorForUrl = ref<string | null>(null);
  // 最终失败时显示“走丢了捏”（不再无限骨架）
  const isLost = ref(false);
  // 跟踪图片是否正在加载（用于隐藏 <img>，防止破裂图闪现）
  const isImageLoading = ref(true);

  // 避免重复 fallback 导致循环/卡顿
  const triedSwitchToOriginal = ref(false);
  const triedOriginalBlob = ref(false);
  const triedThumbnailBlob = ref(false);

  // 非致命加载失败（例如 asset.localhost 偶发 500）时的轻量重试：
  // - 只对“非 blob url”的缩略图生效
  // - 次数有限，避免刷屏/死循环
  const retryCount = ref(0);
  let retryTimer: number | null = null;
  const MAX_RETRIES = 2;

  function clearRetryTimer() {
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

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
    clearRetryTimer();
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
      const prevUrl = previousUrl || "";

      // 关键：如果发生 "asset -> blob" 的变化，为避免闪烁，挂载期间不切换；
      // 只记录为 pending，供上层在 item 卸载后应用（卸载 = 一定在视口外）。
      const isAssetToBlobSwitch =
        nextUrl &&
        prevUrl &&
        nextUrl.startsWith("blob:") &&
        !prevUrl.startsWith("blob:") &&
        (prevUrl.includes("asset.localhost") || prevUrl.startsWith("asset:"));

      if (isAssetToBlobSwitch) {
        pendingWarmBlobUrl.value = nextUrl;
        pendingWarmSeq.value = warmSeq.value;
        // 不更新 previousUrl，这样下次 watch 触发时仍能检测到变化
        return;
      }

      previousUrl = newUrl;

      handledErrorForUrl.value = null;
      isLost.value = false;
      triedSwitchToOriginal.value = false;
      triedOriginalBlob.value = false;
      triedThumbnailBlob.value = false;
      retryCount.value = 0;
      clearRetryTimer();
      clearMissingUrlTimer();
      pendingWarmBlobUrl.value = "";
      pendingWarmSeq.value = 0;

      if (nextUrl) {
        // 如果是 asset->blob 切换且图片仍在加载，保持 loading 状态
        // 否则正常设置 loading
        if (!isAssetToBlobSwitch) {
          isImageLoading.value = true;
        }
        attemptUrl.value = nextUrl;
        isLost.value = false;

        // cache miss 时：后台 warmup blob（不在挂载期间切换 src；避免闪烁）
        // 只对"从本地路径来的 asset url"做（remote/blob/url map 不做）
        const seq = ++warmSeq.value;
        const image = options.image.value;
        const thumbPath = (image.thumbnailPath || "").trim();
        const isBlob = nextUrl.startsWith("blob:");
        const isAsset =
          !isBlob &&
          (nextUrl.includes("asset.localhost") || nextUrl.startsWith("asset:"));
        // 只预热缩略图：原图永不进 LRU
        if (isAsset && thumbPath && !options.useOriginal.value) {
          void blobCache
            .ensureThumbnailFromLocalPath(thumbPath)
            .then((blobUrl) => {
              if (!blobUrl) return;
              // 已有新一轮 url 变化/组件已卸载：不更新
              if (warmSeq.value !== seq) return;
              pendingWarmBlobUrl.value = blobUrl;
              pendingWarmSeq.value = seq;
            });
        }
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

  /**
   * 取走 pending 的 warmup blob url（并清空）。
   * - 上层（ImageGrid）可在“虚拟滚动卸载”时调用，从而保证替换发生在视口外。
   */
  function takePendingWarmBlobUrl(): string {
    const pending = pendingWarmBlobUrl.value;
    if (!pending) return "";
    // URL 已经被新一轮刷新覆盖：不再返回
    if (pendingWarmSeq.value !== warmSeq.value) return "";
    pendingWarmBlobUrl.value = "";
    pendingWarmSeq.value = 0;
    return pending;
  }

  function handleImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    if (img.complete && img.naturalHeight !== 0) {
      isImageLoading.value = false;
      isLost.value = false;
      handledErrorForUrl.value = null;
      retryCount.value = 0;
      clearRetryTimer();
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

    const thumbUrl = thumbnailUrl.value;
    const origUrl = originalUrl.value;

    // 1) 缩略图失败：优先切到原图（“缩略图坏了但原图还在”）
    if (
      !triedSwitchToOriginal.value &&
      thumbUrl &&
      origUrl &&
      isSameResourceUrl(currentUrl, thumbUrl) &&
      !isSameResourceUrl(origUrl, thumbUrl)
    ) {
      triedSwitchToOriginal.value = true;
      handledErrorForUrl.value = null; // 允许新 URL 的 error 被处理
      attemptUrl.value = origUrl;
      isImageLoading.value = true;
      return;
    }

    // 2) 轻量重试（解决 asset.localhost 偶发 500）：只对“缩略图 url”生效，且次数有限
    // 说明：控制台的 500 日志来自 <img> 请求本身，我们只能通过“尽快成功/尽快停止”来减少刷屏。
    if (
      thumbUrl &&
      isSameResourceUrl(currentUrl, thumbUrl) &&
      // 只有“没有可用原图”时才重试缩略图；否则直接走原图兜底更符合预期
      (!origUrl || isSameResourceUrl(origUrl, thumbUrl)) &&
      !currentUrl.startsWith("blob:") &&
      retryCount.value < MAX_RETRIES
    ) {
      retryCount.value += 1;
      const delay = retryCount.value === 1 ? 180 : 650; // 轻微退避
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        // 再次尝试前，允许 error 处理下一次（否则会被 handledErrorForUrl 拦住）
        handledErrorForUrl.value = null;
        attemptUrl.value = withCacheBust(thumbUrl, retryCount.value);
        isImageLoading.value = true;
      }, delay);
      return;
    }

    const image = options.image.value;

    // 3) URL 持续失败时：直接从本地读文件生成 blob，优先用原图（原图可看时应尽量保住）
    if (
      !triedOriginalBlob.value &&
      image.localPath &&
      image.localExists !== false
    ) {
      triedOriginalBlob.value = true;
      const rebuilt = await recreateBlobUrl(image.localPath);
      if (rebuilt?.url) {
        handledErrorForUrl.value = null;
        attemptUrl.value = rebuilt.url;
        options.onBlobUrlInvalid?.({
          oldUrl: currentUrl,
          newUrl: rebuilt.url,
          newBlob: rebuilt.blob ?? undefined,
          imageId: image.id,
          localPath: image.localPath,
        });
        return;
      }
    }

    // 4) 原图也无法读：再尝试缩略图文件（可能 thumbnailPath 仍存在）
    if (
      !triedThumbnailBlob.value &&
      image.thumbnailPath &&
      image.localExists !== false
    ) {
      triedThumbnailBlob.value = true;
      const rebuilt = await recreateBlobUrl(image.thumbnailPath);
      if (rebuilt?.url) {
        handledErrorForUrl.value = null;
        attemptUrl.value = rebuilt.url;
        options.onBlobUrlInvalid?.({
          oldUrl: currentUrl,
          newUrl: rebuilt.url,
          newBlob: rebuilt.blob ?? undefined,
          imageId: image.id,
          localPath: image.thumbnailPath,
        });
        return;
      }
    }

    // 5) 全部失败：显示“走丢了捏”，不再无限骨架
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
    takePendingWarmBlobUrl,
  };
}
