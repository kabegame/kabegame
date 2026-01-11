import type { Ref } from "vue";
import { watch } from "vue";
import { enableDragScroll, type DragScrollOptions } from "../utils/dragScroll";

export interface UseDragScrollOptions {
  /**
   * 限制拖拽滚动的最大速度（px/ms）。
   * - 可以是固定数值，也可以是返回数值的函数（支持动态行高等场景）
   * - 例如：每 0.2 秒滚动一行 => maxVelocityPxPerMs = () => rowHeight / 200
   */
  maxVelocityPxPerMs?: DragScrollOptions["maxVelocityPxPerMs"];
}

export function useDragScroll(
  container: Ref<HTMLElement | null>,
  options?: UseDragScrollOptions
) {
  let dropScroll: (() => void) | null = null;
  watch(
    container,
    (newVal) => {
      if (dropScroll) {
        dropScroll();
        dropScroll = null;
      }
      if (newVal) {
        dropScroll = enableDragScroll(newVal, {
          requireSpaceKey: false,
          enableForPointerTypes: ["mouse", "pen"],
          ignoreSelector:
            "a,button,input,textarea,select,label,[contenteditable='true']," +
            ".page-header,.el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box",
          maxVelocityPxPerMs: options?.maxVelocityPxPerMs,
        });
      }
    },
    { immediate: true, flush: "post" }
  );
}
