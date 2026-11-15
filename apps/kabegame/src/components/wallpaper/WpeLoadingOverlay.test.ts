// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import WpeLoadingOverlay from "./WpeLoadingOverlay.vue";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

describe("WpeLoadingOverlay", () => {
  it("场景：按进度画条、按阶段显示文字", async () => {
    const wrapper = mount(WpeLoadingOverlay, { props: { scene: true, value: 0.42, stage: "compile" } });
    expect(wrapper.findComponent({ name: "Progress" }).props("value")).toBeCloseTo(42);
    expect(wrapper.find('[data-testid="wpe-loading-label"]').text()).toBe("gallery.wpeLoadStageCompile");
    for (const [stage, key] of [
      ["page", "gallery.wpeLoadStagePage"],
      ["decode", "gallery.wpeLoadStageDecode"],
      ["prepare", "gallery.wpeLoadStagePrepare"],
      ["gpu", "gallery.wpeLoadStageGpu"],
      ["frame", "gallery.wpeLoadStageFrame"],
    ] as const) {
      await wrapper.setProps({ stage });
      expect(wrapper.find('[data-testid="wpe-loading-label"]').text()).toBe(key);
    }
  });

  it("场景加载中：有计数的阶段显示「done / total · 总百分比」（两位小数），其余阶段只有百分比；失败、网页不显示", async () => {
    const wrapper = mount(WpeLoadingOverlay, {
      props: { scene: true, value: 0.42178, stage: "compile", count: { done: 37, total: 142 } },
    });
    const meta = () => wrapper.find('[data-testid="wpe-loading-meta"]');
    expect(meta().text()).toBe("37 / 142 · 42.18%");
    await wrapper.setProps({ stage: "prepare", count: { done: 0, total: 1 }, value: 0.7 });
    expect(meta().text()).toBe("70.00%");
    await wrapper.setProps({ stage: "gpu", count: { done: 12, total: 33 } });
    expect(meta().text()).toBe("12 / 33 · 70.00%");
    await wrapper.setProps({ failure: ["x"] });
    expect(meta().exists()).toBe(false);
    await wrapper.setProps({ failure: null, scene: false });
    expect(meta().exists()).toBe(false);
  });

  it("网页壁纸：不定进度条与「加载中」", () => {
    const wrapper = mount(WpeLoadingOverlay, { props: { scene: false, value: 0.5, stage: "gpu" } });
    expect(wrapper.findComponent({ name: "Progress" }).props("value")).toBeNull();
    expect(wrapper.text()).toBe("gallery.wpeLoadStageWeb");
  });

  it("失败：文字与进度条变红，标题是「喵呜，这张壁纸渲染失败了呢」，下面列原因；超时是「加载超时」、不列原因", async () => {
    const wrapper = mount(WpeLoadingOverlay, {
      props: { scene: true, value: 0.3, stage: "compile", failure: ["object:particle", "script:api:x"] },
    });
    const label = wrapper.find('[data-testid="wpe-loading-label"]');
    expect(label.text()).toBe("gallery.wpeLoadFailed");
    expect(label.classes()).toContain("text-kb-danger");
    expect(wrapper.find('[data-testid="wpe-loading-detail"]').text()).toBe("object:particle; script:api:x");
    const progress = wrapper.findComponent({ name: "Progress" });
    expect(progress.props("value")).toBe(100);
    expect(progress.props("tone")).toBe("danger");
    await wrapper.setProps({ failure: ["render:timeout"] });
    expect(wrapper.find('[data-testid="wpe-loading-label"]').text()).toBe("gallery.wpeLoadTimeout");
    expect(wrapper.find('[data-testid="wpe-loading-detail"]').exists()).toBe(false);
  });

  it("bottom：失败后留在缩略图底部，不模糊、没有进度条", () => {
    const wrapper = mount(WpeLoadingOverlay, {
      props: { scene: true, value: 1, stage: "gpu", failure: ["effect:x"], placement: "bottom" },
    });
    expect((wrapper.element as HTMLElement).style.backdropFilter).toBe("");
    expect(wrapper.findComponent({ name: "Progress" }).exists()).toBe(false);
    expect(wrapper.find('[data-testid="wpe-loading-detail"]').text()).toBe("effect:x");
  });

  it("屏幕上的大小固定：按量到的显示缩放反向缩放中间那块、模糊半径除以缩放，宽度取 320 px 与显示宽度 70% 的较小值", async () => {
    vi.useFakeTimers();
    const wrapper = mount(WpeLoadingOverlay, {
      props: { scene: true, value: 0.5, stage: "gpu" },
      attachTo: document.body,
    });
    const root = wrapper.element as HTMLElement;
    const pill = () => root.firstElementChild as HTMLElement;
    // 单根：调用方给的定位类落在根上
    expect(root.dataset.testid).toBe("wpe-loading-overlay");
    // 没量到（还没布局）：只有对中的平移，不缩放、不定宽，模糊按没缩放
    expect(pill().style.transform).toBe("translate(-50%, -50%)");
    expect(pill().style.width).toBe("");
    expect(root.style.backdropFilter).toBe("blur(16px)");
    // 3840×2160 的画布缩到 960×540 显示
    Object.defineProperty(root, "offsetWidth", { configurable: true, value: 3840 });
    Object.defineProperty(root, "offsetHeight", { configurable: true, value: 2160 });
    root.getBoundingClientRect = () => ({ width: 960, height: 540 }) as DOMRect;
    vi.advanceTimersByTime(250);
    await flushPromises();
    expect(pill().style.transform).toBe("translate(-50%, -50%) scale(4)");
    expect(pill().style.transformOrigin).toBe("center");
    expect(pill().style.width).toBe("320px");
    expect(root.style.backdropFilter).toBe("blur(64px)");
    // 显示得很小时宽度跟着显示宽度
    root.getBoundingClientRect = () => ({ width: 200, height: 112.5 }) as DOMRect;
    vi.advanceTimersByTime(250);
    await flushPromises();
    expect(pill().style.transform).toBe("translate(-50%, -50%) scale(19.2)");
    expect(pill().style.width).toBe("140px");
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("对中不靠 grid：那一块按根绝对定位在中线上（小场景放大显示时它的排版宽度比根还宽，grid 的列会被撑开、中心偏右）", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(WpeLoadingOverlay, {
        props: { scene: true, value: 1, stage: "gpu", failure: ["effect:x"], placement: "bottom" },
        attachTo: document.body,
      });
      const root = wrapper.element as HTMLElement;
      const pill = root.firstElementChild as HTMLElement;
      expect(root.classList.contains("grid")).toBe(false);
      expect(pill.classList).toContain("absolute");
      expect(pill.classList).toContain("left-1/2");
      expect(pill.classList).toContain("bottom-[4%]");
      expect(pill.style.transform).toBe("translateX(-50%)");
      // 343×193 的小场景放大到 1066 宽显示（实测 dino_run）：排版宽度 480 > 343
      Object.defineProperty(root, "offsetWidth", { configurable: true, value: 343 });
      Object.defineProperty(root, "offsetHeight", { configurable: true, value: 193 });
      root.getBoundingClientRect = () => ({ width: 1066, height: 600 }) as DOMRect;
      vi.advanceTimersByTime(250);
      await flushPromises();
      expect(pill.style.width).toBe("480px");
      expect(pill.style.transform).toMatch(/^translateX\(-50%\) scale\(0\.32/);
      expect(pill.style.transformOrigin).toBe("bottom center");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
