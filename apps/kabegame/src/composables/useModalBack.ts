import { onBeforeUnmount, watch, type Ref, type WritableComputedRef } from "vue";
import { IS_ANDROID } from "../env";
import { useModalStackStore } from "../stores/modalStack";

/**
 * 将外部维护的弹层 visible ref 接入统一返回栈。
 * 适用于 Element Plus popover 这类不由 `useModal()` 持有开关状态的弹层。
 */
export function useModalBack(visible: Ref<boolean> | WritableComputedRef<boolean>): void {
  if (!IS_ANDROID) return;

  const modalStack = useModalStackStore();
  let slotId: string | null = null;

  const release = () => {
    if (!slotId) return;
    modalStack.release(slotId);
    slotId = null;
  };

  watch(
    visible,
    (open) => {
      if (open && !slotId) {
        slotId = modalStack.acquire(1, () => {
          visible.value = false;
        }).id;
      } else if (!open) {
        release();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(release);
}
