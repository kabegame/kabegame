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
  /** 占位方标记；`topZIndex(excludeOwner)` 据此排除某个组件自己的弹层 */
  owner?: string;
}

export const useModalStackStore = defineStore("modalStack", () => {
  const slots = ref<SlotEntry[]>([]);

  function _nextTopSlot(entries: SlotEntry[] = slots.value): number {
    if (entries.length === 0) return 0;
    return Math.max(...entries.map((e) => e.slotIndex + e.layers));
  }

  function acquire(layers = 1, close?: ModalCloseCallback, owner?: string): { id: string; zIndex: number } {
    const id = crypto.randomUUID();
    const safeLayers = Math.max(1, Math.floor(layers));
    const slotIndex = _nextTopSlot();
    slots.value.push({ id, slotIndex, layers: safeLayers, close, owner });
    return { id, zIndex: MODAL_Z_BASE + slotIndex * MODAL_Z_STEP };
  }

  function release(id: string) {
    const idx = slots.value.findIndex((e) => e.id === id);
    if (idx !== -1) slots.value.splice(idx, 1);
  }

  function zIndexForSlot(slotIndex: number): number {
    return MODAL_Z_BASE + slotIndex * MODAL_Z_STEP;
  }

  /**
   * 压在所有已占栈位之上的 z-index；无栈位时返回 null。
   * `excludeOwner` 排除该 owner 自己的栈位，供常驻浮层（kamechan）置顶又不盖住自己打开的菜单/弹窗：
   * 自己的弹层与它同层时，靠 DOM 顺序（后 teleport 者在上）压住它。
   */
  function topZIndex(excludeOwner?: string): number | null {
    const others = excludeOwner ? slots.value.filter((e) => e.owner !== excludeOwner) : slots.value;
    if (others.length === 0) return null;
    return zIndexForSlot(_nextTopSlot(others));
  }

  // Android back button: close the topmost modal (highest reserved layer)
  async function closeTop(): Promise<boolean> {
    if (slots.value.length === 0) return false;
    const top = slots.value.reduce((a, b) => (a.slotIndex + a.layers - 1 > b.slotIndex + b.layers - 1 ? a : b));
    if (top.close) await top.close();
    return true;
  }

  const isEmpty = () => slots.value.length === 0;

  return { slots, acquire, release, zIndexForSlot, topZIndex, closeTop, isEmpty };
});
