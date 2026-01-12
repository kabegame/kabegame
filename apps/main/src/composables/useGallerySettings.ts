import { useSettingsStore } from "@kabegame/core/stores/settings";

/**
 * 画廊设置 composable
 */
export function useGallerySettings() {
  const settingsStore = useSettingsStore();

  // 加载设置
  const loadSettings = async () => {
    try {
      // 优先从 store 加载全部设置，确保状态同步
      await settingsStore.loadAll();
    } catch (error) {
      console.error("加载设置失败:", error);
    }
  };

  return {
    loadSettings,
  };
}
