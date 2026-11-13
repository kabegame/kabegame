// @vitest-environment happy-dom
/**
 * 自由输入补全的键盘语义：回车默认提交原文，只有方向键选中候选后回车才是选候选；失焦收起。
 */
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, defineComponent, h, nextTick, ref } from "vue";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import Autocomplete from "./Autocomplete.vue";

const wrappers: { unmount: () => void }[] = [];

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body.innerHTML = "";
});

function mountHost() {
  const text = ref("");
  const selected: string[] = [];
  const submitted: string[] = [];
  const all = ["pixiv.net", "pixai.art", "wallhaven.cc"];
  const Host = defineComponent({
    setup() {
      const items = computed(() => all.filter((x) => x.includes(text.value)));
      return () =>
        h(Autocomplete<string>, {
          modelValue: text.value,
          "onUpdate:modelValue": (v: string) => (text.value = v),
          items: items.value,
          onSelect: (item: string) => selected.push(item),
          onSubmit: (value: string) => submitted.push(value),
        });
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  wrappers.push(wrapper);
  const input = wrapper.get("input");
  return { wrapper, input, text, selected, submitted };
}

describe("Autocomplete", () => {
  it("打字后直接回车提交原文，不选第一条候选", async () => {
    const { input, selected, submitted } = mountHost();
    await input.trigger("focus");
    await input.setValue("pix");
    await nextTick();
    expect(document.querySelectorAll("[role=option]").length).toBe(2);
    expect(input.attributes("aria-activedescendant")).toBeUndefined();
    await input.trigger("keydown", { key: "Enter" });
    expect(submitted).toEqual(["pix"]);
    expect(selected).toEqual([]);
    expect(input.attributes("aria-expanded")).toBe("false");
  });

  it("方向键选中后回车选候选；↑ 从末尾开始、循环", async () => {
    const { input, selected, submitted } = mountHost();
    await input.trigger("focus");
    await input.setValue("pix");
    await input.trigger("keydown", { key: "ArrowUp" });
    expect(document.querySelector("[data-highlighted]")?.textContent).toBe("pixai.art");
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(document.querySelector("[data-highlighted]")?.textContent).toBe("pixiv.net");
    await input.trigger("keydown", { key: "Enter" });
    expect(selected).toEqual(["pixiv.net"]);
    expect(submitted).toEqual([]);
  });

  it("重新打字清掉键盘高亮；失焦收起", async () => {
    const { input, submitted } = mountHost();
    await input.trigger("focus");
    await input.setValue("p");
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.setValue("pixa");
    await nextTick();
    expect(document.querySelector("[data-highlighted]")).toBeNull();
    await input.trigger("keydown", { key: "Enter" });
    expect(submitted).toEqual(["pixa"]);

    await input.trigger("focus");
    expect(input.attributes("aria-expanded")).toBe("true");
    await input.trigger("blur");
    expect(input.attributes("aria-expanded")).toBe("false");
  });

  it("没有候选时不展开", async () => {
    const { input } = mountHost();
    await input.trigger("focus");
    await input.setValue("zzz");
    expect(input.attributes("aria-expanded")).toBe("false");
    expect(document.querySelector("[role=listbox]")).toBeNull();
  });
});
