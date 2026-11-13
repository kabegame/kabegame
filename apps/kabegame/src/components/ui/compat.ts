/**
 * 混用期垫片：新组件（reka-ui）与还没迁的 element-plus / Vant 界面同时存在时的几处衔接。
 *
 * TODO:[REF_UI] P9 删除整份文件（EP 与 Vant 都删掉之后这些情况不再出现）：
 * - useLayerZIndex / nextLayerZIndex：改成自己的计数器（或固定的 --kb-z-* 档位）；
 * - keepOpenOnForeign / isForeignLayer、keepFocusForForeign、foreignPortalTarget、withForeignFocus、usePauseForeignTraps：
 *   调用处一并删掉；
 * - styles/kb-compat.css 一起删。
 *
 * 三类问题与对策：
 * 1. 层级：EP 每打开一个弹出层 / 对话框就把 z-index 从 3000 往上加 1（全局计数器，只增不减），
 *    新浮层若用固定 z-index，打开得晚也可能被压在旧层底下。新浮层打开时向同一个计数器取号。
 * 2. 点外部：Reka 的模态层把 body 设成 pointer-events: none，并把「点到层外」当作关闭信号；
 *    旧浮层（下拉、确认框、提示）都挂在 body 下、在新层之外。kb-compat.css 让它们仍可点，
 *    新层的 pointer-down-outside / focus-outside 由 keepOpenOnForeign 判成「层内」不关。
 * 3. 焦点陷阱与 Esc：Reka 与 EP 的模态层各有一套焦点陷阱，彼此看对方都在「层外」，同时生效会来回抢焦点；
 *    EP 的陷阱还在 document 上响应 Esc（只要没被暂停），按 Esc 关新浮层会把底下的 EP 对话框一起关掉。
 *    - 新浮层打开期间压一层到 EP 的焦点层栈（usePauseForeignTraps），EP 的陷阱暂停：不抢焦点、不响应 Esc；
 *    - 新浮层的触发器在 EP 对话框 / 抽屉里：浮层挂进那个对话框（foreignPortalTarget），定位、层叠都跟着对话框走；
 *    - 从新对话框里弹 EP 确认框：确认框门面用 withForeignFocus 在确认框存在期间暂停 Reka 的陷阱。
 */
import { h, nextTick, onBeforeUnmount, ref, render, watch, type Ref } from "vue";
import { FocusScope } from "reka-ui";
import { useZIndex } from "@kabegame/element-plus";
import { focusableStack, type FocusLayer } from "@kabegame/element-plus/components/focus-trap";

/** EP / Vant 的浮层与我们自己的提示消息：新模态层把它们当作「层内」 */
const FOREIGN_LAYER_SELECTOR = [
  ".el-popper",
  ".el-overlay",
  ".el-message",
  ".el-message-box__wrapper",
  ".el-drawer",
  ".el-image-viewer__wrapper",
  ".van-popup",
  ".van-overlay",
  ".van-toast",
  "[data-kb-toast]",
].join(",");

/** 与 App.vue 的 el-config-provider :z-index 一致 */
const EP_Z_BASE = 3000;
let fallbackZ = EP_Z_BASE + 1000;

/**
 * 向 EP 的全局 z-index 计数器取下一个号（EP 自己的弹出层也从这里取，两边就有了统一的先后）。
 * 测试里 EP 常被整体 mock 掉，取不到时退回本地计数器。
 */
export function nextLayerZIndex(): number {
  try {
    return useZIndex(ref(EP_Z_BASE)).nextZIndex();
  } catch {
    fallbackZ += 1;
    return fallbackZ;
  }
}

/** 浮层每次打开时取一个新号，压在此前打开的一切（新旧都算）之上 */
export function useLayerZIndex(open: Ref<boolean>): Ref<number> {
  const z = ref(open.value ? nextLayerZIndex() : EP_Z_BASE);
  watch(open, (value) => {
    if (value) z.value = nextLayerZIndex();
  });
  return z;
}

/**
 * 新浮层（对话框、侧边面板、菜单、选择框、气泡）打开期间暂停 EP 的焦点陷阱：往 EP 的焦点层栈顶压一个空层，
 * 与 EP 自己嵌套弹层时的做法相同；关闭或卸载时移除，下面的 EP 陷阱恢复。
 */
export function usePauseForeignTraps(open: Ref<boolean>): void {
  let layer: FocusLayer | null = null;
  const release = () => {
    if (!layer) return;
    try {
      focusableStack.remove(layer);
    } catch {
      // 测试里 EP 被 mock 掉时没有栈
    }
    layer = null;
  };
  watch(
    open,
    (value) => {
      if (value && !layer) {
        layer = { paused: false, pause() {}, resume() {} };
        try {
          focusableStack.push(layer);
        } catch {
          layer = null;
        }
      } else if (!value) {
        release();
      }
    },
    { immediate: true },
  );
  onBeforeUnmount(release);
}

/**
 * 接在菜单的 @close-auto-focus 上：菜单项打开了一个 EP 对话框 / 抽屉时（它不包含菜单的触发器），
 * 不把焦点还给触发器，而是照 EP 打开时的规则聚焦对话框容器（el-dialog 的 focus-start-el="container"）。
 * 对话框打开那一刻菜单的焦点陷阱还在，EP 自己放进去的焦点会被拉回菜单，所以要在菜单关闭时补一次。
 */
export function keepFocusForForeign(event: Event, trigger: Element | null | undefined): void {
  const overlays = document.querySelectorAll<HTMLElement>(".el-overlay");
  for (const overlay of overlays) {
    if (overlay.style.display === "none" || (trigger && overlay.contains(trigger))) continue;
    const host = overlay.querySelector<HTMLElement>(".el-dialog, .el-drawer, .el-message-box");
    if (host) {
      event.preventDefault();
      if (!host.contains(document.activeElement)) host.focus();
      return;
    }
  }
}

export function isForeignLayer(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(FOREIGN_LAYER_SELECTOR) != null;
}

/** 新浮层（Reka 的对话框 / 侧边面板 / 菜单 / 弹出层）：内容带 data-kb-trap，或挂在 Reka 的定位容器里 */
const OWN_LAYER_SELECTOR =
  "[data-kb-trap],[data-reka-popper-content-wrapper],[role=menu],[role=dialog],[role=alertdialog]";

/**
 * 事件目标是否落在任何浮层（新旧都算）里：页面级的键盘 / 滚轮 / 点击处理据此让路，
 * 免得在弹层里操作时底下的网格跟着滚动、改列数或清空选择。
 * TODO:[REF_UI] P9 去掉旧浮层那一半（只留 OWN_LAYER_SELECTOR），并从 compat.ts 移到 ui 的工具里。
 */
export function isInAnyLayer(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof Element)) return false;
  return isForeignLayer(target) || target.closest(OWN_LAYER_SELECTOR) != null;
}

type OutsideEvent = Event & { detail?: { originalEvent?: Event } };

/**
 * 接在 Reka 层的 @pointer-down-outside / @focus-outside / @interact-outside 上：
 * 点到 / 聚焦到旧浮层或提示消息时不关闭新层。
 */
export function keepOpenOnForeign(event: OutsideEvent): void {
  const target = event.detail?.originalEvent?.target ?? event.target;
  if (isForeignLayer(target)) event.preventDefault();
}

/**
 * 元素在 EP 对话框 / 抽屉 / 确认框里时，返回那个容器，供新浮层的 Portal `to` 使用；
 * 否则 undefined（挂到 body）。挂进去之后 EP 的焦点陷阱把浮层当作层内，不会把焦点抢回去。
 */
export function foreignPortalTarget(el: Element | null | undefined): HTMLElement | undefined {
  const host = el?.closest(".el-dialog, .el-drawer, .el-message-box");
  return host instanceof HTMLElement ? host : undefined;
}

/**
 * 在 run 期间暂停 Reka 的焦点陷阱：挂一个不陷焦点的 FocusScope，它入栈时会让当前栈顶的陷阱 paused，
 * 出栈时恢复。用于从新对话框里弹 EP 的确认框（ElMessageBox 有自己的陷阱）。
 */
export async function withForeignFocus<T>(run: () => Promise<T>): Promise<T> {
  // 没有打开的新模态层（Dialog / Sheet / AlertDialog 的内容带 data-kb-trap）就不用暂停，也不多等两拍
  if (typeof document === "undefined" || !document.querySelector("[data-kb-trap]")) return run();
  const host = document.createElement("div");
  host.hidden = true;
  host.setAttribute("data-kb-focus-pause", "");
  document.body.appendChild(host);
  render(
    h(
      FocusScope,
      {
        trapped: false,
        // 别让这个空 scope 自己抢焦点，也别在卸载时把焦点送回去（EP 确认框会自己还焦点）
        onMountAutoFocus: (e: Event) => e.preventDefault(),
        onUnmountAutoFocus: (e: Event) => e.preventDefault(),
      },
      () => h("span"),
    ),
    host,
  );
  // FocusScope 在 watchEffect 里等一个 nextTick 才入栈
  await nextTick();
  await nextTick();
  try {
    return await run();
  } finally {
    render(null, host);
    host.remove();
  }
}
