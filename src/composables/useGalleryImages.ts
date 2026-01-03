import { ref, shallowRef, nextTick, type Ref } from "vue";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";

/**
 * 画廊图片加载和URL管理 composable
 */
export function useGalleryImages(
  galleryContainerRef: Ref<HTMLElement | null>,
  filterPluginId: Ref<string | null>,
  showFavoritesOnly: Ref<boolean>,
  isLoadingMore: Ref<boolean>
) {
  const crawlerStore = useCrawlerStore();

  // 使用独立的本地图片列表，避免直接修改 store 的 images 导致的重新渲染
  // 使用 shallowRef 减少深度响应式追踪，提高性能
  const displayedImages = shallowRef<ImageInfo[]>([]);

  // 图片 URL 映射，存储每个图片的缩略图和原图 URL
  // 使用 shallowRef 减少深度响应式追踪，避免每次更新都触发重新渲染
  const imageSrcMap = ref<Record<string, { thumbnail?: string; original?: string }>>({});
  
  // 已经加载过 URL 的图片 ID，用于快速跳过重复加载
  const loadedImageIds = new Set<string>();

  // 存储所有创建的 Blob URL，用于在组件卸载时释放内存
  const blobUrls = new Set<string>();

  // 将本地文件路径转换为 Blob URL（比 base64 更高效）
  async function getImageUrl(localPath: string): Promise<string> {
    if (!localPath) return "";
    try {
      // 移除 Windows 长路径前缀 \\?\（如果存在）
      let normalizedPath = localPath.trimStart().replace(/^\\\\\?\\/, "");

      // 读取文件二进制数据
      const fileData = await readFile(normalizedPath);

      // 根据文件扩展名确定 MIME 类型
      const ext = normalizedPath.split('.').pop()?.toLowerCase();
      let mimeType = "image/jpeg";
      if (ext === "png") mimeType = "image/png";
      else if (ext === "gif") mimeType = "image/gif";
      else if (ext === "webp") mimeType = "image/webp";
      else if (ext === "bmp") mimeType = "image/bmp";

      // 创建 Blob 对象
      const blob = new Blob([fileData], { type: mimeType });

      // 创建 Blob URL
      const blobUrl = URL.createObjectURL(blob);

      // 记录 Blob URL，以便后续释放
      blobUrls.add(blobUrl);

      return blobUrl;
    } catch (error) {
      console.error("Failed to load image file:", error, localPath);
      return "";
    }
  }

  // 获取视口内的图片ID（用于优先加载可见图片）
  const getVisibleImageIds = (): string[] => {
    const container = galleryContainerRef.value;
    if (!container) return [];

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

    return visibleIds;
  };

  // 加载图片 URL（可选传入待加载的图片列表）；只加载缺失的图片
  const loadImageUrls = async (targetImages?: ImageInfo[]) => {
    const source = targetImages ?? displayedImages.value;
    const visibleIds = getVisibleImageIds();
    const visibleSet = new Set(visibleIds);

    // 只获取还没有加载的图片
    const imagesToLoad = source.filter(img => {
      if (loadedImageIds.has(img.id)) return false;
      const existing = imageSrcMap.value[img.id];
      // 如果图片已经加载过（有 thumbnail 或 original），则跳过
      return !existing || (!existing.thumbnail && !existing.original);
    });

    // 可见图片优先加载
    imagesToLoad.sort((a, b) => {
      const av = visibleSet.has(a.id) ? 0 : 1;
      const bv = visibleSet.has(b.id) ? 0 : 1;
      if (av !== bv) return av - bv;
      return 0;
    });

    if (imagesToLoad.length === 0) {
      return;
    }

    // 优先加载前20张（可见区域），并行加载以加快速度
    const priorityImages = imagesToLoad.slice(0, 20);
    const remainingImages = imagesToLoad.slice(20);

    // 并行加载优先图片，每加载完一张立即更新，不等待所有图片加载完成
    const priorityPromises = priorityImages.map(async (image) => {
      // 再次检查，避免重复处理
      if (imageSrcMap.value[image.id]?.thumbnail || imageSrcMap.value[image.id]?.original) {
        return;
      }

      // 异步读取文件并转换为 Blob URL
      try {
        const thumbnailUrl = image.thumbnailPath ? await getImageUrl(image.thumbnailPath) : "";
        const originalUrl = await getImageUrl(image.localPath);

        // 检查图片是否仍然存在（可能在异步操作期间被删除）
        const imageStillExists = displayedImages.value.some(img => img.id === image.id);
        if (!imageStillExists) {
          return;
        }

        const imageData = {
          thumbnail: thumbnailUrl || originalUrl || undefined,
          original: originalUrl || undefined,
        };

        // 立即更新，不等待其他图片
        // 使用 Object.assign 确保触发响应式更新
        imageSrcMap.value = { ...imageSrcMap.value, [image.id]: imageData };
        loadedImageIds.add(image.id);
      } catch (error) {
        console.error("Failed to load image:", error, image);
      }
    });

    // 不等待所有优先图片加载完成，让它们并行加载并在完成后立即更新
    // 这样用户可以看到图片逐步出现，而不是等待所有图片加载完成
    Promise.all(priorityPromises).catch(() => {
      // 忽略错误，已经在单个 promise 中处理了
    });

    // 剩余的图片在后台处理，批量更新以减少重新渲染
    if (remainingImages.length > 0) {
      const remainingUpdates: Record<string, { thumbnail?: string; original?: string }> = {};
      let processedCount = 0;
      const BATCH_SIZE = 10; // 每处理 10 张图片批量更新一次

      // 使用 requestIdleCallback 或 setTimeout 在空闲时处理
      const processRemaining = async (index = 0) => {
        if (index >= remainingImages.length) {
          // 处理完所有图片后，批量更新剩余的
          if (Object.keys(remainingUpdates).length > 0) {
            imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
            Object.keys(remainingUpdates).forEach((id) => loadedImageIds.add(id));
          }
          return;
        }

        const image = remainingImages[index];
        // 再次检查，避免重复处理
        if (loadedImageIds.has(image.id) || imageSrcMap.value[image.id]?.thumbnail || imageSrcMap.value[image.id]?.original) {
          // 已处理，继续下一个
          if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => processRemaining(index + 1), { timeout: 2000 });
          } else {
            setTimeout(() => processRemaining(index + 1), 50);
          }
          return;
        }

        // 异步读取文件并转换为 Blob URL
        try {
          const thumbnailUrl = image.thumbnailPath ? await getImageUrl(image.thumbnailPath) : "";
          const originalUrl = await getImageUrl(image.localPath);

          // 检查图片是否仍然存在（可能在异步操作期间被删除）
          const imageStillExists = displayedImages.value.some(img => img.id === image.id);
          if (imageStillExists) {
            remainingUpdates[image.id] = {
              thumbnail: thumbnailUrl || originalUrl || undefined,
              original: originalUrl || undefined,
            };
            processedCount++;

            // 每处理 BATCH_SIZE 张图片，批量更新一次
            if (processedCount % BATCH_SIZE === 0) {
              imageSrcMap.value = { ...imageSrcMap.value, ...remainingUpdates };
              // 清空已更新的项
              Object.keys(remainingUpdates).forEach(key => delete remainingUpdates[key]);
            }
          }
        } catch (error) {
          console.error("Failed to load image:", error);
        }

        // 继续处理下一个
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => processRemaining(index + 1), { timeout: 2000 });
        } else {
          setTimeout(() => processRemaining(index + 1), 50);
        }
      };

      // 使用 requestIdleCallback 如果可用，否则使用 setTimeout
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => processRemaining(0), { timeout: 2000 });
      } else {
        setTimeout(() => processRemaining(0), 100);
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
    opts: { preserveScroll?: boolean; forceReload?: boolean; skipScrollReset?: boolean } = {}
  ) => {
    const preserveScroll = opts.preserveScroll ?? false;
    const forceReload = opts.forceReload ?? false;
    const skipScrollReset = opts.skipScrollReset ?? false;
    const container = preserveScroll
      ? galleryContainerRef.value
      : null;
    const prevScrollTop = container?.scrollTop ?? 0;

    // 如果强制重新加载，清除 URL 缓存并清空列表以触发重新挂载动画
    if (forceReload) {
      // 释放所有 Blob URL
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
      blobUrls.clear();
      imageSrcMap.value = {};
      loadedImageIds.clear();
      // 先清空列表，让 Vue 移除所有元素
      displayedImages.value = [];
      await nextTick();
    }

    // 记录旧的图片 ID，用于判断哪些是新增的
    const oldIds = forceReload ? new Set<string>() : new Set(displayedImages.value.map((img) => img.id));

    await crawlerStore.loadImages(reset, filterPluginId.value, showFavoritesOnly.value);

    // 使用新的图片数据（不复用旧引用，确保数据更新）
    displayedImages.value = [...crawlerStore.images];

    await nextTick();

    // 为需要加载的图片加载 URL
    const imagesToLoad = forceReload ? displayedImages.value : displayedImages.value.filter((img) => !oldIds.has(img.id));
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
      const fetchSize = Math.max(crawlerStore.pageSize, displayedImages.value.length + 100);
      const result = await invoke<{
        images: ImageInfo[];
        total: number;
        page: number;
        pageSize: number;
      }>("get_images_paginated", {
        page: 0,
        pageSize: fetchSize,
        pluginId: filterPluginId.value || null,
      });

      // 再次获取当前的 existingIds（可能在异步操作期间有新图片被添加）
      const currentExistingIds = new Set(displayedImages.value.map((img) => img.id));
      
      // 过滤出新图片（双重检查：既检查初始的 existingIds，也检查当前的 currentExistingIds）
      const newOnes = result.images.filter((img) => 
        !existingIds.has(img.id) && !currentExistingIds.has(img.id)
      );

      // 更新 hasMore：只在确定已拿到全部数据时将其关闭，避免遗留的 true 导致按钮出现
      const totalAfterAdd = displayedImages.value.length + newOnes.length;
      if (totalAfterAdd >= result.total) {
        crawlerStore.hasMore = false;
      }

      if (newOnes.length === 0) return;

      // 最后一次检查：在追加前再次确认这些图片确实不存在（防止并发添加）
      const finalExistingIds = new Set(displayedImages.value.map((img) => img.id));
      const trulyNewOnes = newOnes.filter((img) => !finalExistingIds.has(img.id));

      if (trulyNewOnes.length === 0) return;

      // 将新增图片追加到列表末尾
      displayedImages.value = [...displayedImages.value, ...trulyNewOnes];

      // 同步 crawlerStore 状态，保持与 displayedImages 一致
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.totalImages = result.total;
      // 计算正确的 currentPage（基于当前显示数量）
      crawlerStore.currentPage = Math.ceil(displayedImages.value.length / crawlerStore.pageSize);

      // 加载新增图片的 URL
      await loadImageUrls(trulyNewOnes);

    } catch (error) {
      console.error("增量刷新最新图片失败:", error);
    } finally {
      isRefreshingIncremental = false;
    }
  };

  // 加载更多图片（手动加载）
  // 直接基于 displayedImages 的长度计算下一页，不依赖 crawlerStore.currentPage
  // 避免 displayedImages 和 crawlerStore.images 不同步导致的问题
  const loadMoreImages = async () => {
    if (!crawlerStore.hasMore || isLoadingMore.value) {
      return;
    }

    isLoadingMore.value = true; // 设置标志，防止 watch 触发
    const container = galleryContainerRef.value;
    if (!container) {
      isLoadingMore.value = false;
      return;
    }

    // 记录加载前的滚动位置
    const prevScrollTop = container.scrollTop;

    try {
      // 计算下一页的页码（基于当前显示的图片数量）
      const nextPage = Math.floor(displayedImages.value.length / crawlerStore.pageSize);

      // 直接从后端获取下一页，不依赖 crawlerStore.loadImages
      const result = await invoke<{
        images: ImageInfo[];
        total: number;
        page: number;
        pageSize: number;
      }>("get_images_paginated", {
        page: nextPage,
        pageSize: crawlerStore.pageSize,
        pluginId: filterPluginId.value || null,
        favoritesOnly: showFavoritesOnly.value || null,
      });

      // 过滤出新图片（避免重复，因为增量刷新可能已经添加了部分图片）
      const existingIds = new Set(displayedImages.value.map(img => img.id));
      const newImages = result.images.filter(img => !existingIds.has(img.id));

      if (newImages.length > 0) {
        // 创建新数组引用，确保 Vue 能够检测到变化（特别是 transition-group）
        displayedImages.value = [...displayedImages.value, ...newImages];

        // 等待 DOM 更新完成
        await nextTick();

        // 恢复滚动位置：保持用户原来的滚动位置
        // 使用延迟策略，确保动画和图片加载完成后恢复
        setTimeout(() => {
          if (container) {
            container.scrollTop = prevScrollTop;
          }
        }, 100);

        // 仅为新增的图片加载 URL，避免触发旧图重新加载
        await loadImageUrls(newImages);
      }

      // 更新 hasMore：基于当前显示数量与总数比较
      const totalDisplayed = displayedImages.value.length;
      crawlerStore.hasMore = totalDisplayed < result.total;

      // 同步 crawlerStore 状态，保持一致性
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.currentPage = nextPage + 1;
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

    // 先获取第一页来获取最新的总数
    const currentCount = displayedImages.value.length;
    const nextPage = Math.floor(currentCount / crawlerStore.pageSize);

    // 获取第一页数据以获取最新的总数
    const firstPageResult = await invoke<{
      images: ImageInfo[];
      total: number;
      page: number;
      pageSize: number;
    }>("get_images_paginated", {
      page: nextPage,
      pageSize: crawlerStore.pageSize,
      pluginId: filterPluginId.value || null,
      favoritesOnly: showFavoritesOnly.value || null,
    });

    // 更新总数
    crawlerStore.totalImages = firstPageResult.total;

    const container = galleryContainerRef.value;
    if (!container) {
      return;
    }

    // 记录加载前的滚动位置
    const prevScrollTop = container.scrollTop;

    try {
      // 计算需要加载的总数
      const totalToLoad = firstPageResult.total;
      const currentDisplayed = displayedImages.value.length;
      const remaining = totalToLoad - currentDisplayed;

      if (remaining <= 0) {
        crawlerStore.hasMore = false;
        return;
      }

      // 分批加载，每次加载 pageSize 的数量，直到加载完所有图片
      let loadedCount = 0;
      let currentPage = nextPage;
      const allNewImages: ImageInfo[] = [];
      const existingIds = new Set(displayedImages.value.map(img => img.id));

      // 先处理第一页的结果（如果还没有加载过）
      const firstPageNewImages = firstPageResult.images.filter(img => !existingIds.has(img.id));
      if (firstPageNewImages.length > 0) {
        allNewImages.push(...firstPageNewImages);
        firstPageNewImages.forEach(img => existingIds.add(img.id));
        loadedCount += firstPageNewImages.length;
      }
      currentPage++;

      // 继续加载后续页面
      while (loadedCount < remaining) {
        const result = await invoke<{
          images: ImageInfo[];
          total: number;
          page: number;
          pageSize: number;
        }>("get_images_paginated", {
          page: currentPage,
          pageSize: crawlerStore.pageSize,
          pluginId: filterPluginId.value || null,
          favoritesOnly: showFavoritesOnly.value || null,
        });

        // 过滤出新图片
        const newImages = result.images.filter(img => !existingIds.has(img.id));

        if (newImages.length === 0) {
          // 没有新图片了，退出循环
          break;
        }

        allNewImages.push(...newImages);
        newImages.forEach(img => existingIds.add(img.id));
        loadedCount += newImages.length;

        // 更新总数（可能后端返回的总数更准确）
        crawlerStore.totalImages = result.total;

        // 如果已经加载了所有图片，退出循环
        if (loadedCount >= remaining || displayedImages.value.length + allNewImages.length >= result.total) {
          break;
        }

        currentPage++;
      }

      if (allNewImages.length > 0) {
        // 创建新数组引用，确保 Vue 能够检测到变化
        displayedImages.value = [...displayedImages.value, ...allNewImages];

        // 等待 DOM 更新完成
        await nextTick();

        // 恢复滚动位置
        setTimeout(() => {
          if (container) {
            container.scrollTop = prevScrollTop;
          }
        }, 100);

        // 为新增的图片加载 URL
        await loadImageUrls(allNewImages);
      }

      // 更新 hasMore：应该已经加载完所有图片
      const totalDisplayed = displayedImages.value.length;
      crawlerStore.hasMore = totalDisplayed < crawlerStore.totalImages;

      // 同步 crawlerStore 状态
      crawlerStore.images = [...displayedImages.value];
      crawlerStore.currentPage = Math.ceil(totalDisplayed / crawlerStore.pageSize);
    } catch (error) {
      console.error("加载全部图片失败:", error);
    }
  };

  // 批量从 UI 缓存里移除（用于后端批量去重后的同步）
  const removeFromUiCacheByIds = (imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);

    // 从列表移除
    displayedImages.value = displayedImages.value.filter((img) => !idSet.has(img.id));

    // 清理 imageSrcMap / Blob URL / loaded set
    const nextMap: Record<string, { thumbnail?: string; original?: string }> = {
      ...imageSrcMap.value,
    };
    for (const id of imageIds) {
      const data = nextMap[id];
      if (data?.thumbnail) {
        URL.revokeObjectURL(data.thumbnail);
        blobUrls.delete(data.thumbnail);
      }
      if (data?.original) {
        URL.revokeObjectURL(data.original);
        blobUrls.delete(data.original);
      }
      delete nextMap[id];
      loadedImageIds.delete(id);
    }
    imageSrcMap.value = nextMap;
  };

  // 清理所有 Blob URL
  const cleanup = () => {
    blobUrls.forEach(url => {
      URL.revokeObjectURL(url);
    });
    blobUrls.clear();
    imageSrcMap.value = {};
    loadedImageIds.clear();
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
    cleanup,
  };
}

