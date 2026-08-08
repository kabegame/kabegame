import type { Directive } from "vue";

/**
 * v-hscroll-fade：横向滚动容器的「两侧渐隐」提示 + 竖向滚轮转横向滚动。
 *
 * 放在滚动容器的**不滚动外框**上（el-scrollbar 根即是；实际滚动的
 * `.el-scrollbar__wrap` 由指令自行发现，宿主自身可滚时退化为宿主）。
 * 渐隐层是宿主的 ::before/::after（见 styles/hscroll-fade.css），宿主不滚动
 * 才能钉在两缘——左侧渐隐 = 已向右滚过（回头还有内容），右侧渐隐 = 右边还有内容。
 */

interface FadeState {
  scroller: HTMLElement;
  ro: ResizeObserver;
  update: () => void;
  onWheel: (e: WheelEvent) => void;
}

const states = new WeakMap<HTMLElement, FadeState>();

export const vHscrollFade: Directive<HTMLElement> = {
  mounted(host) {
    const scroller = host.querySelector<HTMLElement>(".el-scrollbar__wrap") ?? host;
    host.classList.add("kb-hscroll-fade");

    const update = () => {
      host.classList.toggle("kb-hscroll-fade--start", scroller.scrollLeft > 1);
      host.classList.toggle(
        "kb-hscroll-fade--end",
        scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1,
      );
    };

    // 竖向滚轮本身不会驱动横向溢出，不接管的话这行看着能滚却滚不动（只有触控板横扫有效）。
    const onWheel = (event: WheelEvent) => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      if (maxScroll <= 0) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const next = Math.min(Math.max(scroller.scrollLeft + delta, 0), maxScroll);
      if (next === scroller.scrollLeft) return; // 已到端点：让页面继续接管滚动
      event.preventDefault();
      scroller.scrollLeft = next; // scroll 事件随后触发 update
    };

    scroller.addEventListener("scroll", update, { passive: true });
    host.addEventListener("wheel", onWheel, { passive: false });

    // 容器与内容（el-scrollbar 的 view 是稳定元素，children 变化会改变其尺寸）都要观察
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);

    states.set(host, { scroller, ro, update, onWheel });
    update();
  },
  updated(host) {
    states.get(host)?.update();
  },
  unmounted(host) {
    const s = states.get(host);
    if (!s) return;
    s.scroller.removeEventListener("scroll", s.update);
    host.removeEventListener("wheel", s.onWheel);
    s.ro.disconnect();
    states.delete(host);
  },
};
