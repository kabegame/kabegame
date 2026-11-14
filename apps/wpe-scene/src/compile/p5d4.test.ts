/**
 * P5d 步骤 4（透明排序）的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 4」点 1、点 4）：
 * - `SceneLayer.sortClass`：各类对象照 WPE 加载时的规则（rea-p5-mesh 2.4 / 4.2、rea-p5-modelflags 1.4 / 2.1、rea-p6b-layout 1.1），
 *   含 additive、alphatocoverage、缺混合键、模型的混合网格、`fullscreen` / `projectlayer`（只认 JSON true）、组合层、带 effect 的图层、
 *   粒子、文本、形状，以及不画的对象不填；
 * - `SceneGeneral.transparentSorting`：只认 JSON 布尔 true；
 * - 能力表：布尔不报（透视、正交都一样），绑属性、挂脚本等别的写法照报 `general:transparentsorting`，`customsortorder` 照报。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, imageSortClass, isOpaqueBlending, type SceneBundle } from "./bundle";
import { checkSceneFeatures } from "./features";
import type { SceneReader } from "./fs";
import { mdlStride } from "./mdl";
import type { JsonObject, SceneJson } from "./model";
import { TEXT_MATERIALS } from "./texts";
import { transparentDrawOrder } from "../render/sortOrder";
import { SceneState } from "../render/state";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 内存工程 ————

/** mdl v23（照 `p5c.test.ts` 的编码，只写这里要用的：每个网格一个材质、位置 + uv 的四边形）。 */
function mdl(materials: string[]): Uint8Array {
  const out: number[] = [];
  const u32 = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const cstr = (text: string) => out.push(...new TextEncoder().encode(text), 0);
  const block = (bytes: Uint8Array) => {
    u32(bytes.length);
    out.push(...bytes);
  };
  cstr("MDLV0023");
  u32(0x9);
  u32(1);
  u32(materials.length);
  for (const material of materials) {
    cstr(material);
    u32(0);
    out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
    u32(0x9);
    block(new Uint8Array(4 * mdlStride(0x9)));
    block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
    out.push(0, 0);
    u32(0);
  }
  out.push(0);
  return new Uint8Array(out);
}

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value.slice();
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate(): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [], combos: [], attributes: [] } as unknown as TranslateResult;
  },
} as unknown as Wpesl2wgsl;

const ASSETS = "A:/assets";
const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
/** 混合 → 材质文件（`materials/<混合>.json`，缺混合键的叫 `materials/none.json`）。 */
const BLENDINGS = ["normal", "translucent", "additive", "alphatocoverage"] as const;

/** 工程里的文件：每种混合一份材质与图像模型，`models/<混合>.json`；网格材质同用这几份；粒子、文本、effect 的最小文件。 */
function projectFiles(scene: JsonObject, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json", general: { properties: { on: { type: "bool", value: true } } } },
    "P:/p/scene.json": scene,
    "P:/p/materials/none.json": { passes: [{ shader: "s" }] },
    "P:/p/models/none.json": { material: "materials/none.json" },
    "P:/p/shaders/s.vert": "void main(){}",
    "P:/p/shaders/s.frag": "void main(){}",
    // 粒子（`children.test.ts` 的最小系统）
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 4,
      emitter: [{ name: "sphererandom", rate: 1 }],
    },
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
    // effect：一个 translucent 的绘制 pass
    "P:/p/effects/fx/effect.json": { passes: [{ material: "materials/fx.json" }] },
    "P:/p/materials/fx.json": { passes: [{ shader: "s", blending: "translucent", textures: [null] }] },
    // 文本的四个宿主材质（WPE 自带，`texts.test.ts` 同）
    [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: { passes: [{ shader: "s", blending: "translucent" }] },
    [`${ASSETS}/${TEXT_MATERIALS.color}`]: { passes: [{ shader: "s", blending: "translucent" }] },
    [`${ASSETS}/${TEXT_MATERIALS.background}`]: { passes: [{ shader: "s", blending: "translucent" }] },
    [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: { passes: [{ shader: "s", blending: "normal" }] },
    ...extra,
  };
  for (const blending of BLENDINGS) {
    files[`P:/p/materials/${blending}.json`] = { passes: [{ shader: "s", blending }] };
    files[`P:/p/models/${blending}.json`] = { material: `materials/${blending}.json` };
  }
  return files;
}

async function compile(
  objects: JsonObject[],
  options: { general?: JsonObject; extra?: Record<string, unknown> } = {},
): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader(projectFiles({ general: options.general ?? {}, objects }, options.extra)),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

const image = (model: string, extra: JsonObject = {}): JsonObject => ({ image: model, origin: "0 0 0", ...extra });
const sortClasses = (bundle: SceneBundle) => bundle.layers.map((layer) => layer.sortClass);

// ———— sortClass ————

describe("isOpaqueBlending / imageSortClass", () => {
  it("normal、alphatocoverage 不透明；translucent、additive、缺键、不认识的都不是（同 `meshDrawOrder` 的判定）", () => {
    expect(BLENDINGS.map(isOpaqueBlending)).toEqual([true, false, false, true]);
    expect(isOpaqueBlending(undefined)).toBe(false);
    expect(isOpaqueBlending("Normal")).toBe(false);
  });

  it("不透明的图层带标志也是 opaque；半透明的带标志是 last、不带是 translucent", () => {
    expect(imageSortClass("normal", true)).toBe("opaque");
    expect(imageSortClass("alphatocoverage", true)).toBe("opaque");
    expect(imageSortClass("translucent", false)).toBe("translucent");
    expect(imageSortClass("additive", true)).toBe("last");
  });
});

describe("compileScene：图像层的 sortClass 看基础材质第一个 pass 的混合（rea-p5-modelflags 2.1，`p5d-sort-a`）", () => {
  it("normal / alphatocoverage → opaque；translucent / additive → translucent；缺混合键按 normal", async () => {
    const bundle = await compile([
      image("models/normal.json"),
      image("models/translucent.json"),
      image("models/additive.json"),
      image("models/alphatocoverage.json"),
      image("models/none.json"),
    ]);
    expect(sortClasses(bundle)).toEqual(["opaque", "translucent", "translucent", "opaque", "opaque"]);
  });

  it("模型标志 fullscreen / projectlayer（JSON true）且半透明 → last；不透明的照旧 opaque；写成 1 不算（`p5d-sort-fs`）", async () => {
    const flagged = (name: string, material: string, flags: JsonObject) => ({
      [`P:/p/models/${name}.json`]: { material: `materials/${material}.json`, ...flags },
    });
    const bundle = await compile(
      [
        image("models/fs.json"),
        image("models/pl.json"),
        image("models/fsn.json"),
        image("models/pln.json"),
        image("models/fs1.json"),
        image("models/pl1.json"),
      ],
      {
        extra: {
          ...flagged("fs", "translucent", { fullscreen: true }),
          ...flagged("pl", "additive", { projectlayer: true }),
          ...flagged("fsn", "normal", { fullscreen: true }),
          ...flagged("pln", "alphatocoverage", { projectlayer: true }),
          ...flagged("fs1", "translucent", { fullscreen: 1 }),
          ...flagged("pl1", "translucent", { projectlayer: "true" }),
        },
      },
    );
    expect(sortClasses(bundle)).toEqual(["last", "last", "opaque", "opaque", "translucent", "translucent"]);
  });

  it("组合层（passthrough）按基础材质：WPE 的 util 组合层都是 translucent → translucent；fullscreenlayer → last", async () => {
    const bundle = await compile(
      [
        image("models/cl.json", { effects: [{ file: "effects/fx/effect.json" }] }),
        image("models/cln.json", { effects: [{ file: "effects/fx/effect.json" }], copybackground: false }),
        image("models/fsl.json", { effects: [{ file: "effects/fx/effect.json" }] }),
      ],
      {
        extra: {
          "P:/p/models/cl.json": { material: "materials/translucent.json", passthrough: true },
          "P:/p/models/cln.json": { material: "materials/normal.json", passthrough: true },
          "P:/p/models/fsl.json": { material: "materials/translucent.json", passthrough: true, fullscreen: true },
        },
      },
    );
    expect(bundle.layers.map((layer) => layer.passthroughModel)).toEqual([true, true, true]);
    // copybackground 不参与（WPE 构造时它还是缺省值）
    expect(sortClasses(bundle)).toEqual(["translucent", "opaque", "last"]);
  });

  it("带 effect、colorBlendMode 混合、被依赖的图层仍只看基础材质（effect 的材质是 translucent 也不算）", async () => {
    const fx = { effects: [{ file: "effects/fx/effect.json" }] };
    const bundle = await compile([
      image("models/normal.json", fx),
      image("models/normal.json", { colorBlendMode: 31 }),
      image("models/normal.json", { colorBlendMode: 5 }),
      image("models/translucent.json", fx),
      image("models/normal.json", { id: 7 }),
      { id: 8, image: "models/normal.json", dependencies: [7] },
    ]);
    expect(bundle.layers.map((layer) => layer.effects.length)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(bundle.layers[4].dependedOn).toBe(true);
    expect(sortClasses(bundle)).toEqual(["opaque", "opaque", "opaque", "translucent", "opaque", "opaque"]);
  });

  it("instanced 的实例覆盖不改混合：solidlayer_instance（translucent）→ translucent", async () => {
    const bundle = await compile([image("models/inst.json", { instance: { combos: { X: 1 } } })], {
      extra: {
        "P:/p/models/inst.json": { material: "materials/translucent.json", instanced: true, solidlayer: true },
      },
    });
    expect(bundle.layers[0].instanced).toBe(true);
    expect(sortClasses(bundle)).toEqual(["translucent"]);
  });
});

describe("compileScene：模型、粒子、文本、形状的 sortClass", () => {
  const model = (name: string, materials: string[]) => ({ [`P:/p/models/${name}.mdl`]: mdl(materials) });
  const meshes = (name: string, blendings: string[]) =>
    model(
      name,
      blendings.map((b) => `materials/${b}.json`),
    );

  it("模型：网格全半透明（translucent / additive）→ translucent；任一网格 normal / alphatocoverage → opaque（rea-p5-mesh 2.4，`p5d-sort-a` 的 M1 / M2）", async () => {
    const bundle = await compile(
      [
        { model: "models/m1.mdl", origin: "0 1 -6" },
        { model: "models/m2.mdl", origin: "0 -1 -7" },
        { model: "models/mix.mdl" },
        { model: "models/add.mdl" },
        { model: "models/a2c.mdl" },
        { model: "models/mixr.mdl" },
      ],
      {
        extra: {
          ...meshes("m1", ["translucent"]),
          ...meshes("m2", ["normal"]),
          ...meshes("mix", ["translucent", "normal"]),
          ...meshes("add", ["additive", "translucent"]),
          ...meshes("a2c", ["additive", "alphatocoverage"]),
          ...meshes("mixr", ["normal", "translucent"]),
        },
      },
    );
    expect(bundle.layers.map((layer) => layer.model?.meshes.length)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(sortClasses(bundle)).toEqual(["translucent", "opaque", "opaque", "translucent", "opaque", "opaque"]);
  });

  it("粒子 → translucent（构造即进名单）；读不到粒子文件的粒子对象同样（不画，无所谓）", async () => {
    const bundle = await compile([{ particle: "particles/p.json" }, { particle: "particles/none.json" }]);
    expect(bundle.layers[0].particle).not.toBeNull();
    expect(sortClasses(bundle)).toEqual(["translucent", "translucent"]);
  });

  it("文本 → translucent（构造函数无条件置位，rea-p6b-layout 1.1）：不看材质，colorBlendMode、带 effect 都一样", async () => {
    const bundle = await compile(
      [
        { text: "12:34" },
        { text: "a", colorBlendMode: 31 },
        { text: "b", effects: [{ file: "effects/fx/effect.json" }] },
      ],
      { general: ORTHO },
    );
    expect(bundle.layers.every((layer) => layer.text)).toBe(true);
    expect(sortClasses(bundle)).toEqual(["translucent", "translucent", "translucent"]);
  });

  it("形状 → opaque（只调基类构造，不进名单）", async () => {
    const bundle = await compile([{ shape: "quad" }], { general: ORTHO });
    expect(bundle.layers[0].shape).not.toBeNull();
    expect(sortClasses(bundle)).toEqual(["opaque"]);
  });

  it("不画的对象不填：分组节点、灯、声音、相机；读不到模型 / 材质的图像层、读不到 mdl 的模型也不填", async () => {
    const bundle = await compile(
      [
        { id: 1, name: "group", origin: "0 0 5" },
        { light: "point", origin: "0 0 1" },
        { sound: [] },
        { camera: "default" },
        image("models/missing.json"),
        image("models/nomat.json"),
        { model: "models/missing.mdl" },
      ],
      { extra: { "P:/p/models/nomat.json": { material: "materials/missing.json" } } },
    );
    expect(bundle.unsupported).toEqual(
      expect.arrayContaining([
        "model:missing:models/missing.json",
        "material:missing:materials/missing.json",
        "mdl:missing:models/missing.mdl",
      ]),
    );
    expect(bundle.layers).toHaveLength(7);
    expect(sortClasses(bundle)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});

describe("p5d-sort-a 端到端：编译期的类别 + 状态 + 排序，复现 WPE 的顺序", () => {
  const NEAR_SCRIPT = "'use strict';\nexport function update(value) {\n\tvalue.z = 5;\n\treturn value;\n}\n";
  const named = (name: string, object: JsonObject) => ({ name, ...object });

  it("FR、CLK、A、D、M2 → C、M1、粒子、E、B、S（S 用原点脚本写回之后的 z +5）", async () => {
    const bundle = await compile(
      [
        named("FR", image("models/normal.json")),
        named("CLK", image("models/normal.json")),
        named("A", image("models/normal.json", { origin: "-1 0 -5" })),
        named("B", image("models/translucent.json", { origin: "-0.5 0 2" })),
        named("C", image("models/translucent.json", { origin: "0 0 -8" })),
        named("D", image("models/normal.json", { origin: "0.5 0 3" })),
        named("E", image("models/additive.json", { origin: "1 0 0" })),
        named("M1", { model: "models/m1.mdl", origin: "0 1 -6" }),
        named("M2", { model: "models/m2.mdl", origin: "0 -1 -7" }),
        named("P", { particle: "particles/p.json", origin: "1.5 1 -4" }),
        named("S", image("models/translucent.json", { origin: { script: NEAR_SCRIPT, value: "-1.5 0 -9" } })),
      ],
      {
        general: { transparentsorting: true },
        extra: {
          "P:/p/models/m1.mdl": mdl(["materials/translucent.json"]),
          "P:/p/models/m2.mdl": mdl(["materials/normal.json"]),
        },
      },
    );
    expect(bundle.general).toMatchObject({ perspective: true, transparentSorting: true });
    expect(bundle.unsupported).not.toContain("general:transparentsorting");
    const state = SceneState.fromBundle(bundle);
    // 编译期的 S 在 z −9（键 9，会排到最前）；字段脚本写回 z +5
    expect(state.layers.get(10)?.origin).toEqual([-1.5, 0, -9]);
    state.write({ property: "", target: { kind: "layer", object: 10, field: "origin" } }, "-1.5 0 5");
    const top = bundle.layers.filter((layer) => layer.group == null);
    expect(transparentDrawOrder(top, state, [0, 0, -1]).map((layer) => layer.name)).toEqual([
      "FR",
      "CLK",
      "A",
      "D",
      "M2",
      "C",
      "M1",
      "P",
      "E",
      "B",
      "S",
    ]);
  });
});

// ———— general.transparentsorting ————

describe("compileScene：SceneGeneral.transparentSorting 只认 JSON 布尔 true", () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
    [1, false],
    ["true", false],
    [{ user: "on", value: true }, false],
    [{ script: "export function update(v) { return v; }", value: true }, false],
    [{ value: true }, false],
  ])("%j → %s", async (value, expected) => {
    const general = value === undefined ? {} : { transparentsorting: value };
    const bundle = await compile([image("models/normal.json")], { general });
    expect(bundle.general.perspective).toBe(true);
    expect(bundle.general.transparentSorting).toBe(expected);
  });

  it("正交场景也照记（渲染器只在透视场景读）", async () => {
    const bundle = await compile([image("models/normal.json")], { general: { ...ORTHO, transparentsorting: true } });
    expect(bundle.general.perspective).toBe(false);
    expect(bundle.general.transparentSorting).toBe(true);
  });
});

describe("能力表：transparentsorting（P5d 步骤 4 点 1）", () => {
  const check = (general: JsonObject) => {
    const unsupported = new Set<string>();
    checkSceneFeatures({ general, objects: [] } as unknown as SceneJson, unsupported);
    return [...unsupported].filter((key) => key.startsWith("general:")).sort();
  };

  it("JSON 布尔不报：透视、正交都一样", () => {
    expect(check({ transparentsorting: true })).toEqual([]);
    expect(check({ transparentsorting: false })).toEqual([]);
    expect(check({ ...ORTHO, transparentsorting: true })).toEqual([]);
  });

  it("绑属性、挂脚本等别的写法照报（不做运行中改），正交也照报", () => {
    const script = "export function update(v) { return v; }";
    for (const value of [{ user: "on", value: true }, { script, value: true }, { value: true }, 1, "true"])
      expect(check({ transparentsorting: value }), JSON.stringify(value)).toEqual(["general:transparentsorting"]);
    expect(check({ ...ORTHO, transparentsorting: { user: "on", value: false } })).toEqual([
      "general:transparentsorting",
    ]);
  });

  it("customsortorder 照报（同时开着 transparentsorting 也一样）", () => {
    expect(check({ customsortorder: true })).toEqual(["general:customsortorder"]);
    expect(check({ customsortorder: true, transparentsorting: true })).toEqual(["general:customsortorder"]);
  });

  it("compileScene：透视场景写 true 时 unsupported 里没有 general:transparentsorting；绑属性的有", async () => {
    const on = await compile([image("models/translucent.json")], { general: { transparentsorting: true } });
    expect(on.unsupported).not.toContain("general:transparentsorting");
    const bound = await compile([image("models/translucent.json")], {
      general: { transparentsorting: { user: "on", value: true } },
    });
    expect(bound.unsupported).toContain("general:transparentsorting");
  });
});
