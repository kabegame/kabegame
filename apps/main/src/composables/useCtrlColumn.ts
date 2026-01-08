import { useUiStore } from "@kabegame/core/src/stores/ui";
import { useEventListener } from "@vueuse/core";
import { Ref } from "vue";

export function useCtrlColumn(el: Ref<HTMLElement | null>) {
  const uiStore = useUiStore();

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;

    event.preventDefault();
    const delta = event.deltaY > 0 ? 1 : -1;
    uiStore.adjustImageGridColumn(delta);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.key === "+" || event.key === "=" ? 1 : -1;
    uiStore.adjustImageGridColumn(delta);
  };

  useEventListener(el, "wheel", onWheel, { passive: false });
  useEventListener(el, "keydown", onKeyDown);
}
