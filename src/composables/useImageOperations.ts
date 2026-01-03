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
  showFavoritesOnly: Ref<boolean>,
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

    // "仅收藏"模式下，取消收藏应直接从列表移除
    if (showFavoritesOnly.value && !favorite) {
      displayedImages.value = displayedImages.value.filter(
        (img) => !idSet.has(img.id)
      );
      crawlerStore.images = [...displayedImages.value];
      galleryViewRef.value?.clearSelection?.();
      return;
    }

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

  // 批量移除图片（只删除缩略图和数据库记录，不删除原图）
  const handleBatchRemove = async (imagesToProcess: ImageInfo[]) => {
    if (imagesToProcess.length === 0) return;

    try {
      const count = imagesToProcess.length;
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);
      const currentHint = includesCurrent
        ? `\n\n注意：其中包含当前壁纸。移除/删除不会立刻改变桌面壁纸，但下次启动将无法复现该壁纸。`
        : "";
      await ElMessageBox.confirm(
        `将从画廊移除，但保留原图文件。是否继续移除${
          count > 1 ? `这 ${count} 张图片` : "这张图片"
        }？${currentHint}`,
        "确认删除",
        { type: "warning" }
      );

      for (const img of imagesToProcess) {
        await crawlerStore.removeImage(img.id);
      }
      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      // 从 displayedImages 中移除已移除的图片
      displayedImages.value = displayedImages.value.filter(
        (img) => !imagesToProcess.some((remImg) => remImg.id === img.id)
      );

      // 清理 imageSrcMap 和 Blob URL
      for (const img of imagesToProcess) {
        const imageData = imageSrcMap.value[img.id];
        if (imageData) {
          if (imageData.thumbnail) {
            URL.revokeObjectURL(imageData.thumbnail);
          }
          if (imageData.original) {
            URL.revokeObjectURL(imageData.original);
          }
          delete imageSrcMap.value[img.id];
        }
      }

      galleryViewRef.value?.clearSelection?.();

      ElMessage.success(
        `${count > 1 ? `已移除 ${count} 张图片` : "已移除图片"}`
      );

      // 发出图片移除事件，通知画册视图更新
      const removedIds = imagesToProcess.map((img) => img.id);
      window.dispatchEvent(
        new CustomEvent("images-removed", {
          detail: { imageIds: removedIds },
        })
      );
    } catch (error) {
      if (error !== "cancel") {
        console.error("移除图片失败:", error);
        ElMessage.error("移除失败");
      }
    }
  };

  // 批量删除图片
  const handleBatchDelete = async (imagesToProcess: ImageInfo[]) => {
    if (imagesToProcess.length === 0) return;

    try {
      const count = imagesToProcess.length;
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);
      const currentHint = includesCurrent
        ? `\n\n注意：其中包含当前壁纸。移除/删除不会立刻改变桌面壁纸，但下次启动将无法复现该壁纸。`
        : "";
      await ElMessageBox.confirm(
        `删除后将同时移除原图、缩略图及数据库记录，且无法恢复。是否继续删除${
          count > 1 ? `这 ${count} 张图片` : "这张图片"
        }？${currentHint}`,
        "确认删除",
        { type: "warning" }
      );

      for (const img of imagesToProcess) {
        await crawlerStore.deleteImage(img.id);
      }
      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      // 从 displayedImages 中移除已删除的图片
      displayedImages.value = displayedImages.value.filter(
        (img) => !imagesToProcess.some((delImg) => delImg.id === img.id)
      );

      // 清理 imageSrcMap 和 Blob URL
      for (const img of imagesToProcess) {
        const imageData = imageSrcMap.value[img.id];
        if (imageData) {
          if (imageData.thumbnail) {
            URL.revokeObjectURL(imageData.thumbnail);
          }
          if (imageData.original) {
            URL.revokeObjectURL(imageData.original);
          }
        }
        const { [img.id]: _, ...rest } = imageSrcMap.value;
        imageSrcMap.value = rest;
      }

      ElMessage.success(`已删除 ${count} 张图片`);
      galleryViewRef.value?.clearSelection?.();

      // 发出图片删除事件，通知画册视图更新
      const deletedIds = imagesToProcess.map((img) => img.id);
      window.dispatchEvent(
        new CustomEvent("images-deleted", {
          detail: { imageIds: deletedIds },
        })
      );
    } catch (error) {
      if (error !== "cancel") {
        ElMessage.error("删除失败");
      }
    }
  };

  // 统一的删除操作：根据是否删除文件决定调用 removeImage 还是 deleteImage
  const handleBatchDeleteImages = async (
    imagesToProcess: ImageInfo[],
    deleteFiles: boolean
  ) => {
    if (imagesToProcess.length === 0) return;

    try {
      const count = imagesToProcess.length;
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);
      const currentHint = includesCurrent
        ? `\n\n注意：其中包含当前壁纸。删除不会立刻改变桌面壁纸，但下次启动将无法复现该壁纸。`
        : "";

      // 显示确认对话框
      await ElMessageBox.confirm(
        deleteFiles
          ? `删除后将同时移除原图、缩略图及数据库记录，且无法恢复。是否继续删除${
              count > 1 ? `这 ${count} 张图片` : "这张图片"
            }？${currentHint}`
          : `将从画廊移除${
              count > 1 ? `这 ${count} 张图片` : "这张图片"
            }，保留原图文件。${currentHint}`,
        "确认删除",
        { type: "warning" }
      );

      // 使用批量 API 一次性处理所有图片
      const imageIds = imagesToProcess.map((img) => img.id);
      if (deleteFiles) {
        await crawlerStore.batchDeleteImages(imageIds);
      } else {
        await crawlerStore.batchRemoveImages(imageIds);
      }

      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      // 从 displayedImages 中移除已处理的图片
      displayedImages.value = displayedImages.value.filter(
        (img) => !imagesToProcess.some((procImg) => procImg.id === img.id)
      );

      // 清理 imageSrcMap 和 Blob URL
      for (const img of imagesToProcess) {
        const imageData = imageSrcMap.value[img.id];
        if (imageData) {
          if (imageData.thumbnail) {
            URL.revokeObjectURL(imageData.thumbnail);
          }
          if (imageData.original) {
            URL.revokeObjectURL(imageData.original);
          }
        }
        const { [img.id]: _, ...rest } = imageSrcMap.value;
        imageSrcMap.value = rest;
      }

      const action = deleteFiles ? "删除" : "移除";
      ElMessage.success(`已${action} ${count} 张图片`);
      galleryViewRef.value?.clearSelection?.();

      // 发出图片删除/移除事件，通知其他视图更新
      const eventType = deleteFiles ? "images-deleted" : "images-removed";
      const processedIds = imagesToProcess.map((img) => img.id);
      window.dispatchEvent(
        new CustomEvent(eventType, {
          detail: { imageIds: processedIds },
        })
      );
    } catch (error) {
      if (error !== "cancel") {
        const action = deleteFiles ? "删除" : "移除";
        ElMessage.error(`${action}失败`);
      }
    }
  };

  // 画廊按 hash 去重确认（实际执行去重逻辑）
  const confirmDedupeByHash = async (
    dedupeProcessing: Ref<boolean>,
    dedupeDeleteFiles: boolean,
    startDedupeDelay: () => void,
    finishDedupeDelay: () => void
  ) => {
    try {
      dedupeProcessing.value = true;
      startDedupeDelay();

      const res = await invoke<{ removed: number; removedIds: string[] }>(
        "dedupe_gallery_by_hash",
        { deleteFiles: dedupeDeleteFiles }
      );
      const removedIds = res?.removedIds ?? [];

      if (removedIds.length > 0) {
        removeFromUiCacheByIds(removedIds);
        await crawlerStore.applyRemovedImageIds(removedIds);
      }

      ElMessage.success(
        `已清理 ${res?.removed ?? removedIds.length} 个重复项${
          dedupeDeleteFiles
            ? "（已从电脑彻底删除）"
            : "（仅从画廊移除，源文件已保留）"
        }`
      );

      // 若当前已加载列表被清空，则自动刷新一次（避免停留在空状态）
      if (displayedImages.value.length === 0) {
        await loadImages(true);
        if (displayedImages.value.length === 0 && crawlerStore.hasMore) {
          await loadMoreImages();
        }
      }
    } catch (error) {
      if (error !== "cancel") {
        console.error("去重失败:", error);
        ElMessage.error("去重失败");
      }
    } finally {
      dedupeProcessing.value = false;
      finishDedupeDelay();
    }
  };

  // 切换收藏状态
  const toggleFavorite = async (image: ImageInfo) => {
    try {
      const newFavorite = !(image.favorite ?? false);
      await invoke("toggle_image_favorite", {
        imageId: image.id,
        favorite: newFavorite,
      });

      ElMessage.success(newFavorite ? "已收藏" : "已取消收藏");

      // 清除收藏画册的缓存，确保下次查看时重新加载
      delete albumStore.albumImages[FAVORITE_ALBUM_ID.value];
      delete albumStore.albumPreviews[FAVORITE_ALBUM_ID.value];
      // 更新收藏画册计数
      const currentCount = albumStore.albumCounts[FAVORITE_ALBUM_ID.value] || 0;
      albumStore.albumCounts[FAVORITE_ALBUM_ID.value] = Math.max(
        0,
        currentCount + (newFavorite ? 1 : -1)
      );

      // 发出收藏状态变化事件，通知其他页面（如收藏画册详情页）更新
      window.dispatchEvent(
        new CustomEvent("favorite-status-changed", {
          detail: { imageIds: [image.id], favorite: newFavorite },
        })
      );

      // 就地更新图片的收藏状态，避免重新加载导致"加载更多"的图片消失
      applyFavoriteChangeToGalleryCache([image.id], newFavorite);
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
        await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);

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
    confirmDedupeByHash,
    toggleFavorite,
    setWallpaper,
    exportToWallpaperEngine,
  };
}
