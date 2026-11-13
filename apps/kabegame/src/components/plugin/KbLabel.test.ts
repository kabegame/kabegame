// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import KbLabel from "./KbLabel.vue";

vi.mock("@/env", () => ({ IS_ANDROID: true }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// vi.mock 会被提升到导入之前，桩的构造放进 vi.hoisted
const { slotStub } = vi.hoisted(() => ({
  slotStub: (name: string) => ({ name, template: "<div><slot /></div>" }),
}));

vi.mock("@/components/ui", () => ({
  Popover: slotStub("Popover"),
  PopoverContent: slotStub("PopoverContent"),
  Tooltip: slotStub("Tooltip"),
}));
vi.mock("reka-ui", () => ({ PopoverTrigger: slotStub("PopoverTrigger") }));

describe("KbLabel", () => {
  it("Android 点按弹出说明气泡（Reka 的 Tooltip 不响应点按），触发器是可点的按钮", () => {
    const wrapper = mount(KbLabel, { props: { label: { id: "auth.needProxy" } } });

    expect(wrapper.findComponent({ name: "Popover" }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: "Tooltip" }).exists()).toBe(false);
    expect(wrapper.find("button.kb-label").exists()).toBe(true);
    wrapper.unmount();
  });

  it("没有标签时渲染等宽空槽", () => {
    const wrapper = mount(KbLabel, { props: { label: null } });
    expect(wrapper.find(".kb-label-empty").exists()).toBe(true);
    wrapper.unmount();
  });
});
