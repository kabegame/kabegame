import { computed, unref, type ComputedRef, type MaybeRef } from "vue";
import { i18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { IS_WEB } from "@/env";
import { useSettingsStore } from "@/stores/settings";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import { useWallpaperScreens } from "@/composables/useWallpaperScreens";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import {
  activeTargetIds,
  effectiveDisplayMode,
  effectiveStyle,
  effectiveTransition,
  screenIdOfTarget,
  type DisplayModeCapability,
  type WallpaperDisplayMode,
  type WallpaperTargetConfig,
} from "@/utils/wallpaperTargets";

/**
 * 壁纸目标的前端读写入口。
 *
 * 目标配置只有一份真值：`settingsStore.values.wallpaperTargets`（后端每次写入发一次
 * `setting-change { wallpaperTargets }`，值是整个 map）。这里只做两件事：按「显示器模式 × 在线屏」算出
 * 活跃目标与默认目标（与后端控制器同规则，见 `utils/wallpaperTargets.ts`），以及把写操作转给已有命令。
 * 写入不做本地乐观副本，等后端事件落地。
 */

interface WallpaperLayout {
  wallpaperMode: string;
  displayMode: WallpaperDisplayMode;
  /** 活跃目标 id，默认目标在前 */
  targetIds: string[];
  /** 当前「壁纸模式 × 显示器模式」的能力；能力表还没读到时为 undefined */
  combo: DisplayModeCapability | undefined;
}

type SettingsStore = ReturnType<typeof useSettingsStore>;
type Capabilities = ReturnType<typeof useWallpaperCapabilities>;
type Screens = ReturnType<typeof useWallpaperScreens>;

/**
 * 按设置、能力表与在线屏算当前布局；读的都是响应式源，放进 computed 即随之更新
 * （在线屏随 `wallpaper-screens-change` 变，见 `useWallpaperScreens`）。
 */
function readLayout(settingsStore: SettingsStore, capabilities: Capabilities, screens: Screens): WallpaperLayout {
  const wallpaperMode = settingsStore.values.wallpaperMode || "native";
  const displayMode = effectiveDisplayMode(
    settingsStore.values.wallpaperDisplayMode,
    capabilities.displayModesFor(wallpaperMode),
  );
  return {
    wallpaperMode,
    displayMode,
    targetIds: activeTargetIds(displayMode, screens.value, settingsStore.values.wallpaperDefaultScreen),
    combo: capabilities.comboFor(wallpaperMode, displayMode),
  };
}

function useWallpaperLayout(): { settingsStore: SettingsStore; layout: ComputedRef<WallpaperLayout> } {
  const settingsStore = useSettingsStore();
  const capabilities = useWallpaperCapabilities();
  const screens = useWallpaperScreens();
  return { settingsStore, layout: computed(() => readLayout(settingsStore, capabilities, screens)) };
}

/** 一个活跃目标的轮播来源。 */
export interface WallpaperRotationSource {
  targetId: string;
  /** 轮播路径；null 表示还没设置（默认全画廊随机路径） */
  path: string | null;
}

function rotationSourcesOf(settingsStore: SettingsStore, targetIds: readonly string[]): WallpaperRotationSource[] {
  const targets = settingsStore.values.wallpaperTargets;
  return targetIds.map((targetId) => ({ targetId, path: targets?.[targetId]?.rotationPath || null }));
}

function rotationPathsOf(settingsStore: SettingsStore, targetIds: readonly string[]): string[] {
  return rotationSourcesOf(settingsStore, targetIds)
    .map((source) => source.path)
    .filter((path): path is string => !!path);
}

/**
 * 写一个壁纸目标：发已有命令，成功返回 true；值由后端的 `setting-change` 落地，这里不改本地值。
 * Web 版没有壁纸后端，拦下并提示桌面版，返回 false（与只读设置键的 `set` 同一约定）。
 *
 * @param target - 目标 id；为空时不带 `target`，由后端落到默认目标。
 */
async function writeTarget(
  featureKey: string,
  command: string,
  args: Record<string, unknown>,
  target: string | null | undefined,
): Promise<boolean> {
  if (IS_WEB) {
    void guardDesktopOnly(featureKey);
    return false;
  }
  await invoke<void>(command, target ? { ...args, target } : args);
  return true;
}

/**
 * 换一个目标的轮播路径（空串 = 默认全画廊随机路径）；路径变了后端会立刻把这个目标切到新路径的第 1 张。
 * 给先经 `pickWallpaperTarget` 选了目标的入口用；绑定在某个目标上的界面用 `useWallpaperTarget(id).setRotationPath`。
 *
 * @returns 是否已发出（Web 版被拦下时为 false）。
 */
export function setWallpaperRotationPath(path: string, target?: string | null): Promise<boolean> {
  return writeTarget("wallpaperRotation", "set_wallpaper_rotation_path", { path }, target);
}

/**
 * 一个壁纸目标的配置与写操作。
 *
 * @param targetId - 目标 id；缺省 = 默认目标（由显示器模式、默认屏与在线屏算出）。缺省时写命令不带
 *   `target`，由后端自己落到默认目标，前端算出的 id 只用来读配置。
 * @returns 目标的配置、按能力归一化后的样式 / 过渡，以及写操作（返回是否已发出）。
 *
 * @example
 * ```ts
 * const target = useWallpaperTarget();
 * target.currentImageId.value; // 默认目标的当前壁纸
 * await target.setStyle("fit");
 * ```
 */
export function useWallpaperTarget(targetId?: MaybeRef<string | null | undefined>) {
  const { settingsStore, layout } = useWallpaperLayout();

  const explicitId = computed(() => unref(targetId) || null);
  const id = computed(() => explicitId.value ?? layout.value.targetIds[0]);
  const config = computed<WallpaperTargetConfig | null>(
    () => settingsStore.values.wallpaperTargets?.[id.value] ?? null,
  );
  /** 写操作见 `writeTarget`；没指定目标时不带 `target`。 */
  const write = (featureKey: string, command: string, args: Record<string, unknown>) =>
    writeTarget(featureKey, command, args, explicitId.value);

  return {
    id,
    config,
    /** 当前壁纸模式下按能力归一化后的样式 / 过渡（规则同后端，不写回） */
    style: computed(() => effectiveStyle(config.value, layout.value.wallpaperMode, layout.value.combo)),
    transition: computed(() => effectiveTransition(config.value, layout.value.wallpaperMode, layout.value.combo)),
    /** 当前「壁纸模式 × 显示器模式」的能力：样式 / 过渡选项从这里取 */
    combo: computed(() => layout.value.combo),
    currentImageId: computed(() => config.value?.currentImageId ?? null),
    /** 轮播来源路径；null 表示默认全画廊随机路径 */
    rotationPath: computed(() => config.value?.rotationPath ?? null),
    /** 目标配置还在随设置首次加载 */
    loading: computed(() => settingsStore.isLoading("wallpaperTargets")),
    /** 换轮播路径（空串 = 默认全画廊随机路径）；路径变了后端会立刻把这个目标切到新路径的第 1 张 */
    setRotationPath: (path: string) => write("wallpaperRotation", "set_wallpaper_rotation_path", { path }),
    setStyle: (style: string) => write("wallpaper", "set_wallpaper_style", { style }),
    setTransition: (transition: string) =>
      write("wallpaperRotation", "set_wallpaper_rotation_transition", { transition }),
  };
}

/** 实际生效的显示器模式：设置里的值在当前壁纸模式下不可用时按 `multiple`（与后端同规则）。 */
export function useWallpaperDisplayMode(): ComputedRef<WallpaperDisplayMode> {
  const { layout } = useWallpaperLayout();
  return computed(() => layout.value.displayMode);
}

/** 当前显示器模式下的活跃目标 id（与后端布局同规则：在线屏 × 显示器模式），默认目标在前。 */
export function useActiveWallpaperTargets(): ComputedRef<string[]> {
  const { layout } = useWallpaperLayout();
  return computed(() => layout.value.targetIds);
}

/** `useActiveWallpaperTargets` 的即时快照，给不在组件里的调用点用（同一份计算）。 */
export function activeWallpaperTargets(): string[] {
  return readLayout(useSettingsStore(), useWallpaperCapabilities(), useWallpaperScreens()).targetIds;
}

/**
 * 逐屏目标所在屏的显示名：屏的名字，没有名字时是「显示器 N」（N 与布局图上的序号相同）。
 * 不是逐屏目标（`multiple` / `span`）、或那块屏不在线时为 null。读的是响应式的在线屏，可以放进 computed。
 */
export function wallpaperTargetScreenName(targetId: string): string | null {
  const screenId = screenIdOfTarget(targetId);
  if (screenId === null) return null;
  const screens = useWallpaperScreens().value;
  const index = screens.findIndex((screen) => screen.id === screenId);
  if (index < 0) return null;
  return screens[index].name || i18n.global.t("settings.screenNumbered", { n: index + 1 });
}

/** 所有活跃目标的当前壁纸 id。 */
export function useActiveWallpaperImageIds(): ComputedRef<Set<string>> {
  const { settingsStore, layout } = useWallpaperLayout();
  return computed(() => {
    const targets = settingsStore.values.wallpaperTargets;
    const ids = new Set<string>();
    for (const id of layout.value.targetIds) {
      const imageId = targets?.[id]?.currentImageId;
      if (imageId) ids.add(imageId);
    }
    return ids;
  });
}

/**
 * 每个活跃目标的轮播来源，与 `useActiveWallpaperTargets` 同序（没设置路径的目标也在，`path` 为 null）。
 * 「是不是每块屏都已经在轮播它」这类判断要用它；只问「有没有哪块屏在轮播它」用 `useActiveWallpaperRotationPaths`。
 */
export function useWallpaperRotationSources(): ComputedRef<WallpaperRotationSource[]> {
  const { settingsStore, layout } = useWallpaperLayout();
  return computed(() => rotationSourcesOf(settingsStore, layout.value.targetIds));
}

/** 所有活跃目标各自的轮播路径（未设置的不算）：轮播来源标记按「任一命中」判断。 */
export function useActiveWallpaperRotationPaths(): ComputedRef<string[]> {
  const { settingsStore, layout } = useWallpaperLayout();
  return computed(() => rotationPathsOf(settingsStore, layout.value.targetIds));
}

/** `useActiveWallpaperRotationPaths` 的即时快照，给不在组件里的调用点用（同一份计算）。 */
export function activeWallpaperRotationPaths(): string[] {
  return rotationPathsOf(useSettingsStore(), activeWallpaperTargets());
}
