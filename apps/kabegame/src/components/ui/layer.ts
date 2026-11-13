/**
 * 浮层的层级与「层内」判断（P9 起取代混用期垫片 compat.ts）。
 *
 * 层级：所有浮层（对话框、侧边面板、菜单、选择框、气泡、提示）打开时向同一个全局计数器取号，
 * 后打开的总在上面。计数器从 3000 起、只增不减——起点高于预览弹窗的 `useModal` 栈位（2000 起）
 * 与页面里的固定层级，预览里再弹出的浮层照样在预览之上。
 */
import { ref, watch, type Ref } from "vue";

const LAYER_Z_BASE = 3000;
let currentZ = LAYER_Z_BASE;

/** 取下一个层级号 */
export function nextLayerZIndex(): number {
  currentZ += 1;
  return currentZ;
}

/** 浮层每次打开时取一个新号，压在此前打开的一切之上 */
export function useLayerZIndex(open: Ref<boolean>): Ref<number> {
  const z = ref(open.value ? nextLayerZIndex() : LAYER_Z_BASE);
  watch(open, (value) => {
    if (value) z.value = nextLayerZIndex();
  });
  return z;
}

/** 浮层：内容带 data-kb-trap，或挂在 Reka 的定位容器里，或是菜单 / 对话框；提示消息也算 */
const LAYER_SELECTOR =
  "[data-kb-trap],[data-reka-popper-content-wrapper],[role=menu],[role=dialog],[role=alertdialog],[data-kb-toast]";

/**
 * 事件目标是否落在任何浮层里：页面级的键盘 / 滚轮 / 点击处理据此让路，
 * 免得在弹层里操作时底下的网格跟着滚动、改列数或清空选择。
 */
export function isInAnyLayer(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(LAYER_SELECTOR) != null;
}

type OutsideEvent = Event & { detail?: { originalEvent?: Event } };

/**
 * 接在 Reka 层的 @pointer-down-outside / @focus-outside / @interact-outside 上：
 * 点到提示消息（关闭按钮、滑动关闭）时不关闭当前层——提示挂在 body 下、不属于任何层。
 */
export function keepOpenOnToast(event: OutsideEvent): void {
  const target = event.detail?.originalEvent?.target ?? event.target;
  if (target instanceof Element && target.closest("[data-kb-toast]")) event.preventDefault();
}
