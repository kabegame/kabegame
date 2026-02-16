import { ref, type Ref } from "vue";

export interface ActionMenuContext<T> {
  target: T | null;
}

export interface UseActionMenuOptions<T> {
  /** Optional: called when a command is emitted (parent can also use @command on ActionRenderer) */
  onCommand?: (command: string, context: ActionMenuContext<T>) => void;
}

export interface UseActionMenuReturn<T> {
  visible: Ref<boolean>;
  position: Ref<{ x: number; y: number }>;
  context: Ref<ActionMenuContext<T>>;
  show: (target: T, event: MouseEvent) => void;
  hide: () => void;
}

/**
 * Composable for a single-target context menu / action sheet (e.g. album card right-click).
 * Use with ActionRenderer: bind visible, position, context, @close=hide, @command to your handler.
 */
export function useActionMenu<T>(_options?: UseActionMenuOptions<T>): UseActionMenuReturn<T> {
  const visible = ref(false);
  const position = ref({ x: 0, y: 0 });
  const context = ref<ActionMenuContext<T>>({ target: null });

  const show = (target: T, event: MouseEvent) => {
    context.value = { target };
    position.value = { x: event.clientX, y: event.clientY };
    visible.value = true;
  };

  const hide = () => {
    visible.value = false;
  };

  return {
    visible,
    position,
    context,
    show,
    hide,
  } as UseActionMenuReturn<T>;
}
