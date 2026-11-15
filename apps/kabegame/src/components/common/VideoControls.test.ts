// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import VideoControls from "./VideoControls.vue";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  vi.useRealTimers();
});

describe("VideoControls 显隐", () => {
  it("视频暂停后显示控制条，但不会让它一直保持显示", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const wrapper = mount(VideoControls, {
      props: { video },
    });
    const controlBar = () => wrapper.get(".preview-control-bar");

    expect(controlBar().classes()).toContain("hidden");

    video.dispatchEvent(new Event("pause"));
    await wrapper.vm.$nextTick();
    expect(controlBar().classes()).not.toContain("hidden");

    await vi.advanceTimersByTimeAsync(999);
    expect(controlBar().classes()).not.toContain("hidden");

    await vi.advanceTimersByTimeAsync(1);
    expect(controlBar().classes()).toContain("hidden");

    wrapper.unmount();
  });
});

describe("VideoControls 缩放按钮（预览放大）", () => {
  const mountWith = (zoom?: number | null) =>
    mount(VideoControls, {
      props: { video: document.createElement("video"), ...(zoom === undefined ? {} : { zoom }) },
      attachTo: document.body,
    });
  /** 第一个悬停面板是音量，第二个是缩放 */
  const panels = (wrapper: ReturnType<typeof mountWith>) => wrapper.findAll(".hover-panel-wrap");

  it("不传 zoom 没有缩放按钮", () => {
    const wrapper = mountWith();
    expect(wrapper.find(".zoom-btn").exists()).toBe(false);
    expect(panels(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });

  it("100% 时是放大镜图标，放大后显示百分比", async () => {
    const wrapper = mountWith(100);
    expect(wrapper.get(".zoom-btn").find("svg").exists()).toBe(true);
    expect(wrapper.get(".zoom-btn").text()).toBe("");
    await wrapper.setProps({ zoom: 250.4 });
    expect(wrapper.get(".zoom-btn").find("svg").exists()).toBe(false);
    expect(wrapper.get(".zoom-btn").text()).toBe("250%");
    wrapper.unmount();
  });

  it("拖滑块依次发 zoom-drag-start / zoom-input / zoom-commit，点按钮发 zoom-reset", async () => {
    const wrapper = mountWith(100);
    const slider = panels(wrapper)[1].get("input");
    await slider.trigger("mousedown");
    (slider.element as HTMLInputElement).value = "300";
    await slider.trigger("input");
    await slider.trigger("change");
    expect(wrapper.emitted("zoom-drag-start")).toHaveLength(1);
    expect(wrapper.emitted("zoom-input")).toEqual([[300]]);
    expect(wrapper.emitted("zoom-commit")).toEqual([[300]]);
    await wrapper.get(".zoom-btn").trigger("click");
    expect(wrapper.emitted("zoom-reset")).toHaveLength(1);
    wrapper.unmount();
  });

  it("拖缩放滑块期间控制条不隐藏，松开后照常隐藏", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const wrapper = mount(VideoControls, { props: { video, zoom: 100 }, attachTo: document.body });
    const controlBar = () => wrapper.get(".preview-control-bar");
    video.dispatchEvent(new Event("pause"));
    await wrapper.vm.$nextTick();
    await panels(wrapper)[1].get("input").trigger("mousedown");
    // 拖动中光标离开控制条：照常排隐藏，但拖动期间不藏
    await controlBar().trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(3000);
    expect(controlBar().classes()).not.toContain("hidden");
    // 滑块在面板外松开：文档级 mouseup 收尾
    document.dispatchEvent(new MouseEvent("mouseup"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(controlBar().classes()).toContain("hidden");
    wrapper.unmount();
  });

  it("缩放面板悬停显示、离开 180 ms 后收起；音量面板照旧", async () => {
    vi.useFakeTimers();
    const wrapper = mountWith(100);
    const [volume, zoom] = panels(wrapper);
    await zoom.trigger("mouseenter");
    expect(zoom.get(".slider-panel").classes()).toContain("visible");
    expect(volume.get(".slider-panel").classes()).not.toContain("visible");
    await zoom.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(179);
    expect(zoom.get(".slider-panel").classes()).toContain("visible");
    await vi.advanceTimersByTimeAsync(1);
    expect(zoom.get(".slider-panel").classes()).not.toContain("visible");
    await volume.trigger("mouseenter");
    expect(volume.get(".slider-panel").classes()).toContain("visible");
    wrapper.unmount();
  });
});

describe("VideoControls 视频上的点击", () => {
  it("单击切播放 / 暂停，双击不切全屏", async () => {
    const video = document.createElement("video");
    const play = vi.spyOn(video, "play").mockResolvedValue();
    const wrapper = mount(VideoControls, { props: { video } });
    video.dispatchEvent(new MouseEvent("click"));
    expect(play).toHaveBeenCalledOnce();
    video.dispatchEvent(new MouseEvent("dblclick"));
    expect(wrapper.emitted("toggle-fullscreen")).toBeUndefined();
    wrapper.unmount();
  });
});
