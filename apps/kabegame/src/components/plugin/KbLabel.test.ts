// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import KbLabel from "./KbLabel.vue";

vi.mock("@/env", () => ({ IS_ANDROID: true }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("KbLabel", () => {
  it("Android 用立即生效的 click Tooltip，避免触摸抬起触发 mouseleave 后消失", () => {
    const wrapper = shallowMount(KbLabel, {
      props: { label: { id: "auth.needProxy" } },
    });

    const tooltip = wrapper.getComponent({ name: "ElTooltip" });
    expect(tooltip.props("trigger")).toBe("click");
    expect(tooltip.props("showAfter")).toBe(0);
    wrapper.unmount();
  });
});
