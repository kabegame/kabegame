import { enableDragScroll } from "@/utils/dragScroll";
import { Ref, watch } from "vue";

export function useDragScroll(container: Ref<HTMLElement | null>) {
  let dropScroll: (() => void) | null = null;
  watch(
    container,
    (newVal) => {
      console.log("[拖拽滚动调试] useDragScroll watch 触发", { hasContainer: !!newVal, containerTag: newVal?.tagName, containerClass: newVal?.className });
      if (dropScroll) {
        console.log("[拖拽滚动调试] 清理旧的拖拽滚动");
        dropScroll();
        dropScroll = null;
      }
      if (newVal) {
        console.log("[拖拽滚动调试] 启用拖拽滚动", {
          container: newVal,
          scrollHeight: newVal.scrollHeight,
          clientHeight: newVal.clientHeight,
          scrollTop: newVal.scrollTop,
        });
        dropScroll = enableDragScroll(newVal, {
          requireSpaceKey: false,
          enableForPointerTypes: ["mouse", "pen"],
          ignoreSelector:
            "a,button,input,textarea,select,label,[contenteditable='true']," +
            ".page-header,.el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box",
        });
        console.log("[拖拽滚动调试] 拖拽滚动已启用");
      } else {
        console.log("[拖拽滚动调试] 容器为空，跳过启用");
      }
    },
    { immediate: true, flush: "post" }
  );
}
