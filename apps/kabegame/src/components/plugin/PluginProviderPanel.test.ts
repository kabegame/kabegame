// @vitest-environment happy-dom

import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@/stores/plugins";
import PluginProviderPanel from "./PluginProviderPanel.vue";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../api", () => ({ invoke }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const plugin: Plugin = {
  id: "test/id",
  version: "1.2.3",
  name: {},
  description: {},
  baseUrl: "",
  sizeBytes: 0,
  config: {},
};

beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (_command, { path }) =>
      path.endsWith("/provider") ? [{ name: "entry/provider" }] : [{ name: "entry/provider", source: "DSL" }],
    );
});

describe("PluginProviderPanel 来源坐标", () => {
  it.each([
    [undefined, "installed"],
    [{ kind: "installed" }, "installed"],
    [{ kind: "store", sourceId: "store/id" }, "byStore/store%2Fid"],
    [{ kind: "preview", token: "secret/token" }, "byPreview/secret%2Ftoken"],
  ] as const)("按 %j 读取摘要与源文，并编码每个路径段", async (fileOrigin, prefix) => {
    const wrapper = shallowMount(PluginProviderPanel, { props: { plugin: { ...plugin, fileOrigin } } });
    await flushPromises();
    expect(invoke.mock.calls.map(([, args]) => args.path)).toEqual([
      `plugin://${prefix}/test%2Fid/1.2.3/provider`,
      `plugin://${prefix}/test%2Fid/1.2.3/provider/entry%2Fprovider`,
    ]);
    expect(wrapper.emitted("loaded")).toEqual([[1]]);
    expect(wrapper.html()).not.toContain("providerInstallFirst");
    wrapper.unmount();
  });

  it("切换来源或版本后忽略旧摘要响应", async () => {
    let finish!: (rows: unknown[]) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = shallowMount(PluginProviderPanel, { props: { plugin } });
    await wrapper.setProps({ plugin: { ...plugin, version: "2.0.0", fileOrigin: { kind: "store", sourceId: "s" } } });
    await flushPromises();
    finish([{ name: "obsolete" }]);
    await flushPromises();
    expect(wrapper.emitted("loaded")).toEqual([[1]]);
    expect(wrapper.html()).not.toContain("providerInstallFirst");
    expect(invoke.mock.calls.map(([, args]) => args.path)).not.toContain(
      "plugin://byStore/s/test%2Fid/2.0.0/provider/obsolete",
    );
    wrapper.unmount();
  });
});
