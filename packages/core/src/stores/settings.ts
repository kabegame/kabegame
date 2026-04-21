import { defineStore } from "pinia";
import { nextTick, reactive, watch, type Ref } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { invoke } from "../api";
import { IS_DEV, IS_LIGHT_MODE, IS_ANDROID, IS_WINDOWS, IS_WEB } from "../env";
import { guardDesktopOnly } from "../utils/desktopOnlyGuard";
import { guardSuperRequired } from "../utils/superModeGuard";
import { getIsSuper } from "../state/superState";

// 与后端 settings.rs 的 AppSettings（serde rename_all = camelCase）保持一致
export interface AppSettings {
  autoLaunch: boolean;
  maxConcurrentDownloads: number;
  /** 同时运行的爬虫任务数（1-10） */
  maxConcurrentTasks: number;
  /** 每次下载完成后进入下一轮前等待（ms，100-10000） */
  downloadIntervalMs: number;
  networkRetryCount: number;
  imageClickAction: "preview" | "open" | "none";
  galleryImageAspectRatio: string | null;
  /** 图片在方框内溢出时的垂直对齐（仅桌面端）：center | top | bottom */
  galleryImageObjectPosition: "center" | "top" | "bottom";
  /** 画廊列数（0=动态；1-4=固定列数），前端本地偏好 */
  galleryGridColumns: number;
  autoDeduplicate: boolean;
  defaultDownloadDir: string | null;
  wallpaperEngineDir: string | null;
  wallpaperRotationEnabled: boolean;
  wallpaperRotationAlbumId: string | null;
  /** 轮播指定画册时是否包含子画册（默认 true，与 07-wallpaper 设计一致） */
  wallpaperRotationIncludeSubalbums: boolean;
  wallpaperRotationIntervalMinutes: number;
  wallpaperRotationMode: "random" | "sequential" | string;
  wallpaperStyle: "fill" | "fit" | "stretch" | "center" | "tile" | string;
  wallpaperRotationTransition: "none" | "fade" | "slide" | "zoom" | string;
  // 按 wallpaperMode 记忆各模式的最后 style/transition（切换模式时用于恢复）
  wallpaperStyleByMode: Record<string, string>;
  wallpaperTransitionByMode: Record<string, string>;
  wallpaperMode: "native" | "window" | string;
  /** 视频壁纸音量 0~1 */
  wallpaperVolume: number;
  /** 视频壁纸播放速率 0.25～3 */
  wallpaperVideoPlaybackRate: number;
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
  autoOpenCrawlerWebview: boolean;
  /** 导入插件推荐运行配置时是否默认启用定时（默认 true） */
  importRecommendedScheduleEnabled: boolean;
  /** 界面语言（持久化为 canonical 语种码；缺失或非法时由前端解析链写回） */
  language: string | null;

  // --- 前端本地偏好（始终走 localStorage，所有平台一致）---
  /** 画廊每页条数（100 / 500 / 1000） */
  galleryPageSize: number;
}

export type AppSettingKey = keyof AppSettings;
export type ImageClickAction = AppSettings["imageClickAction"];

/**
 * Web mode 下通过浏览器 localStorage 持久化的设置项。
 * 这些键在 web 环境下不走后端 IPC，而是直接读写本地存储；
 * 其他平台（Tauri 桌面 / Android）仍走 IPC 后端。
 *
 * - `readonly: true`：web 端只读；写入时弹 desktopOnlyGuard 引导用户前往桌面版。
 * - 省略 readonly：web 端可自由写入 localStorage（如语言、画廊设置等前端偏好）。
 *
 * 区别于"super 管控项"：非短路的设置项在 web 端仍走 RPC，需要 super 权限才可写入；
 * 非 super 状态下写入时弹 guardSuperRequired 提示开启 super 模式。
 */
type WebLocalSettingEntry = {
  [K in AppSettingKey]: { key: K; defaultValue: AppSettings[K]; readonly?: boolean };
}[AppSettingKey];

const WEB_LOCAL_SETTING_ENTRIES: WebLocalSettingEntry[] = [
  { key: "language", defaultValue: "en" },
  { key: "imageClickAction", defaultValue: "preview", readonly: true },
  { key: "galleryImageAspectRatio", defaultValue: "16/10" },
  { key: "galleryImageObjectPosition", defaultValue: "center" },
  // 壁纸能力：web 模式下只做 localStorage 占位，修改时弹 desktopOnlyGuard
  { key: "wallpaperRotationEnabled", defaultValue: false, readonly: true },
  { key: "wallpaperRotationAlbumId", defaultValue: null, readonly: true },
  { key: "wallpaperRotationIncludeSubalbums", defaultValue: true, readonly: true },
  { key: "wallpaperRotationIntervalMinutes", defaultValue: 30, readonly: true },
  { key: "wallpaperRotationMode", defaultValue: "random", readonly: true },
  { key: "currentWallpaperImageId", defaultValue: null, readonly: true },
  { key: "wallpaperVolume", defaultValue: 0.5, readonly: true },
  { key: "wallpaperVideoPlaybackRate", defaultValue: 1, readonly: true },
  // 壁纸样式/模式/过渡：web 不使用，readonly 占位防止 IPC 调用
  { key: "wallpaperStyle", defaultValue: "fill", readonly: true },
  { key: "wallpaperRotationTransition", defaultValue: "none", readonly: true },
  { key: "wallpaperStyleByMode", defaultValue: {} as Record<string, string>, readonly: true },
  { key: "wallpaperTransitionByMode", defaultValue: {} as Record<string, string>, readonly: true },
  { key: "wallpaperMode", defaultValue: "native", readonly: true },
  { key: "windowState", defaultValue: null as AppSettings["windowState"], readonly: true },
  // 桌面/系统能力：web 端不可用，设置时弹 desktopOnlyGuard
  { key: "albumDriveEnabled", defaultValue: false, readonly: true },
  { key: "albumDriveMountPoint", defaultValue: "", readonly: true },
  { key: "autoOpenCrawlerWebview", defaultValue: false, readonly: true },
  { key: "defaultDownloadDir", defaultValue: null, readonly: true },
  { key: "autoLaunch", defaultValue: false, readonly: true },
];

const WEB_LOCAL_STORAGE_PREFIX = "kabegame-setting-";

/**
 * 将设置键映射到 `web.feature.*` 下的通用桶，
 * 避免为每个键单独添加 i18n 文案。
 */
const WEB_READONLY_FEATURE_KEY_MAP: Partial<Record<AppSettingKey, string>> = {
  currentWallpaperImageId: "wallpaper",
  wallpaperVolume: "wallpaperPlayback",
  wallpaperVideoPlaybackRate: "wallpaperPlayback",
  wallpaperRotationEnabled: "wallpaperRotation",
  wallpaperRotationAlbumId: "wallpaperRotation",
  wallpaperRotationIncludeSubalbums: "wallpaperRotation",
  wallpaperRotationIntervalMinutes: "wallpaperRotation",
  wallpaperRotationMode: "wallpaperRotation",
  wallpaperRotationTransition: "wallpaperRotation",
  wallpaperStyle: "wallpaper",
  wallpaperStyleByMode: "wallpaper",
  wallpaperTransitionByMode: "wallpaper",
  wallpaperMode: "wallpaper",
  wallpaperEngineDir: "wallpaper",
  albumDriveEnabled: "albumDrive",
  albumDriveMountPoint: "albumDrive",
  autoOpenCrawlerWebview: "openCrawlerWindow",
  windowState: "windowState",
  autoLaunch: "autoLaunch",
  defaultDownloadDir: "defaultDownloadDir",
  imageClickAction: "imageClickAction",
  maxConcurrentDownloads: "downloadSettings",
  maxConcurrentTasks: "downloadSettings",
  downloadIntervalMs: "downloadSettings",
  networkRetryCount: "downloadSettings",
  galleryImageObjectPosition: "gallerySettings",
  autoDeduplicate: "autoDeduplicate",
  importRecommendedScheduleEnabled: "scheduler",
};

function webReadonlyFeatureKey(key: AppSettingKey): string {
  return WEB_READONLY_FEATURE_KEY_MAP[key] ?? key;
}

/**
 * 前端本地偏好：始终走 localStorage（不经 IPC，所有平台一致）。
 * 与 WEB_LOCAL_SETTING_ENTRIES 不同，这里不受 IS_WEB 限制——web 模式下
 * 两份列表会合并到同一个 localStorage 短路层，对消费者完全透明。
 */
const FRONTEND_LOCAL_SETTING_ENTRIES: WebLocalSettingEntry[] = [
  { key: "galleryPageSize", defaultValue: 100 },
  { key: "galleryGridColumns", defaultValue: 0 },
];

/** 旧键 → 新键（`${WEB_LOCAL_STORAGE_PREFIX}${key}`）一次性迁移表。 */
const LOCAL_SETTING_LEGACY_KEYS: Partial<Record<AppSettingKey, string>> = {
  galleryPageSize: "kabegame-galleryPageSize",
};

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
    language: { getter: "get_language", setter: "set_language", param: "language" },
    importRecommendedScheduleEnabled: {
      getter: "get_import_recommended_schedule_enabled",
      setter: "set_import_recommended_schedule_enabled",
      param: "enabled",
    },
    maxConcurrentDownloads: { getter: "get_max_concurrent_downloads", setter: "set_max_concurrent_downloads", param: "count" },
    maxConcurrentTasks: { getter: "get_max_concurrent_tasks", setter: "set_max_concurrent_tasks", param: "count" },
    downloadIntervalMs: { getter: "get_download_interval_ms", setter: "set_download_interval_ms", param: "intervalMs" },
    networkRetryCount: { getter: "get_network_retry_count", setter: "set_network_retry_count", param: "count" },
    autoDeduplicate: { getter: "get_auto_deduplicate", setter: "set_auto_deduplicate", param: "enabled" },
    wallpaperRotationEnabled: { getter: "get_wallpaper_rotation_enabled", setter: "set_wallpaper_rotation_enabled", param: "enabled" },
    wallpaperRotationAlbumId: { getter: "get_wallpaper_rotation_album_id", setter: "set_wallpaper_rotation_album_id", param: "albumId" },
    wallpaperRotationIncludeSubalbums: {
      getter: "get_wallpaper_rotation_include_subalbums",
      setter: "set_wallpaper_rotation_include_subalbums",
      param: "includeSubalbums",
    },
    wallpaperRotationIntervalMinutes: { getter: "get_wallpaper_rotation_interval_minutes", setter: "set_wallpaper_rotation_interval_minutes", param: "minutes" },
    wallpaperRotationMode: { getter: "get_wallpaper_rotation_mode", setter: "set_wallpaper_rotation_mode", param: "mode" },
    wallpaperStyle: { getter: "get_wallpaper_rotation_style", setter: "set_wallpaper_style", param: "style" },
    wallpaperRotationTransition: { getter: "get_wallpaper_rotation_transition", setter: "set_wallpaper_rotation_transition", param: "transition" },
    wallpaperStyleByMode: { getter: "get_wallpaper_style_by_mode", setter: "set_wallpaper_style_by_mode" },
    wallpaperTransitionByMode: { getter: "get_wallpaper_transition_by_mode", setter: "set_wallpaper_transition_by_mode" },
    wallpaperMode: { getter: "get_wallpaper_mode", setter: "set_wallpaper_mode", param: "mode" },
    wallpaperVolume: { getter: "get_wallpaper_volume", setter: "set_wallpaper_volume", param: "volume" },
    wallpaperVideoPlaybackRate: { getter: "get_wallpaper_video_playback_rate", setter: "set_wallpaper_video_playback_rate", param: "rate" },
    windowState: { getter: "get_window_state", setter: "set_window_state" },
    currentWallpaperImageId: { getter: "get_current_wallpaper_image_id", setter: "set_current_wallpaper_image_id" },
  };

  // 非安卓才归入
  if (!IS_ANDROID) {
    map.autoLaunch = { getter: "get_auto_launch", setter: "set_auto_launch", param: "enabled" };
    map.imageClickAction = { getter: "get_image_click_action", setter: "set_image_click_action", param: "action" };
    map.galleryImageAspectRatio = { getter: "get_gallery_image_aspect_ratio", setter: "set_gallery_image_aspect_ratio", param: "aspectRatio" };
    map.galleryImageObjectPosition = { getter: "get_gallery_image_object_position", setter: "set_gallery_image_object_position", param: "position" };
    map.defaultDownloadDir = { getter: "get_default_download_dir", setter: "set_default_download_dir", param: "dir" };
    map.autoOpenCrawlerWebview = {
      getter: "get_auto_open_crawler_webview",
      setter: "set_auto_open_crawler_webview",
      param: "enabled",
    };
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
  // 后端 AppSettings 的 key-value 缓存（key 与后端完全一致）
  const values = reactive<Partial<AppSettings>>({});
  const loadingByKey = reactive<Record<string, boolean>>({});
  const savingByKey = reactive<Record<string, boolean>>({});

  // 统一的设置键配置表
  const SETTING_KEY_MAP = buildSettingKeyMap();

  // localStorage 短路层：FRONTEND_LOCAL 始终激活（所有平台），WEB_LOCAL 仅 web 模式追加。
  // 对消费者透明：load/save 命中 webLocalRefs 的 key 即短路到 localStorage，其他走 IPC。
  const webLocalRefs: Partial<Record<AppSettingKey, Ref<any>>> = {};
  const webLocalReadonly = new Set<AppSettingKey>();
  const localEntries: WebLocalSettingEntry[] = [
    ...FRONTEND_LOCAL_SETTING_ENTRIES,
    ...(IS_WEB ? WEB_LOCAL_SETTING_ENTRIES : []),
  ];
  for (const entry of localEntries) {
    const newKey = `${WEB_LOCAL_STORAGE_PREFIX}${entry.key}`;
    const legacyKey = LOCAL_SETTING_LEGACY_KEYS[entry.key];
    if (legacyKey && localStorage.getItem(newKey) === null) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        localStorage.setItem(newKey, legacy);
        localStorage.removeItem(legacyKey);
      }
    }
    webLocalRefs[entry.key] = useLocalStorage(
      newKey,
      entry.defaultValue as any,
      { mergeDefaults: true },
    );
    if (entry.readonly) webLocalReadonly.add(entry.key);
    // 预填 values，并保持与 ref 的双向同步（其它 tab 改 localStorage 也能带动 UI）
    (values as any)[entry.key] = webLocalRefs[entry.key]!.value;
    watch(webLocalRefs[entry.key]!, (v: unknown) => {
      (values as any)[entry.key] = v;
    });
  }
  const isWebLocal = (key: AppSettingKey) => key in webLocalRefs;
  // 保留原语义：readonly 仅在 web 模式下生效；非 web 不关心 readonly。
  const isWebReadonly = (key: AppSettingKey) => IS_WEB && webLocalReadonly.has(key);

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
      // Web mode：直接从 localStorage 读取
      if (isWebLocal(key)) {
        (values as any)[key] = webLocalRefs[key]!.value;
        return;
      }
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

      // Web mode：写入 localStorage 后即完成，不再走后端 IPC
      if (isWebLocal(key)) {
        if (isWebReadonly(key)) {
          // 让 watcher 先捕获到「值被改变」的中间状态，然后再回滚；
          // 否则 Vue 3 对"净变化=0"的连续写入会去重，导致组件里的
          // localValue ref 无法通过 watch(settingValue) 被重置（UI 看上去「设置成功」）。
          await nextTick();
          (values as any)[key] = prevValue;
          void guardDesktopOnly(webReadonlyFeatureKey(key));
          return;
        }
        webLocalRefs[key]!.value = value;
        if (onAfterSave) {
          await onAfterSave();
        }
        return;
      }

      if (IS_WEB && !getIsSuper()) {
        await nextTick();
        // 回滚本地值
        (values as any)[key] = prevValue;
        guardDesktopOnly(webReadonlyFeatureKey(key));
        return;
      }

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
      // web mode 下 RPC -32001 forbidden：需要 super 权限，弹窗提示
      if (IS_WEB && (error as { code?: number }).code === -32001) {
        void guardSuperRequired();
        return;
      }
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
    // app settings
    values,
    loadingByKey,
    savingByKey,
    isLoading,
    isSaving,
    isDown,
    isWebReadonly,
    load,
    loadMany,
    loadAll,
    save,
  };
});
