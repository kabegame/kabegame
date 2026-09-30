// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import KbTreeRow from "./KbTreeRow.vue";

function mountRow(props: Partial<InstanceType<typeof KbTreeRow>["$props"]> = {}) {
  return shallowMount(KbTreeRow, {
    props: { depth: 0, ...props },
    global: { stubs: { ElIcon: true } },
  });
}

describe("KbTreeRow", () => {
  it("只给可点击且未禁用的节点添加悬浮提示类", async () => {
    const wrapper = mountRow({ clickable: true });

    expect(wrapper.classes()).toContain("kb-tree-row--clickable");

    await wrapper.setProps({ clickable: false });
    expect(wrapper.classes()).not.toContain("kb-tree-row--clickable");

    await wrapper.setProps({ clickable: true, disabled: true });
    expect(wrapper.classes()).not.toContain("kb-tree-row--clickable");
  });

  it("clickable 只控制视觉提示，不改变普通行的点击事件", async () => {
    const wrapper = mountRow({ clickable: false });

    await wrapper.trigger("click");
    await wrapper.trigger("dblclick");

    expect(wrapper.emitted("row-click")).toHaveLength(1);
    expect(wrapper.emitted("row-dblclick")).toHaveLength(1);
  });

  it("点击展开图标只触发 toggle，不触发行点击", async () => {
    const wrapper = mountRow({ clickable: true, expandable: true });
    const twistie = wrapper.get("[data-kb-tree-twistie]");

    expect(twistie.attributes("disabled")).toBeUndefined();
    await twistie.trigger("click");

    expect(wrapper.emitted("toggle")).toHaveLength(1);
    expect(wrapper.emitted("row-click")).toBeUndefined();
  });

  it("禁用节点不响应行点击、双击或展开", async () => {
    const wrapper = mountRow({ clickable: true, expandable: true, disabled: true });
    const twistie = wrapper.get("[data-kb-tree-twistie]");

    expect(wrapper.attributes("aria-disabled")).toBe("true");
    expect(twistie.attributes()).toHaveProperty("disabled");

    await wrapper.trigger("click");
    await wrapper.trigger("dblclick");
    await twistie.trigger("click");

    expect(wrapper.emitted("row-click")).toBeUndefined();
    expect(wrapper.emitted("row-dblclick")).toBeUndefined();
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });
});
