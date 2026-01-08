import { ref, shallowRef, nextTick, type Ref } from "vue";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  useCrawlerStore,
  type ImageInfo,
  type RangedImages,
} from "@/stores/crawler";

/**
 * 画廊图片加载和URL管理 composable
 */
export function useGalleryImages(
  galleryContainerRef: Ref<HTMLElement | null>,
  isLoadingMore: Ref<boolean>,
  /**
   * 网格是否需要“优先使用原图显示”（例如列数很少时，为了更清晰）。
   * - false：只生成缩略图 URL（更快、IO 更少）
   * - true：对“优先队列”同时生成 original（其余仍在后台/空闲时补齐）
   */
  preferOriginalInGrid: Ref<boolean> = ref(false),
  /**
   * 网格列数（用于快速估算可见范围，避免每次滚动遍历 DOM 计算可见项）。
   * - 不传则退化为旧实现：querySelectorAll + getBoundingClientRect（大列表会卡）
   */
  gridColumns?: Ref<number>,
  /**
   * 用户是否正在强交互（例如 dragScroll 拖拽滚动）
   * - true：优先保证滚动帧率，后台任务尽量推迟到空闲/交互结束
   */
  isInteracting?: Ref<boolean>
) {
  const crawlerStore = useCrawlerStore();

  // 使用独立的本地图片列表，避免直接修改 store 的 images 导致的重新渲染
  // 使用 shallowRef 减少深度响应式追踪，提高性能
  const displayedImages = shallowRef<ImageInfo[]>([]);
  // O(1) 存在性判断：避免在万级列表里频繁 displayedImages.some(...) 造成 O(N) 掉帧
  let displayedImageIds = new Set<string>();

  const setDisplayedImages = (next: ImageInfo[]) => {
    displayedImages.value = next;
    displayedImageIds = new Set(next.map((i) => i.id));
  };

  // 图片 URL 映射，存储每个图片的缩略图和原图 URL
  // 使用 shallowRef 减少深度响应式追踪，避免每次更新都触发重新渲染
  const imageSrcMap = ref<
    Record<string, { thumbnail?: string; original?: string }>
  >({});

  // 已经加载过 URL 的图片 ID，用于快速跳过重复加载
  // - thumbnail：列表展示所需（优先）
  // - original：仅在需要更清晰显示（例如列数<=2 或预览）时才需要
  const loadedThumbnailIds = new Set<string>();
  const loadedOriginalIds = new Set<string>();
  // 进行中的加载任务：避免 scroll-stable 高频触发时重复 readFile 同一张图
  const inFlightThumbnailIds = new Set<string>();
  const inFlightOriginalIds = new Set<string>();

  // 少量图片“迟迟不显示”的兜底：重试（convertFileSrc 不涉及 readFile 超时，这里保留重试即可）
  const MAX_THUMBNAIL_RETRIES = 3;
  const MAX_ORIGINAL_RETRIES = 2;
  const RETRY_BASE_DELAY_MS = 450;
  const thumbnailRetryCount = new Map<string, number>();
  const originalRetryCount = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // 加载全部的取消标志
  let abortLoadAll = false;

  // 将本地文件路径转换为可被 Webview 加载的 URL（Tauri asset protocol）
  async function getImageUrl(localPath: string): Promise<string> {
    const raw = (localPath || "").trim();
    if (!raw) return "";
    try {
      // 移除 Windows 长路径前缀 \\?\
      const normalizedPath = raw
        .trimStart()
        .replace(/^\\\\\?\\/, "")
        .trim();
      if (!normalizedPath) return "";

      // 非 Tauri 环境：不要返回 D:\... 给 <img>（会报错并刷屏）
      if (!isTauri()) return "";

      const u = convertFileSrc(normalizedPath);
      // 兜底：极端情况下 convertFileSrc 可能返回原路径，避免浏览器尝试加载 Windows 路径
      const looksLikeWindowsPath =
        /^[a-zA-Z]:\\/.test(u) || /^[a-zA-Z]:\//.test(u);
      if (!u || looksLikeWindowsPath) return "";
      return u;
    } catch (error) {
      console.error("convertFileSrc 失败:", error, raw);
      return "";
    }
  }

  const clearRetryTimer = (imageId: string) => {
    const t = retryTimers.get(imageId);
    if (t) {
      clearTimeout(t);
      retryTimers.delete(imageId);
    }
  };

  const scheduleRetry = (imageId: string, kind: "thumbnail" | "original") => {
    if (!displayedImageIds.has(imageId)) return;
    // 避免重复安排（同一张图只保留一个定时器）
    if (retryTimers.has(imageId)) return;
    const isThumb = kind === "thumbnail";
    const retryMap = isThumb ? thumbnailRetryCount : originalRetryCount;
    const max = isThumb ? MAX_THUMBNAIL_RETRIES : MAX_ORIGINAL_RETRIES;
    const current = retryMap.get(imageId) ?? 0;
    if (current >= max) return;
    const nextCount = current + 1;
    retryMap.set(imageId, nextCount);

    // 指数退避（少量失败图片会快速补上；大量成功图片不受影响）
    const delay = Math.min(
      5000,
      RETRY_BASE_DELAY_MS * Math.pow(2, nextCount - 1)
    );

    const timer = setTimeout(() => {
      retryTimers.delete(imageId);
      if (!displayedImageIds.has(imageId)) return;
      const image = displayedImages.value.find((i) => i.id === imageId);
      if (!image) return;
      // 只重试缺失的部分；needOriginal 取当前值（列数变化时自动对齐）
      void loadSingleImageUrl(image, preferOriginalInGrid.value);
    }, delay);
    retryTimers.set(imageId, timer);
  };

  const uniquePaths = (paths: Array<string | undefined | null>): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      const v = (p || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };

  const calcGridGap = (columns: number) =>
    Math.max(4, 16 - (Math.max(1, columns) - 1));

  /**
   * 快速估算可见范围（返回索引区间 [start, end)）。
   * 依赖：
   * - 列数 gridColumns
   * - 宽高比（沿用 ImageGrid 里的 window.innerWidth / window.innerHeight）
   * - gap 规则与 ImageGrid 的 gridStyle 保持一致
   */
  const estimateVisibleIndexRange = (): {
    start: number;
    end: number;
    visibleIds: string[];
  } => {
    const container = galleryContainerRef.value;
    const images = displayedImages.value;
    if (!container || images.length === 0) {
      return { start: 0, end: 0, visibleIds: [] };
    }

    const colsRaw = gridColumns?.value ?? 0;
    if (!colsRaw || colsRaw <= 0) {
      // 没有列数：退化为旧方案（DOM 扫描）
      const containerRect = container.getBoundingClientRect();
      const items = container.querySelectorAll<HTMLElement>(".image-item");
      const visibleIds: string[] = [];
      items.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const isVisible =
          rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
        if (isVisible) {
          const id = el.getAttribute("data-id");
          if (id) visibleIds.push(id);
        }
      });
      return { start: 0, end: images.length, visibleIds };
    }

    const columns = Math.max(1, colsRaw);
    const gap = calcGridGap(columns);

    // ImageGrid 的左右 padding 是 8px；容器本身不加左右 padding
    const gridHorizontalPadding = 16; // 8 + 8
    const containerWidth = Math.max(
      0,
      container.clientWidth - gridHorizontalPadding
    );
    const itemWidth =
      columns <= 1
        ? containerWidth
        : (containerWidth - gap * (columns - 1)) / columns;
    const aspectRatio = Math.max(
      0.1,
      window.innerWidth / Math.max(1, window.innerHeight)
    );
    const itemHeight = itemWidth > 0 ? itemWidth / aspectRatio : 200;
    const rowHeight = itemHeight + gap;

    // overscan：让视口上下多取几行，避免滚动边缘“来不及加载”
    // 与 ImageGrid 默认 virtualOverscan(≈8) 尽量对齐：大列表/快速滚动时能明显减少“骨架停留很久”
    const overscanRows = 8;
    const startRow = Math.max(
      0,
      Math.floor(container.scrollTop / rowHeight) - overscanRows
    );
    const endRow =
      Math.ceil((container.scrollTop + container.clientHeight) / rowHeight) +
      overscanRows;

    const start = Math.max(0, Math.min(images.length, startRow * columns));
    const end = Math.max(
      start,
      Math.min(images.length, (endRow + 1) * columns)
    );
    const visibleIds = images.slice(start, end).map((i) => i.id);
    return { start, end, visibleIds };
  };

  // 简单并发池：避免一次性 readFile 30+ 个把 IO/解码压满，导致“视口不优先”
  const runPool = async <T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
  ) => {
    const limit = Math.max(1, concurrency | 0);
    let index = 0;
    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (index < items.length) {
          const current = index++;
          const item = items[current];
          try {
            await worker(item);
          } catch (e) {
            // 单个任务失败不影响整体
            console.error("图片 URL 加载任务失败:", e);
          }
        }
      }
    );
    await Promise.all(runners);
  };

  // 加载图片 URL（可选传入待加载的图片列表）；只加载缺失的图片
  const loadImageUrls = async (targetImages?: ImageInfo[]) => {
    // console.log("call loadImageUrls", targetImages);
    // console.trace();
    // 拖拽滚动期间（强交互优先）：如果是“按可视范围加载”（没有显式指定 targetImages），直接跳过。
    // 这样可以避免 readFile/Blob 创建抢主线程导致滚动掉帧；交互结束后会由 scroll-stable 或下一次滚动补齐。
    if (isInteracting?.value && !targetImages) {
      return;
    }
    // 始终尝试计算当前视口集合（即使传了 targetImages，也用来做优先级排序）
    // - 典型场景：refresh/loadMore 会传大量 targetImages，但用户真正关心的是“当前视口先出图”
    const range = estimateVisibleIndexRange();
    const source =
      targetImages ?? displayedImages.value.slice(range.start, range.end);
    const visibleSet = new Set(range.visibleIds);

    // 只获取还没有加载的图片（按需：thumbnail/original 分开判断）
    const needOriginal = preferOriginalInGrid.value;
    const imagesToLoad = source.filter((img) => {
      const existing = imageSrcMap.value[img.id];
      const hasThumb =
        !!existing?.thumbnail ||
        loadedThumbnailIds.has(img.id) ||
        inFlightThumbnailIds.has(img.id);
      const hasOrig =
        !!existing?.original ||
        loadedOriginalIds.has(img.id) ||
        inFlightOriginalIds.has(img.id);
      if (!hasThumb) return true;
      if (needOriginal && !hasOrig) return true;
      return false;
    });

    if (imagesToLoad.length === 0) {
      return;
    }

    // 可见图片优先加载，然后是不可见的
    imagesToLoad.sort((a, b) => {
      const av = visibleSet.has(a.id) ? 0 : 1;
      const bv = visibleSet.has(b.id) ? 0 : 1;
      if (av !== bv) return av - bv;
      return 0;
    });

    // 关键修复：
    // - 之前“只并发加载前 30 张，其余走 idle 串行”会导致在多列/大视口时，明明在屏幕里的缩略图也要等很久（甚至几分钟）
    // - 现在：把“当前调用要处理的集合（尤其是按视口 slice 出来的 source）”都纳入并发池，保证视口内能快速补齐
    //
    // 仍然保留后台渐进：仅用于 targetImages 很大、且包含大量非视口项的情况（避免一次性把 IO/解码压满）
    const visibleConcurrency = isInteracting?.value ? 1 : 8;

    // 1) 视口（或本次 slice）优先：有限并发快速补齐
    const likelyVisible = targetImages
      ? imagesToLoad.filter((img) => visibleSet.has(img.id))
      : imagesToLoad;
    if (likelyVisible.length > 0) {
      void runPool(likelyVisible, visibleConcurrency, async (image) => {
        await loadSingleImageUrl(image, needOriginal);
      });
    }

    // 2) 非视口项：后台 idle 渐进补齐（仅 targetImages 场景下可能有意义）
    const remainingImages = targetImages
      ? imagesToLoad.filter((img) => !visibleSet.has(img.id))
      : [];
    if (remainingImages.length > 0) {
      const remainingUpdates: Record<
        string,
        { thumbnail?: string; original?: string }
      > = {};
      let processedCount = 0;
      const BATCH_SIZE = 20; // 每处理 20 张图片批量更新一次
      let pendingUpdate = false;

      // 使用 requestAnimationFrame 批量更新，确保在下一帧渲染
      const flushUpdates = () => {
        if (Object.keys(remainingUpdates).length > 0) {
          // 重要：不要用对象展开去“复制整个 imageSrcMap”
          // 十万级 key 时每次更新都会触发 O(N) 拷贝 + 大量 GC，导致滚动/拖动卡顿
          Object.assign(imageSrcMap.value, remainingUpdates);
          // 清空已更新的项
          Object.keys(remainingUpdates).forEach(
            (key) => delete remainingUpdates[key]
          );
        }
        pendingUpdate = false;
      };

      // 使用 requestIdleCallback 或 setTimeout 在空闲时处理
      const processRemaining = async (index = 0) => {
        if (index >= remainingImages.length) {
          // 处理完所有图片后，批量更新剩余的
          if (Object.keys(remainingUpdates).length > 0) {
            Object.assign(imageSrcMap.value, remainingUpdates);
          }
          return;
        }

        const image = remainingImages[index];
        // 再次检查，避免重复处理
        const existing = imageSrcMap.value[image.id];
        const hasThumb =
          !!existing?.thumbnail ||
          loadedThumbnailIds.has(image.id) ||
          inFlightThumbnailIds.has(image.id);
        const hasOrig =
          !!existing?.original ||
          loadedOriginalIds.has(image.id) ||
          inFlightOriginalIds.has(image.id);

        if (hasThumb && (!needOriginal || hasOrig)) {
          // 已处理，继续下一个
          scheduleNext(() => processRemaining(index + 1));
          return;
        }

        try {
          // 加载缩略图
          if (!hasThumb) {
            inFlightThumbnailIds.add(image.id);
            try {
              const thumbPath = image.thumbnailPath || image.localPath;
              const thumbUrl = thumbPath ? await getImageUrl(thumbPath) : "";

              // 检查图片是否仍然存在
              const imageStillExists = displayedImageIds.has(image.id);
              if (imageStillExists && thumbUrl) {
                remainingUpdates[image.id] = {
                  ...(remainingUpdates[image.id] || {}),
                  thumbnail: thumbUrl,
                };
                loadedThumbnailIds.add(image.id);
                processedCount++;
              }
            } finally {
              inFlightThumbnailIds.delete(image.id);
            }
          }

          // 加载原图（如果需要）
          if (needOriginal && !hasOrig) {
            inFlightOriginalIds.add(image.id);
            try {
              const origUrl = image.localPath
                ? await getImageUrl(image.localPath)
                : "";

              const imageStillExists = displayedImageIds.has(image.id);
              if (imageStillExists && origUrl) {
                remainingUpdates[image.id] = {
                  ...(remainingUpdates[image.id] || {}),
                  original: origUrl,
                };
                loadedOriginalIds.add(image.id);
                processedCount++;
              }
            } finally {
              inFlightOriginalIds.delete(image.id);
            }
          }

          // 每处理 BATCH_SIZE 张图片，批量更新一次
          if (
            processedCount % BATCH_SIZE === 0 &&
            Object.keys(remainingUpdates).length > 0
          ) {
            if (!pendingUpdate) {
              pendingUpdate = true;
              requestAnimationFrame(flushUpdates);
            }
          }
        } catch (error) {
          console.error("Failed to load image:", error);
        }

        // 继续处理下一个
        scheduleNext(() => processRemaining(index + 1));
      };

      // 使用 requestIdleCallback 如果可用，否则使用 setTimeout
      scheduleNext(() => processRemaining(0));
    }
  };

  // 调度下一个空闲任务
  const scheduleNext = (callback: () => void) => {
    // 滚动交互最重要：拖拽滚动期间尽量不要安排 readFile/Blob 创建等重活
    if (isInteracting?.value) {
      setTimeout(() => {
        // 如果仍在交互中，继续往后推（避免后台任务抢主线程）
        if (isInteracting?.value) {
          scheduleNext(callback);
          return;
        }
        callback();
      }, 160);
      return;
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => callback(), { timeout: 2000 });
    } else {
      setTimeout(callback, 50);
    }
  };

  // 加载单张图片的 URL
  const loadSingleImageUrl = async (
    image: ImageInfo,
    needOriginal: boolean
  ) => {
    const existing = imageSrcMap.value[image.id] || {};
    const hasThumb =
      !!existing.thumbnail ||
      loadedThumbnailIds.has(image.id) ||
      inFlightThumbnailIds.has(image.id);
    const hasOrig =
      !!existing.original ||
      loadedOriginalIds.has(image.id) ||
      inFlightOriginalIds.has(image.id);

    // 1) thumbnail：优先加载（thumbnailPath 优先；没有则退化为 localPath）
    if (!hasThumb) {
      inFlightThumbnailIds.add(image.id);
      try {
        // 注意：thumbnailPath 可能“存在但偶发读不到/很慢/暂时被占用”
        // 这里增加两件事：
        // - 超时：避免少数图片把 inFlight 卡死
        // - 候选路径：thumbnailPath -> localPath（thumbnail 失败时可退化为原图路径，至少先出图）
        const candidates = uniquePaths([image.thumbnailPath, image.localPath]);
        let thumbUrl = "";
        for (const p of candidates) {
          thumbUrl = await getImageUrl(p);
          if (thumbUrl) break;
        }

        // 图片可能在异步期间被移除
        if (!displayedImageIds.has(image.id)) return;

        if (thumbUrl) {
          // 原地写入，避免复制整个大对象
          imageSrcMap.value[image.id] = { ...existing, thumbnail: thumbUrl };
          loadedThumbnailIds.add(image.id);
          thumbnailRetryCount.delete(image.id);
          clearRetryTimer(image.id);
        } else {
          scheduleRetry(image.id, "thumbnail");
        }
      } finally {
        inFlightThumbnailIds.delete(image.id);
      }
    }

    // 2) original：仅在需要更清晰显示时才加载（列数<=2 等）
    if (needOriginal && !hasOrig) {
      inFlightOriginalIds.add(image.id);
      try {
        const origUrl = image.localPath
          ? await getImageUrl(image.localPath)
          : "";
        if (!displayedImageIds.has(image.id)) return;
        if (origUrl) {
          const curr = imageSrcMap.value[image.id] || {};
          // 原地写入，避免复制整个大对象
          imageSrcMap.value[image.id] = { ...curr, original: origUrl };
          loadedOriginalIds.add(image.id);
          originalRetryCount.delete(image.id);
          clearRetryTimer(image.id);
        } else {
          scheduleRetry(image.id, "original");
        }
      } finally {
        inFlightOriginalIds.delete(image.id);
      }
    }
  };

  /**
   * 刷新列表并尽量复用已有项，避免全量图片重新加载。
   * @param reset 是否从第一页重置加载
   * @param opts.preserveScroll 是否保留当前滚动位置（用于 image-added 事件，避免回到顶部）
   * @param opts.forceReload 是否强制重新加载所有图片 URL（清除缓存）
   * @param opts.skipScrollReset 是否跳过滚动重置（用于 onActivated，由调用者自行恢复滚动位置）
   */
  const refreshImagesPreserveCache = async (
    reset = true,
    opts: {
      preserveScroll?: boolean;
      forceReload?: boolean;
      skipScrollReset?: boolean;
    } = {}
  ) => {
    const preserveScroll = opts.preserveScroll ?? false;
    const forceReload = opts.forceReload ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;
    const container = preserveScroll ? galleryContainerRef.value : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    // 如果强制重新加载，清除 URL 缓存并清空列表以触发重新挂载动画
    if (forceReload) {
      // 先清空列表，让 Vue 移除所有元素
      setDisplayedImages([]);
      await nextTick();
      imageSrcMap.value = {};
      loadedThumbnailIds.clear();
      loadedOriginalIds.clear();
      inFlightThumbnailIds.clear();
      inFlightOriginalIds.clear();
    }

    // 记录旧的图片 ID，用于判断哪些是新增的
    const oldIds = forceReload
      ? new Set<string>()
      : new Set(displayedImages.value.map((img) => img.id));

    await crawlerStore.loadImages(reset);

    // 使用新的图片数据（不复用旧引用，确保数据更新）
    setDisplayedImages([...crawlerStore.images]);

    await nextTick();

    // 为需要加载的图片加载 URL
    const imagesToLoad = forceReload
      ? displayedImages.value
      : displayedImages.value.filter((img) => !oldIds.has(img.id));
    loadImageUrls(imagesToLoad);

    // 滚动处理：skipScrollReset 时跳过任何滚动操作（由调用者自行处理）
    if (!skipScrollReset) {
      if (preserveScroll && container) {
        container.scrollTop = prevScrollTop;
      } else if (reset) {
        const c = container ?? galleryContainerRef.value;
        if (c) c.scrollTop = 0;
      }
    }
  };

  // 执行锁，防止 refreshLatestIncremental 并发执行
  let isRefreshingIncremental = false;

  /**
   * 仅增量获取最新一页图片并追加到末尾，避免全量刷新和旧图重载。
   *
   * 重要规则：
   * - 当 hasMore=true（有加载更多按钮）时，不自动增长画廊，新图片藏在"加载更多"里
   * - 当 hasMore=false（没有更多了）时，画廊自动增长，且不会自动设置 hasMore=true
   * - 当画廊为空时，使用正常的分页加载初始化，而不是增量刷新
   * - hasMore 只在用户主动刷新时由分页逻辑设置，增量刷新不会让"加载更多"按钮出现
   */
  const refreshLatestIncremental = async () => {
    // 如果正在执行，直接返回，避免并发执行导致重复添加
    if (isRefreshingIncremental) {
      return;
    }

    isRefreshingIncremental = true;
    try {
      // 如果画廊为空，使用正常的分页加载初始化（确保 store 状态正确同步）
      if (displayedImages.value.length === 0) {
        await refreshImagesPreserveCache(true);
        return;
      }

      // 如果还有更多未加载（hasMore=true），不自动增长画廊
      // 新下载的图片会藏在"加载更多"按钮里
      if (crawlerStore.hasMore) {
        return;
      }

      // hasMore=false 时，画廊自动增长
      // 获取足够多的图片以包含所有新增的（不限于 pageSize）
      // 在获取数据前先记录当前的 existingIds，避免并发时重复添加
      const existingIds = new Set(displayedImages.value.map((img) => img.id));

      // 使用较大的 pageSize 来获取所有可能的新图片
      // 但不要超过合理范围，避免一次加载太多
      const fetchSize = Math.max(
        crawlerStore.pageSize,
        displayedImages.value.length + 100
      );
      const result = await invoke<RangedImages>("get_images_range", {
        offset: 0,
        limit: fetchSize,
      });

      // 再次获取当前的 existingIds（可能在异步操作期间有新图片被添加）
      const currentExistingIds = new Set(
        displayedImages.value.map((img) => img.id)
      );

      // 过滤出新图片（双重检查：既检查初始的 existingIds，也检查当前的 currentExistingIds）
      const newOnes = result.images.filter(
        (img) => !existingIds.has(img.id) && !currentExistingIds.has(img.id)
      );

      // 更新 hasMore：只在确定已拿到全部数据时将其关闭，避免遗留的 true 导致按钮出现
      const totalAfterAdd = displayedImages.value.length + newOnes.length;
      if (totalAfterAdd >= result.total) {
        crawlerStore.hasMore = false;
      }

      if (newOnes.length === 0) return;

      // 最后一次检查：在追加前再次确认这些图片确实不存在（防止并发添加）
      const finalExistingIds = new Set(
        displayedImages.value.map((img) => img.id)
      );
      const trulyNewOnes = newOnes.filter(
        (img) => !finalExistingIds.has(img.id)
      );

      if (trulyNewOnes.length === 0) return;

      // 将新增图片追加到列表末尾
      setDisplayedImages([...displayedImages.value, ...trulyNewOnes]);

      // 同步 crawlerStore 状态，保持与 displayedImages 一致
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.totalImages = result.total;

      // 加载新增图片的 URL
      loadImageUrls(trulyNewOnes);
    } catch (error) {
      console.error("增量刷新最新图片失败:", error);
    } finally {
      isRefreshingIncremental = false;
    }
  };

  // 加载更多图片（手动加载）
  // 直接基于 displayedImages 的长度计算 offset，不依赖“页数”状态
  // 避免 displayedImages 和 crawlerStore.images 不同步导致的问题
  // 支持初始加载：当 displayedImages.value.length === 0 时，加载第一页
  const loadMoreImages = async (isInitialLoad = false) => {
    // 初始加载时，跳过 hasMore 检查（因为初始时 hasMore 可能还是 false）
    if (!isInitialLoad && (!crawlerStore.hasMore || isLoadingMore.value)) {
      return;
    }

    // 非初始加载时，如果正在加载更多，直接返回
    if (!isInitialLoad && isLoadingMore.value) {
      return;
    }

    isLoadingMore.value = true; // 设置标志，防止 watch 触发
    const container = galleryContainerRef.value;
    if (!container) {
      isLoadingMore.value = false;
      return;
    }

    // 记录加载前的滚动位置（初始加载时不需要保持）
    const prevScrollTop = container.scrollTop;
    const isFirstPage = displayedImages.value.length === 0;

    try {
      const offset = displayedImages.value.length;

      // 初始加载时，重置 crawlerStore 状态（hasMore/total 由后端返回决定）
      if (isInitialLoad || isFirstPage) {
        crawlerStore.images = [];
        crawlerStore.hasMore = false;
      }

      // 直接从后端获取下一页，不依赖 crawlerStore.loadImages
      const result = await invoke<RangedImages>("get_images_range", {
        offset,
        limit: crawlerStore.pageSize,
      });

      // 过滤出新图片（避免重复，因为增量刷新可能已经添加了部分图片）
      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      const newImages = result.images.filter((img) => !existingIds.has(img.id));

      if (newImages.length > 0) {
        // 先计算更新后的总数和 hasMore，避免在设置 displayedImages 后短暂显示"加载更多"按钮
        const totalDisplayed = displayedImages.value.length + newImages.length;
        const hasMore = totalDisplayed < result.total;

        // 在设置 displayedImages 之前先更新 hasMore，确保按钮状态正确
        crawlerStore.hasMore = hasMore;

        // 创建新数组引用，确保 Vue 能够检测到变化（特别是 transition-group）
        // 先设置 displayedImages，让元素先渲染出来，用户可以看到骨架屏或占位符
        setDisplayedImages([...displayedImages.value, ...newImages]);

        // 等待 DOM 更新完成
        await nextTick();

        // 初始加载时，重置滚动位置到顶部；否则保持用户原来的滚动位置
        if (isFirstPage) {
          if (container) {
            container.scrollTop = 0;
          }
        } else {
          // 恢复滚动位置：保持用户原来的滚动位置
          // 使用延迟策略，确保动画和图片加载完成后恢复
          setTimeout(() => {
            if (container) {
              container.scrollTop = prevScrollTop;
            }
          }, 100);
        }

        // 仅为新增的图片加载 URL，避免触发旧图重新加载
        loadImageUrls(newImages);
      } else {
        // 即使没有新图片，也要更新 hasMore（可能总数变化了）
        const totalDisplayed = displayedImages.value.length;
        crawlerStore.hasMore = totalDisplayed < result.total;
      }

      // 同步 crawlerStore 状态，保持一致性
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.totalImages = result.total;
    } catch (error) {
      console.error("加载更多图片失败:", error);
    } finally {
      // 延迟重置标志，确保 watch 不会立即触发
      setTimeout(() => {
        isLoadingMore.value = false;
      }, 100);
    }
  };

  // 加载全部图片（加载所有剩余的图片）
  const loadAllImages = async () => {
    if (!crawlerStore.hasMore || isLoadingMore.value) {
      return;
    }

    const container = galleryContainerRef.value;
    if (!container) {
      return;
    }

    // 重置取消标志
    abortLoadAll = false;

    // 记录加载前的滚动位置：只在用户没有主动滚动的情况下恢复（避免"抢滚动"）
    const prevScrollTop = container.scrollTop;

    try {
      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      let appended = 0;
      let pageCount = 0;
      let pendingAppend: ImageInfo[] = [];

      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

      // “温和加载全部”：优先让滚动交互顺滑，加载全部只需要稳定推进即可
      const waitLoadAllPace = async () => {
        // 拖拽滚动期间：暂停推进（用户不会看那么快，帧率更重要）
        if (isInteracting?.value) {
          await sleep(220);
          return;
        }
        // 非交互：尽量用 idle，不阻塞主线程
        if (typeof requestIdleCallback !== "undefined") {
          await new Promise<void>((resolve) =>
            requestIdleCallback(() => resolve(), { timeout: 1500 })
          );
          return;
        }
        await sleep(90);
      };

      const flushPendingAppend = async () => {
        if (pendingAppend.length === 0) return;
        setDisplayedImages([...displayedImages.value, ...pendingAppend]);
        pendingAppend = [];
        await nextTick();
        await nextFrame();
      };

      // 分批加载并"渐进追加"到 displayedImages，避免一次性插入上千节点卡顿
      while (true) {
        // 检查是否被取消（刷新时会设置此标志）
        if (abortLoadAll) {
          console.log("加载全部被取消");
          break;
        }

        const offset = displayedImages.value.length;
        const result = await invoke<RangedImages>("get_images_range", {
          offset,
          limit: crawlerStore.pageSize,
        });

        // 再次检查取消标志（异步操作后可能已被取消）
        if (abortLoadAll) {
          console.log("加载全部被取消（异步后）");
          break;
        }

        crawlerStore.totalImages = result.total;

        if (!result.images || result.images.length === 0) {
          break;
        }

        const newImages = result.images.filter(
          (img) => !existingIds.has(img.id)
        );
        if (newImages.length > 0) {
          // 批量追加：减少频繁的大数组拷贝/响应式更新（十万级列表下很关键）
          pendingAppend.push(...newImages);
          appended += newImages.length;
          newImages.forEach((img) => existingIds.add(img.id));
        }

        // 已到末尾：退出
        if (offset + result.images.length >= result.total) {
          break;
        }

        pageCount++;
        // 每 2 页 flush 一次 UI（让用户看到进度在走），并让出主线程
        if (pageCount % 2 === 0) {
          await flushPendingAppend();
        }
        // 控制“加载全部”速度：空闲优先；交互期间自动放慢/暂停
        await waitLoadAllPace();
      }

      // 最后 flush 一次剩余 pending
      await flushPendingAppend();

      // 如果被取消，不执行后续的状态同步
      if (abortLoadAll) {
        return;
      }

      // 等待最终 DOM 更新
      if (appended > 0) {
        // 恢复滚动位置：仅当用户仍停留在原位置附近（没有主动滚动）
        const delta = Math.abs(container.scrollTop - prevScrollTop);
        if (delta < 4) {
          container.scrollTop = prevScrollTop;
        }

        // 确保当前视口 URL 能尽快补齐（不会扫描全量）
        void loadImageUrls();
      }

      // 更新 hasMore：应该已经加载完所有图片
      const totalDisplayed = displayedImages.value.length;
      crawlerStore.hasMore = totalDisplayed < crawlerStore.totalImages;

      // 同步 crawlerStore 状态
      crawlerStore.images = [...displayedImages.value];
    } catch (error) {
      console.error("加载全部图片失败:", error);
    }
  };

  // 取消加载全部操作
  const cancelLoadAll = () => {
    abortLoadAll = true;
  };

  // 批量从 UI 缓存里移除（用于后端批量去重后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);

    // 从列表移除
    setDisplayedImages(
      displayedImages.value.filter((img) => !idSet.has(img.id))
    );

    // 清理 imageSrcMap / Blob URL / Blob 对象引用 / loaded set
    const nextMap: Record<string, { thumbnail?: string; original?: string }> = {
      ...imageSrcMap.value,
    };
    for (const id of imageIds) {
      clearRetryTimer(id);
      thumbnailRetryCount.delete(id);
      originalRetryCount.delete(id);
      const data = nextMap[id];
      if (data?.thumbnail) {
        console.log("revoke thumbnail", data.thumbnail);
        // convertFileSrc 不需要 revoke
      }
      if (data?.original) {
        // convertFileSrc 不需要 revoke
      }
      delete nextMap[id];
      loadedThumbnailIds.delete(id);
      loadedOriginalIds.delete(id);
      inFlightThumbnailIds.delete(id);
      inFlightOriginalIds.delete(id);
    }
    imageSrcMap.value = nextMap;
  };

  // 重新创建特定图片的 URL（用于处理 Blob URL 失效的情况）
  const recreateImageUrl = async (
    imageId: string,
    localPath: string,
    isThumbnail: boolean = false
  ) => {
    const image = displayedImages.value.find((img) => img.id === imageId);
    if (!image) {
      console.warn("图片不存在，无法重新创建 URL:", imageId);
      return;
    }

    // 确定要使用的路径
    const pathToUse =
      isThumbnail && image.thumbnailPath ? image.thumbnailPath : localPath;

    // 重新创建 URL
    const newUrl = await getImageUrl(pathToUse);
    if (!newUrl) {
      console.error("重新创建 URL 失败:", pathToUse);
      return;
    }

    // 更新 imageSrcMap
    const currentData = imageSrcMap.value[imageId] || {};
    const newData = { ...currentData };

    if (isThumbnail) {
      // convertFileSrc 不需要释放旧 URL
      if (currentData.thumbnail) {
        try {
          // ignore
        } catch (e) {
          // 忽略错误
        }
      }
      newData.thumbnail = newUrl;
    } else {
      // convertFileSrc 不需要释放旧 URL
      if (currentData.original) {
        try {
          // ignore
        } catch (e) {
          // 忽略错误
        }
      }
      newData.original = newUrl;
    }

    // 更新 imageSrcMap
    // 原地写入，避免复制整个大对象
    imageSrcMap.value[imageId] = newData;
  };

  // 清理缓存
  const cleanup = () => {
    imageSrcMap.value = {};
    loadedThumbnailIds.clear();
    loadedOriginalIds.clear();
    inFlightThumbnailIds.clear();
    inFlightOriginalIds.clear();
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    thumbnailRetryCount.clear();
    originalRetryCount.clear();
  };

  return {
    displayedImages,
    imageSrcMap,
    loadImageUrls,
    refreshImagesPreserveCache,
    refreshLatestIncremental,
    loadMoreImages,
    loadAllImages,
    cancelLoadAll,
    removeFromUiCacheByIds,
    recreateImageUrl,
    cleanup,
  };
}
