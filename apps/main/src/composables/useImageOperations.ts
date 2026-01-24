import { computed, type Ref } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox } from "element-plus";
import { useCrawlerStore, type ImageInfo } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { storeToRefs } from "pinia";
import { useImageUrlMapCache } from "@kabegame/core/composables/useImageUrlMapCache";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";

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
  _removeFromUiCacheByIds: (imageIds: string[]) => void,
  _loadImages: (reset?: boolean, opts?: any) => Promise<void>,
) {
  const crawlerStore = useCrawlerStore();
  const albumStore = useAlbumStore();
  const settingsStore = useSettingsStore();
  const urlCache = useImageUrlMapCache();
  const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
  const albums = computed(() => albumStore.albums);
  const { set: setWallpaperRotationEnabled } = useSettingKeyState(
    "wallpaperRotationEnabled",
  );
  const { set: setWallpaperRotationAlbumId } = useSettingKeyState(
    "wallpaperRotationAlbumId",
  );
  const detectImageMimeByPath = (path: string): string => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "bmp") return "image/bmp";
    return "";
  };
  const toArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
      return u8.buffer as unknown as ArrayBuffer;
    }
    return u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as unknown as ArrayBuffer;
  };

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
      const writeImageBlobToClipboard = async (blob: Blob) => {
        const mime = blob.type || "image/png";
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      };

      const convertImageBlobToPng = async (blob: Blob): Promise<Blob> => {
        if (typeof createImageBitmap === "function") {
          const bitmap = await createImageBitmap(blob);
          try {
            if (typeof OffscreenCanvas !== "undefined") {
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const ctx = canvas.getContext("2d");
              if (!ctx) throw new Error("Failed to create canvas context");
              ctx.drawImage(bitmap, 0, 0);
              return await canvas.convertToBlob({ type: "image/png" });
            }

            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Failed to create canvas context");
            ctx.drawImage(bitmap, 0, 0);
            return await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob(
                (b) =>
                  b ? resolve(b) : reject(new Error("canvas.toBlob failed")),
                "image/png",
              );
            });
          } finally {
            try {
              bitmap.close();
            } catch {
              // ignore
            }
          }
        }

        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          img.src = url;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("Image decode failed"));
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Failed to create canvas context");
          ctx.drawImage(img, 0, 0);
          return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (b) =>
                b ? resolve(b) : reject(new Error("canvas.toBlob failed")),
              "image/png",
            );
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const tryCopyByLoadedUrl = async (imageUrl: string) => {
        const response = await fetch(imageUrl);
        const fetched = await response.blob();
        const mime = fetched.type || detectImageMimeByPath(imageUrl);
        const blob =
          fetched.type && fetched.type === mime
            ? fetched
            : new Blob([await fetched.arrayBuffer()], {
                type: mime || "image/png",
              });

        try {
          await writeImageBlobToClipboard(blob);
          return;
        } catch (e) {
          const mt = (mime || blob.type || "").toLowerCase();
          if (mt === "image/jpeg" || mt === "image/jpg") {
            const png = await convertImageBlobToPng(blob);
            await writeImageBlobToClipboard(png);
            return;
          }
          throw e;
        }
      };

      const localPath = (image.localPath || "").trim();

      const fromMap = imageSrcMap.value[image.id] ?? {};
      const imageUrl = fromMap.original || fromMap.thumbnail;

      if (isTauri() && localPath) {
        if (imageUrl) {
          try {
            await tryCopyByLoadedUrl(imageUrl);
            ElMessage.success("图片已复制到剪贴板");
            return;
          } catch {
            // ignore
          }
        }
        try {
          await invoke("copy_image_to_clipboard", { imagePath: localPath });
          ElMessage.success("图片已复制到剪贴板");
          return;
        } catch {
          if (imageUrl) {
            await tryCopyByLoadedUrl(imageUrl);
            ElMessage.success("图片已复制到剪贴板");
            return;
          }
          const bytes = await invoke<number[] | Uint8Array>(
            "get_gallery_image",
            {
              imagePath: localPath,
            },
          );
          const u8 =
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          const mime = detectImageMimeByPath(localPath) || "image/png";
          await writeImageBlobToClipboard(
            new Blob([toArrayBuffer(u8)], { type: mime }),
          );
          ElMessage.success("图片已复制到剪贴板");
          return;
        }
      }

      if (!imageUrl) {
        ElMessage.warning("图片尚未加载完成，请稍后再试");
        return;
      }

      await tryCopyByLoadedUrl(imageUrl);

      ElMessage.success("图片已复制到剪贴板");
    } catch (error) {
      console.error("复制图片失败:", error);
      ElMessage.error("复制图片失败");
    }
  };

  // 应用收藏状态变化到画廊缓存
  const applyFavoriteChangeToGalleryCache = (
    imageIds: string[],
    favorite: boolean,
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
    deleteFiles: boolean,
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
        (img) => !idSet.has(img.id),
      );

      // 清理全局 URL 缓存（thumbnail=blob 需要 revoke；由 cache 统一处理）
      urlCache.removeByIds(Array.from(idSet));

      const action = deleteFiles ? "删除" : "移除";
      ElMessage.success(`已${action} ${count} 张图片`);
      galleryViewRef.value?.clearSelection?.();
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
        currentCount + (newFavorite ? 1 : -1),
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
          // 提取友好的错误信息
          const errorMessage =
            typeof error === "string"
              ? error
              : error?.message || String(error) || "添加图片到画册失败";
          ElMessage.error(errorMessage);
          throw error;
        }

        await settingsStore.loadMany([
          "wallpaperRotationEnabled",
          "wallpaperRotationAlbumId",
        ]);

        // 5. 如果轮播未开启，开启它
        if (!settingsStore.values.wallpaperRotationEnabled) {
          await setWallpaperRotationEnabled(true);
        }

        // 6. 设置轮播画册为新创建的画册
        await setWallpaperRotationAlbumId(createdAlbum.id);

        ElMessage.success(
          `已开启轮播：画册「${albumName}」（${imageIds.length} 张）`,
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
    } catch (error: any) {
      console.error("设置壁纸失败:", error);
      // 提取友好的错误信息
      const errorMessage =
        typeof error === "string"
          ? error
          : error?.message || String(error) || "未知错误";
      ElMessage.error(`设置壁纸失败: ${errorMessage}`);
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
        },
      ).catch(() => ({ value: null })); // 用户取消时返回 null

      if (projectName === null) return; // 用户取消

      const mp = await invoke<string | null>(
        "get_wallpaper_engine_myprojects_dir",
      );
      if (!mp) {
        ElMessage.warning(
          "未配置 Wallpaper Engine 目录：请到 设置 -> 壁纸轮播 -> Wallpaper Engine 目录 先选择",
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
        },
      );
      ElMessage.success(
        `已导出 WE 工程（${res.imageCount} 张）：${res.projectDir}`,
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
