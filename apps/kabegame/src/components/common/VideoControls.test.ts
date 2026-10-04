// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import VideoControls from "./VideoControls.vue";

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
