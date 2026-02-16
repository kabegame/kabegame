import { defineStore } from "pinia";
import { ref } from "vue";
import { useThrottleFn } from "@vueuse/core";
import { IS_ANDROID } from "../env";

export const useUiStore = defineStore("ui", () => {
  // 壁纸模式切换是跨多个设置项的共享状态（切换过程中需要禁用样式/过渡等控件）
  const wallpaperModeSwitching = ref(false);
  // 全局维护一个列数状态，用于控制图片网格的列数
  // Android 下固定为 2 列
  const imageGridColumns = ref(IS_ANDROID ? 2 : 5);

  const adjustImageGridColumn = useThrottleFn((delta: number) => {
    // Android 下不允许调整列数
    if (IS_ANDROID) return;
    
    if (delta > 0) {
      // 增加列数（最大 10 列）
      if (imageGridColumns.value < 10) {
        imageGridColumns.value++;
      }
    } else {
      // 减少列数（最小 1 列）
      if (imageGridColumns.value > 1) {
        imageGridColumns.value--;
      }
    }
  }, 100);

  return {
    wallpaperModeSwitching,
    imageGridColumns,
    adjustImageGridColumn,
  };
});


