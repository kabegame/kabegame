// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PreviewRangeSlider from "./PreviewRangeSlider.vue";

describe("PreviewRangeSlider 键盘行为", () => {
  it.each(["ArrowLeft", "ArrowRight"])(
    "阻止 %s 触发原生 range 调整",
    (key) => {
      const wrapper = mount(PreviewRangeSlider, {
        props: { modelValue: 50 },
      });
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });

      wrapper.element.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    },
  );

  it("不阻止其他方向键的原生行为", () => {
    const wrapper = mount(PreviewRangeSlider, {
      props: { modelValue: 50 },
    });
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });

    wrapper.element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});
