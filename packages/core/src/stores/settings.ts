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
  wallpaperStyle: "fill" | "fit" | "stretch" | "center" | "tile" | string;
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

/**
 * 设置键状态机                   (一般也很短)
 * 初始状态 -> loading -> down -> saving
              (很短的过程)  ^---<----|        
 *  
*/
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

  // TODO: 将这些落实到前端状态管理中
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
      wallpaperRotationIntervalMinutes:
        "get_wallpaper_rotation_interval_minutes",
      wallpaperRotationMode: "get_wallpaper_rotation_mode",
      wallpaperStyle: "get_wallpaper_rotation_style",
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

  // 将 key 映射到对应的 setter 命令名
  const getSetterCommand = (key: AppSettingKey): string | null => {
    const keyMap: Partial<Record<AppSettingKey, string>> = {
      autoLaunch: "set_auto_launch",
      maxConcurrentDownloads: "set_max_concurrent_downloads",
      networkRetryCount: "set_network_retry_count",
      imageClickAction: "set_image_click_action",
      galleryImageAspectRatio: "set_gallery_image_aspect_ratio",
      autoDeduplicate: "set_auto_deduplicate",
      defaultDownloadDir: "set_default_download_dir",
      wallpaperEngineDir: "set_wallpaper_engine_dir",
      wallpaperRotationEnabled: "set_wallpaper_rotation_enabled",
      wallpaperRotationAlbumId: "set_wallpaper_rotation_album_id",
      wallpaperRotationIntervalMinutes:
        "set_wallpaper_rotation_interval_minutes",
      wallpaperRotationMode: "set_wallpaper_rotation_mode",
      wallpaperStyle: "set_wallpaper_style",
      wallpaperRotationTransition: "set_wallpaper_rotation_transition",
      wallpaperStyleByMode: "set_wallpaper_style_by_mode",
      wallpaperTransitionByMode: "set_wallpaper_transition_by_mode",
      wallpaperMode: "set_wallpaper_mode",
      windowState: "set_window_state",
      currentWallpaperImageId: "set_current_wallpaper_image_id",
      albumDriveEnabled: "set_album_drive_enabled",
      albumDriveMountPoint: "set_album_drive_mount_point",
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
      "wallpaperStyle",
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

  // 将 key 映射到对应的 setter 参数名
  const getSetterParamKey = (key: AppSettingKey): string => {
    const paramMap: Partial<Record<AppSettingKey, string>> = {
      autoLaunch: "enabled",
      maxConcurrentDownloads: "count",
      networkRetryCount: "count",
      imageClickAction: "action",
      galleryImageAspectRatio: "ratio",
      autoDeduplicate: "enabled",
      defaultDownloadDir: "dir",
      wallpaperEngineDir: "dir",
      wallpaperRotationEnabled: "enabled",
      wallpaperRotationAlbumId: "albumId",
      wallpaperRotationIntervalMinutes: "minutes",
      wallpaperRotationMode: "mode",
      wallpaperStyle: "style",
      wallpaperRotationTransition: "transition",
      wallpaperMode: "mode",
      albumDriveEnabled: "enabled",
      albumDriveMountPoint: "mount_point",
    };
    return paramMap[key] || camelToSnake(key);
  };

  // 将 camelCase 转换为 snake_case
  const camelToSnake = (str: string): string => {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  };

  const save = async <K extends AppSettingKey>(
    key: K,
    value: AppSettings[K],
    onAfterSave?: () => Promise<void> | void,
  ) => {
    if (savingByKey[key]) return;
    if (loadingByKey[key]) return;

    savingByKey[key] = true;
    const prevValue = (values as any)[key];
    try {
      // 更新本地值
      (values as any)[key] = value;

      // 调用后端接口
      const command = getSetterCommand(key);
      if (!command) {
        console.warn(`No setter command found for key: ${key}`);
        // 回滚本地值
        (values as any)[key] = prevValue;
        return;
      }

      // 构建参数对象：将 camelCase key 转换为 snake_case 参数名
      const paramKey = getSetterParamKey(key);
      const args: Record<string, any> = { [paramKey]: value };
      if (__DEV__) {
        console.log(`Saving setting ${key} with value ${value}`, args);
      }
      await invoke(command, args);

      // 执行可选的回调
      if (onAfterSave) {
        await onAfterSave();
      }
    } catch (error) {
      // 回滚本地值
      (values as any)[key] = prevValue;
      console.error(`Failed to save setting ${key}:`, error);
      throw error;
    } finally {
      savingByKey[key] = false;
    }
  };

  // 判断状态是否为 down（既不在 loading 也不在 saving）
  const isDown = (key: AppSettingKey) => {
    return !loadingByKey[key] && !savingByKey[key];
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
    isDown,
    load,
    loadMany,
    loadAll,
    save,
  };
});
