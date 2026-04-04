import { watch, onBeforeUnmount, isReadonly, type Ref, type WritableComputedRef, type ComputedRef } from 'vue';
import { useModalStackStore } from '../stores/modalStack';
import { IS_ANDROID } from '../env';

export interface UseModalBackOptions {
  /** Called when the ref becomes true (after pushing to stack) */
  onOpen?: () => void;
  /** Called when the ref becomes false (before removing from stack) */
  onClose?: () => void;
}

/**
 * Composable for managing modal back button behavior on Android.
 * When the provided ref is true, pushes a function to modalStack.
 * When the ref becomes false, removes the function from the stack.
 *
 * @param isOpen - A ref, writable computed ref, or readonly computed ref that tracks whether the modal is open
 * @param options - Optional callbacks when the ref becomes true or false
 */
export function useModalBack(
  isOpen: Ref<boolean> | WritableComputedRef<boolean> | ComputedRef<boolean>,
  options?: UseModalBackOptions
) {
  if (!IS_ANDROID) return;

  const { onOpen, onClose } = options ?? {};
  const modalStack = useModalStackStore();
  let stackId: string | null = null;

  watch(
    isOpen,
    (val) => {
      if (val) {
        stackId = modalStack.push(() => {
          // 对于只读 computed，不设置值，只执行 onClose
          // 对于可写 ref，先设置为 false，再执行 onClose（以便 watch 能收到 false 并从栈中移除）
          if (!isReadonly(isOpen)) {
            (isOpen as Ref<boolean>).value = false;
          }
          onClose?.();
        });
        onOpen?.();
      } else {
        onClose?.();
        if (stackId) {
          modalStack.remove(stackId);
          stackId = null;
        }
      }
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    if (stackId) {
      modalStack.remove(stackId);
      stackId = null;
    }
  });
}
