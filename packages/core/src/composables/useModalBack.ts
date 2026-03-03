import { watch, onBeforeUnmount, type Ref, type WritableComputedRef } from 'vue';
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
 * When the provided ref is true, pushes a function to modalStack that sets it to false.
 * When the ref becomes false, removes the function from the stack.
 *
 * @param isOpen - A ref or writable computed ref that tracks whether the modal is open
 * @param options - Optional callbacks when the ref becomes true or false
 */
export function useModalBack(
  isOpen: Ref<boolean> | WritableComputedRef<boolean>,
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
          isOpen.value = false;
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
