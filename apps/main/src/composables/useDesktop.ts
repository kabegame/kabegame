import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { IS_LINUX } from "@kabegame/core/env";

export type DesktopEnv = "plasma" | "gnome" | "unknown";

/**
 * 运行期获取 Linux 桌面环境（通过后端 get_linux_desktop_env）。
 * 非 Linux 平台返回 "unknown"，isPlasma / isGnome 为 false。
 * isPlasmaPluginAvailable：仅当桌面为 Plasma 且已安装 Kabegame 壁纸插件时为 true，用于控制是否展示「插件模式」选项。
 */
export function useDesktop() {
  const desktop = ref<DesktopEnv>("unknown");
  const plasmaPluginInstalled = ref(false);

  const fetchDesktop = async () => {
    if (!IS_LINUX) return;
    try {
      const value = await invoke<string>("get_linux_desktop_env");
      desktop.value = value as DesktopEnv;
    } catch {
      desktop.value = "unknown";
    }
  };

  const fetchPlasmaPluginInstalled = async () => {
    if (!IS_LINUX) return;
    try {
      plasmaPluginInstalled.value = await invoke<boolean>("is_plasma_wallpaper_plugin_installed");
    } catch {
      plasmaPluginInstalled.value = false;
    }
  };

  const refresh = async () => {
    await fetchDesktop();
    await fetchPlasmaPluginInstalled();
  };

  // 立即发起请求，不等到 onMounted，以便首屏尽量拿到正确值
  fetchDesktop();
  fetchPlasmaPluginInstalled();

  const isPlasma = computed(() => desktop.value === "plasma");
  const isGnome = computed(() => desktop.value === "gnome");
  /** 仅当 Plasma 且已安装 Kabegame 壁纸插件时为 true，用于壁纸模式中的「插件」选项 */
  const isPlasmaPluginAvailable = computed(() => isPlasma.value && plasmaPluginInstalled.value);

  return {
    desktop,
    isPlasma,
    isGnome,
    isPlasmaPluginAvailable,
    refresh,
  };
}
