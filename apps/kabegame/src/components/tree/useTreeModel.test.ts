// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it } from "vitest";
import { useTreeModel, type TreeModel } from "./useTreeModel";
import type { TreeDataSource } from "./types";

interface ElementSnapshot {
  id: string;
  count: number;
}

describe("useTreeModel 快照同步", () => {
  it("子项 key 不变时保留句柄并替换 element", async () => {
    let children: ElementSnapshot[] = [{ id: "child", count: 1 }];
    const dataSource: TreeDataSource<ElementSnapshot> = {
      getKey: (element) => element.id,
      hasChildren: (element) => element.id === "root",
      getChildren: async () => children,
    };
    let model!: TreeModel<ElementSnapshot>;
    const wrapper = mount(
      defineComponent({
        setup() {
          model = useTreeModel({
            dataSource,
            sections: () => [{ id: "test", roots: () => [{ id: "root", count: 0 }] }],
            defaultExpanded: (element) => element.id === "root",
          });
          return () => null;
        },
      }),
    );

    try {
      await flushPromises();
      const original = model.nodeByKey("child");
      expect(original?.element.count).toBe(1);

      children = [{ id: "child", count: 8 }];
      await model.refreshChildren("root");

      expect(model.nodeByKey("child")).toBe(original);
      expect(original?.element.count).toBe(8);
    } finally {
      wrapper.unmount();
    }
  });
});
