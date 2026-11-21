import { ref, computed } from "vue";
import { invoke } from "@/api/rpc";
import { IS_LINUX } from "@/env";

export type DesktopEnv = "plasma" | "gnome" | "unknown";

/**
 * 运行期获取 Linux 桌面环境（通过后端 get_linux_desktop_env）。
 * 非 Linux 平台返回 "unknown"，isPlasma / isGnome 为 false。
 * 插件模式能不能选只看后端的壁纸能力表（`get_wallpaper_capabilities`）：Plasma 6 会话下列出，切过去时后端自动装 / 升级插件。
 */
export function useDesktop() {
  const desktop = ref<DesktopEnv>("unknown");

  const fetchDesktop = async () => {
    if (!IS_LINUX) return;
    try {
      const value = await invoke<string>("get_linux_desktop_env");
      desktop.value = value as DesktopEnv;
    } catch {
      desktop.value = "unknown";
    }
  };

  // 立即发起请求，不等到 onMounted，以便首屏尽量拿到正确值
  fetchDesktop();

  const isPlasma = computed(() => desktop.value === "plasma");
  const isGnome = computed(() => desktop.value === "gnome");

  return {
    desktop,
    isPlasma,
    isGnome,
    refresh: fetchDesktop,
  };
}
