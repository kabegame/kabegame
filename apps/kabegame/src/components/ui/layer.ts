/**
 * 浮层的层级与「层内」判断（P9 起取代混用期垫片 compat.ts）。
 *
 * 层级：所有浮层（对话框、侧边面板、菜单、选择框、气泡、提示）打开时向同一个全局计数器取号，
 * 后打开的总在上面。计数器从 3000 起、只增不减——起点高于预览弹窗的 `useModal` 栈位（2000 起）
 * 与页面里的固定层级，预览里再弹出的浮层照样在预览之上。
 *
 * 模态层（对话框、确认框、侧边面板、看图）打开期间另外登记自己的层级号（{@link topModalLayerZIndex}），
 * 供常驻浮层（看板娘）排在所有模态层之上；它们之后打开的菜单、气泡取到更大的号，照样盖住常驻浮层。
 */
import { getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";

const LAYER_Z_BASE = 3000;
let currentZ = LAYER_Z_BASE;

/** 取下一个层级号 */
export function nextLayerZIndex(): number {
  currentZ += 1;
  return currentZ;
}

interface ModalLayer {
  z: number;
  /** 打开方标记；{@link topModalLayerZIndex} 据此排除某个常驻浮层自己打开的对话框 */
  owner?: string;
}

/** 打开着的模态层（响应式，看板娘的层级跟着它变） */
const openModalLayers = shallowRef<ModalLayer[]>([]);

export interface LayerZIndexOptions {
  /** 模态层：打开期间登记层级号，常驻浮层据此排在它之上 */
  modal?: boolean;
  /** 模态层的打开方，见 {@link topModalLayerZIndex} */
  owner?: string;
}

/** 浮层每次打开时取一个新号，压在此前打开的一切之上 */
export function useLayerZIndex(open: Ref<boolean>, options: LayerZIndexOptions = {}): Ref<number> {
  const z = ref(open.value ? nextLayerZIndex() : LAYER_Z_BASE);
  let entry: ModalLayer | null = null;

  const unregister = () => {
    if (!entry) return;
    const current = entry;
    openModalLayers.value = openModalLayers.value.filter((layer) => layer !== current);
    entry = null;
  };
  const register = () => {
    if (!options.modal) return;
    unregister();
    entry = { z: z.value, owner: options.owner };
    openModalLayers.value = [...openModalLayers.value, entry];
  };

  if (open.value) register();
  watch(open, (value) => {
    if (value) {
      z.value = nextLayerZIndex();
      register();
    } else {
      unregister();
    }
  });
  if (getCurrentScope()) onScopeDispose(unregister);
  return z;
}

/**
 * 最上面一个打开着的模态层的层级号，没有时为 null；`excludeOwner` 排除该打开方自己的模态层。
 * 常驻浮层（看板娘）取它 + 1：盖在所有模态层之上，又不盖住自己打开的对话框。在 computed 里读即可响应。
 */
export function topModalLayerZIndex(excludeOwner?: string): number | null {
  let top: number | null = null;
  for (const layer of openModalLayers.value) {
    if (excludeOwner && layer.owner === excludeOwner) continue;
    if (top === null || layer.z > top) top = layer.z;
  }
  return top;
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

/** 点到这些元素不算「点了层外面」：提示消息，以及盖在模态层之上的常驻浮层（看板娘带 data-kb-persistent） */
const KEEP_OPEN_SELECTOR = "[data-kb-toast],[data-kb-persistent]";

/**
 * 接在 Reka 层的 @pointer-down-outside / @focus-outside / @interact-outside 上：
 * 点到提示消息（关闭按钮、滑动关闭）或常驻浮层时不关闭当前层——它们挂在 body 下、不属于任何层。
 */
export function keepOpenOnToast(event: OutsideEvent): void {
  const target = event.detail?.originalEvent?.target ?? event.target;
  if (target instanceof Element && target.closest(KEEP_OPEN_SELECTOR)) event.preventDefault();
}
