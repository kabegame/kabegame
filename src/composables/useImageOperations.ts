import { computed, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox } from "element-plus";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { storeToRefs } from "pinia";

export type FavoriteStatusChangedDetail = {
  imageIds: string[];
  favorite: boolean;
};

/**
 * 图片操作 composable
 */
export function useImageOperations(
  displayedImages: Ref<ImageInfo[]>,
  imageSrcMap: Ref<Record<string, { thumbnail?: string; original?: string }>>,
  currentWallpaperImageId: Ref<string | null>,
  galleryViewRef: Ref<any>,
  removeFromUiCacheByIds: (imageIds: string[]) => void,
  loadImages: (reset?: boolean, opts?: any) => Promise<void>,
  loadMoreImages: () => Promise<void>
) {
  const crawlerStore = useCrawlerStore();
  const albumStore = useAlbumStore();
  const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
  const albums = computed(() => albumStore.albums);

  // 打开文件路径
  const handleOpenImagePath = async (localPath: string) => {
    try {
      await invoke("open_file_path", { filePath: localPath });
    } catch (error) {
      console.error("打开文件失败:", error);
      ElMessage.error("打开文件失败");
    }
  };

  // 复制图片到剪贴板
  const handleCopyImage = async (image: ImageInfo) => {
    try {
      // 获取图片的 Blob URL
      const imageUrl =
        imageSrcMap.value[image.id]?.original ||
        imageSrcMap.value[image.id]?.thumbnail;
      if (!imageUrl) {
        ElMessage.warning("图片尚未加载完成，请稍后再试");
        return;
      }

      // 从 Blob URL 获取 Blob
      const response = await fetch(imageUrl);
      let blob = await response.blob();

      // 如果 blob 类型是 image/jpeg，转换为 PNG（因为某些浏览器不支持 image/jpeg）
      if (blob.type === "image/jpeg" || blob.type === "image/jpg") {
        // 创建一个 canvas 来转换图片格式
        const img = new Image();
        img.src = imageUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("无法创建 canvas context");
        }
        ctx.drawImage(img, 0, 0);

        // 将 canvas 转换为 PNG blob
        blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("转换图片失败"));
            }
          }, "image/png");
        });
      }

      // 使用 Clipboard API 复制图片
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);

      ElMessage.success("图片已复制到剪贴板");
    } catch (error) {
      console.error("复制图片失败:", error);
      ElMessage.error("复制图片失败");
    }
  };

  // 应用收藏状态变化到画廊缓存
  const applyFavoriteChangeToGalleryCache = (
    imageIds: string[],
    favorite: boolean
  ) => {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);

    // 就地更新 favorite 字段（避免全量刷新）
    let changed = false;
    const next = displayedImages.value.map((img) => {
      if (!idSet.has(img.id)) return img;
      if ((img.favorite ?? false) === favorite) return img;
      changed = true;
      return { ...img, favorite };
    });
    if (changed) {
      displayedImages.value = next;
      crawlerStore.images = [...next];
    }
  };
  // 统一的删除操作：根据是否删除文件决定调用 removeImage 还是 deleteImage
  // 注意：此函数不再显示确认对话框，调用方需要自行处理确认逻辑
  const handleBatchDeleteImages = async (
    imagesToProcess: ImageInfo[],
    deleteFiles: boolean
  ) => {
    if (imagesToProcess.length === 0) return;

    try {
      // 删除触发“后续图片顶上来”的 move 过渡（仅短暂开启，避免加载更多抖动）
      galleryViewRef.value?.startDeleteMoveAnimation?.();

      const count = imagesToProcess.length;
      const imageIds = imagesToProcess.map((img) => img.id);
      const idSet = new Set(imageIds);
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);

      // 使用批量 API 一次性处理所有图片
      if (deleteFiles) {
        // Gallery 内部会手动更新列表；这里禁用 store 的全局事件，避免监听器抢先 refresh 导致滚动回顶
        await crawlerStore.batchDeleteImages(imageIds, { emitEvent: false });
      } else {
        await crawlerStore.batchRemoveImages(imageIds, { emitEvent: false });
      }

      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      // 从 displayedImages 中移除已处理的图片
      displayedImages.value = displayedImages.value.filter(
        (img) => !idSet.has(img.id)
      );

      // 清理 imageSrcMap 和 Blob URL（批量更新，避免循环中反复重建对象导致额外渲染/加载）
      const nextMap: Record<string, { thumbnail?: string; original?: string }> =
        { ...imageSrcMap.value };
      for (const id of idSet) {
        const imageData = nextMap[id];
        if (imageData?.thumbnail) URL.revokeObjectURL(imageData.thumbnail);
        if (imageData?.original) URL.revokeObjectURL(imageData.original);
        delete nextMap[id];
      }
      imageSrcMap.value = nextMap;

      const action = deleteFiles ? "删除" : "移除";
      ElMessage.success(`已${action} ${count} 张图片`);
      galleryViewRef.value?.clearSelection?.();

      // 通知其他视图同步（必须在本地移除后再发出，否则 Gallery 自己的监听器会抢先 refresh）
      const eventType = deleteFiles ? "images-deleted" : "images-removed";
      window.dispatchEvent(
        new CustomEvent(eventType, {
          detail: { imageIds },
        })
      );
    } catch (error) {
      const action = deleteFiles ? "删除" : "移除";
      console.error(`${action}失败:`, error);
      ElMessage.error(`${action}失败`);
    }
  };

  // 注意：按 hash 去重已改为后端“分批后台任务 + 事件驱动 UI 同步”，逻辑迁移到 Gallery.vue

  // 切换收藏状态
  const toggleFavorite = async (image: ImageInfo) => {
    try {
      const newFavorite = !(image.favorite ?? false);
      await invoke("toggle_image_favorite", {
        imageId: image.id,
        favorite: newFavorite,
      });

      ElMessage.success(newFavorite ? "已收藏" : "已取消收藏");

      // 新策略：收藏状态以 store 为准，不再通过全局事件/清缓存同步
      // 1) 更新画廊缓存（就地更新，避免全量刷新导致“加载更多”图片丢失）
      applyFavoriteChangeToGalleryCache([image.id], newFavorite);
      // 2) 更新收藏画册计数（用于画册页预览/计数显示）
      const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID.value] || 0;
      albumStore.albumCounts[FAVORITE_ALBUM_ID.value] = Math.max(
        0,
        currentCount + (newFavorite ? 1 : -1)
      );
      // 3) 若收藏画册图片缓存已加载：取消收藏应从缓存数组中移除（而不是清缓存）
      const favList = albumStore.albumImages[FAVORITE_ALBUM_ID.value];
      if (Array.isArray(favList)) {
        const idx = favList.findIndex((i) => i.id === image.id);
        if (newFavorite) {
          if (idx === -1) favList.push({ ...image, favorite: true });
          else favList[idx] = { ...favList[idx], favorite: true } as ImageInfo;
        } else {
          if (idx !== -1) favList.splice(idx, 1);
        }
      }
      galleryViewRef.value?.clearSelection?.();
    } catch (error) {
      console.error("切换收藏状态失败:", error);
      ElMessage.error("操作失败");
    }
  };

  // 设置壁纸（单选或多选）
  const setWallpaper = async (imagesToProcess: ImageInfo[]) => {
    try {
      if (imagesToProcess.length > 1) {
        // 多选：创建"桌面画册x"，添加到画册，开启轮播
        // 1. 找到下一个可用的"桌面画册x"名称
        await albumStore.loadAlbums();
        let albumName = "桌面画册1";
        let counter = 1;
        while (albums.value.some((a) => a.name === albumName)) {
          counter++;
          albumName = `桌面画册${counter}`;
        }

        // 2. 创建画册
        const createdAlbum = await albumStore.createAlbum(albumName);

        // 3. 将选中的图片添加到画册
        const imageIds = imagesToProcess.map((img) => img.id);
        try {
          await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);
        } catch (error: any) {
          const errorMessage = error?.message || String(error);
          ElMessage.error(errorMessage || "添加图片到画册失败");
          throw error;
        }

        // 4. 获取当前设置
        const currentSettings = await invoke<{
          wallpaperRotationEnabled: boolean;
          wallpaperRotationAlbumId: string | null;
        }>("get_settings");

        // 5. 如果轮播未开启，开启它
        if (!currentSettings.wallpaperRotationEnabled) {
          await invoke("set_wallpaper_rotation_enabled", { enabled: true });
        }

        // 6. 设置轮播画册为新创建的画册
        await invoke("set_wallpaper_rotation_album_id", {
          albumId: createdAlbum.id,
        });

        ElMessage.success(
          `已开启轮播：画册「${albumName}」（${imageIds.length} 张）`
        );
      } else {
        // 单选：直接设置壁纸
        await invoke("set_wallpaper_by_image_id", {
          imageId: imagesToProcess[0].id,
        });
        currentWallpaperImageId.value = imagesToProcess[0].id;
        ElMessage.success("壁纸设置成功");
      }

      galleryViewRef.value?.clearSelection?.();
    } catch (error) {
      console.error("设置壁纸失败:", error);
      ElMessage.error("设置壁纸失败: " + (error as Error).message);
    }
  };

  // 导出到 Wallpaper Engine
  const exportToWallpaperEngine = async (image: ImageInfo) => {
    try {
      // 让用户输入工程名称
      const defaultName = `Kabegame_${image.id}`;

      const { value: projectName } = await ElMessageBox.prompt(
        `请输入 WE 工程名称（留空使用默认名称）`,
        "导出到 Wallpaper Engine",
        {
          confirmButtonText: "导出",
          cancelButtonText: "取消",
          inputPlaceholder: defaultName,
          inputValidator: (value) => {
            if (value && value.trim().length > 64) {
              return "名称不能超过 64 个字符";
            }
            return true;
          },
        }
      ).catch(() => ({ value: null })); // 用户取消时返回 null

      if (projectName === null) return; // 用户取消

      const mp = await invoke<string | null>(
        "get_wallpaper_engine_myprojects_dir"
      );
      if (!mp) {
        ElMessage.warning(
          "未配置 Wallpaper Engine 目录：请到 设置 -> 壁纸轮播 -> Wallpaper Engine 目录 先选择"
        );
        return;
      }

      // 使用用户输入的名称，如果为空则使用默认名称
      const finalName = projectName?.trim() || defaultName;

      const res = await invoke<{ projectDir: string; imageCount: number }>(
        "export_images_to_we_project",
        {
          imagePaths: [image.localPath],
          title: finalName,
          outputParentDir: mp,
          options: null,
        }
      );
      ElMessage.success(
        `已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`
      );
      await invoke("open_file_path", { filePath: res.projectDir });
    } catch (error) {
      if (error !== "cancel") {
        console.error("导出 Wallpaper Engine 工程失败:", error);
        ElMessage.error("导出失败");
      }
    }
  };

  return {
    handleOpenImagePath,
    handleCopyImage,
    applyFavoriteChangeToGalleryCache,
    handleBatchDeleteImages,
    toggleFavorite,
    setWallpaper,
    exportToWallpaperEngine,
  };
}
