import { computed, watch } from "vue";
import { AppSettingKey, AppSettings, useSettingsStore, type SettingsSaveOptions } from "../stores/settings";
import { useLoadingDelay } from "./useLoadingDelay";
import { IS_WEB } from "../env";
import { trackEvent } from "../track/umami";
import { guardDesktopOnly } from "../utils/desktopOnlyGuard";

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function currentSettingsSource() {
  if (typeof location === "undefined") return "unknown";
  return location.pathname === "/settings" ? "settings_page" : "quick_settings_drawer";
}

function trackSettingChange(
  key: string,
  value: unknown,
  source = currentSettingsSource(),
  extra: Record<string, unknown> = {},
) {
  if (!IS_WEB) return;
  trackEvent("setting_change", {
    key,
    value,
    url: currentUrl(),
    source,
    ...extra,
  });
}

/**
 * web readonly 设置键对应的能力文案桶。
 *
 * 这是 UI 关切，不属于 settings store：store 只知道 key 当前是否 readonly，
 * 这里负责把 key 映射到 `web.feature.*` 的展示文案。
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
  albumDriveEnabled: "albumDrive",
  albumDriveMountPoint: "albumDrive",
  albumDriveDriverInstalled: "albumDrive",
  autoOpenCrawlerWebview: "openCrawlerWindow",
  windowState: "windowState",
  autoLaunch: "autoLaunch",
  defaultDownloadDir: "defaultDownloadDir",
  imageClickAction: "imageClickAction",
};

function webReadonlyFeatureKey(key: AppSettingKey): string {
  return WEB_READONLY_FEATURE_KEY_MAP[key] ?? key;
}

/**
 * 封装设置键的状态管理
 *
 * 状态机：初始状态 -> loading -> down -> saving -> down
 * - loading: 正在从后端加载设置值
 * - down: 空闲状态，可以响应用户操作
 * - saving: 正在保存设置值到后端
 *
 * 使用延迟显示（300ms）来避免短暂的状态闪烁
 *
 * @param key - 设置键名；后端类型由 settings descriptor 决定。
 * @returns 状态管理相关的响应式引用和方法
 *
 * @example
 * ```ts
 * const { settingValue, set, disabled } = useSettingKeyState("galleryPageSize");
 * await set(500);
 * await set("recommended", { history: "replace", source: "auto_config_tabs" });
 * ```
 */
export function useSettingKeyState<K extends AppSettingKey>(key: K) {
  const settingsStore = useSettingsStore();

  // 原始状态
  const isLoading = computed(() => settingsStore.isLoading(key));
  const isSaving = computed(() => settingsStore.isSaving(key));
  const isDown = computed(() => settingsStore.isDown(key));
  const isReadonly = computed(() => settingsStore.isReadonly(key));

  // 延迟显示的状态（300ms）
  const { showLoading: showLoadingState, startLoading: startLoadingDelay, finishLoading: finishLoadingDelay } = useLoadingDelay(300);
  const { showLoading: showSavingState, startLoading: startSavingDelay, finishLoading: finishSavingDelay } = useLoadingDelay(300);

  // watch isLoading/isSaving 驱动延迟状态
  watch(isLoading, (v) => v ? startLoadingDelay() : finishLoadingDelay(), { immediate: true });
  watch(isSaving, (v) => v ? startSavingDelay() : finishSavingDelay(), { immediate: true });

  // 设置值（响应式引用）
  const settingValue = computed({
    get: () => settingsStore.values[key] as AppSettings[K] | undefined,
    set: (value: AppSettings[K]) => {
      void set(value);
    },
  });

  // 是否禁用（用于 UI）
  const disabled = computed(() => !isDown.value);
  const showDisabled = computed(() => showLoadingState.value || showSavingState.value);

  /**
   * 设置值并保存到当前 key 的后端。
   *
   * @param value - 要设置的值
   * @param opts - query history 与可选埋点上下文。只有传入 `source` 时才埋点。
   * @returns `true` 表示写入已发起或完成；`false` 表示被 loading/saving/readonly 拒绝。
   *
   * @example
   * ```ts
   * await set("hide/全部", { history: "replace" });
   * await set(true, { source: "settings_page", extra: { section: "wallpaper" } });
   * ```
   */
  const set = async (
    value: AppSettings[K],
    opts?: SettingsSaveOptions,
  ): Promise<boolean> => {
    if (isReadonly.value) {
      void guardDesktopOnly(webReadonlyFeatureKey(key));
      return false;
    }
    if (!isDown.value) return false;
    const ok = await settingsStore.save(key, value, opts);
    if (ok && opts?.source) {
      trackSettingChange(key, value, opts.source, opts.extra);
    }
    return ok;
  };

  return {
    // 状态
    isLoading,
    isSaving,
    isDown,
    isReadonly,
    showLoading: showLoadingState,
    showSaving: showSavingState,
    disabled,
    showDisabled,
    showReadonly: isReadonly,

    // 值，可以直接设置，但如果要传入options就通过 set 方法
    settingValue,

    // 方法
    set,
  };
}
