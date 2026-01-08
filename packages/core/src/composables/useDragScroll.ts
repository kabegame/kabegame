import type { Ref } from "vue";
import { watch } from "vue";
import { enableDragScroll } from "../utils/dragScroll";

export function useDragScroll(container: Ref<HTMLElement | null>) {
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
        });
      }
    },
    { immediate: true, flush: "post" }
  );
}
