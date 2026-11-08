/**
 * P4b 步骤 6 的编译侧单测：`instanceoverride.colorn` 经 `compileScene` 的取值、绑定登记、场景 `version` 门控（`0x200000`）
 * 与能力表（rea-p4b-render.md 7.1、7.4，计划 phase-4b-tier2.md「步骤 6」点 2、4、5）。模拟器一侧在 `particles/colorn.test.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneBinding } from "./bindings";
import { compileScene, passthroughMaterial } from "./bundle";
import type { SceneReader } from "./fs";
import { observePropertyReads, type JsonObject } from "./model";
import { SceneState } from "../render/state";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const f32 = Math.fround;

/** 内存文件：字符串原样，其它按 JSON（同 p4a5.test.ts）。 */
function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate() {
    return { ok: true };
  },
} as unknown as Wpesl2wgsl;

const PROPERTIES = { c: { type: "color", value: "0 0 1" }, k: { type: "combo", value: "1" } };
const SYSTEMS: Record<string, JsonObject> = {
  plain: {},
  random: { initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }] },
  change: { operator: [{ name: "colorchange", startvalue: "1 0 0", endvalue: "0 0 1" }] },
  masked: { flags: 8, initializer: [{ name: "colorrandom", min: "255 0 0", max: "255 0 0" }] },
};

function compile(scene: { version?: unknown; overrides: Record<string, JsonObject> }) {
  const objects = Object.entries(scene.overrides).map(([system, instanceoverride], i) => ({
    id: 10 + i,
    particle: `particles/${system}.json`,
    instanceoverride,
  }));
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json", general: { properties: PROPERTIES } },
    "P:/p/scene.json": {
      ...(scene.version === undefined ? {} : { version: scene.version }),
      general: ORTHO,
      objects,
    },
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["_rt_FullFrameBuffer"] }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
  };
  for (const [name, json] of Object.entries(SYSTEMS))
    files[`P:/p/particles/${name}.json`] = {
      material: "materials/pm.json",
      maxcount: 4,
      emitter: [{ name: "sphererandom", rate: 1 }],
      ...json,
    };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("compileScene：系统色与 0x200000 看场景 version", () => {
  const flagOf = async (version: unknown, system = "random") =>
    (await compile({ version, overrides: { [system]: { colorn: "0 1 0" } } })).layers[0].particle!.colorSystem;

  it('有颜色模块：version 3、4 与缺键（按 0）置，5、6 不置；非数字（字符串 "5"）按 0', async () => {
    for (const version of [3, 4, undefined, "5", null])
      expect((await flagOf(version)).instanceColor, String(version)).toBe(true);
    for (const version of [5, 6]) expect((await flagOf(version)).instanceColor, String(version)).toBe(false);
  });

  it("没有颜色模块：任何 version 都置；系统色来自颜色模块（不读对象或粒子 JSON 上的 colorn）", async () => {
    for (const version of [0, 5])
      expect(await flagOf(version, "plain")).toEqual({ rgb: [1, 1, 1], instanceColor: true });
    expect((await flagOf(5, "random")).rgb).toEqual([1, 0, 0]);
    expect((await flagOf(5, "change")).rgb).toEqual([1, 0, 0]);
  });

  it("passthrough 材质与粒子共用同一个 version 取值（缺键、非数字按 0）", () => {
    expect(passthroughMaterial("5")).toBe("materials/util/effectpassthrough.json");
    expect(passthroughMaterial(Number.NaN)).toBe("materials/util/effectpassthrough.json");
    expect(passthroughMaterial(5)).toBe("materials/util/effectpassthrough_4.json");
  });
});

describe("compileScene：colorn 的取值、绑定与能力表", () => {
  const instanceBindings = (bindings: readonly SceneBinding[]) =>
    bindings.filter((binding) => binding.target.kind === "particle-instance");

  it("静态 colorn、color 都不再报 particle:instance:colorn；color ÷255 后 %.5f，两个都写时取 color", async () => {
    const bundle = await compile({
      version: 3,
      overrides: {
        random: { colorn: "0 1 0" },
        change: { color: "100 255 0" },
        plain: { color: "0 0 255", colorn: "1 0 0" },
      },
    });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.particle!.instance.colorn)).toEqual([
      [0, 1, 0],
      [f32(0.39216), 1, 0],
      [0, 0, 1],
    ]);
    expect(instanceBindings(bundle.bindings)).toEqual([]);
  });

  it("colorn 绑颜色属性：登记成就地目标，值取用户属性；SceneState 起始值相同", async () => {
    const read = new Set<string>();
    observePropertyReads((name) => read.add(name));
    let bundle;
    try {
      bundle = await compile({ version: 5, overrides: { random: { colorn: { user: "c", value: "0 1 0" } } } });
    } finally {
      observePropertyReads(null);
    }
    expect(bundle.unsupported).toEqual([]);
    expect(instanceBindings(bundle.bindings)).toEqual([
      { property: "c", target: { kind: "particle-instance", object: 0, field: "colorn" } },
    ]);
    expect(bundle.layers[0].particle!.instance.colorn).toEqual([0, 0, 1]);
    expect(SceneState.fromBundle(bundle).particleInstances.get(0)!.colorn).toEqual([0, 0, 1]);
    // 漏登记 = 改了没反应
    expect([...read]).toEqual(["c"]);
  });

  it("两个键都写、colorn 绑了属性：取 color，colorn 的绑定随之丢掉、不登记也不读属性", async () => {
    const read = new Set<string>();
    observePropertyReads((name) => read.add(name));
    let bundle;
    try {
      bundle = await compile({ overrides: { random: { color: "0 255 0", colorn: { user: "c", value: "1 0 0" } } } });
    } finally {
      observePropertyReads(null);
    }
    expect(bundle.layers[0].particle!.instance.colorn).toEqual([0, 1, 0]);
    expect(instanceBindings(bundle.bindings)).toEqual([]);
    expect([...read]).toEqual([]);
  });

  it("color 绑属性报 color:user（只取静态值、不登记）；colorn 带 condition 报 colorn:condition；bit3 时都不报", async () => {
    const color = await compile({ overrides: { random: { color: { user: "c", value: "255 0 0" } } } });
    expect(color.unsupported).toEqual(["particle:instance:color:user"]);
    expect(color.layers[0].particle!.instance.colorn).toEqual([1, 0, 0]);
    expect(instanceBindings(color.bindings)).toEqual([]);
    const condition = await compile({
      overrides: { random: { colorn: { user: { name: "k", condition: "1" }, value: "0 1 0" } } },
    });
    expect(condition.unsupported).toEqual(["particle:instance:colorn:condition"]);
    const masked = await compile({
      overrides: {
        masked: { color: { user: "c", value: "255 0 0" } },
      },
    });
    expect(masked.unsupported).toEqual([]);
    const maskedCondition = await compile({
      overrides: { masked: { colorn: { user: { name: "k", condition: "1" }, value: "0 1 0" } } },
    });
    expect(maskedCondition.unsupported).toEqual([]);
  });
});
