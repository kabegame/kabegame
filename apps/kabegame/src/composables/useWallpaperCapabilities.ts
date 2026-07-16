import { computed, ref, type Ref } from "vue";
import { invoke } from "@/api/rpc";

export interface WallpaperOption {
  value: string;
  label: Record<string, string>;
  desc: Record<string, string>;
}

export interface WallpaperCapabilities {
  modes: WallpaperOption[];
  styles: Record<string, WallpaperOption[]>;
  transitions: Record<string, WallpaperOption[]>;
}

const modes: Ref<WallpaperOption[]> = ref([]);
const styles: Ref<Record<string, WallpaperOption[]>> = ref({});
const transitions: Ref<Record<string, WallpaperOption[]>> = ref({});
let loadPromise: Promise<void> | null = null;

export function useWallpaperCapabilities() {
  const load = async (): Promise<void> => {
    if (modes.value.length > 0) return;
    if (!loadPromise) {
      loadPromise = invoke<WallpaperCapabilities>("get_wallpaper_capabilities")
        .then((capabilities) => {
          modes.value = capabilities.modes ?? [];
          styles.value = capabilities.styles ?? {};
          transitions.value = capabilities.transitions ?? {};
        })
        .catch((e) => {
          console.warn("[useWallpaperCapabilities] 获取壁纸能力失败:", e);
          modes.value = [];
          styles.value = {};
          transitions.value = {};
        });
    }
    await loadPromise;
  };

  const stylesFor = (mode: string): WallpaperOption[] => styles.value[mode] ?? [];
  const transitionsFor = (mode: string): WallpaperOption[] => transitions.value[mode] ?? [];

  void load();

  return {
    modes: computed(() => modes.value),
    styles,
    transitions,
    stylesFor,
    transitionsFor,
    load,
  };
}
