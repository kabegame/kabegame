// @vitest-environment happy-dom
import { DOMWrapper, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "vue";
import KbFilterDropdown from "./FilterDropdown.vue";
import { kbFilterDropdownContextKey, type KbFilterDropdownOption } from "./filterDropdown";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useModalBack", () => ({ useModalBack: vi.fn() }));

/**
 * 过滤 chip 下拉的可展开选项（`expandable` + `option-panel` 插槽）与键盘导航。
 * 面板经 Portal 挂到 body 上，在 document.body 里找；开合经点 chip 驱动。
 */
const options: KbFilterDropdownOption[] = [
  { label: "时间", value: "by-time" },
  { label: "颜色", value: "by-color", expandable: true },
  { label: "随机", value: "random" },
];

const wrappers: ReturnType<typeof mount>[] = [];
function render(modelValue = "by-time") {
  const wrapper = mount(KbFilterDropdown, {
    props: { modelValue, options, chipLabel: "排序", clearable: false },
    slots: {
      "option-panel": ({ option, close }: { option: KbFilterDropdownOption; close: () => void }) =>
        h("div", { class: "probe" }, [
          h("span", { class: "probe-value" }, option.value),
          h("input", { class: "probe-input" }),
          h("button", { class: "probe-close", type: "button", onClick: close }, "选好了"),
        ]),
    },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function setOpen(wrapper: ReturnType<typeof mount>, open: boolean) {
  const chip = wrapper.get('[role="button"]');
  if ((chip.attributes("aria-expanded") === "true") !== open) await chip.trigger("click");
  await wrapper.vm.$nextTick();
}
const body = () => new DOMWrapper(document.body);
const optionButton = (_wrapper: ReturnType<typeof mount>, index: number) =>
  body().get(`[data-kb-filter-index="${index}"]`);

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("FilterDropdown 可展开选项", () => {
  it("点可展开的选项只切换展开：不 emit、不关闭，插槽拿到该选项", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    expect(body().find(".probe").exists()).toBe(false);
    expect(optionButton(wrapper, 1).attributes("aria-expanded")).toBe("false");
    // 不可展开的选项不带 aria-expanded
    expect(optionButton(wrapper, 0).attributes("aria-expanded")).toBeUndefined();

    await optionButton(wrapper, 1).trigger("click");
    expect(body().get(".probe-value").text()).toBe("by-color");
    expect(optionButton(wrapper, 1).attributes("aria-expanded")).toBe("true");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();

    await optionButton(wrapper, 1).trigger("click");
    expect(body().find(".probe").exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("展开区紧跟在它的选项下面", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    await optionButton(wrapper, 1).trigger("click");
    const list = body().get('[role="listbox"]').element;
    const children = Array.from(list.children);
    const panelIndex = children.findIndex((el) => el.querySelector(".probe"));
    expect(children[panelIndex - 1]).toBe(optionButton(wrapper, 1).element);
    expect(children[panelIndex + 1]).toBe(optionButton(wrapper, 2).element);
  });

  it("普通选项照常选中并关闭", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    await optionButton(wrapper, 2).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["random"]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("插槽的 close 关掉整个下拉；重新打开时是收起的", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    await optionButton(wrapper, 1).trigger("click");
    await body().get(".probe-close").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();

    await setOpen(wrapper, true);
    expect(body().find(".probe").exists()).toBe(false);
    expect(optionButton(wrapper, 1).attributes("aria-expanded")).toBe("false");
  });

  it("当前值是可展开选项时该行照常高亮", async () => {
    const wrapper = render("by-color");
    await setOpen(wrapper, true);
    expect(optionButton(wrapper, 1).classes()).toContain("is-selected");
    expect(optionButton(wrapper, 1).attributes("aria-selected")).toBe("true");
  });

  it("键盘：回车与空格在高亮的可展开选项上切换展开", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    const panel = body().get("[data-kb-filter-panel]");
    await panel.trigger("keydown", { key: "ArrowDown" });
    expect(optionButton(wrapper, 1).classes()).toContain("is-highlighted");

    await panel.trigger("keydown", { key: "Enter" });
    expect(body().find(".probe").exists()).toBe(true);
    await panel.trigger("keydown", { key: " " });
    expect(body().find(".probe").exists()).toBe(false);
    await panel.trigger("keydown", { key: " " });
    expect(body().find(".probe").exists()).toBe(true);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();

    // 高亮在普通选项上时回车仍是选中；空格不接管
    await panel.trigger("keydown", { key: "ArrowDown" });
    await panel.trigger("keydown", { key: " " });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    await panel.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")).toEqual([["random"]]);
  });

  it("展开区里的按键归面板内容：回车不会选中高亮行，Escape 仍关闭下拉", async () => {
    const wrapper = render();
    await setOpen(wrapper, true);
    await optionButton(wrapper, 1).trigger("mouseenter");
    await optionButton(wrapper, 1).trigger("click");
    const input = body().get(".probe-input");
    await input.trigger("keydown", { key: "Enter" });
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: " " });
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(body().find(".probe").exists()).toBe(true);
    expect(optionButton(wrapper, 1).classes()).toContain("is-highlighted");

    await input.trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

describe("FilterDropdown 对话框档（紧凑布局）", () => {
  it("点 chip 打开对话框，面板在对话框里；选中后关闭", async () => {
    const wrapper = mount(KbFilterDropdown, {
      props: { modelValue: "by-time", options, chipLabel: "排序", clearable: false },
      global: { provide: { [kbFilterDropdownContextKey as symbol]: { panelMode: "dialog" } } },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    expect(body().find("[data-kb-filter-panel]").exists()).toBe(false);
    await wrapper.get('[role="button"]').trigger("click");
    const dialog = body().get('[role="dialog"]');
    expect(dialog.text()).toContain("排序");
    expect(dialog.find("[data-kb-filter-panel]").exists()).toBe(true);
    expect(wrapper.emitted("open")).toHaveLength(1);

    await optionButton(wrapper, 2).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["random"]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
