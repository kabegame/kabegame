import { ref, computed, onBeforeUnmount, type ComputedRef } from 'vue';
import { useModalStackStore } from '../stores/modalStack';

export interface UseModalOptions {
  onOpen?: () => void;
  onClose?: () => void;
  /** Reserve N consecutive z-index layers. Default 1. */
  layers?: number;
}

export interface UseModalReturn {
  /** Readonly computed — mutate only via open()/close(). */
  readonly isOpen: ComputedRef<boolean>;
  /** Base z-index for this modal. Additional layers: zIndex.value + 10, + 20, etc. */
  readonly zIndex: ComputedRef<number>;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export function useModal(options: UseModalOptions = {}): UseModalReturn {
  const { onOpen, onClose, layers = 1 } = options;

  const _isOpen = ref(false);
  const _zIndex = ref(0);
  const isOpen: ComputedRef<boolean> = computed(() => _isOpen.value);
  const zIndex: ComputedRef<number> = computed(() => _zIndex.value);

  const store = useModalStackStore();
  let slotId: string | null = null;

  function open() {
    if (_isOpen.value) return;
    const { id, zIndex: z } = store.acquire(layers, close);
    slotId = id;
    _zIndex.value = z;
    _isOpen.value = true;
    onOpen?.();
  }

  function close() {
    if (!_isOpen.value) return;
    _isOpen.value = false;
    if (slotId) {
      store.release(slotId);
      slotId = null;
    }
    onClose?.();
  }

  function toggle() {
    _isOpen.value ? close() : open();
  }

  onBeforeUnmount(() => {
    if (slotId) {
      store.release(slotId);
      slotId = null;
    }
  });

  return { isOpen, zIndex, open, close, toggle };
}
