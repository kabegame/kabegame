import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useThrottleFn, useWindowSize } from "@vueuse/core";
import { IS_ANDROID, COMPACT_BREAKPOINT, IS_WEB } from "../env";
import { useSettingsStore } from "./settings";

export const useUiStore = defineStore("ui", () => {
  // 壁纸模式切换是跨多个设置项的共享状态（切换过程中需要禁用样式/过渡等控件）
  const wallpaperModeSwitching = ref(false);

  // 单例紧凑布局信号：Android 恒紧凑；其余平台跟随视口宽度（Tauri 桌面缩窗至 <768 也响应）。
  // 所有组件从 useUiStore().isCompact 读取，避免每组件独立订阅 resize。
  const { width: viewportWidth } = useWindowSize();
  const isCompact = computed(
    () => IS_ANDROID || IS_WEB && viewportWidth.value < COMPACT_BREAKPOINT
  );

  // 全局维护一个列数状态，用于控制图片网格的列数
  // 紧凑布局下固定为 2 列；桌面最大 6 列
  const imageGridColumns = ref(isCompact.value ? 2 : 4);
  const settingsStore = useSettingsStore();

  const clampDesktopColumns = (value: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 4;
    return Math.min(6, Math.max(1, Math.round(n)));
  };

  const adjustImageGridColumn = useThrottleFn((delta: number) => {
    // 紧凑布局下不允许调整列数
    if (isCompact.value) return;
    // 固定列数模式（1-6）下，忽略快捷键/滚轮调整
    if ((settingsStore.values.galleryGridColumns ?? 0) > 0) return;

    if (delta > 0) {
      // 增加列数（最大 6 列）
      if (imageGridColumns.value < 6) {
        imageGridColumns.value++;
      }
    } else {
      // 减少列数（最小 1 列）
      if (imageGridColumns.value > 1) {
        imageGridColumns.value--;
      }
    }
  }, 100);

  watch(
    () => settingsStore.values.galleryGridColumns,
    (v) => {
      if (isCompact.value) return;
      // 仅固定列数模式时强制覆盖当前列数；动态模式保持用户当前值
      if (typeof v === "number" && v > 0) {
        imageGridColumns.value = clampDesktopColumns(v);
      }
    },
    { immediate: true }
  );

  // web mode 视口从宽屏切到紧凑时，强制把列数夹到 2；反之恢复到 settings 或默认 4
  watch(isCompact, (compact) => {
    if (compact) {
      if (imageGridColumns.value > 2) imageGridColumns.value = 2;
    } else {
      const v = settingsStore.values.galleryGridColumns;
      imageGridColumns.value =
        typeof v === "number" && v > 0 ? clampDesktopColumns(v) : 4;
    }
  });

  return {
    wallpaperModeSwitching,
    imageGridColumns,
    adjustImageGridColumn,
    isCompact,
  };
});


