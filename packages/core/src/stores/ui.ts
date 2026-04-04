import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { useThrottleFn } from "@vueuse/core";
import { IS_ANDROID } from "../env";
import { useSettingsStore } from "./settings";

export const useUiStore = defineStore("ui", () => {
  // 壁纸模式切换是跨多个设置项的共享状态（切换过程中需要禁用样式/过渡等控件）
  const wallpaperModeSwitching = ref(false);
  // 全局维护一个列数状态，用于控制图片网格的列数
  // Android 下固定为 2 列；桌面最大 4 列
  const imageGridColumns = ref(IS_ANDROID ? 2 : 4);
  const settingsStore = useSettingsStore();

  const clampDesktopColumns = (value: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 4;
    return Math.min(4, Math.max(1, Math.round(n)));
  };

  const adjustImageGridColumn = useThrottleFn((delta: number) => {
    // Android 下不允许调整列数
    if (IS_ANDROID) return;
    // 固定列数模式（1-4）下，忽略快捷键/滚轮调整
    if ((settingsStore.values.galleryGridColumns ?? 0) > 0) return;
    
    if (delta > 0) {
      // 增加列数（最大 4 列）
      if (imageGridColumns.value < 4) {
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
      if (IS_ANDROID) return;
      // 仅固定列数模式时强制覆盖当前列数；动态模式保持用户当前值
      if (typeof v === "number" && v > 0) {
        imageGridColumns.value = clampDesktopColumns(v);
      }
    },
    { immediate: true }
  );

  return {
    wallpaperModeSwitching,
    imageGridColumns,
    adjustImageGridColumn,
  };
});


