// @vitest-environment happy-dom

import { shallowMount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PluginVarsForm from "./PluginVarsForm.vue";

vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
  usePluginConfigI18n: () => ({
    varDisplayName: (def: { key: string }) => def.key,
    varDescripts: () => "",
    optionDisplayName: (option: { variable: string }) => option.variable,
  }),
}));

vi.mock("../../stores/ui", () => ({
  useUiStore: () => ({ isCompact: false }),
}));

const conditionalVar = {
  key: "quality",
  type: "options",
  name: "quality",
  when: { backend: ["v8"] },
  options: [
    { name: "Always", variable: "always" },
    { name: "V8 only", variable: "v8-only", when: { backend: ["v8"] } },
  ],
};

function renderedOptions(ignoreWhen = false) {
  const wrapper = shallowMount(PluginVarsForm, {
    props: {
      pluginVars: [conditionalVar],
      modelValue: { backend: "webview", quality: "always" },
      ignoreWhen,
    },
  });
  const options = wrapper.getComponent({ name: "PluginVar" }).props("options");
  wrapper.unmount();
  return options;
}

describe("PluginVarsForm when 处理", () => {
  it("默认按当前配置过滤带 when 的候选值", () => {
    expect(renderedOptions()).toEqual([{ name: "always", variable: "always" }]);
  });

  it("ignoreWhen 开启时展示插件声明的全部候选值", () => {
    expect(renderedOptions(true)).toEqual([
      { name: "always", variable: "always" },
      { name: "v8-only", variable: "v8-only" },
    ]);
  });

  it("ignoreWhen 开启时将当前不满足 when 的字段降低至 80% 不透明度", () => {
    const wrapper = shallowMount(PluginVarsForm, {
      props: {
        pluginVars: [conditionalVar],
        modelValue: { backend: "webview", quality: "always" },
        ignoreWhen: true,
      },
    });

    const ignoredItem = wrapper.get(".opacity-40");
    expect(ignoredItem.classes()).toEqual(expect.arrayContaining(["transition-opacity", "duration-200", "ease-out"]));
  });
});
