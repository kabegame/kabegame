import { watch } from "vue";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@kabegame/core/src/stores/settings";

/**
 * 画廊设置 composable
 */
export function useGallerySettings() {
  const crawlerStore = useCrawlerStore();
  const settingsStore = useSettingsStore();

  // 监听 galleryPageSize 的变化，实时同步到 crawlerStore
  watch(
    () => settingsStore.values.galleryPageSize,
    (v) => {
      if (v !== undefined && v > 0) {
        crawlerStore.setPageSize(v);
      }
    },
    { immediate: true }
  );

  // 加载设置
  const loadSettings = async () => {
    try {
      // 优先从 store 加载全部设置，确保状态同步
      await settingsStore.loadAll();

      const settings = settingsStore.values;
      if (settings.galleryPageSize && settings.galleryPageSize > 0) {
        crawlerStore.setPageSize(settings.galleryPageSize);
      }
    } catch (error) {
      console.error("加载设置失败:", error);
    }
  };

  return {
    loadSettings,
  };
}
