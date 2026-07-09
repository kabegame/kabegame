import { defineStore } from "pinia";
import { computed, reactive, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { invoke } from "../api";
import { IS_ANDROID, IS_DEV, IS_WEB } from "../env";
import { guardSuperRequired } from "../utils/superModeGuard";
import {
  buildSettingsDescriptors,
  type QuerySettingDescriptor,
  type SettingDescriptor,
  type SettingsHistoryMode,
  type SettingsSaveOptions,
} from "./settingsDescriptors";
import { runLocalSettingsMigrations } from "./localSettingsMigrations";

// 与后端 settings.rs 的 AppSettings（serde rename_all = camelCase）保持一致。
export interface AppSettings {
  autoLaunch: boolean;
  maxConcurrentDownloads: number;
  /** 同时运行的爬虫任务数（1-10） */
  maxConcurrentTasks: number;
  /** 每次下载完成后进入下一轮前等待（ms，100-10000） */
  downloadIntervalMs: number;
  networkRetryCount: number;
  imageClickAction: "preview" | "open" | "none";
  /** 画廊列数（0=动态；1-6=固定列数），前端本地偏好 */
  galleryGridColumns: number;
  autoDeduplicate: boolean;
  realtimeFolderSync: boolean;
  defaultDownloadDir: string | null;
  wallpaperRotationEnabled: boolean;
  wallpaperRotationAlbumId: string | null;
  /** 轮播指定画册时是否包含子画册（默认 true，与 07-wallpaper 设计一致） */
  wallpaperRotationIncludeSubalbums: boolean;
  wallpaperRotationIntervalMinutes: number;
  wallpaperRotationMode: "random" | "sequential" | string;
  wallpaperStyle: "fill" | "fit" | "stretch" | "center" | "tile" | string;
  wallpaperRotationTransition: "none" | "fade" | "slide" | "zoom" | string;
  /** 按 wallpaperMode 记忆各模式的最后 style/transition（切换模式时用于恢复） */
  wallpaperStyleByMode: Record<string, string>;
  wallpaperTransitionByMode: Record<string, string>;
  wallpaperMode: "native" | "window" | string;
  /** 关闭壁纸：整体禁用壁纸功能（后端拒绝壁纸操作、隐藏壁纸窗口、启动不恢复） */
  wallpaperDisabled: boolean;
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
  albumDriveDriverInstalled: boolean;
  autoOpenCrawlerWebview: boolean;
  /** 导入插件推荐运行配置时是否默认启用定时（默认 true） */
  importRecommendedScheduleEnabled: boolean;
  /** 界面语言（持久化为 canonical 语种码；缺失或非法时由前端解析链写回） */
  language: string | null;

  // --- 前端本地偏好（始终走 localStorage，所有平台一致）---
  /** 应用内背景图开关 */
  appBackgroundEnabled: boolean;
  /** 应用内背景图模糊半径（px） */
  appBackgroundBlur: number;
  /** 应用内背景图透明度（0~1） */
  appBackgroundOpacity: number;
  /** 画廊每页条数（100 / 500 / 1000） */
  galleryPageSize: number;
  /** 画廊布局模式："grid"=CSS 网格（现状）；"gallery"=瀑布流（N 列/行 masonry） */
  galleryLayoutMode: "grid" | "gallery";
  /** 布局方向："vertical"=从上到下滚动（现状）；"horizontal"=从左到右滚动 */
  galleryLayoutDirection: "vertical" | "horizontal";
  /** 是否启用 Kamechan；关闭后消息走普通弹出提示 */
  kamechanEnabled: boolean;

  // --- URL query 镜像键（settings 层只做哑同步，页面自己做激活态 guard）---
  /** `/auto-configs?tab=`；缺省为 `"mine"`，`"mine"` 会编码为空并删除参数。 */
  autoConfigTab: "mine" | "recommended";
  /** 图片预览 query `?pvwimgid=`；空串表示未预览。 */
  previewImageId: string;
  /** web super query `?super=1`；非 `"1"` 都解码为 false。 */
  superMode: boolean;
  /** 插件详情来源模式 query `?mode=remote`；缺省为 `"local"`。 */
  pluginDetailMode: "local" | "remote";
  /** 插件详情商店源 query `?sourceId=`；空串表示未指定。 */
  pluginDetailSourceId: string;
  /** 插件详情期望版本 query `?version=`；空串表示未指定。 */
  pluginDetailVersion: string;
  /** 画廊 route path query 的原始字符串，包含可选 `hide/` 前缀。 */
  "gallery-path": string;
  /** 任务详情 route path query 的原始字符串，包含可选 `hide/` 前缀。 */
  "task-detail-path": string;
  /** 畅游图片 route path query 的原始字符串，包含可选 `hide/` 前缀。 */
  "surf-images-path": string;
  /** 画册详情 route path query 的原始字符串，包含可选 `hide/` 前缀。 */
  "album-detail-path": string;
}

export type AppSettingKey = keyof AppSettings;
export type ImageClickAction = AppSettings["imageClickAction"];
export type { SettingsSaveOptions, SettingsHistoryMode };

const LOCAL_STORAGE_PREFIX = "kabegame-setting-";
const descriptors = buildSettingsDescriptors();

export interface SettingsQueryAdapter {
  /**
   * 响应式当前 query。通常由 app 层传入 `computed(() => route.query)`。
   *
   * @example
   * ```ts
   * setSettingsQueryAdapter({
   *   query: computed(() => route.query),
   *   write: (param, value, history) => router[history]({ query: { ...route.query, [param]: value } }),
   * });
   * ```
   */
  query: ComputedRef<Record<string, unknown>> | Ref<Record<string, unknown>>;
  /**
   * 写入单个 query 参数。`value === ""` 表示删除参数。
   * `history` 由调用方决定，页面状态同步一般用 replace，用户导航动作一般用 push。
   */
  write(param: string, value: string, history: SettingsHistoryMode): Promise<void>;
}

const queryAdapterRef = shallowRef<SettingsQueryAdapter | null>(null);

/**
 * 注入 URL query 后端。
 *
 * core 包不依赖 vue-router；app 层在拿到 `useRoute()` / `useRouter()`
 * 后调用一次这个函数即可让 query descriptor 开始响应式同步。
 *
 * @param adapter - 提供当前 query 的响应式引用，以及写入单个 query 参数的方法。
 *
 * @example
 * ```ts
 * const route = useRoute();
 * const router = useRouter();
 * setSettingsQueryAdapter({
 *   query: computed(() => route.query as Record<string, unknown>),
 *   async write(param, value, history) {
 *     const query = { ...route.query };
 *     if (value === "") delete query[param];
 *     else query[param] = value;
 *     await router[history]({ path: route.path, query });
 *   },
 * });
 * ```
 */
export function setSettingsQueryAdapter(adapter: SettingsQueryAdapter | null) {
  queryAdapterRef.value = adapter;
}

function descriptorFor<K extends AppSettingKey>(key: K): SettingDescriptor<K> | undefined {
  return descriptors[key] as SettingDescriptor<K> | undefined;
}

function backendKeys() {
  return (Object.keys(descriptors) as AppSettingKey[]).filter((key) => descriptorFor(key)?.backend === "tauri");
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function rawQueryValue(param: string): string {
  const adapter = queryAdapterRef.value;
  if (!adapter) return "";
  const raw = adapter.query.value[param];
  if (Array.isArray(raw)) return String(raw[0] ?? "");
  return raw == null ? "" : String(raw);
}

function decodeQueryValue<K extends AppSettingKey>(descriptor: QuerySettingDescriptor<K>): AppSettings[K] {
  const raw = rawQueryValue(descriptor.param);
  if (descriptor.codec) return descriptor.codec.decode(raw);
  return raw as AppSettings[K];
}

function encodeQueryValue<K extends AppSettingKey>(
  descriptor: QuerySettingDescriptor<K>,
  value: AppSettings[K],
): string {
  if (descriptor.codec) return descriptor.codec.encode(value);
  return String(value ?? "");
}

/**
 * 设置键状态机。
 *
 * `save` 不做乐观写，也不手动回滚：保存开始只标记 `savingByKey[key] = true`，
 * 真正的 `values[key]` 更新和保存态退出都由观察源确认：
 *
 * - tauri：后端 `setting-change` 事件进入 `applyChanges`。
 * - localStorage：`useLocalStorage` ref 的 watcher。
 * - query：注入 adapter 的 `query` watcher。
 *
 * @example
 * ```ts
 * const settings = useSettingsStore();
 * await settings.loadAll();
 * await settings.save("galleryPageSize", 500);
 * ```
 */
export const useSettingsStore = defineStore("settings", () => {
  runLocalSettingsMigrations();

  const values = reactive<Partial<AppSettings>>({});
  const loadingByKey = reactive<Partial<Record<AppSettingKey, boolean>>>({});
  const savingByKey = reactive<Partial<Record<AppSettingKey, boolean>>>({});
  const localRefs: Partial<Record<AppSettingKey, Ref<unknown>>> = {};

  let settingsLoaded = false;
  let settingsLoadPromise: Promise<void> | null = null;

  for (const key of Object.keys(descriptors) as AppSettingKey[]) {
    const descriptor = descriptorFor(key);
    if (!descriptor) continue;

    if (descriptor.backend === "localStorage") {
      const storageKey = `${LOCAL_STORAGE_PREFIX}${String(key)}`;
      const localRef = useLocalStorage(storageKey, descriptor.defaultValue as any, { mergeDefaults: true });
      localRefs[key] = localRef;
      (values as any)[key] = localRef.value;
      watch(localRef, (value) => {
        (values as any)[key] = value;
        savingByKey[key] = false;
      });
      continue;
    }

    if (descriptor.backend === "readonly") {
      (values as any)[key] = descriptor.defaultValue;
      continue;
    }

    if (descriptor.backend === "query") {
      (values as any)[key] = decodeQueryValue(descriptor as QuerySettingDescriptor<any>);
      watch(
        () => decodeQueryValue(descriptor as QuerySettingDescriptor<any>),
        (value) => {
          (values as any)[key] = value;
          savingByKey[key] = false;
        },
        { immediate: true },
      );
    }
  }

  const applyAndroidDefaults = () => {
    if (!IS_ANDROID) return;
    (values as any).imageClickAction = "preview";
    (values as any).defaultDownloadDir = null;
  };

  const setBackendLoading = (loading: boolean) => {
    for (const key of backendKeys()) {
      loadingByKey[key] = loading;
    }
  };

  const applySnapshot = (snapshot: Partial<AppSettings>) => {
    for (const [rawKey, value] of Object.entries(snapshot)) {
      const key = rawKey as AppSettingKey;
      if (descriptorFor(key)?.backend !== "tauri") continue;
      (values as any)[key] = value;
    }
    applyAndroidDefaults();
  };

  const fetchSettingsBatch = async () => {
    const keys = backendKeys();
    if (keys.length === 0) {
      applyAndroidDefaults();
      settingsLoaded = true;
      return;
    }

    setBackendLoading(true);
    try {
      const snapshot = await invoke<Partial<AppSettings>>("get_settings", { keys });
      applySnapshot(snapshot);
      settingsLoaded = true;
    } finally {
      setBackendLoading(false);
    }
  };

  const setSettingsLoadPromise = (promise: Promise<void>) => {
    settingsLoadPromise = promise.finally(() => {
      settingsLoadPromise = null;
    });
    return settingsLoadPromise;
  };

  const loadAll = async () => {
    if (settingsLoadPromise) {
      await settingsLoadPromise.catch((error) => {
        console.error("Failed to load settings:", error);
      });
      return;
    }
    if (settingsLoaded) return;
    setSettingsLoadPromise(
      fetchSettingsBatch().catch((error) => {
        console.error("Failed to load settings:", error);
      }),
    );
    await settingsLoadPromise;
  };

  const refreshAll = async () => {
    if (settingsLoadPromise) await settingsLoadPromise;
    await setSettingsLoadPromise(fetchSettingsBatch());
  };

  const refresh = async <K extends AppSettingKey>(key: K): Promise<void> => {
    const descriptor = descriptorFor(key);
    if (descriptor?.backend !== "tauri" || !descriptor.getter) return;

    loadingByKey[key] = true;
    try {
      (values as any)[key] = await invoke<AppSettings[K]>(descriptor.getter);
    } finally {
      loadingByKey[key] = false;
    }
  };

  /**
   * 应用后端设置变更事件。
   *
   * 这是 tauri 后端的真实值同步入口，也是 tauri 保存态的确认入口；
   * 命中的 key 会同时更新 `values[key]` 并清掉 `savingByKey[key]`。
   */
  const applyChanges = (changes: Partial<AppSettings> | Record<string, unknown>) => {
    for (const [rawKey, value] of Object.entries(changes)) {
      const key = rawKey as AppSettingKey;
      const descriptor = descriptorFor(key);
      if (!descriptor) continue;
      if (descriptor.backend === "localStorage") {
        localRefs[key]!.value = value;
      } else if (descriptor.backend === "tauri") {
        (values as any)[key] = value;
      }
      savingByKey[key] = false;
    }
  };

  const saveLocalStorage = <K extends AppSettingKey>(key: K, value: AppSettings[K]) => {
    const localRef = localRefs[key];
    if (!localRef) {
      savingByKey[key] = false;
      return false;
    }
    const unchanged = Object.is(localRef.value, value);
    localRef.value = value;
    if (unchanged) savingByKey[key] = false;
    return true;
  };

  const saveQuery = async <K extends AppSettingKey>(
    key: K,
    descriptor: QuerySettingDescriptor<K>,
    value: AppSettings[K],
    opts?: SettingsSaveOptions,
  ) => {
    const adapter = queryAdapterRef.value;
    if (!adapter) {
      savingByKey[key] = false;
      return false;
    }
    const encoded = encodeQueryValue(descriptor, value);
    const previous = rawQueryValue(descriptor.param);
    const history = opts?.history ?? "replace";
    if (previous === encoded) {
      (values as any)[key] = value;
      savingByKey[key] = false;
      return true;
    }
    await adapter.write(descriptor.param, encoded, history);
    (values as any)[key] = decodeQueryValue(descriptor);
    savingByKey[key] = false;
    return true;
  };

  const saveTauri = async <K extends AppSettingKey>(
    key: K,
    descriptor: Extract<SettingDescriptor<K>, { backend: "tauri" }>,
    value: AppSettings[K],
  ) => {
    const paramKey = descriptor.param || camelToSnake(String(key));
    const args: Record<string, unknown> = { [paramKey]: value };
    if (IS_DEV) {
      console.log(`Saving setting ${String(key)} with value`, value, args);
    }
    await invoke(descriptor.setter!, args);
    return true;
  };

  /**
   * 保存单个设置值。
   *
   * @param key - `AppSettings` 中的设置键。
   * @param value - 与 key 类型匹配的新值。
   * @param opts - query history 与可选埋点上下文；store 只消费 `history`。
   * @returns `true` 表示写入已发起或完成；`false` 表示当前状态拒绝写入。
   *
   * @example
   * ```ts
   * await settings.save("galleryPageSize", 500);
   * await settings.save("gallery-path", "hide/全部", { history: "replace" });
   * ```
   */
  const save = async <K extends AppSettingKey>(
    key: K,
    value: AppSettings[K],
    opts?: SettingsSaveOptions,
  ): Promise<boolean> => {
    if (savingByKey[key] || loadingByKey[key]) return false;

    const descriptor = descriptorFor(key);
    if (!descriptor) {
      console.warn(`No setting descriptor found for key: ${String(key)}`);
      return false;
    }
    if (descriptor.backend === "readonly") return false;

    savingByKey[key] = true;
    try {
      if (descriptor.backend === "localStorage") {
        return saveLocalStorage(key, value);
      }
      if (descriptor.backend === "query") {
        return await saveQuery(key, descriptor as QuerySettingDescriptor<K>, value, opts);
      }
      return await saveTauri(key, descriptor as Extract<SettingDescriptor<K>, { backend: "tauri" }>, value);
    } catch (error) {
      savingByKey[key] = false;
      if (IS_WEB && (error as { code?: number }).code === -32001) {
        void guardSuperRequired();
        return false;
      }
      console.error(`Failed to save setting ${String(key)}:`, error);
      throw error;
    }
  };

  const isLoading = (key: AppSettingKey) => !!loadingByKey[key];
  const isSaving = (key: AppSettingKey) => !!savingByKey[key];
  const isDown = (key: AppSettingKey) => !loadingByKey[key] && !savingByKey[key];
  const isReadonly = (key: AppSettingKey) => descriptorFor(key)?.backend === "readonly";

  return {
    values,
    loadingByKey,
    savingByKey,
    isLoading,
    isSaving,
    isDown,
    isReadonly,
    applyChanges,
    loadAll,
    refreshAll,
    refresh,
    save,
  };
});
