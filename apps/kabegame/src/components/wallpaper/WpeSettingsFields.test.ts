// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WpeSettingsFields from "./WpeSettingsFields.vue";
import { WPE_SETTING_DEFAULTS } from "@/utils/wpeSettings";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const confirm = vi.hoisted(() => ({ result: true, calls: 0 }));
vi.mock("@/utils/wpeForceRender", () => ({
  confirmWpeForceRender: async () => {
    confirm.calls += 1;
    return confirm.result;
  },
}));

/** 控件桩：测试里直接发 update */
const ControlStub = defineComponent({
  name: "WpeSettingControl",
  props: { settingKey: String },
  emits: ["update"],
  setup: () => () => h("div"),
});

function mountFields(variant: "settings" | "panel") {
  return mount(WpeSettingsFields, {
    props: {
      fields: ["forceRender", "mediaIntegration"],
      values: { ...WPE_SETTING_DEFAULTS },
      followAvailable: false,
      variant,
    },
    global: {
      stubs: {
        WpeSettingControl: ControlStub,
        SettingRow: defineComponent({
          setup:
            (_, { slots }) =>
            () =>
              h("div", slots.default?.()),
        }),
      },
    },
  });
}

const control = (wrapper: ReturnType<typeof mountFields>, key: string) =>
  wrapper.findAllComponents(ControlStub).find((item) => item.props("settingKey") === key)!;

beforeEach(() => {
  confirm.result = true;
  confirm.calls = 0;
});

describe("WpeSettingsFields 打开强制渲染先确认", () => {
  for (const variant of ["settings", "panel"] as const) {
    it(`${variant}：打开先确认，确认了才报；取消不报；关掉与别的字段不确认`, async () => {
      const wrapper = mountFields(variant);
      control(wrapper, "forceRender").vm.$emit("update", "forceRender", true);
      await flushPromises();
      expect(confirm.calls).toBe(1);
      expect(wrapper.emitted("update")).toEqual([["forceRender", true]]);

      confirm.result = false;
      control(wrapper, "forceRender").vm.$emit("update", "forceRender", true);
      await flushPromises();
      expect(confirm.calls).toBe(2);
      expect(wrapper.emitted("update")).toHaveLength(1);

      control(wrapper, "forceRender").vm.$emit("update", "forceRender", false);
      control(wrapper, "mediaIntegration").vm.$emit("update", "mediaIntegration", true);
      await flushPromises();
      expect(confirm.calls).toBe(2);
      expect(wrapper.emitted("update")).toEqual([
        ["forceRender", true],
        ["forceRender", false],
        ["mediaIntegration", true],
      ]);
    });
  }
});
