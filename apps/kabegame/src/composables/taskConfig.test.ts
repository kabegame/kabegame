import { describe, expect, it, vi } from "vitest";
import type { PluginVarDef } from "@/utils/pluginVarForm";

vi.mock("@/stores/crawler", () => ({
  useCrawlerStore: () => ({ setTaskConfig: vi.fn() }),
}));
vi.mock("@/stores/plugins", () => ({
  usePluginStore: () => ({ plugins: [], loadPlugins: vi.fn() }),
}));
vi.mock("@/composables/usePluginConfig", () => ({
  fetchPluginUserDefault: vi.fn(async () => null),
}));

import { buildSubmitUserConfig, resolveTaskConfig } from "./taskConfig";

const defs: PluginVarDef[] = [
  { key: "a", type: "string", name: "A", default: "defA" },
  { key: "n", type: "int", name: "N", default: 3 },
  { key: "c", type: "string", name: "C", default: "defC" },
  { key: "flag", type: "boolean", name: "F", default: false },
  { key: "tags", type: "checkbox", name: "T", options: ["x", "y"], default: ["x"] },
  { key: "mode", type: "options", name: "M", options: ["p", "q"], default: "p" },
  { key: "hidden", type: "string", name: "H", default: "h", when: { mode: ["q"] } },
];

describe("resolveTaskConfig", () => {
  it("vars 按 key 取 入参 > 用户默认 > 插件声明默认", () => {
    const result = resolveTaskConfig(
      { pluginId: "p", userConfig: { a: "inA" } },
      { userConfig: { a: "udA", n: 7 }, outputDir: "/ud", httpHeaders: { X: "1" } },
      defs,
    );
    expect(result.userConfig.a).toBe("inA");
    expect(result.userConfig.n).toBe(7);
    expect(result.userConfig.c).toBe("defC");
    expect(result.outputDir).toBe("/ud");
    expect(result.httpHeaders).toEqual({ X: "1" });
  });

  it("入参无效值回落到用户默认", () => {
    const result = resolveTaskConfig(
      { pluginId: "p", userConfig: { n: "not-a-number" } },
      { userConfig: { n: 9 }, outputDir: "", httpHeaders: {} },
      defs,
    );
    expect(result.userConfig.n).toBe(9);
  });

  it("显式 null 不补默认值", () => {
    const result = resolveTaskConfig({ pluginId: "p", userConfig: { c: null } }, null, defs);
    expect("c" in result.userConfig).toBe(false);
    expect(result.userConfig.a).toBe("defA");
  });

  it("outputDir/httpHeaders 整字段覆盖，空值不回落", () => {
    const result = resolveTaskConfig(
      { pluginId: "p", outputDir: "", httpHeaders: {} },
      { userConfig: {}, outputDir: "/ud", httpHeaders: { X: "1" } },
      defs,
    );
    expect(result.outputDir).toBe("");
    expect(result.httpHeaders).toEqual({});
  });

  it("插件不存在（无 var 定义）时 vars 为空", () => {
    const result = resolveTaskConfig(
      { pluginId: "missing", userConfig: { unknown: 1 }, outputDir: "/o" },
      { userConfig: { unknown: 1 }, outputDir: "/ud", httpHeaders: {} },
      [],
    );
    expect(result.userConfig).toEqual({});
  });

  it("outputAlbumId 缺省为 null，传入时保留", () => {
    expect(resolveTaskConfig({ pluginId: "p" }, null, defs).outputAlbumId).toBeNull();
    expect(resolveTaskConfig({ pluginId: "p", outputAlbumId: "alb" }, null, defs).outputAlbumId).toBe("alb");
  });
});

describe("buildSubmitUserConfig", () => {
  it("丢弃字段级 when 隐藏的字段，checkbox 转后端对象格式", () => {
    const out = buildSubmitUserConfig({ tags: { x: true, y: false }, mode: "p", hidden: "keep" }, defs);
    expect(out).not.toHaveProperty("hidden");
    expect(out.tags).toEqual({ x: true, y: false });
    expect(out.mode).toBe("p");
  });

  it("字段级 when 切换回来时原值仍在", () => {
    const out = buildSubmitUserConfig({ tags: ["x"], mode: "q", hidden: "keep" }, defs);
    expect(out.hidden).toBe("keep");
  });

  it("选项级 when 让当前值不可选时按回退值提交，且不修改入参", () => {
    const optionDefs: PluginVarDef[] = [
      { key: "dep", type: "boolean", name: "D", default: false },
      {
        key: "mode2",
        type: "options",
        name: "M2",
        default: "p",
        options: [
          { name: "P", variable: "p", when: { dep: [false] } },
          { name: "Q", variable: "q", when: { dep: [true] } },
        ],
      },
    ];
    const input = { dep: true, mode2: "p" };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = buildSubmitUserConfig(input, optionDefs);
    expect(out.mode2).toBe("q");
    expect(input).toEqual(snapshot);
  });

  it("不修改入参（含 checkbox 数组）", () => {
    const input = { tags: { x: true, y: false }, mode: "p" };
    const snapshot = JSON.parse(JSON.stringify(input));
    buildSubmitUserConfig(input, defs);
    expect(input).toEqual(snapshot);
  });
});
