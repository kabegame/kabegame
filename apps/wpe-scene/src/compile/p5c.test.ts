/**
 * P5c 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「步骤 1」点 3、点 4、点 5）：
 * - 模型对象进 `layer.model`（网格的顶点 / 索引视图、格式、stride、索引宽度、按 `skin` 选的材质 pass、绘制顺序、包围盒），报过渡键
 *   `model:pending`、不再报 `object:model`；同一个 mdl 被两个对象引用时只读一次、缓冲共用，材质各编一份；`transferableBuffers` 带上 mdl；
 * - 模型 pass 的深度 / 剔除按 WPE 缺省推（缺 `cullmode` = normal、缺 `depthtest` / `depthwrite` = enabled），会写深度的报
 *   `depthwrite:enabled`，只测不写的中性；图像层的缺省和检查不变；
 * - `mdl:missing-attribute` 只对读了的属性报（真翻译器，`p5c-attr` 的 M1–M5）；
 * - `mdl:*` 各键、`model:id`、`model:effects`、模型在组里（`model:passthrough:children:model`）；`castshadow` 等在模型上中性、在图像层上照报。
 * 依据是 p5-REPORT「P5c 语义的实测核对」。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, transferableBuffers, type SceneBundle } from "./bundle";
import { checkMdlFeatures, checkObjectFeatures, checkPassFeatures, groupChildIssues } from "./features";
import type { SceneReader } from "./fs";
import { mdlStride, parseMdl } from "./mdl";
import type { MaterialPass, SceneObject } from "./model";
import { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— mdl 编码（照 `ignore/p5/c0/mdl_enc.py`，只写这里要用的：四边形网格、空的可选块、按标签写空段；完整的在 `mdl.test.ts`） ————

interface MeshSpec {
  materials: string[];
  /** 缺省 0x9（位置 + uv）。 */
  format?: number;
  flags?: number;
  /** v ≥ 23 的记录表项数（木偶数据）。 */
  records?: number;
}

function mdl(meshes: MeshSpec[], options: { version?: number; sections?: string[] } = {}): Uint8Array {
  const version = options.version ?? 23;
  const out: number[] = [];
  const u32 = (value: number) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const cstr = (text: string) => out.push(...new TextEncoder().encode(text), 0);
  const block = (bytes: Uint8Array) => {
    u32(bytes.length);
    out.push(...bytes);
  };
  cstr(`MDLV${String(version).padStart(4, "0")}`);
  u32(meshes[0].format ?? 0x9);
  u32(meshes[0].materials.length);
  u32(meshes.length);
  for (const mesh of meshes) {
    const format = mesh.format ?? 0x9;
    for (const path of mesh.materials) cstr(path);
    u32(mesh.flags ?? 0);
    if (version >= 17) out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
    if (version >= 15) u32(format);
    // 4 个顶点（内容无所谓）、6 个 u16 索引
    block(new Uint8Array(4 * mdlStride(format)));
    block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
    if (version >= 21) out.push(0, 0);
    if (version >= 23) {
      u32(mesh.records ?? 0);
      for (let r = 0; r < (mesh.records ?? 0); r++) {
        out.push(...new Uint8Array(8));
        cstr("masks/clipping_mask_0");
        u32(0);
        u32(0);
        u32(0);
      }
    }
  }
  if (version > 12) {
    for (const tag of options.sections ?? []) {
      cstr(tag);
      u32(out.length + 4);
    }
    out.push(0);
  }
  return new Uint8Array(out);
}

// ———— 内存工程 ————

/** 记下每个路径被整读的次数（同一个 mdl 只读一次）。 */
function memoryReader(files: Record<string, Uint8Array | string>, reads: Map<string, number> = new Map()): SceneReader {
  const bytes = (path: string) => {
    const key = path.replace(/\\/g, "/");
    const value = files[key];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  };
  return {
    async readWhole(path) {
      const key = path.replace(/\\/g, "/");
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

/** 材质：一个 pass，着色器 `s`；`pass` 覆盖 / 补充 pass 的键（缺省不写深度、剔除键）。 */
const material = (pass: Partial<MaterialPass> = {}) => JSON.stringify({ passes: [{ shader: "s", ...pass }] });

/** 假翻译器：一律成功、没有接口，不依赖 wasm。 */
const fakeTranslator = {
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/** 场景的对象与另加的文件（键是工程内路径）；缺省有 `models/a.mdl`（一个网格、材质 `materials/a.json`）与着色器 `s`。 */
async function compileModels(
  objects: Record<string, unknown>[],
  extra: Record<string, Uint8Array | string> = {},
  options: { translator?: Wpesl2wgsl; reads?: Map<string, number>; exhaustive?: boolean } = {},
): Promise<SceneBundle> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
    "P:/p/models/a.mdl": mdl([{ materials: ["materials/a.json"] }]),
    "P:/p/materials/a.json": material({ blending: "translucent", depthwrite: "disabled", cullmode: "nocull" }),
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
  };
  for (const [path, value] of Object.entries(extra)) files[`P:/p/${path}`] = value;
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files, options.reads),
    translator: options.translator ?? fakeTranslator,
    postprocess: "disabled",
    exhaustive: options.exhaustive ?? true,
  });
}
const modelObject = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `m${id}`,
  model: "models/a.mdl",
  origin: "960 540 0",
  ...extra,
});

describe("compileScene：模型对象进 layer.model（P5c 步骤 1 点 3）", () => {
  it("网格的格式、stride、顶点 / 索引、材质 pass、顺序与包围盒；报 model:pending、不报 object:model", async () => {
    const bundle = await compileModels([modelObject(1)]);
    expect(bundle.unsupported).toEqual(["model:pending"]);
    const [layer] = bundle.layers;
    expect(layer.passes).toEqual([]);
    expect(layer.perspective).toBe(false);
    expect(layer.model).toMatchObject({ path: "models/a.mdl", version: 23, order: [0], bounds: [-1, -1, 0, 1, 1, 0] });
    const mesh = layer.model!.meshes[0];
    expect(mesh).toMatchObject({
      format: 0x9,
      stride: 20,
      vertexCount: 4,
      indexFormat: "uint16",
      indexCount: 6,
      material: "materials/a.json",
    });
    expect(mesh.vertices.length).toBe(80);
    expect(Array.from(new Uint16Array(mesh.indices.slice().buffer))).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mesh.passes).toHaveLength(1);
    expect(mesh.passes[0]).toMatchObject({ key: "objects/0/meshes/0/passes/0", blending: "translucent", program: 0 });
    // 其它对象的 model 为 null
    const mixed = await compileModels([{ id: 2, name: "group" }, modelObject(1)]);
    expect(mixed.layers[0].model).toBeNull();
    expect(mixed.layers[1].model).not.toBeNull();
  });

  it("快速路径：第一个模型对象就确定退回（model:pending 先报，网格不再编）", async () => {
    const bundle = await compileModels([modelObject(1), modelObject(2)], {}, { exhaustive: false });
    expect(bundle.unsupported).toEqual(["model:pending"]);
    expect(bundle.layers).toHaveLength(1);
    expect(bundle.layers[0].model?.meshes).toEqual([]);
  });

  it("perspective: true 落到图层上（和透视图层同一套，p5c-matrix），不报", async () => {
    const bundle = await compileModels([modelObject(1, { perspective: true })]);
    expect(bundle.unsupported).toEqual(["model:pending"]);
    expect(bundle.layers[0].perspective).toBe(true);
  });

  it("skin 选材质：非负整数取 min(skin, N − 1)，负数、字符串取 0（p5c-skin）", async () => {
    const skins = [undefined, 0, 1, 5, -1, "1", true];
    const bundle = await compileModels(
      skins.map((skin, i) => modelObject(i + 1, skin === undefined ? {} : { skin })),
      {
        "models/a.mdl": mdl([{ materials: ["materials/red.json", "materials/blue.json"] }]),
        "materials/red.json": material({ blending: "translucent" }),
        "materials/blue.json": material({ blending: "additive" }),
      },
    );
    expect(bundle.layers.map((layer) => layer.model!.meshes[0].material)).toEqual([
      "materials/red.json",
      "materials/red.json",
      "materials/blue.json",
      "materials/blue.json",
      "materials/red.json",
      "materials/red.json",
      "materials/red.json",
    ]);
    // `skin` 在模型上中性
    expect(bundle.unsupported).toEqual(["model:pending"]);
  });

  it("同一个 mdl 两个对象：只读一次、缓冲共用，材质按对象各编一份；transferableBuffers 带上它一次", async () => {
    const reads = new Map<string, number>();
    const bundle = await compileModels([modelObject(1), modelObject(2, { skin: 0 })], {}, { reads });
    expect(reads.get("P:/p/models/a.mdl")).toBe(1);
    const [a, b] = bundle.layers.map((layer) => layer.model!.meshes[0]);
    expect(a.vertices.buffer).toBe(b.vertices.buffer);
    expect(a.indices.buffer).toBe(a.vertices.buffer);
    expect([a.passes[0].key, b.passes[0].key]).toEqual(["objects/0/meshes/0/passes/0", "objects/1/meshes/0/passes/0"]);
    const buffers = transferableBuffers(bundle);
    expect(buffers.filter((buffer) => buffer === a.vertices.buffer)).toHaveLength(1);
  });

  it("多个网格：绘制顺序不透明在前（meshDrawOrder）", async () => {
    const bundle = await compileModels([modelObject(1)], {
      "models/a.mdl": mdl([
        { materials: ["materials/t.json"] },
        { materials: ["materials/n.json"] },
        { materials: ["materials/t.json"] },
        { materials: ["materials/n.json"] },
      ]),
      "materials/t.json": material({ blending: "translucent" }),
      "materials/n.json": material({ blending: "normal", depthwrite: "disabled" }),
    });
    expect(bundle.layers[0].model!.order).toEqual([1, 3, 0, 2]);
    expect(bundle.layers[0].model!.meshes.map((mesh) => mesh.passes[0].key)).toEqual([
      "objects/0/meshes/0/passes/0",
      "objects/0/meshes/1/passes/0",
      "objects/0/meshes/2/passes/0",
      "objects/0/meshes/3/passes/0",
    ]);
  });
});

describe("模型 pass 的深度与剔除（WPE 缺省：缺 cullmode = normal、缺 depthtest / depthwrite = enabled）", () => {
  const passOf = async (pass: Partial<MaterialPass>) => {
    const bundle = await compileModels([modelObject(1)], { "materials/a.json": material(pass) });
    return { pass: bundle.layers[0].model!.meshes[0].passes[0], unsupported: bundle.unsupported };
  };

  it("三个键都缺：ScenePass 写 normal / enabled / enabled", async () => {
    const { pass, unsupported } = await passOf({ blending: "translucent" });
    expect(pass).toMatchObject({ cullmode: "normal", depthtest: "enabled", depthwrite: "enabled" });
    // translucent 不写深度：只测不写，中性
    expect(unsupported).toEqual(["model:pending"]);
  });

  it("会写深度（normal / alphatocoverage，没关测试、没关写入）报 depthwrite:enabled，留给 P5d", async () => {
    expect((await passOf({ blending: "normal" })).unsupported).toEqual(["depthwrite:enabled", "model:pending"]);
    expect((await passOf({})).unsupported).toEqual(["depthwrite:enabled", "model:pending"]);
    expect((await passOf({ blending: "normal", depthwrite: "enabled" })).unsupported).toEqual([
      "depthwrite:enabled",
      "model:pending",
    ]);
    expect((await passOf({ blending: "alphatocoverage" })).unsupported).toEqual([
      "blend:alphatocoverage",
      "depthwrite:enabled",
      "model:pending",
    ]);
  });

  it("只测不写、不测：中性", async () => {
    expect((await passOf({ blending: "normal", depthwrite: "disabled" })).unsupported).toEqual(["model:pending"]);
    expect((await passOf({ blending: "normal", depthtest: "disabled" })).unsupported).toEqual(["model:pending"]);
    expect((await passOf({ blending: "additive", depthwrite: "enabled" })).unsupported).toEqual(["model:pending"]);
    // retro 的 bgfade：translucent、缺 depthtest、depthwrite disabled、nocull
    const retro = await passOf({ blending: "translucent", depthwrite: "disabled", cullmode: "nocull" });
    expect(retro.unsupported).toEqual(["model:pending"]);
    expect(retro.pass).toMatchObject({ cullmode: "nocull", depthtest: "enabled", depthwrite: "disabled" });
  });

  it("cullmode 只认 normal / nocull，depthtest 只认 enabled / disabled，其余照报", async () => {
    const cull = await passOf({ blending: "translucent", cullmode: "normal" });
    expect(cull.unsupported).toEqual(["model:pending"]);
    expect(cull.pass.cullmode).toBe("normal");
    expect((await passOf({ blending: "translucent", cullmode: "front" })).unsupported).toEqual([
      "cull:front",
      "model:pending",
    ]);
    expect((await passOf({ blending: "translucent", depthtest: "enabled" })).unsupported).toEqual(["model:pending"]);
    expect((await passOf({ blending: "translucent", depthtest: "greater" })).unsupported).toEqual([
      "depthtest:greater",
      "model:pending",
    ]);
  });

  it("图像层的缺省与检查不变：缺键按 nocull / disabled，normal 缺深度键不报", () => {
    const keys = (pass: MaterialPass, model?: boolean) => {
      const out = new Set<string>();
      checkPassFeatures(pass, out, { model });
      return [...out].sort();
    };
    expect(keys({ shader: "s" })).toEqual([]);
    expect(keys({ shader: "s", cullmode: "normal" })).toEqual(["cull:normal"]);
    expect(keys({ shader: "s", depthtest: "enabled", depthwrite: "disabled" })).toEqual(["depthtest:enabled"]);
    expect(keys({ shader: "s" }, true)).toEqual(["depthwrite:enabled"]);
    expect(keys({ shader: "s", cullmode: "normal", depthtest: "enabled", depthwrite: "disabled" }, true)).toEqual([]);
  });

  it("图像层的 ScenePass 缺键仍是 nocull / disabled / disabled", async () => {
    const bundle = await compileModels([{ id: 1, image: "models/i.json" }], {
      "models/i.json": JSON.stringify({ material: "materials/a.json" }),
      "materials/a.json": material({ blending: "normal" }),
    });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].passes[0]).toMatchObject({
      cullmode: "nocull",
      depthtest: "disabled",
      depthwrite: "disabled",
    });
    expect(bundle.layers[0].model).toBeNull();
  });
});

// ———— 缺属性（真翻译器） ————

const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const VCOLOR_FRAG = "varying vec4 v_Color;\n\nvoid main() {\n\tgl_FragColor = v_Color;\n}\n";
/** `ignore/p5/c0/gen_c.py` 的 `ATTR_TESTS`：网格格式、着色器声明、送进 `v_Color` 的表达式，加一个名字不在属性表里的。 */
const ATTR_TESTS: [string, number, string[], string, string[]][] = [
  ["M1：网格 TexCoordVec4 / 着色器 vec2 a_TexCoord", 0x21, ["vec2 a_TexCoord"], "vec4(a_TexCoord, 0.0, 1.0)", []],
  [
    "M2：网格无法线 / 读 a_Normal",
    0x9,
    ["vec2 a_TexCoord", "vec3 a_Normal"],
    "vec4(a_Normal * 0.5 + 0.5, 1.0)",
    ["mdl:missing-attribute:a_Normal"],
  ],
  ["M3：网格无法线 / 声明不读", 0x9, ["vec2 a_TexCoord", "vec3 a_Normal"], "vec4(0.0, 1.0, 0.0, 1.0)", []],
  ["M4：网格 vec2 uv / 着色器 vec4 a_TexCoordVec4", 0x9, ["vec4 a_TexCoordVec4"], "a_TexCoordVec4", []],
  [
    "M5：网格无颜色 / 读 a_Color",
    0x9,
    ["vec2 a_TexCoord", "vec4 a_Color"],
    "a_Color",
    ["mdl:missing-attribute:a_Color"],
  ],
  ["名字不在属性表里", 0x9, ["vec4 a_Custom"], "a_Custom", ["mdl:attribute:a_Custom"]],
];

describe.skipIf(!existsSync(wasm))("mdl:missing-attribute：只对读了的属性报（p5c-attr，真翻译器）", () => {
  it.each(ATTR_TESTS)("%s", async (name, format, declarations, expression, expected) => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const vertex = [
      "uniform mat4 g_ModelViewProjectionMatrix;",
      "",
      "attribute vec3 a_Position;",
      ...declarations.map((declaration) => `attribute ${declaration};`),
      "",
      "varying vec4 v_Color;",
      "",
      "void main() {",
      "\tgl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);",
      `\tv_Color = ${expression};`,
      "}",
    ].join("\n");
    const bundle = await compileModels(
      [modelObject(1)],
      {
        "models/a.mdl": mdl([{ materials: ["materials/a.json"], format }]),
        "materials/a.json": material({ blending: "translucent", cullmode: "nocull" }),
        "shaders/s.vert": vertex,
        "shaders/s.frag": VCOLOR_FRAG,
      },
      { translator },
    );
    expect(bundle.unsupported).toEqual([...expected, "model:pending"].sort());
    const program = bundle.programs[bundle.layers[0].model!.meshes[0].passes[0].program!];
    expect(program.ok).toBe(true);
    // M3：翻译器把声明了没读的属性标 unused
    if (name.startsWith("M3")) expect(program.attributes?.find((item) => item.name === "a_Normal")?.unused).toBe(true);
  });
});

// ———— 能力表 ————

describe("checkMdlFeatures：mdl 的细分键", () => {
  const keys = (bytes: Uint8Array) => {
    const out = new Set<string>();
    checkMdlFeatures(parseMdl(bytes), out);
    return [...out].sort();
  };
  const quad = (extra: Partial<MeshSpec> = {}) => [{ materials: ["materials/a.json"], ...extra }];

  it("静态网格（各版本、不认识的段）不报", () => {
    for (const version of [4, 14, 16, 17, 21, 23]) expect(keys(mdl(quad(), { version }))).toEqual([]);
    expect(keys(mdl(quad(), { sections: ["ZZZZ0001", "MDLX0001"] }))).toEqual([]);
    expect(keys(mdl(quad({ flags: 3 })))).toEqual([]);
  });

  it("段：MDLS* / MDLE0002 骨骼，MDLA* 动画，MDMP0001 变形，MDAT0001 挂点（按 WPE 的比较长度）", () => {
    expect(keys(mdl(quad(), { sections: ["MDLS0004"] }))).toEqual(["mdl:skeleton"]);
    expect(keys(mdl(quad(), { sections: ["MDLS0001", "MDLA0006"] }))).toEqual(["mdl:animation", "mdl:skeleton"]);
    expect(keys(mdl(quad(), { sections: ["MDMP0001"] }))).toEqual(["mdl:morph"]);
    expect(keys(mdl(quad(), { sections: ["MDAT0001"] }))).toEqual(["mdl:attachment"]);
    expect(keys(mdl(quad(), { sections: ["MDLE0002"] }))).toEqual(["mdl:skeleton"]);
    // MDLE 全串比较、MDMP / MDAT 比较 8 个字符：别的版本号是不认识的段
    expect(keys(mdl(quad(), { sections: ["MDLE0001", "MDMP0002", "MDAT0002"] }))).toEqual([]);
  });

  it("截断、木偶数据、多余的标志位、表外或重复语义的格式", () => {
    const bytes = mdl(quad());
    expect(keys(bytes.subarray(0, bytes.length - 1))).toEqual(["mdl:truncated"]);
    expect(keys(mdl(quad({ records: 1 })))).toEqual(["mdl:puppet"]);
    expect(keys(mdl(quad({ flags: 0x400 })))).toEqual(["mdl:flags:0x400"]);
    expect(keys(mdl(quad({ flags: 0x1005 })))).toEqual(["mdl:flags:0x1004"]);
    expect(keys(mdl(quad({ format: 0x4000009 })))).toEqual(["mdl:format:0x4000009"]);
    // a_Position 与 a_PositionVec4 都是 POSITION0；a_TexCoord 与 a_TexCoordVec4 都是 TEXCOORD0
    expect(keys(mdl(quad({ format: 0x10009 })))).toEqual(["mdl:format:0x10009"]);
    expect(keys(mdl(quad({ format: 0x29 })))).toEqual(["mdl:format:0x29"]);
  });
});

describe("compileScene：模型的细分键（点 3、点 4）", () => {
  it("骨骼段：mdl:skeleton；材质多于一个 pass：mdl:material-passes", async () => {
    expect(
      (
        await compileModels([modelObject(1)], {
          "models/a.mdl": mdl([{ materials: ["materials/a.json"] }], { sections: ["MDLS0004"] }),
        })
      ).unsupported,
    ).toEqual(["mdl:skeleton", "model:pending"]);
    const twoPasses = JSON.stringify({
      passes: [
        { shader: "s", blending: "translucent" },
        { shader: "s", blending: "additive" },
      ],
    });
    const bundle = await compileModels([modelObject(1)], { "materials/a.json": twoPasses });
    expect(bundle.unsupported).toEqual(["mdl:material-passes", "model:pending"]);
    expect(bundle.layers[0].model!.meshes[0].passes.map((pass) => pass.key)).toEqual([
      "objects/0/meshes/0/passes/0",
      "objects/0/meshes/0/passes/1",
    ]);
  });

  it("mdl 读不到：mdl:missing:<路径>；材质读不到：material:missing:<路径>；model 不是字符串：model:id", async () => {
    const missing = await compileModels([modelObject(1, { model: "models/none.mdl" })]);
    expect(missing.unsupported).toEqual(["mdl:missing:models/none.mdl", "model:pending"]);
    expect(missing.layers[0].model).toBeNull();
    const noMaterial = await compileModels([modelObject(1)], {
      "models/a.mdl": mdl([{ materials: ["materials/x.json"] }]),
    });
    expect(noMaterial.unsupported).toEqual(["material:missing:materials/x.json", "model:pending"]);
    expect(noMaterial.layers[0].model!.meshes[0]).toMatchObject({ material: "materials/x.json", passes: [] });
    const id = await compileModels([modelObject(1, { model: 3 })]);
    expect(id.unsupported).toEqual(["model:id", "model:pending"]);
  });

  it("模型带 effect：model:effects（不编译）", async () => {
    const bundle = await compileModels([modelObject(1, { effects: [{ file: "effects/tint/effect.json" }] })]);
    expect(bundle.unsupported).toEqual(["model:effects", "model:pending"]);
    expect(bundle.layers[0].effects).toEqual([]);
  });

  it("模型在组里：model:passthrough:children:model", async () => {
    const bundle = await compileModels(
      [{ id: 1, image: "models/c.json", origin: "960 540 0" }, modelObject(2, { parent: 1 })],
      {
        "models/c.json": JSON.stringify({ material: "materials/c.json", passthrough: true }),
        "materials/c.json": material({ blending: "translucent" }),
        "materials/util/effectpassthrough.json": material({ blending: "normal" }),
      },
    );
    expect(bundle.layers[1].group).toBe(0);
    expect(bundle.unsupported).toEqual(["model:passthrough:children:model", "model:pending"]);
    expect(
      groupChildIssues({
        passthroughModel: false,
        passes: [],
        effects: [],
        colorBlendMode: 0,
        fullscreen: false,
        perspective: false,
        particle: null,
        model: null,
      }),
    ).toEqual([]);
  });
});

describe("checkObjectFeatures：模型对象（点 4）", () => {
  const keys = (object: SceneObject) => {
    const out = new Set<string>();
    checkObjectFeatures(object, out);
    return [...out].sort();
  };

  it("不再报 object:model；skin、castshadow、reflected、disablepropagation、perspective: true 中性", () => {
    expect(keys({ id: 1, model: "models/a.mdl" })).toEqual([]);
    expect(
      keys({
        id: 1,
        model: "models/a.mdl",
        skin: 1,
        castshadow: true,
        reflected: true,
        disablepropagation: true,
        solid: true,
        locktransforms: true,
        parallaxDepth: "1 1",
        perspective: true,
      }),
    ).toEqual([]);
  });

  it("这几个键在图像层上照报；模型上 perspective 绑属性、attachment、animationlayers 照报", () => {
    expect(
      keys({ id: 1, image: "models/i.json", castshadow: true, reflected: true, skin: 1, disablepropagation: true }),
    ).toEqual(["object:castshadow", "object:disablepropagation", "object:reflected", "object:skin"]);
    expect(keys({ id: 1, model: "models/a.mdl", perspective: { user: "p", value: true } })).toEqual([
      "object:perspective",
    ]);
    expect(keys({ id: 1, model: "models/a.mdl", attachment: "head" })).toEqual(["object:attachment"]);
    expect(keys({ id: 1, model: "models/a.mdl", animationlayers: [{ animation: 1 }] })).toEqual([
      "object:animationlayers",
    ]);
  });

  it("effects 非空报 model:effects，空数组不报", () => {
    expect(keys({ id: 1, model: "models/a.mdl", effects: [{ file: "effects/tint/effect.json" }] })).toEqual([
      "model:effects",
    ]);
    expect(keys({ id: 1, model: "models/a.mdl", effects: [] })).toEqual([]);
  });
});
