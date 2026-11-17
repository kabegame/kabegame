// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PreviewSpeedControl, { formatRate, PREVIEW_SPEED_PRESETS } from "./PreviewSpeedControl.vue";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PreviewSpeedControl", () => {
  it("档位在 0.25–4 之间、含 1；倍数去掉多余的 0", () => {
    expect(PREVIEW_SPEED_PRESETS[0]).toBe(0.25);
    expect(PREVIEW_SPEED_PRESETS[PREVIEW_SPEED_PRESETS.length - 1]).toBe(4);
    expect(PREVIEW_SPEED_PRESETS).toContain(1);
    expect([formatRate(1), formatRate(1.25), formatRate(0.5), formatRate(4)]).toEqual(["1×", "1.25×", "0.5×", "4×"]);
  });

  it("按钮显示当前倍数，点它回到 1×；选档位报新值、当前档位标出", async () => {
    const wrapper = mount(PreviewSpeedControl, { props: { modelValue: 2 } });
    const button = wrapper.find('[data-testid="preview-speed-button"]');
    expect(button.text()).toBe("2×");
    await button.trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[1]]);
    const option = (rate: number) => wrapper.find(`[data-rate="${rate}"]`);
    expect(option(2).classes()).toContain("selected");
    expect(option(2).attributes("aria-selected")).toBe("true");
    await option(0.25).trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([0.25]);
  });

  it("悬停出面板、离开 180 ms 后收起，期间报 active", async () => {
    const wrapper = mount(PreviewSpeedControl, { props: { modelValue: 1 } });
    const panel = () => wrapper.find('[data-testid="preview-speed-panel"]');
    expect(panel().classes()).not.toContain("visible");
    await wrapper.trigger("mouseenter");
    expect(panel().classes()).toContain("visible");
    expect(wrapper.emitted("active")).toEqual([[true]]);
    await wrapper.trigger("mouseleave");
    vi.advanceTimersByTime(100);
    await wrapper.vm.$nextTick();
    expect(panel().classes()).toContain("visible");
    vi.advanceTimersByTime(100);
    await wrapper.vm.$nextTick();
    expect(panel().classes()).not.toContain("visible");
    expect(wrapper.emitted("active")?.at(-1)).toEqual([false]);
  });
});
