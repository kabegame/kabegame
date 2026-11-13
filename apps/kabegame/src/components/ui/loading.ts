/**
 * 加载遮罩指令（取代 EP 的 v-loading）：在 `<script setup>` 里 `import { vLoading } from "@/components/ui"`，
 * 模板照旧写 `v-loading="busy"`——script setup 里的 vLoading 优先于全局注册的同名指令。
 *
 * 宿主是 static 定位时临时改成 relative（遮罩要绝对定位铺满宿主），卸载时还原。
 * 遮罩是 LoadingOverlay.vue（类名写在 .vue 里，UnoCSS 才扫描得到）。
 */
import { h, render, type Directive } from "vue";
import LoadingOverlay from "./LoadingOverlay.vue";

interface LoadingState {
  host: HTMLElement;
  patchedPosition: boolean;
}

const states = new WeakMap<HTMLElement, LoadingState>();

function update(el: HTMLElement, visible: boolean) {
  let state = states.get(el);
  if (!state && !visible) return;
  if (!state) {
    const host = document.createElement("div");
    host.setAttribute("data-kb-loading", "");
    host.style.display = "contents";
    el.appendChild(host);
    const position = getComputedStyle(el).position;
    const patchedPosition = !position || position === "static";
    if (patchedPosition) el.style.position = "relative";
    state = { host, patchedPosition };
    states.set(el, state);
  }
  // 宿主内容整体重渲染时可能把遮罩挤掉，再挂回去
  if (state.host.parentNode !== el) el.appendChild(state.host);
  render(h(LoadingOverlay, { visible }), state.host);
}

export const vLoading: Directive<HTMLElement, boolean | null | undefined> = {
  mounted(el, binding) {
    update(el, !!binding.value);
  },
  updated(el, binding) {
    if (!!binding.value !== !!binding.oldValue || states.has(el)) update(el, !!binding.value);
  },
  beforeUnmount(el) {
    const state = states.get(el);
    if (!state) return;
    render(null, state.host);
    state.host.remove();
    if (state.patchedPosition) el.style.position = "";
    states.delete(el);
  },
};
