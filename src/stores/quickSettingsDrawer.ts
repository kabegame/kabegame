import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type QuickSettingsPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "pluginbrowser"
  | "settings";

export const useQuickSettingsDrawerStore = defineStore(
  "quickSettingsDrawer",
  () => {
    const isOpen = ref(false);
    const pageId = ref<QuickSettingsPageId>("gallery");

    const title = computed(() => {
      switch (pageId.value) {
        case "gallery":
          return "画廊设置";
        case "albumdetail":
          return "画册设置";
        case "albums":
          return "画册列表设置";
        case "pluginbrowser":
          return "源管理设置";
        case "settings":
          return "设置";
        default:
          return "设置";
      }
    });

    const open = (p: QuickSettingsPageId) => {
      pageId.value = p;
      isOpen.value = true;
    };

    const close = () => {
      isOpen.value = false;
    };

    return { isOpen, pageId, title, open, close };
  }
);
