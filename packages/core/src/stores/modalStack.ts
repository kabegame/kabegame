import { defineStore } from "pinia";
import { ref, computed } from "vue";

export type ModalCloseCallback = () => void | Promise<void>;

export interface ModalEntry {
  id: string;
  close: ModalCloseCallback;
}

export const useModalStackStore = defineStore("modalStack", () => {
  const stack = ref<ModalEntry[]>([]);

  const isEmpty = computed(() => stack.value.length === 0);
  const count = computed(() => stack.value.length);

  /**
   * Push a close callback to the stack.
   * Returns a unique ID that can be used to remove the entry manually (though pop is preferred).
   */
  function push(close: ModalCloseCallback): string {
    const id = crypto.randomUUID();
    stack.value.push({ id, close });
    return id;
  }

  /**
   * Pop the top entry from the stack (without calling close).
   * Useful if the modal was closed by other means (e.g. close button).
   */
  function pop(): ModalEntry | undefined {
    return stack.value.pop();
  }

  /**
   * Remove a specific entry by ID (if it exists).
   */
  function remove(id: string) {
    const index = stack.value.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      stack.value.splice(index, 1);
    }
  }

  /**
   * Close the top modal: execute its close callback and pop it.
   * Returns true if a modal was closed, false if stack was empty.
   */
  async function closeTop(): Promise<boolean> {
    const entry = stack.value.pop();
    if (entry) {
      await entry.close();
      return true;
    }
    return false;
  }

  return {
    stack,
    isEmpty,
    count,
    push,
    pop,
    remove,
    closeTop,
  };
});
