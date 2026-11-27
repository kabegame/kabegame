import { computed, ref, type Ref } from "vue";
import { invoke } from "@/api/rpc";
import { IS_WEB } from "@/env";
import type { DisplayModeCapability, WallpaperOption } from "@/utils/wallpaperTargets";

export type { DisplayModeCapability, WallpaperOption };

export interface WallpaperCapabilities {
  modes: WallpaperOption[];
  /** 当前桌面下由 Kabegame 自渲染壁纸窗口的模式（window / plasma-plugin / native） */
  renderedMode?: string;
  /** 壁纸模式 → 该模式下列出的显示器模式（含不可用项及原因、各自的样式与过渡） */
  displayModes: Record<string, DisplayModeCapability[]>;
}

const modes: Ref<WallpaperOption[]> = ref([]);
const renderedMode: Ref<string | null> = ref(null);
const displayModes: Ref<Record<string, DisplayModeCapability[]>> = ref({});
let loadPromise: Promise<void> | null = null;

export function isRenderedWallpaperMode(mode: string | null | undefined): boolean {
  if (!mode) return false;
  if (renderedMode.value) return mode === renderedMode.value;
  return mode === "window" || mode === "plasma-plugin";
}

export function useWallpaperCapabilities() {
  const load = async (): Promise<void> => {
    // Web 版没有壁纸后端，也没有这条命令：能力表保持为空
    if (IS_WEB || modes.value.length > 0) return;
    if (!loadPromise) {
      loadPromise = invoke<WallpaperCapabilities>("get_wallpaper_capabilities")
        .then((capabilities) => {
          modes.value = capabilities.modes ?? [];
          renderedMode.value = capabilities.renderedMode ?? null;
          displayModes.value = capabilities.displayModes ?? {};
        })
        .catch((e) => {
          console.warn("[useWallpaperCapabilities] 获取壁纸能力失败:", e);
          modes.value = [];
          renderedMode.value = null;
          displayModes.value = {};
        });
    }
    await loadPromise;
  };

  /** 壁纸模式 `mode` 下列出的显示器模式；能力表还没读到时为空。 */
  const displayModesFor = (mode: string): DisplayModeCapability[] => displayModes.value[mode] ?? [];
  /** 「壁纸模式 × 显示器模式」组合的能力（样式、过渡、是否可用）；没有该组合或能力表还没读到时为 undefined。 */
  const comboFor = (mode: string, display: string): DisplayModeCapability | undefined =>
    displayModesFor(mode).find((combo) => combo.value === display);

  void load();

  return {
    modes: computed(() => modes.value),
    renderedMode: computed(() => renderedMode.value),
    isRenderedMode: isRenderedWallpaperMode,
    displayModes,
    displayModesFor,
    comboFor,
    load,
  };
}
