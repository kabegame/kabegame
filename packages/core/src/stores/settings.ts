import { defineStore } from "pinia";
import { reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { IS_DEV, IS_LIGHT_MODE, IS_ANDROID, IS_WINDOWS } from "../env";

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

type SettingKeyMeta = {
  getter: string;       // IPC getter 命令名
  setter: string;       // IPC setter 命令名
  param?: string;       // setter 参数名（省略时 fallback 为 camelToSnake(key)）
};

/**
 * 构建设置键配置表
 * 先定义基础通用键，然后按平台/模式条件追加专属键
 */
function buildSettingKeyMap(): Partial<Record<AppSettingKey, SettingKeyMeta>> {
  const map: Partial<Record<AppSettingKey, SettingKeyMeta>> = {
    // --- 基础通用键（所有平台） ---
    maxConcurrentDownloads: { getter: "get_max_concurrent_downloads", setter: "set_max_concurrent_downloads", param: "count" },
    networkRetryCount: { getter: "get_network_retry_count", setter: "set_network_retry_count", param: "count" },
    autoDeduplicate: { getter: "get_auto_deduplicate", setter: "set_auto_deduplicate", param: "enabled" },
    wallpaperRotationEnabled: { getter: "get_wallpaper_rotation_enabled", setter: "set_wallpaper_rotation_enabled", param: "enabled" },
    wallpaperRotationAlbumId: { getter: "get_wallpaper_rotation_album_id", setter: "set_wallpaper_rotation_album_id", param: "albumId" },
    wallpaperRotationIntervalMinutes: { getter: "get_wallpaper_rotation_interval_minutes", setter: "set_wallpaper_rotation_interval_minutes", param: "minutes" },
    wallpaperRotationMode: { getter: "get_wallpaper_rotation_mode", setter: "set_wallpaper_rotation_mode", param: "mode" },
    wallpaperStyle: { getter: "get_wallpaper_rotation_style", setter: "set_wallpaper_style", param: "style" },
    wallpaperRotationTransition: { getter: "get_wallpaper_rotation_transition", setter: "set_wallpaper_rotation_transition", param: "transition" },
    wallpaperStyleByMode: { getter: "get_wallpaper_style_by_mode", setter: "set_wallpaper_style_by_mode" },
    wallpaperTransitionByMode: { getter: "get_wallpaper_transition_by_mode", setter: "set_wallpaper_transition_by_mode" },
    wallpaperMode: { getter: "get_wallpaper_mode", setter: "set_wallpaper_mode", param: "mode" },
    windowState: { getter: "get_window_state", setter: "set_window_state" },
    currentWallpaperImageId: { getter: "get_current_wallpaper_image_id", setter: "set_current_wallpaper_image_id" },
  };

  // 非安卓才归入
  if (!IS_ANDROID) {
    map.autoLaunch = { getter: "get_auto_launch", setter: "set_auto_launch", param: "enabled" };
    map.imageClickAction = { getter: "get_image_click_action", setter: "set_image_click_action", param: "action" };
    map.galleryImageAspectRatio = { getter: "get_gallery_image_aspect_ratio", setter: "set_gallery_image_aspect_ratio", param: "aspectRatio" };
    map.defaultDownloadDir = { getter: "get_default_download_dir", setter: "set_default_download_dir", param: "dir" };
  }

  // 仅 Windows
  if (IS_WINDOWS) {
    map.wallpaperEngineDir = { getter: "get_wallpaper_engine_dir", setter: "set_wallpaper_engine_dir", param: "dir" };
  }

  // 非安卓 + 非 light 模式
  if (!IS_ANDROID && !IS_LIGHT_MODE) {
    map.albumDriveEnabled = { getter: "get_album_drive_enabled", setter: "set_album_drive_enabled", param: "enabled" };
    map.albumDriveMountPoint = { getter: "get_album_drive_mount_point", setter: "set_album_drive_mount_point", param: "mountPoint" };
  }

  return map;
}

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

  // 统一的设置键配置表
  const SETTING_KEY_MAP = buildSettingKeyMap();

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
    return SETTING_KEY_MAP[key]?.getter || null;
  };

  // 将 key 映射到对应的 setter 命令名
  const getSetterCommand = (key: AppSettingKey): string | null => {
    return SETTING_KEY_MAP[key]?.setter || null;
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
    // 从统一配置表中获取所有可用键
    const allKeys = Object.keys(SETTING_KEY_MAP) as AppSettingKey[];
    
    // 并发加载所有设置
    await Promise.all(allKeys.map((k) => load(k)));

    // 安卓下设置默认值（这些键不在配置表中，但需要在 values 中有默认值）
    if (IS_ANDROID) {
      // imageClickAction: 安卓下固定为应用内预览
      (values as any).imageClickAction = "preview";
      
      // galleryImageAspectRatio: 安卓下自动使用屏幕宽高比
      const screenW = window.screen.width;
      const screenH = window.screen.height;
      (values as any).galleryImageAspectRatio = `custom:${screenW}:${screenH}`;
      
      // defaultDownloadDir: 保持 null，后端自动使用默认目录
      (values as any).defaultDownloadDir = null;
    }
  };

  // 将 key 映射到对应的 setter 参数名
  const getSetterParamKey = (key: AppSettingKey): string => {
    const meta = SETTING_KEY_MAP[key];
    return meta?.param || camelToSnake(key);
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
      if (IS_DEV) {
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
