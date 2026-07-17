import { IS_ANDROID, IS_LIGHT_MODE, IS_LINUX, IS_MACOS, IS_WEB, IS_WINDOWS } from "../env";
import type { AppSettingKey, AppSettings } from "./settings";

export type SettingsHistoryMode = "push" | "replace";

/**
 * 保存设置时的可选上下文。
 *
 * - `history` 只对 query 后端生效，用来决定 URL 更新使用 `router.push`
 *   还是 `router.replace`。settings 层不会替页面判断默认语义。
 * - `source` / `extra` 只给 `useSettingKeyState` 做埋点；store 本身不消费。
 *
 * @example
 * ```ts
 * const { set } = useSettingKeyState("autoConfigTab");
 * await set("recommended", { history: "replace", source: "auto_config_tabs" });
 * ```
 */
export interface SettingsSaveOptions {
  history?: SettingsHistoryMode;
  source?: string;
  extra?: Record<string, unknown>;
}

export interface QuerySettingCodec<TValue> {
  /**
   * 把 typed setting value 转成 URL query 字符串。
   * 返回空字符串表示该参数应从 URL 删除。
   *
   * @example
   * ```ts
   * encode: (enabled: boolean) => enabled ? "1" : ""
   * ```
   */
  encode(value: TValue): string;
  /**
   * 把 URL query 字符串转回 typed setting value。
   * 参数不存在时 settings 会传入空字符串，所以这里应返回逻辑默认值。
   *
   * @example
   * ```ts
   * decode: (raw: string) => raw === "1"
   * ```
   */
  decode(raw: string): TValue;
}

export type TauriSettingDescriptor<K extends AppSettingKey = AppSettingKey> = {
  backend: "tauri";
  /** IPC getter 命令名；当前批量读取使用 `get_settings`，此字段保留给单键读取和文档。 */
  getter: string;
  /** IPC setter 命令名；`save` 会调用 `invoke(setter, { [param]: value })`。 */
  setter?: string;
  /** setter 入参名；省略时回退为设置 key 的 snake_case 形式。 */
  param?: string;
  _key?: K;
};

export type LocalStorageSettingDescriptor<K extends AppSettingKey = AppSettingKey> = {
  backend: "localStorage";
  /** `useLocalStorage("kabegame-setting-${key}", defaultValue)` 的默认值。 */
  defaultValue: AppSettings[K];
};

export type QuerySettingDescriptor<K extends AppSettingKey = AppSettingKey> = {
  backend: "query";
  /** URL query 参数名，例如 `tab`、`pvwimgid`、`path`。 */
  param: string;
  /**
   * query 后端的类型桥。省略时使用字符串恒等转换，适合 path/id 这类原始字符串。
   *
   * @example
   * ```ts
   * { backend: "query", param: "super", codec: booleanQueryCodec }
   * ```
   */
  codec?: QuerySettingCodec<AppSettings[K]>;
};

export type ReadonlySettingDescriptor<K extends AppSettingKey = AppSettingKey> = {
  backend: "readonly";
  /** web 下只读占位值；写入在 `useSettingKeyState` 被拦截。 */
  defaultValue: AppSettings[K];
};

export type SettingDescriptor<K extends AppSettingKey = AppSettingKey> =
  | TauriSettingDescriptor<K>
  | LocalStorageSettingDescriptor<K>
  | QuerySettingDescriptor<K>
  | ReadonlySettingDescriptor<K>;

export type SettingsDescriptorMap = Partial<{
  [K in AppSettingKey]: SettingDescriptor<K>;
}>;

const frontendLocal = <K extends AppSettingKey>(
  key: K,
  defaultValue: AppSettings[K],
): [K, LocalStorageSettingDescriptor<K>] => [key, { backend: "localStorage", defaultValue }];

const readonly = <K extends AppSettingKey>(
  key: K,
  defaultValue: AppSettings[K],
): [K, ReadonlySettingDescriptor<K>] => [key, { backend: "readonly", defaultValue }];

const tauri = <K extends AppSettingKey>(
  key: K,
  getter: string,
  setter?: string,
  param?: string,
): [K, TauriSettingDescriptor<K>] => [key, { backend: "tauri", getter, setter, param }];

const query = <K extends AppSettingKey>(
  key: K,
  param: string,
  codec?: QuerySettingCodec<AppSettings[K]>,
): [K, QuerySettingDescriptor<K>] => [key, { backend: "query", param, codec }];

const booleanQueryCodec: QuerySettingCodec<boolean> = {
  encode: (value) => value ? "1" : "",
  decode: (raw) => raw === "1",
};

const autoConfigTabCodec: QuerySettingCodec<AppSettings["autoConfigTab"]> = {
  encode: (value) => value === "recommended" ? "recommended" : "",
  decode: (raw) => raw === "recommended" ? "recommended" : "mine",
};

const pluginDetailModeCodec: QuerySettingCodec<AppSettings["pluginDetailMode"]> = {
  encode: (value) => value === "remote" ? "remote" : "",
  decode: (raw) => raw === "remote" ? "remote" : "local",
};

function assignEntry<K extends AppSettingKey>(
  map: SettingsDescriptorMap,
  [key, descriptor]: [K, SettingDescriptor<K>],
) {
  (map as Record<string, SettingDescriptor>)[key] = descriptor;
}

/**
 * 构建当前平台的设置描述表。
 *
 * 每个 key 的后端选择都封装在这里：消费者只通过
 * `useSettingKeyState(key)` 读写，不需要知道它最终落到 IPC、
 * localStorage、readonly 还是 URL query。
 *
 * @example
 * ```ts
 * const descriptor = getSettingDescriptor("galleryPageSize");
 * // descriptor.backend === "localStorage"
 * ```
 */
export function buildSettingsDescriptors(): SettingsDescriptorMap {
  const map: SettingsDescriptorMap = {};

  const entries: Array<[AppSettingKey, SettingDescriptor]> = [
    tauri("language", "get_language", "set_language", "language"),
    tauri("importRecommendedScheduleEnabled", "get_import_recommended_schedule_enabled", "set_import_recommended_schedule_enabled", "enabled"),
    tauri("maxConcurrentDownloads", "get_max_concurrent_downloads", "set_max_concurrent_downloads", "count"),
    tauri("maxConcurrentTasks", "get_max_concurrent_tasks", "set_max_concurrent_tasks", "count"),
    tauri("downloadIntervalMs", "get_download_interval_ms", "set_download_interval_ms", "intervalMs"),
    tauri("networkRetryCount", "get_network_retry_count", "set_network_retry_count", "count"),
    tauri("autoDeduplicate", "get_auto_deduplicate", "set_auto_deduplicate", "enabled"),
    tauri("wallpaperRotationEnabled", "get_wallpaper_rotation_enabled", "set_wallpaper_rotation_enabled", "enabled"),
    tauri("wallpaperRotationAlbumId", "get_wallpaper_rotation_album_id", "set_wallpaper_rotation_album_id", "albumId"),
    tauri("wallpaperRotationIncludeSubalbums", "get_wallpaper_rotation_include_subalbums", "set_wallpaper_rotation_include_subalbums", "includeSubalbums"),
    tauri("wallpaperRotationIntervalMinutes", "get_wallpaper_rotation_interval_minutes", "set_wallpaper_rotation_interval_minutes", "minutes"),
    tauri("wallpaperRotationMode", "get_wallpaper_rotation_mode", "set_wallpaper_rotation_mode", "mode"),
    tauri("wallpaperStyle", "get_wallpaper_rotation_style", "set_wallpaper_style", "style"),
    tauri("wallpaperRotationTransition", "get_wallpaper_rotation_transition", "set_wallpaper_rotation_transition", "transition"),
    tauri("wallpaperStyleByMode", "get_wallpaper_style_by_mode", "set_wallpaper_style_by_mode"),
    tauri("wallpaperTransitionByMode", "get_wallpaper_transition_by_mode", "set_wallpaper_transition_by_mode"),
    tauri("wallpaperMode", "get_wallpaper_mode", "set_wallpaper_mode", "mode"),
    tauri("wallpaperDisabled", "get_wallpaper_disabled", "set_wallpaper_disabled", "disabled"),
    tauri("wallpaperVolume", "get_wallpaper_volume", "set_wallpaper_volume", "volume"),
    tauri("wallpaperVideoPlaybackRate", "get_wallpaper_video_playback_rate", "set_wallpaper_video_playback_rate", "rate"),
    tauri("windowState", "get_window_state", "set_window_state"),
    tauri("currentWallpaperImageId", "get_current_wallpaper_image_id", "set_current_wallpaper_image_id"),
  ];

  if (!IS_ANDROID) {
    entries.push(
      tauri("autoLaunch", "get_auto_launch", "set_auto_launch", "enabled"),
      tauri("imageClickAction", "get_image_click_action", "set_image_click_action", "action"),
      tauri("defaultDownloadDir", "get_default_download_dir", "set_default_download_dir", "dir"),
      tauri("autoOpenCrawlerWebview", "get_auto_open_crawler_webview", "set_auto_open_crawler_webview", "enabled"),
    );
  }

  if (!IS_ANDROID && !IS_WEB && (IS_MACOS || IS_LINUX || IS_WINDOWS)) {
    entries.push(tauri("realtimeFolderSync", "get_realtime_folder_sync", "set_realtime_folder_sync", "enabled"));
  }

  if (!IS_ANDROID && !IS_LIGHT_MODE) {
    entries.push(
      tauri("albumDriveEnabled", "get_album_drive_enabled", "set_album_drive_enabled", "enabled"),
      tauri("albumDriveMountPoint", "get_album_drive_mount_point", "set_album_drive_mount_point", "mountPoint"),
      tauri("albumDriveDriverInstalled", "get_album_drive_driver_installed"),
    );
  }

  // MCP 服务（仅桌面）：复用 settings 架构，运行态用 mcpEnabled 表示，无独立 state
  if (!IS_ANDROID && !IS_WEB) {
    entries.push(
      tauri("mcpEnabled", "get_mcp_enabled", "set_mcp_enabled", "enabled"),
      tauri("mcpPort", "get_mcp_port", "set_mcp_port", "port"),
      tauri("mcpDisabledCapabilities", "get_mcp_disabled_capabilities", "set_mcp_disabled_capabilities", "disabled"),
    );
  }

  for (const entry of entries) assignEntry(map, entry);

  const localEntries = [
    frontendLocal("appBackgroundEnabled", false),
    frontendLocal("appBackgroundBlur", 2),
    frontendLocal("appBackgroundOpacity", 0.25),
    frontendLocal("galleryPageSize", 100),
    frontendLocal("galleryGridColumns", 0),
    frontendLocal("galleryLayoutMode", "grid"),
    frontendLocal("galleryLayoutDirection", "vertical"),
    frontendLocal("kamechanEnabled", true),
    frontendLocal("imageFit", "fit"),
  ];
  if (!IS_WEB) {
    localEntries.push(
      // @ts-expect-error 非web下localstorage
      frontendLocal("gallery-path", ""),
    )
  }
  for (const entry of localEntries) assignEntry(map, entry);

  if (IS_WEB) {
    const webLocalEntries = [
      frontendLocal("language", null),
      frontendLocal("currentWallpaperImageId", null),
    ];
    for (const entry of webLocalEntries) assignEntry(map, entry);

    const webReadonlyEntries = [
      readonly("imageClickAction", "preview"),
      readonly("wallpaperRotationEnabled", false),
      readonly("wallpaperRotationAlbumId", null),
      readonly("wallpaperRotationIncludeSubalbums", true),
      readonly("wallpaperRotationIntervalMinutes", 30),
      readonly("wallpaperRotationMode", "random"),
      readonly("wallpaperVolume", 0.5),
      readonly("wallpaperVideoPlaybackRate", 1),
      readonly("wallpaperStyle", "fill"),
      readonly("wallpaperRotationTransition", "none"),
      readonly("wallpaperStyleByMode", {} as Record<string, string>),
      readonly("wallpaperTransitionByMode", {} as Record<string, string>),
      readonly("wallpaperMode", "native"),
      readonly("windowState", null),
      readonly("albumDriveEnabled", false),
      readonly("albumDriveMountPoint", ""),
      readonly("albumDriveDriverInstalled", false),
      readonly("autoOpenCrawlerWebview", false),
      readonly("defaultDownloadDir", null),
      readonly("autoLaunch", false),
    ];
    for (const entry of webReadonlyEntries) assignEntry(map, entry);
  }

  const queryEntries = [
    query("autoConfigTab", "tab", autoConfigTabCodec),
    query("previewImageId", "pvwimgid"),
    query("superMode", "super", booleanQueryCodec),
    query("pluginDetailMode", "mode", pluginDetailModeCodec),
    query("pluginDetailSourceId", "sourceId"),
    query("pluginDetailVersion", "version"),
    query("task-detail-path", "path"),
    query("surf-images-path", "path"),
    query("album-detail-path", "path"),
  ];
  if (IS_WEB) {
    queryEntries.push(
      // @ts-expect-error 非web下用localStorage
      query("gallery-path", "path")
    )
  }
  for (const entry of queryEntries) assignEntry(map, entry);

  return map;
}
