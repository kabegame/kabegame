/**
 * 壁纸目标的数据形状与纯规则（与 Rust `kabegame_core::settings::wallpaper_targets`、
 * 壁纸控制器 `wallpaper::manager` 的 `compute_layout` / `pick_option` / `display_mode_for` 同规则）。
 *
 * 目标（target）是轮播路径与位置、样式、过渡、当前壁纸的设置单位，全部目标存在一个设置键
 * `wallpaperTargets: { [targetId]: WallpaperTargetConfig }` 里。这里不碰 store 与 IPC：主窗口经
 * `useWallpaperTarget` 用，壁纸窗口（不挂设置 store）直接用。
 */

export type WallpaperDisplayMode = "multiple" | "span" | "single";

/** 一个目标的配置（后端 `WallpaperTargetConfig`）。轮播开关与间隔是全局设置，不在这里。 */
export interface WallpaperTargetConfig {
  /** 轮播来源 PathQL 路径（不含分页尾）；null 表示默认全画廊随机路径 */
  rotationPath: string | null;
  /** 下一张在轮播路径中的 0 起序号；-1 表示刚换了路径，下次从第 1 张开始 */
  rotationPosition: number;
  /** 壁纸模式 → 样式，可能缺键 */
  style: Record<string, string>;
  /** 壁纸模式 → 过渡，可能缺键 */
  transition: Record<string, string>;
  currentImageId: string | null;
}

/** 目标 id → 配置；`setting-change` 里 `wallpaperTargets` 的值就是整个 map。 */
export type WallpaperTargets = Record<string, WallpaperTargetConfig>;

/** 一块在线的显示器（后端 `ScreenInfo`）。 */
export interface WallpaperScreen {
  /** 平台持久标识；目标 id = `screen:<id>` */
  id: string;
  name: string | null;
  x: number;
  y: number;
  /** 左上原点的平台桌面坐标与尺寸（Windows 物理像素、macOS 点）：只用来画相对位置 */
  width: number;
  height: number;
  /** 物理像素分辨率：界面上显示用，前端不按平台自己换算 */
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  primary: boolean;
}

/** 在线屏变化事件，载荷 `{ screens: WallpaperScreen[] }`（变化后的完整列表，主屏在前）。 */
export const WALLPAPER_SCREENS_CHANGE_EVENT = "wallpaper-screens-change";

export interface WallpaperOption {
  value: string;
  label: Record<string, string>;
  desc: Record<string, string>;
}

/** 一个「壁纸模式 × 显示器模式」组合的能力（后端 `DisplayModeCapability`）。 */
export interface DisplayModeCapability {
  value: WallpaperDisplayMode;
  label: Record<string, string>;
  desc: Record<string, string>;
  /** null = 可用；否则是不可用的原因（i18n map） */
  unavailable: Record<string, string> | null;
  styles: WallpaperOption[];
  transitions: WallpaperOption[];
  /** true：该组合下样式对所有目标只有一个值 */
  sharedStyle: boolean;
}

/** 各屏复制：所有显示器同一张壁纸的唯一目标。 */
export const TARGET_MULTIPLE = "multiple";
/** 跨屏拼接：整个桌面当一块画布的唯一目标。 */
export const TARGET_SPAN = "span";

const SCREEN_TARGET_PREFIX = "screen:";

/** 逐屏独立的目标 id：`screen:<屏幕持久标识>`。 */
export function screenTarget(screenId: string): string {
  return `${SCREEN_TARGET_PREFIX}${screenId}`;
}

/** `screen:<id>` 目标对应的屏幕持久标识；不是逐屏目标时为 null。 */
export function screenIdOfTarget(targetId: string): string | null {
  return targetId.startsWith(SCREEN_TARGET_PREFIX) ? targetId.slice(SCREEN_TARGET_PREFIX.length) || null : null;
}

/**
 * 一块屏在显示器模式 `displayMode` 下属于哪个目标：`multiple` / `span` 下所有屏同属那唯一一个目标，
 * `single` 下各是各的。布局图据此决定点一块屏选中谁、哪些块一起高亮。
 */
export function targetIdOfScreen(displayMode: WallpaperDisplayMode, screenId: string): string {
  if (displayMode === "span") return TARGET_SPAN;
  if (displayMode === "single") return screenTarget(screenId);
  return TARGET_MULTIPLE;
}

/**
 * 目标 id 属于哪个显示器模式：`screen:<id>` 是逐屏独立，`span` 是跨屏拼接，其余按各屏复制。
 * 壁纸窗口只知道后端布置给它的目标 id，据此取该组合的样式 / 过渡能力。
 */
export function displayModeOfTarget(targetId: string): WallpaperDisplayMode {
  if (screenIdOfTarget(targetId) !== null) return "single";
  return targetId === TARGET_SPAN ? "span" : "multiple";
}

/** 后端发给一个壁纸窗口的布置（后端 `WindowAssignment`）：显示哪个目标、出不出声。 */
export interface WallpaperWindowAssignment {
  targetId: string;
  /** false：这个窗口静音（各屏复制时只有主屏窗口出声） */
  audible: boolean;
}

/** 布置变化事件，只发给对应的壁纸窗口，载荷是 `WallpaperWindowAssignment`。 */
export const WALLPAPER_ASSIGNMENT_EVENT = "wallpaper-assignment";

/**
 * 逐屏独立下的默认屏：`defaultScreen` 在线就是它，否则主屏，再不行第一块（与 `activeTargetIds` 同规则）。
 * 没有在线屏时为 null。
 */
export function defaultScreenId(
  screens: readonly WallpaperScreen[],
  defaultScreen: string | null | undefined,
): string | null {
  const wanted = defaultScreen ? screens.find((screen) => screen.id === defaultScreen) : undefined;
  return (wanted ?? screens.find((screen) => screen.primary) ?? screens[0])?.id ?? null;
}

/** 配置还留着、但屏已不在线的逐屏目标 id（按 id 排序，顺序稳定）。 */
export function disconnectedScreenTargets(
  targets: WallpaperTargets | null | undefined,
  screens: readonly WallpaperScreen[],
): string[] {
  const online = new Set(screens.map((screen) => screen.id));
  return Object.keys(targets ?? {})
    .filter((targetId) => {
      const screenId = screenIdOfTarget(targetId);
      return screenId !== null && !online.has(screenId);
    })
    .sort();
}

/** 没有任何字段的目标配置（web 版本地背景、目标尚未落盘时的初值）。 */
export function emptyWallpaperTargetConfig(): WallpaperTargetConfig {
  return { rotationPath: null, rotationPosition: 0, style: {}, transition: {}, currentImageId: null };
}

function isDisplayMode(value: unknown): value is WallpaperDisplayMode {
  return value === "multiple" || value === "span" || value === "single";
}

/**
 * 实际生效的显示器模式：设置里的值在当前壁纸模式下不可用（没列出或带 `unavailable`）就按 `multiple`。
 *
 * @param wanted - 设置 `wallpaperDisplayMode`
 * @param combos - 当前壁纸模式下列出的显示器模式；空数组表示能力表还没读到，此时信设置里的值
 *   （后端切壁纸模式时会把回落后的值写回设置，存下来的值平时就是可用的）。
 */
export function effectiveDisplayMode(wanted: unknown, combos: readonly DisplayModeCapability[]): WallpaperDisplayMode {
  const mode = isDisplayMode(wanted) ? wanted : "multiple";
  if (combos.length === 0) return mode;
  return combos.some((combo) => combo.value === mode && !combo.unavailable) ? mode : "multiple";
}

/**
 * 活跃目标 id，默认目标在前：
 * - `multiple` → `["multiple"]`；`span` → `["span"]`；
 * - `single` → 每块在线屏一个 `screen:<id>`，默认目标是 `defaultScreen` 对应的屏，它不在线或未设置时取主屏，
 *   再不行取第一块；没有屏幕信息时逐屏无从谈起，按 `multiple` 给出。
 */
export function activeTargetIds(
  displayMode: WallpaperDisplayMode,
  screens: readonly WallpaperScreen[],
  defaultScreen: string | null | undefined,
): string[] {
  if (displayMode === "span") return [TARGET_SPAN];
  if (displayMode !== "single" || screens.length === 0) return [TARGET_MULTIPLE];
  const defaultId = defaultScreenId(screens, defaultScreen);
  const defaultIndex = screens.findIndex((screen) => screen.id === defaultId);
  return [
    screenTarget(screens[defaultIndex].id),
    ...screens.filter((_, index) => index !== defaultIndex).map((screen) => screenTarget(screen.id)),
  ];
}

/**
 * 目标里按壁纸模式存的值按能力归一化：在选项里就用它，否则取能力表第一项，选项为空取 `fallback`。
 *
 * @param options - 该组合的样式 / 过渡选项；`undefined` 表示能力表还没读到，此时先用存下来的值，
 *   免得界面在能力表到达前后跳一下。
 */
export function effectiveOption(
  saved: string | null | undefined,
  options: readonly WallpaperOption[] | undefined,
  fallback: string,
): string {
  if (!options) return saved || fallback;
  if (saved && options.some((option) => option.value === saved)) return saved;
  return options[0]?.value ?? fallback;
}

/** 目标在「壁纸模式 × 该组合能力」下的有效样式；`combo` 为空表示能力表还没读到。 */
export function effectiveStyle(
  config: WallpaperTargetConfig | null | undefined,
  wallpaperMode: string,
  combo: DisplayModeCapability | undefined,
): string {
  return effectiveOption(config?.style?.[wallpaperMode], combo?.styles, "fill");
}

/** 目标在「壁纸模式 × 该组合能力」下的有效过渡；`combo` 为空表示能力表还没读到。 */
export function effectiveTransition(
  config: WallpaperTargetConfig | null | undefined,
  wallpaperMode: string,
  combo: DisplayModeCapability | undefined,
): string {
  return effectiveOption(config?.transition?.[wallpaperMode], combo?.transitions, "none");
}
