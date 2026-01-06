import { ref, shallowRef, nextTick, type Ref } from "vue";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
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
  gridColumns?: Ref<number>
) {
  const crawlerStore = useCrawlerStore();

  // 使用独立的本地图片列表，避免直接修改 store 的 images 导致的重新渲染
  // 使用 shallowRef 减少深度响应式追踪，提高性能
  const displayedImages = shallowRef<ImageInfo[]>([]);

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

  // 存储 Blob URL 到 Blob 对象的映射，用于在组件卸载时释放内存
  // 同时保持 Blob 对象引用，防止被垃圾回收导致 URL 失效
  const blobObjects = new Map<string, Blob>();

  // 将本地文件路径转换为 Blob URL（比 base64 更高效）
  async function getImageUrl(localPath: string): Promise<string> {
    if (!localPath) return "";
    try {
      // 移除 Windows 长路径前缀 \\?\（如果存在）
      let normalizedPath = localPath
        .trimStart()
        .replace(/^\\\\\?\\/, "")
        .trim();

      if (!normalizedPath) {
        console.error("路径为空:", localPath);
        return "";
      }

      // 读取文件二进制数据
      const fileData = await readFile(normalizedPath);

      // 验证文件数据
      if (!fileData || fileData.length === 0) {
        console.error("文件数据为空:", localPath);
        return "";
      }

      // 根据文件扩展名确定 MIME 类型
      const ext = normalizedPath.split(".").pop()?.toLowerCase();
      let mimeType = "image/jpeg";
      if (ext === "png") mimeType = "image/png";
      else if (ext === "gif") mimeType = "image/gif";
      else if (ext === "webp") mimeType = "image/webp";
      else if (ext === "bmp") mimeType = "image/bmp";

      // 创建 Blob 对象
      const blob = new Blob([fileData], { type: mimeType });

      // 验证 Blob 大小
      if (blob.size === 0) {
        console.error("Blob 大小为 0:", localPath);
        return "";
      }

      // 创建 Blob URL
      const blobUrl = URL.createObjectURL(blob);

      // 存储 Blob URL 到 Blob 对象的映射，防止被垃圾回收
      blobObjects.set(blobUrl, blob);
      // console.log("set blob object", blobUrl, blob);
      return blobUrl;
    } catch (error) {
      console.error("Failed to load image file:", error, localPath);
      return "";
    }
  }

  const calcGridGap = (columns: number) => Math.max(4, 16 - (Math.max(1, columns) - 1));

  /**
   * 快速估算可见范围（返回索引区间 [start, end)）。
   * 依赖：
   * - 列数 gridColumns
   * - 宽高比（沿用 ImageGrid 里的 window.innerWidth / window.innerHeight）
   * - gap 规则与 ImageGrid 的 gridStyle 保持一致
   */
  const estimateVisibleIndexRange = (): { start: number; end: number; visibleIds: string[] } => {
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
        const isVisible = rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
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
    const containerWidth = Math.max(0, container.clientWidth - gridHorizontalPadding);
    const itemWidth =
      columns <= 1 ? containerWidth : (containerWidth - gap * (columns - 1)) / columns;
    const aspectRatio = Math.max(0.1, window.innerWidth / Math.max(1, window.innerHeight));
    const itemHeight = itemWidth > 0 ? itemWidth / aspectRatio : 200;
    const rowHeight = itemHeight + gap;

    // overscan：让视口上下多取几行，避免滚动边缘“来不及加载”
    const overscanRows = 3;
    const startRow = Math.max(0, Math.floor(container.scrollTop / rowHeight) - overscanRows);
    const endRow = Math.ceil((container.scrollTop + container.clientHeight) / rowHeight) + overscanRows;

    const start = Math.max(0, Math.min(images.length, startRow * columns));
    const end = Math.max(start, Math.min(images.length, (endRow + 1) * columns));
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
    const range = targetImages ? null : estimateVisibleIndexRange();
    const source = targetImages ?? displayedImages.value.slice(range!.start, range!.end);
    const visibleIds = targetImages ? (range ? range.visibleIds : []) : range!.visibleIds;
    const visibleSet = new Set(visibleIds);

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

    // 优先加载前30张（可见区域及附近），并行加载
    const priorityImages = imagesToLoad.slice(0, 30);
    const remainingImages = imagesToLoad.slice(30);

    // 优先队列：限制并发；并且"先出缩略图"，原图按需补齐
    void runPool(priorityImages, 6, async (image) => {
      await loadSingleImageUrl(image, needOriginal);
    });

    // 剩余的图片在后台使用 requestIdleCallback 逐步加载
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
          imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
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
            imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
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
              const imageStillExists = displayedImages.value.some(
                (img) => img.id === image.id
              );
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

              const imageStillExists = displayedImages.value.some(
                (img) => img.id === image.id
              );
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
        const thumbPath = image.thumbnailPath || image.localPath;
        const thumbUrl = thumbPath ? await getImageUrl(thumbPath) : "";

        // 图片可能在异步期间被移除
        if (!displayedImages.value.some((img) => img.id === image.id)) return;

        if (thumbUrl) {
          imageSrcMap.value = {
            ...imageSrcMap.value,
            [image.id]: { ...existing, thumbnail: thumbUrl },
          };
          loadedThumbnailIds.add(image.id);
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
        if (!displayedImages.value.some((img) => img.id === image.id)) return;
        if (origUrl) {
          const curr = imageSrcMap.value[image.id] || {};
          imageSrcMap.value = {
            ...imageSrcMap.value,
            [image.id]: { ...curr, original: origUrl },
          };
          loadedOriginalIds.add(image.id);
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
      displayedImages.value = [];
      await nextTick();
      // 释放所有 Blob URL 和 Blob 对象引用
      for (const url of blobObjects.keys()) {
        URL.revokeObjectURL(url);
      }
      // console.log("clear blob urls");
      // console.trace();
      blobObjects.clear();
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
    displayedImages.value = [...crawlerStore.images];

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
      displayedImages.value = [...displayedImages.value, ...trulyNewOnes];

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
        displayedImages.value = [...displayedImages.value, ...newImages];

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

    // 记录加载前的滚动位置：只在用户没有主动滚动的情况下恢复（避免“抢滚动”）
    const prevScrollTop = container.scrollTop;

    try {
      const existingIds = new Set(displayedImages.value.map((img) => img.id));
      let appended = 0;
      let pageCount = 0;

      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      // 分批加载并“渐进追加”到 displayedImages，避免一次性插入上千节点卡顿
      while (true) {
        const offset = displayedImages.value.length;
        const result = await invoke<RangedImages>("get_images_range", {
          offset,
          limit: crawlerStore.pageSize,
        });

        crawlerStore.totalImages = result.total;

        if (!result.images || result.images.length === 0) {
          break;
        }

        const newImages = result.images.filter(
          (img) => !existingIds.has(img.id)
        );
        if (newImages.length > 0) {
          // 先追加到 UI，动画更平滑；URL 加载由滚动/可见范围触发（不提前刷全量）
          displayedImages.value = [...displayedImages.value, ...newImages];
          appended += newImages.length;
          newImages.forEach((img) => existingIds.add(img.id));
        }

        // 已到末尾：退出
        if (offset + result.images.length >= result.total) {
          break;
        }

        pageCount++;
        // 每追加 2 页就让出一帧，保证滚动/动画有机会运行
        if (pageCount % 2 === 0) {
          await nextTick();
          await nextFrame();
        }
      }

      // 等待最终 DOM 更新
      if (appended > 0) {
        await nextTick();
        await nextFrame();

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

  // 批量从 UI 缓存里移除（用于后端批量去重后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);

    // 从列表移除
    displayedImages.value = displayedImages.value.filter(
      (img) => !idSet.has(img.id)
    );

    // 清理 imageSrcMap / Blob URL / Blob 对象引用 / loaded set
    const nextMap: Record<string, { thumbnail?: string; original?: string }> = {
      ...imageSrcMap.value,
    };
    for (const id of imageIds) {
      const data = nextMap[id];
      if (data?.thumbnail) {
        console.log("revoke thumbnail", data.thumbnail);
        URL.revokeObjectURL(data.thumbnail);
        blobObjects.delete(data.thumbnail);
      }
      if (data?.original) {
        console.log("revoke original", data.original);
        URL.revokeObjectURL(data.original);
        blobObjects.delete(data.original);
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
      // 释放旧的缩略图 URL
      if (currentData.thumbnail) {
        try {
          URL.revokeObjectURL(currentData.thumbnail);
          blobObjects.delete(currentData.thumbnail);
        } catch (e) {
          // 忽略错误
        }
      }
      newData.thumbnail = newUrl;
    } else {
      // 释放旧的原图 URL
      if (currentData.original) {
        try {
          URL.revokeObjectURL(currentData.original);
          blobObjects.delete(currentData.original);
        } catch (e) {
          // 忽略错误
        }
      }
      newData.original = newUrl;
    }

    // 更新 imageSrcMap
    imageSrcMap.value = { ...imageSrcMap.value, [imageId]: newData };
  };

  // 清理所有 Blob URL 和 Blob 对象引用
  const cleanup = () => {
    for (const url of blobObjects.keys()) {
      URL.revokeObjectURL(url);
    }
    blobObjects.clear();
    console.log("clear blob urls2");
    console.trace();
    imageSrcMap.value = {};
    loadedThumbnailIds.clear();
    loadedOriginalIds.clear();
    inFlightThumbnailIds.clear();
    inFlightOriginalIds.clear();
  };

  return {
    displayedImages,
    imageSrcMap,
    loadImageUrls,
    refreshImagesPreserveCache,
    refreshLatestIncremental,
    loadMoreImages,
    loadAllImages,
    removeFromUiCacheByIds,
    recreateImageUrl,
    cleanup,
  };
}
