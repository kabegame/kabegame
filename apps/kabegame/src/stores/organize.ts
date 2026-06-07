import { defineStore } from "pinia";
import { ref } from "vue";

/** 与 OrganizeDialog 的 confirm 载荷 / 后端 start_organize 参数一致 */
export interface OrganizeOptions {
  dedupe: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  deleteSourceFiles: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/**
 * 整理（Organize）对话框的跨组件桥：
 * - 触发按钮 + 进度 popover + 事件监听仍由 header 的 OrganizeHeaderControl 承载；
 * - 对话框本体渲染在 Gallery.vue。
 * header 通过 openDialog 打开对话框；Gallery 确认后通过 requestStart 把参数回传，
 * header 监听 pendingOptions 并真正启动整理。
 */
export const useOrganizeStore = defineStore("organize", () => {
  /** 整理对话框开关 */
  const dialogOpen = ref(false);
  /** 待启动的整理参数：Gallery 确认后写入，header 消费后清空 */
  const pendingOptions = ref<OrganizeOptions | null>(null);

  const openDialog = () => {
    dialogOpen.value = true;
  };
  const closeDialog = () => {
    dialogOpen.value = false;
  };

  /** Gallery 确认整理：回传参数给 header 启动 */
  const requestStart = (options: OrganizeOptions) => {
    pendingOptions.value = { ...options };
  };

  /** header 消费待启动参数（取出并清空） */
  const consumeStart = (): OrganizeOptions | null => {
    const o = pendingOptions.value;
    pendingOptions.value = null;
    return o;
  };

  return { dialogOpen, pendingOptions, openDialog, closeDialog, requestStart, consumeStart };
});
