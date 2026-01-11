import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type QuickSettingsDrawerStoreOptions<PageId extends string> = {
  /** Pinia store id（各 app 需保持原值不变，避免影响持久化/DevTools 等） */
  storeId: string;
  /** 默认页面 id */
  defaultPageId: PageId;
  /** 标题生成 */
  getTitle: (pageId: PageId) => string;
  /** 默认标题（fallback） */
  defaultTitle?: string;
};

/**
 * QuickSettingsDrawer 的共用 store 工厂
 *
 * - 之所以做成工厂：main / plugin-editor 的 pageId 枚举不同，且 storeId 也不同
 * - 通过 options 保持每个 app 的 storeId 与默认页不变
 */
export function createQuickSettingsDrawerStore<PageId extends string>(
  options: QuickSettingsDrawerStoreOptions<PageId>
) {
  const defaultTitle = options.defaultTitle ?? "设置";

  return defineStore(options.storeId, () => {
    const isOpen = ref(false);
    const pageId = ref<PageId>(options.defaultPageId);

    const title = computed(() => {
      try {
        return options.getTitle(pageId.value) ?? defaultTitle;
      } catch {
        return defaultTitle;
      }
    });

    const open = (p: PageId = options.defaultPageId) => {
      pageId.value = p;
      isOpen.value = true;
    };

    const close = () => {
      isOpen.value = false;
    };

    return { isOpen, pageId, title, open, close };
  });
}
