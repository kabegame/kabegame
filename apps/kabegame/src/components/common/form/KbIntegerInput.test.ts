// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import KbIntegerInput from "./KbIntegerInput.vue";

const validate = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@kabegame/element-plus", () => ({
  useFormItem: () => ({ formItem: { validate } }),
}));

vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  validate.mockClear();
});

describe("KbIntegerInput", () => {
  it("在上下限处禁用对应按钮，并通过按钮按 1 步进", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 3, min: 1, max: 3 },
    });
    const [decrease, increase] = wrapper.findAll("button");

    expect(decrease.attributes("disabled")).toBeUndefined();
    expect(increase.attributes()).toHaveProperty("disabled");

    await decrease.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([2]);
  });

  it("键盘输入合法整数时发送 number", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 2, min: 1, max: 10 },
    });

    await wrapper.get("input").setValue("4");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([4]);
  });

  it("非法键盘输入发送并保留原始文本，失焦也不修正", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 2, min: 1, max: 10 },
    });
    const input = wrapper.get("input");

    await input.setValue("1.5");
    await input.trigger("blur");

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["1.5"]);
    expect(input.element.value).toBe("1.5");
  });

  it("modelValue 每次变化只触发一次 change 校验", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 2, min: 1, max: 10 },
    });

    await wrapper.setProps({ modelValue: "bad" });
    await nextTick();

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith("change");
  });

  it("按 step 步进并 clamp 到边界，同时发出 change", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 1435, min: 1, max: 1440, step: 10 },
    });
    const [, increase] = wrapper.findAll("button");

    await increase.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([1440]);
    expect(wrapper.emitted("change")?.at(-1)).toEqual([1440]);
  });

  it("失焦时 change 发 clamp 后的值，非法文本发 undefined，且不改写 modelValue", async () => {
    const wrapper = mount(KbIntegerInput, {
      props: { modelValue: 2, min: 1, max: 10 },
    });
    const input = wrapper.get("input");

    await input.setValue("99");
    await input.trigger("blur");
    expect(wrapper.emitted("change")?.at(-1)).toEqual([10]);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([99]);

    await input.setValue("abc");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("change")?.at(-1)).toEqual([undefined]);
  });
});
