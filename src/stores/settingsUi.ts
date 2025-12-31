import { defineStore } from "pinia";
import { ref } from "vue";

export const useSettingsUiStore = defineStore("settingsUi", () => {
  // 壁纸模式切换是跨多个设置项的共享状态（切换过程中需要禁用样式/过渡等控件）
  const wallpaperModeSwitching = ref(false);

  return { wallpaperModeSwitching };
});
