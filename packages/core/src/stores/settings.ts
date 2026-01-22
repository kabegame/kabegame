import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

// 与后端 settings.rs 的 AppSettings（serde rename_all = camelCase）保持一致
export interface AppSettings {
  autoLaunch: boolean;
  maxConcurrentDownloads: number;
  networkRetryCount: number;
  imageClickAction: "preview" | "open" | "none";
  galleryImageAspectRatio: string | null;
  autoDeduplicate: boolean;
  defaultDownloadDir: string | null;
  wallpaperEngineDir: string | null;
  wallpaperRotationEnabled: boolean;
  wallpaperRotationAlbumId: string | null;
  wallpaperRotationIntervalMinutes: number;
  wallpaperRotationMode: "random" | "sequential" | string;
  wallpaperRotationStyle:
    | "fill"
    | "fit"
    | "stretch"
    | "center"
    | "tile"
    | string;
  wallpaperRotationTransition: "none" | "fade" | "slide" | "zoom" | string;
  // 按 wallpaperMode 记忆各模式的最后 style/transition（切换模式时用于恢复）
  wallpaperStyleByMode: Record<string, string>;
  wallpaperTransitionByMode: Record<string, string>;
  wallpaperMode: "native" | "window" | string;
  windowState: {
    x: number | null;
    y: number | null;
    width: number;
    height: number;
    maximized: boolean;
  } | null;
  currentWallpaperImageId: string | null;

  // Windows：画册虚拟盘（Dokan）
  albumDriveEnabled: boolean;
  albumDriveMountPoint: string;
}

export type AppSettingKey = keyof AppSettings;
export type ImageClickAction = AppSettings["imageClickAction"];

export const useSettingsStore = defineStore("settings", () => {
  // 旧逻辑：收藏画册 ID（不是 AppSettings 的字段）
  const favoriteAlbumId = ref<string>("");

  // 新逻辑：后端 AppSettings 的 key-value 缓存（key 与后端完全一致）
  const values = reactive<Partial<AppSettings>>({});
  const loadingByKey = reactive<Record<string, boolean>>({});
  const savingByKey = reactive<Record<string, boolean>>({});

  const init = async () => {
    try {
      const id = await invoke<string>("get_favorite_album_id");
      favoriteAlbumId.value = id;
    } catch (e) {
      console.error("Failed to load favorite album ID:", e);
      // 如果加载失败，使用默认值作为兜底
      favoriteAlbumId.value = "00000000-0000-0000-0000-000000000001";
    }
  };

  const isLoading = (key: AppSettingKey) => !!loadingByKey[key];
  const isSaving = (key: AppSettingKey) => !!savingByKey[key];

  // 将 key 映射到对应的 getter 命令名
  const getGetterCommand = (key: AppSettingKey): string | null => {
    const keyMap: Partial<Record<AppSettingKey, string>> = {
      autoLaunch: "get_auto_launch",
      maxConcurrentDownloads: "get_max_concurrent_downloads",
      networkRetryCount: "get_network_retry_count",
      imageClickAction: "get_image_click_action",
      galleryImageAspectRatio: "get_gallery_image_aspect_ratio",
      autoDeduplicate: "get_auto_deduplicate",
      defaultDownloadDir: "get_default_download_dir",
      wallpaperEngineDir: "get_wallpaper_engine_dir",
      wallpaperRotationEnabled: "get_wallpaper_rotation_enabled",
      wallpaperRotationAlbumId: "get_wallpaper_rotation_album_id",
      wallpaperRotationIntervalMinutes: "get_wallpaper_rotation_interval_minutes",
      wallpaperRotationMode: "get_wallpaper_rotation_mode",
      wallpaperRotationStyle: "get_wallpaper_rotation_style",
      wallpaperRotationTransition: "get_wallpaper_rotation_transition",
      wallpaperStyleByMode: "get_wallpaper_style_by_mode",
      wallpaperTransitionByMode: "get_wallpaper_transition_by_mode",
      wallpaperMode: "get_wallpaper_mode",
      windowState: "get_window_state",
      currentWallpaperImageId: "get_current_wallpaper_image_id",
      albumDriveEnabled: "get_album_drive_enabled",
      albumDriveMountPoint: "get_album_drive_mount_point",
    };
    return keyMap[key] || null;
  };

  const load = async <K extends AppSettingKey>(key: K) => {
    if (loadingByKey[key]) return;
    loadingByKey[key] = true;
    try {
      const command = getGetterCommand(key);
      if (!command) {
        console.warn(`No getter command found for key: ${key}`);
        return;
      }
      const v = await invoke<any>(command);
      (values as any)[key] = v;
    } catch (error) {
      console.error(`Failed to load setting ${key}:`, error);
    } finally {
      loadingByKey[key] = false;
    }
  };

  const loadMany = async (keys: AppSettingKey[]) => {
    await Promise.all(keys.map((k) => load(k)));
  };

  const loadAll = async () => {
    // 并发获取所有设置（只加载后端实际存在的字段）
    const allKeys: AppSettingKey[] = [
      "autoLaunch",
      "maxConcurrentDownloads",
      "networkRetryCount",
      "imageClickAction",
      "galleryImageAspectRatio",
      "autoDeduplicate",
      "defaultDownloadDir",
      "wallpaperEngineDir",
      "wallpaperRotationEnabled",
      "wallpaperRotationAlbumId",
      "wallpaperRotationIntervalMinutes",
      "wallpaperRotationMode",
      "wallpaperRotationStyle",
      "wallpaperRotationTransition",
      "wallpaperStyleByMode",
      "wallpaperTransitionByMode",
      "wallpaperMode",
      "windowState",
      "currentWallpaperImageId",
      "albumDriveEnabled",
      "albumDriveMountPoint",
    ];
    
    await Promise.all(allKeys.map((k) => load(k)));
  };

  return {
    favoriteAlbumId,
    init,

    // app settings
    values,
    loadingByKey,
    savingByKey,
    isLoading,
    isSaving,
    load,
    loadMany,
    loadAll,
  };
});
