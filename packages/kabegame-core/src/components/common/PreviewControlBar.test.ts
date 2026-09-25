// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PreviewControlBar from "./PreviewControlBar.vue";

const controlBar = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get(".preview-control-bar");

const exposedApi = (wrapper: ReturnType<typeof mount>) =>
  wrapper.vm as unknown as {
    show: () => void;
    scheduleHide: (delay?: number) => void;
    refreshPointerPosition: (
      event?: MouseEvent | PointerEvent | null,
      delay?: number,
    ) => void;
  };

afterEach(() => {
  vi.useRealTimers();
});

describe("PreviewControlBar 显隐", () => {
  it("初始隐藏控制条，但仍渲染插槽内容", () => {
    const wrapper = mount(PreviewControlBar, {
      slots: { default: '<button class="test-control">播放</button>' },
    });

    expect(controlBar(wrapper).classes()).toContain("hidden");
    expect(wrapper.get(".test-control").text()).toBe("播放");
  });

  it("进入底部热区时显示，离开一秒后隐藏", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar);

    await wrapper.get(".preview-control-bar-hover-zone").trigger("mouseenter");
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    await wrapper.get(".preview-control-bar-hover-zone").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(999);
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    await vi.advanceTimersByTimeAsync(1);
    expect(controlBar(wrapper).classes()).toContain("hidden");
  });

  it("鼠标从热区移入控制条时取消隐藏，离开控制条后重新计时", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar);
    const hotzone = wrapper.get(".preview-control-bar-hover-zone");

    await hotzone.trigger("mouseenter");
    await hotzone.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(500);
    await controlBar(wrapper).trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(1000);
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    await controlBar(wrapper).trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(1000);
    expect(controlBar(wrapper).classes()).toContain("hidden");
  });

  it("keepVisible 开启时，离开交互区后仍保持显示", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar, {
      props: { keepVisible: true },
    });
    const hotzone = wrapper.get(".preview-control-bar-hover-zone");

    await hotzone.trigger("mouseenter");
    await hotzone.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(1000);

    expect(controlBar(wrapper).classes()).not.toContain("hidden");
  });

  it("公开 API 可以立即显示，并按指定延迟隐藏", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar);
    const api = exposedApi(wrapper);

    api.show();
    await wrapper.vm.$nextTick();
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    api.scheduleHide(250);
    await vi.advanceTimersByTimeAsync(249);
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    await vi.advanceTimersByTimeAsync(1);
    expect(controlBar(wrapper).classes()).toContain("hidden");
  });

  it("根据指针是否位于热区或控制条内刷新显隐状态", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar);
    const api = exposedApi(wrapper);
    const hotzoneRect = {
      left: 10,
      right: 110,
      top: 20,
      bottom: 80,
    } as DOMRect;
    const controlsRect = {
      left: 120,
      right: 220,
      top: 20,
      bottom: 80,
    } as DOMRect;

    vi.spyOn(
      wrapper.get(".preview-control-bar-hover-zone").element,
      "getBoundingClientRect",
    ).mockReturnValue(hotzoneRect);
    vi.spyOn(
      controlBar(wrapper).element,
      "getBoundingClientRect",
    ).mockReturnValue(controlsRect);

    api.refreshPointerPosition(
      new MouseEvent("mousemove", { clientX: 50, clientY: 50 }),
    );
    await wrapper.vm.$nextTick();
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    api.refreshPointerPosition(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(controlBar(wrapper).classes()).toContain("hidden");

    api.refreshPointerPosition(
      new MouseEvent("mousemove", { clientX: 150, clientY: 50 }),
    );
    await wrapper.vm.$nextTick();
    expect(controlBar(wrapper).classes()).not.toContain("hidden");

    api.refreshPointerPosition(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(controlBar(wrapper).classes()).toContain("hidden");
  });

  it("卸载时清除尚未触发的隐藏计时器", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PreviewControlBar);

    await wrapper.get(".preview-control-bar-hover-zone").trigger("mouseleave");
    expect(vi.getTimerCount()).toBe(1);

    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
