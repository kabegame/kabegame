import { defineStore } from "pinia";
import { ref } from "vue";

export type ModalCloseCallback = () => void | Promise<void>;

const MODAL_Z_BASE = 2000;
const MODAL_Z_STEP = 10;

interface SlotEntry {
  id: string;
  slotIndex: number;
  layers: number;
  close?: ModalCloseCallback;
}

export const useModalStackStore = defineStore("modalStack", () => {
  const slots = ref<SlotEntry[]>([]);

  function _nextTopSlot(): number {
    if (slots.value.length === 0) return 0;
    return Math.max(...slots.value.map((e) => e.slotIndex + e.layers));
  }

  function acquire(layers = 1, close?: ModalCloseCallback): { id: string; zIndex: number } {
    const id = crypto.randomUUID();
    const safeLayers = Math.max(1, Math.floor(layers));
    const slotIndex = _nextTopSlot();
    slots.value.push({ id, slotIndex, layers: safeLayers, close });
    return { id, zIndex: MODAL_Z_BASE + slotIndex * MODAL_Z_STEP };
  }

  function release(id: string) {
    const idx = slots.value.findIndex((e) => e.id === id);
    if (idx !== -1) slots.value.splice(idx, 1);
  }

  function zIndexForSlot(slotIndex: number): number {
    return MODAL_Z_BASE + slotIndex * MODAL_Z_STEP;
  }

  // Android back button: close the topmost modal (highest reserved layer)
  async function closeTop(): Promise<boolean> {
    if (slots.value.length === 0) return false;
    const top = slots.value.reduce((a, b) =>
      a.slotIndex + a.layers - 1 > b.slotIndex + b.layers - 1 ? a : b
    );
    if (top.close) await top.close();
    return true;
  }

  const isEmpty = () => slots.value.length === 0;

  return { slots, acquire, release, zIndexForSlot, closeTop, isEmpty };
});
