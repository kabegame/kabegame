import { computed, type Ref } from "vue";
import { invoke } from "@/api/rpc";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useAlbumStore, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { storeToRefs } from "pinia";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { fileToUrl } from "@kabegame/core/httpServer";
import { isVideoMediaType } from "@kabegame/core/utils/mediaMime";
import { IS_WEB } from "@kabegame/core/env";
import { openLocalImage } from "@/utils/openLocalImage";
import { setWallpaperOrBackground } from "@/utils/wallpaperMode";
import { useImageTypes } from "@/composables/useImageTypes";
import { i18n } from "@kabegame/i18n";

export type FavoriteStatusChangedDetail = {
  imageIds: string[];
  favorite: boolean;
};

/**
 * 图片操作 composable
 */
export function useImageOperations(
  _displayedImages: Readonly<Ref<ImageInfo[]>>,
  currentWallpaperImageId: Ref<string | null>,
  galleryViewRef: Ref<any>
) {
  const albumStore = useAlbumStore();
  const settingsStore = useSettingsStore();

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
    if (ext === "avif") return "image/avif";
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

  const getImageDownloadUrl = (image: ImageInfo) =>
    fileToUrl(image.localPath) || fileToUrl(image.thumbnailPath || "") || image.url || "";

  const decodeFileName = (fileName: string) => {
    try {
      return decodeURIComponent(fileName);
    } catch {
      return fileName;
    }
  };

  const getLastPathSegment = (path: string) => {
    const segment = path.split(/[\\/]/).filter(Boolean).pop()?.trim() || "";
    return segment ? decodeFileName(segment) : "";
  };

  const getFileNameFromUrlOrPath = (source: string) => {
    const value = (source || "").trim();
    if (!value) return "";

    try {
      const parsed = new URL(value, window.location.href);
      const proxiedPath = parsed.searchParams.get("path") || "";
      return getLastPathSegment(proxiedPath || parsed.pathname);
    } catch {
      const withoutHash = value.split("#", 1)[0] || "";
      const withoutQuery = withoutHash.split("?", 1)[0] || "";
      return getLastPathSegment(withoutQuery);
    }
  };

  const getImageFileName = (image: ImageInfo) =>
    getFileNameFromUrlOrPath(fileToUrl(image.localPath)) ||
    getFileNameFromUrlOrPath(image.localPath) ||
    getFileNameFromUrlOrPath(fileToUrl(image.thumbnailPath || "")) ||
    getFileNameFromUrlOrPath(image.url || "") ||
    image.id;

  // web 模式：先转成同源 blob URL 再 download，避免跨域直链忽略 download 后跳转到图片页。
  const handleDownloadImage = async (image: ImageInfo) => {
    const url = getImageDownloadUrl(image);
    if (!url) {
      ElMessage.warning(i18n.global.t("common.imageNotLoadedYet"));
      return;
    }
    let objectUrl = "";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download fetch failed: ${response.status}`);
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = getImageFileName(image);
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      console.error("下载图片失败:", error);
      ElMessage.error(i18n.global.t("common.operationFailed"));
    } finally {
      if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  };

  // 复制图片到剪贴板（不依赖 Tauri 剪贴板插件：本地文件用后端 copy_image_to_clipboard，否则用 navigator.clipboard）
  const handleCopyImage = async (image: ImageInfo) => {
    try {
      if (IS_WEB && typeof ClipboardItem === "undefined") {
        throw new Error("ClipboardItem is not supported");
      }

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
      const imageUrl = getImageDownloadUrl(image) || fileToUrl(localPath) || fileToUrl(thumbnailPath);

      if (!IS_WEB && localPath) {
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

  // 永久删除：同时移除 DB 记录与磁盘文件。调用方自行处理确认逻辑。
  const handleBatchDeleteImages = async (imagesToProcess: ImageInfo[]) => {
    if (imagesToProcess.length === 0) return;

    try {
      galleryViewRef.value?.startDeleteMoveAnimation?.();

      const count = imagesToProcess.length;
      const imageIds = imagesToProcess.map((img) => img.id);
      const includesCurrent =
        !!currentWallpaperImageId.value &&
        imagesToProcess.some((img) => img.id === currentWallpaperImageId.value);

      await invoke("batch_delete_images", { imageIds });

      if (includesCurrent) {
        currentWallpaperImageId.value = null;
      }

      ElMessage.success(
        i18n.global.t("common.deletedCountSuccess", { count }),
      );
      galleryViewRef.value?.clearSelection?.();
    } catch (error) {
      console.error("删除失败:", error);
      ElMessage.error(i18n.global.t("common.deleteFail"));
    }
  };

  // 批量隐藏：加入 HIDDEN_ALBUM_ID，保留 DB 记录与磁盘文件
  const handleBatchHideImages = async (imagesToProcess: ImageInfo[]) => {
    if (imagesToProcess.length === 0) return;

    try {
      galleryViewRef.value?.startDeleteMoveAnimation?.();

      const count = imagesToProcess.length;
      const imageIds = imagesToProcess.map((img) => img.id);
      await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, imageIds);

      ElMessage.success(
        count > 1
          ? i18n.global.t("contextMenu.hiddenCount", { count })
          : i18n.global.t("contextMenu.hiddenOne"),
      );
      galleryViewRef.value?.clearSelection?.();
    } catch (error) {
      console.error("隐藏失败:", error);
      ElMessage.error(i18n.global.t("contextMenu.hideFailed"));
    }
  };

  // 注意：按 hash 去重已改为后端“分批后台任务 + 事件驱动 UI 同步”，逻辑迁移到 Gallery.vue

  // 批量切换收藏：任一未收藏 → 全部收藏，否则全部取消收藏。
  // 列表与画册缓存由 album-images-change / images-change 事件驱动刷新。
  const toggleFavoriteForImages = async (imagesToProcess: ImageInfo[]) => {
    if (imagesToProcess.length === 0) return;
    const desiredFavorite = imagesToProcess.some((img) => !(img.favorite ?? false));
    const toChange = imagesToProcess.filter(
      (img) => (img.favorite ?? false) !== desiredFavorite,
    );
    if (toChange.length === 0) {
      ElMessage.info(
        desiredFavorite
          ? i18n.global.t("common.favorited")
          : i18n.global.t("common.unfavorited"),
      );
      return;
    }

    const results = await Promise.allSettled(
      toChange.map((img) =>
        invoke("toggle_image_favorite", {
          imageId: img.id,
          favorite: desiredFavorite,
        }),
      ),
    );
    const succeeded = toChange.filter((_, idx) => results[idx]?.status === "fulfilled");
    if (succeeded.length === 0) {
      ElMessage.error(i18n.global.t("common.operationFailed"));
      return;
    }

    ElMessage.success(
      desiredFavorite
        ? i18n.global.t("common.favoritedCount", { count: succeeded.length })
        : i18n.global.t("common.unfavoritedCount", { count: succeeded.length }),
    );
    galleryViewRef.value?.clearSelection?.();
    return { favorite: desiredFavorite, images: succeeded };
  };

  // 分享单张图片（Android share sheet / 桌面系统分享）
  const shareImage = async (image: ImageInfo) => {
    try {
      const filePath = image.localPath;
      if (!filePath) {
        ElMessage.error(i18n.global.t("common.imagePathMissing"));
        return;
      }
      const ext = filePath.split(".").pop()?.toLowerCase() || "";
      const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
      await loadImageTypes();
      const mimeType = getMimeTypeForImage(image, ext);
      await invoke("share_file", { filePath, mimeType });
    } catch (error) {
      console.error("分享失败:", error);
      ElMessage.error(i18n.global.t("common.shareFailed"));
    }
  };

  // 在资源管理器中打开图片所在文件夹
  const openImageFolder = async (image: ImageInfo) => {
    try {
      await invoke("open_file_folder", { filePath: image.localPath });
    } catch (error) {
      console.error("打开文件夹失败:", error);
      ElMessage.error(i18n.global.t("common.openFolderFailed"));
    }
  };

  // 设置壁纸（单选或多选）
  const setWallpaper = async (imagesToProcess: ImageInfo[]) => {
    try {
      if (IS_WEB && imagesToProcess.length > 0) {
        await setWallpaperOrBackground(imagesToProcess[0].id);
        currentWallpaperImageId.value = imagesToProcess[0].id;
        ElMessage.success(i18n.global.t("common.wallpaperSetSuccess"));
        galleryViewRef.value?.clearSelection?.();
        return;
      }

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
        await setWallpaperOrBackground(imagesToProcess[0].id);
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

  return {
    handleOpenImagePath,
    handleDownloadImage,
    handleCopyImage,
    handleBatchDeleteImages,
    handleBatchHideImages,
    toggleFavoriteForImages,
    shareImage,
    openImageFolder,
    setWallpaper,
  };
}
