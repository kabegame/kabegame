import { ref, computed, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
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

  const galleryColumns = ref<number>(0); // 0 表示自动（auto-fill），其他值表示固定列数
  const galleryImageAspectRatioMatchWindow = ref<boolean>(false); // 图片宽高比是否与窗口相同
  const windowAspectRatio = ref<number>(16 / 9); // 窗口宽高比

  // 监听 store 变化，同步到本地 ref
  watch(
    () => settingsStore.values.galleryColumns,
    (v) => {
      if (v !== undefined) galleryColumns.value = v;
    }
  );

  watch(
    () => settingsStore.values.galleryImageAspectRatioMatchWindow,
    (v) => {
      if (v !== undefined) galleryImageAspectRatioMatchWindow.value = v;
    }
  );

  // 加载设置
  const loadSettings = async () => {
    try {
      // 优先从 store 加载全部设置，确保状态同步
      await settingsStore.loadAll();

      const settings = settingsStore.values;
      galleryColumns.value = settings.galleryColumns || 0;
      galleryImageAspectRatioMatchWindow.value = settings.galleryImageAspectRatioMatchWindow || false;
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

  // 调整列数的函数
  const adjustColumns = (delta: number) => {
    if (delta > 0) {
      // 增加列数（最大 10 列）
      if (galleryColumns.value === 0) {
        // 如果当前是自动，设置为 5 列
        galleryColumns.value = 5;
      } else if (galleryColumns.value < 10) {
        galleryColumns.value++;
      }
    } else {
      // 减少列数（最小 1 列，0 表示自动）
      if (galleryColumns.value > 1) {
        galleryColumns.value--;
      } else if (galleryColumns.value === 1) {
        // 从 1 列变为自动
        galleryColumns.value = 0;
      }
    }
    // 同步到 store
    settingsStore.values.galleryColumns = galleryColumns.value;
    // 保存设置
    invoke("set_gallery_columns", { columns: galleryColumns.value }).catch((error) => {
      console.error("保存列数设置失败:", error);
    });
  };

  // 节流函数
  const throttle = <T extends (...args: any[]) => any>(func: T, delay: number): T => {
    let lastCall = 0;
    return ((...args: any[]) => {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return func(...args);
      }
    }) as T;
  };

  // 节流后的调整列数函数（100ms 节流）
  const throttledAdjustColumns = throttle(adjustColumns, 100);

  return {
    imageClickAction,
    galleryColumns,
    galleryImageAspectRatioMatchWindow,
    windowAspectRatio,
    loadSettings,
    updateWindowAspectRatio,
    handleResize,
    adjustColumns,
    throttledAdjustColumns,
  };
}

