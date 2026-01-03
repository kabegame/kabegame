import { ref, computed, watch } from "vue";
import { useCrawlerStore } from "@/stores/crawler";
import { useSettingsStore } from "@/stores/settings";

/**
 * 画廊设置 composable
 */
export function useGallerySettings() {
  const crawlerStore = useCrawlerStore();
  const settingsStore = useSettingsStore();

  const imageClickAction = computed(() => {
    const action = settingsStore.values.imageClickAction;
    return (action === "open" ? "open" : "preview") as "preview" | "open";
  });

  const galleryImageAspectRatioMatchWindow = ref<boolean>(false); // 图片宽高比是否与窗口相同
  const windowAspectRatio = ref<number>(16 / 9); // 窗口宽高比

  watch(
    () => settingsStore.values.galleryImageAspectRatioMatchWindow,
    (v) => {
      if (v !== undefined) galleryImageAspectRatioMatchWindow.value = v;
    }
  );

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
      galleryImageAspectRatioMatchWindow.value =
        settings.galleryImageAspectRatioMatchWindow || false;
      if (settings.galleryPageSize && settings.galleryPageSize > 0) {
        crawlerStore.setPageSize(settings.galleryPageSize);
      }
    } catch (error) {
      console.error("加载设置失败:", error);
    }
  };

  // 更新窗口宽高比
  const updateWindowAspectRatio = () => {
    windowAspectRatio.value = window.innerWidth / window.innerHeight;
  };

  // 监听窗口大小变化
  const handleResize = () => {
    updateWindowAspectRatio();
  };

  return {
    imageClickAction,
    galleryImageAspectRatioMatchWindow,
    windowAspectRatio,
    loadSettings,
    updateWindowAspectRatio,
    handleResize,
  };
}
