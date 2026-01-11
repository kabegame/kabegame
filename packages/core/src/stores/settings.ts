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
  galleryPageSize: number;
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
  restoreLastTab: boolean;
  lastTabPath: string | null;
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

  const load = async <K extends AppSettingKey>(key: K) => {
    if (loadingByKey[key]) return;
    loadingByKey[key] = true;
    try {
      const v = await invoke<any>("get_setting", { key });
      (values as any)[key] = v;
    } finally {
      loadingByKey[key] = false;
    }
  };

  const loadMany = async (keys: AppSettingKey[]) => {
    await Promise.all(keys.map((k) => load(k)));
  };

  const loadAll = async () => {
    const s = await invoke<AppSettings>("get_settings");
    Object.assign(values, s);
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
