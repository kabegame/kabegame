// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it, vi } from "vitest";
import KameToolboxBubble from "./KameToolboxBubble.vue";

// 自定义条目（整理、清理隐藏、检查更新）做完自己的事后 emit("done")，工具箱据此关闭
const CustomTool = defineComponent({
  name: "CustomTool",
  emits: ["done"],
  template: '<button type="button" class="custom-tool" @click="$emit(\'done\')">整理</button>',
});

// 只替换 useI18n；其它导出保留真实实现：导入链上的 utils/backfillName.ts 在模块加载时就读 i18n.global
vi.mock(import("@kabegame/i18n"), async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: (() => ({ t: (key: string) => key })) as never,
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
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/composables/useBusyTasks", () => ({
  useBusyTasks: () => ({ count: 0, hasUnseenFailure: false }),
}));

describe("KameToolboxBubble", () => {
  it("点击自定义工具项后关闭气泡", async () => {
    const wrapper = mount(KameToolboxBubble, {
      props: { visible: true },
      global: {
        stubs: {
          Transition: false,
          BusyTasksSection: true,
        },
      },
    });

    await wrapper.get(".custom-tool").trigger("click");

    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
