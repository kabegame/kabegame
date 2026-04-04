import { computed, type Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox } from "element-plus";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useAlbumStore } from "@/stores/albums";
import { storeToRefs } from "pinia";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { fileToUrl } from "@kabegame/core/httpServer";
import { openLocalImage } from "@/utils/openLocalImage";
import { setWallpaperByImageIdWithModeFallback } from "@/utils/wallpaperMode";
import { i18n } from "@kabegame/i18n";

export type FavoriteStatusChangedDetail = {
  imageIds: string[];
  favorite: boolean;
};

/**
 * 图片操作 composable
 */
export function useImageOperations(
  displayedImages: Ref<ImageInfo[]>,
  currentWallpaperImageId: Ref<string | null>,
  galleryViewRef: Ref<any>,
  _removeFromUiCacheByIds: (imageIds: string[]) => void,
  _loadImages: (reset?: boolean, opts?: any) => Promise<void>,
) {
  const albumStore = useAlbumStore();
  const settingsStore = useSettingsStore();
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

  // 打开文件路径（Android 用系统图片查看器 openImage，桌面用 open_file_path）
  const handleOpenImagePath = async (localPath: string) => {
    try {
      await openLocalImage(localPath);
    } catch (error) {
      console.error("打开文件失败:", error);
      ElMessage.error(i18n.global.t("common.openFileFailed"));
    }
  };

  // 复制图片到剪贴板（不依赖 Tauri 剪贴板插件：本地文件用后端 copy_image_to_clipboard，否则用 navigator.clipboard）
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
      const thumbnailPath = (image.thumbnailPath || "").trim();
      const imageUrl = fileToUrl(localPath) || fileToUrl(thumbnailPath);

      if (localPath) {
        try {
          await invoke("copy_image_to_clipboard", { imageId: image.id });
          ElMessage.success(i18n.global.t("common.copyImageSuccess"));
          return;
        } catch (error) {
          console.error("复制图片失败:", error);
          ElMessage.error(i18n.global.t("common.copyImageFailed"));
          return;
        }
      }

      if (!imageUrl) {
        ElMessage.warning(i18n.global.t("common.imageNotLoadedYet"));
        return;
      }

      await tryCopyByLoadedUrl(imageUrl);
      ElMessage.success(i18n.global.t("common.copyImageSuccess"));
    } catch (error) {
      console.error("复制图片失败:", error);
      ElMessage.error(i18n.global.t("common.copyImageFailed"));
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
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);

      // 使用批量 API 一次性处理所有图片
      if (deleteFiles) {
        await invoke("batch_delete_images", { imageIds });
      } else {
        await invoke("batch_remove_images", { imageIds });
      }

      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      // 列表由 `images-change` 事件驱动刷新，此处不做乐观移除

      ElMessage.success(
        deleteFiles
          ? i18n.global.t("common.deletedCountSuccess", { count })
          : i18n.global.t("common.removedCountSuccess", { count }),
      );
      galleryViewRef.value?.clearSelection?.();
    } catch (error) {
      console.error(deleteFiles ? "删除失败:" : "移除失败:", error);
      ElMessage.error(
        deleteFiles
          ? i18n.global.t("common.deleteFail")
          : i18n.global.t("common.removeFail"),
      );
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

      ElMessage.success(
        newFavorite
          ? i18n.global.t("common.favorited")
          : i18n.global.t("common.unfavorited"),
      );

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
      ElMessage.error(i18n.global.t("common.operationFailed"));
    }
  };

  // 设置壁纸（单选或多选）
  const setWallpaper = async (imagesToProcess: ImageInfo[]) => {
    try {
      if (imagesToProcess.length > 1) {
        // 多选：创建"桌面画册x"，添加到画册，开启轮播
        // 1. 找到下一个可用的"桌面画册x"名称
        await albumStore.loadAlbums();
        let counter = 1;
        let albumName = i18n.global.t("gallery.desktopAlbumName", { n: counter });
        while (albums.value.some((a) => a.name === albumName)) {
          counter++;
          albumName = i18n.global.t("gallery.desktopAlbumName", { n: counter });
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
              : error?.message ||
                String(error) ||
                i18n.global.t("common.addToAlbumFailed");
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
          i18n.global.t("gallery.rotationStartedWithCount", {
            name: albumName,
            count: imageIds.length,
          }),
        );
      } else {
        // 单选：直接设置壁纸
        await setWallpaperByImageIdWithModeFallback(imagesToProcess[0].id);
        currentWallpaperImageId.value = imagesToProcess[0].id;
        ElMessage.success(i18n.global.t("common.wallpaperSetSuccess"));
      }

      galleryViewRef.value?.clearSelection?.();
    } catch (error: any) {
      console.error("设置壁纸失败:", error);
      // 提取友好的错误信息
      const errorMessage =
        typeof error === "string"
          ? error
          : error?.message || String(error) || "未知错误";
      ElMessage.error(`${i18n.global.t("common.wallpaperSetFailed")}: ${errorMessage}`);
    }
  };

  // 判断是否为支持的视频路径（与 wallpaper 及后端 image_type 一致）
  const isVideoPath = (path: string) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ext === "mp4" || ext === "mov";
  };

  // 导出到 Wallpaper Engine（图片轮播或单视频）
  const exportToWallpaperEngine = async (image: ImageInfo) => {
    try {
      const defaultName = `Kabegame_${image.id}`;

      const { value: projectName } = await ElMessageBox.prompt(
        i18n.global.t("gallery.weProjectNamePrompt"),
        i18n.global.t("gallery.exportToWE"),
        {
          confirmButtonText: i18n.global.t("gallery.export"),
          cancelButtonText: i18n.global.t("common.cancel"),
          inputPlaceholder: defaultName,
          inputValidator: (value) => {
            if (value && value.trim().length > 64) {
              return i18n.global.t("gallery.weNameTooLong");
            }
            return true;
          },
        },
      ).catch(() => ({ value: null }));

      if (projectName === null) return;

      const mp = await invoke<string | null>(
        "get_wallpaper_engine_myprojects_dir",
      );
      if (!mp) {
        ElMessage.warning(i18n.global.t("gallery.weDirNotConfigured"));
        return;
      }

      const finalName = projectName?.trim() || defaultName;
      const isVideo = isVideoPath(image.localPath);

      const res = await invoke<{
        projectDir: string;
        imageCount: number;
        videoCount?: number;
      }>(
        isVideo ? "export_video_to_we_project" : "export_images_to_we_project",
        isVideo
          ? {
              videoPath: image.localPath,
              title: finalName,
              outputParentDir: mp,
            }
          : {
              imagePaths: [image.localPath],
              title: finalName,
              outputParentDir: mp,
              options: null,
            },
      );
      const msg = res.videoCount
        ? i18n.global.t("gallery.weExportVideoSuccess", { path: res.projectDir })
        : i18n.global.t("gallery.weExportSuccess", {
            count: res.imageCount,
            path: res.projectDir,
          });
      ElMessage.success(msg);
      await invoke("open_file_path", { filePath: res.projectDir });
    } catch (error) {
      if (error !== "cancel") {
        console.error("导出 Wallpaper Engine 工程失败:", error);
        ElMessage.error(i18n.global.t("common.exportFailed"));
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
