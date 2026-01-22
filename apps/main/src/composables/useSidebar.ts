import { ref, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * 侧边栏 composable
 * 处理侧边栏折叠和 Windows DWM 毛玻璃效果
 */
export function useSidebar() {
  const isCollapsed = ref(false);

  const toggleCollapse = () => {
    isCollapsed.value = !isCollapsed.value;
  };

  // Windows DWM 毛玻璃：通知后端把 blur region 设为侧栏宽度
  const updateSidebarDwmBlur = async () => {
    // 非 Tauri 环境直接跳过
    try {
      await invoke("set_main_sidebar_blur", { sidebarWidth: isCollapsed.value ? 64 : 200 });
    } catch (e) {
      // 之前这里吞掉错误会导致"没效果也没报错"，所以至少在控制台给个提示
      console.warn("set_main_sidebar_blur failed:", e);
    }
  };

  watch(isCollapsed, () => {
    void updateSidebarDwmBlur();
  });

  const init = () => {
    // 首次进入时设置一次；后续折叠/窗口 resize 再更新
    void updateSidebarDwmBlur();
    // WebView/窗口初始化可能有时序问题，再延迟补一次，提升稳定性
    window.setTimeout(() => void updateSidebarDwmBlur(), 500);
    window.addEventListener("resize", updateSidebarDwmBlur, { passive: true });
  };

  const cleanup = () => {
    window.removeEventListener("resize", updateSidebarDwmBlur);
  };

  onMounted(() => {
    init();
  });

  onUnmounted(() => {
    cleanup();
  });

  return {
    isCollapsed,
    toggleCollapse,
  };
}
