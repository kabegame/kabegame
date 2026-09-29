// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it, vi } from "vitest";
import KameToolboxBubble from "./KameToolboxBubble.vue";

const CustomTool = defineComponent({
  name: "CustomTool",
  template: '<button type="button">整理</button>',
});

vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/header/globalToolsRegistry", () => ({
  useGlobalTools: () => ({
    groups: [
      {
        id: "maintenance",
        title: "maintenance",
        items: [
          {
            id: "organize",
            group: "maintenance",
            label: "整理",
            comp: CustomTool,
            kind: "action",
          },
        ],
      },
    ],
  }),
}));
vi.mock("@/composables/useBusyTasks", () => ({
  useBusyTasks: () => ({ count: 0, hasUnseenFailure: false }),
}));

describe("KameToolboxBubble", () => {
  it("点击自定义工具项后关闭气泡", async () => {
    const wrapper = shallowMount(KameToolboxBubble, {
      props: { visible: true },
      global: {
        stubs: {
          Transition: false,
          BusyTasksSection: true,
          ElIcon: true,
          ElSwitch: true,
        },
      },
    });

    await wrapper.get(".tool-row-comp").trigger("click");

    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
