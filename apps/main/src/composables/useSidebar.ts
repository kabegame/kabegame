import { ref } from "vue";

/**
 * 侧边栏 composable
 * 处理侧边栏折叠。毛玻璃在窗口创建时通过 tauri.conf 的 windowEffects 设置，无需在此处调用。
 */
export function useSidebar() {
  const isCollapsed = ref(false);

  const toggleCollapse = () => {
    isCollapsed.value = !isCollapsed.value;
  };

  return {
    isCollapsed,
    toggleCollapse,
  };
}
