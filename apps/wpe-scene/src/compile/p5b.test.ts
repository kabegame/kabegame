/**
 * P5b 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`）：
 * - 步骤 1：图像层尺寸的取值顺序（`imageLayerSize`）、图层上的 `noPadding` / `perspective` 两个标志、能力表放开 `nopadding` 与
 *   图像层的 `perspective: true`；
 * - 步骤 2：组合层（无子层）的 `passthroughModel` / `copyBackground`、`projectlayer` 取正交投影宽高、能力表放开 `passthrough` 与
 *   `projectlayer`，带子层报 `model:passthrough:children`、组合层又透视报 `object:perspective`；
 * - 步骤 3：`fullscreen` 模型的 `fullscreen` / `fullscreenSize`（几何 2×2，合成 RT 取槽 0 静态纹理的图像尺寸或场景尺寸）、能力表放开
 *   `fullscreen`（fullscreenlayer 不再报）。
 * 依据是 p5-REPORT「P5b 语义的实测核对」：`p5b-autosize`（`autosize` 覆盖 `size`，三者都缺时 1×1）、`p5b-nopad`、`p5b-persp`、
 * `p5b-cl`、`p5b-proj`、`p5b-fs`、`p5b-fsmvp`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, imageLayerSize } from "./bundle";
import { checkModelFeatures, checkObjectFeatures, checkSceneFeatures } from "./features";
import type { SceneReader } from "./fs";
import { parseModel, type ModelJson, type SceneObject } from "./model";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** `p5b-autosize` 的纹理：纹理尺寸 64×64，图像尺寸 48×40（NPOT 图像补到 2 的幂）。 */
const TEXTURE = { width: 48, height: 40, textureWidth: 64, textureHeight: 64 };
const MATERIAL = "materials/a.json";
/** 场景的正交投影宽高（`SceneGeneral` 的 `width` / `height`）：只有 `projectlayer` + `autosize` 才读。 */
const PROJECTION: [number, number] = [1920, 1080];

describe("imageLayerSize：1×1 → 模型宽高 → 对象 size → autosize（p5b-autosize）", () => {
  it.each<[string, ModelJson, number[], number[]]>([
    ["autosize + size 24×20：取图像尺寸", { material: MATERIAL, autosize: true }, [24, 20], [48, 40]],
    ["都没有：1×1（不取纹理）", { material: MATERIAL }, [], [1, 1]],
    ["模型 100×50", { material: MATERIAL, width: 100, height: 50 }, [], [100, 50]],
    [
      "autosize + 模型 100×50：取图像尺寸",
      { material: MATERIAL, width: 100, height: 50, autosize: true },
      [],
      [48, 40],
    ],
    ["autosize + size 300×300：取图像尺寸", { material: MATERIAL, autosize: true }, [300, 300], [48, 40]],
  ])("%s", (_name, model, size, expected) => {
    expect(imageLayerSize(model, size, TEXTURE, PROJECTION)).toEqual(expected);
  });

  it("对象 size 覆盖模型宽高（没有 autosize）", () => {
    expect(imageLayerSize({ material: MATERIAL, width: 100, height: 50 }, [24, 20], TEXTURE, PROJECTION)).toEqual([
      24, 20,
    ]);
  });

  it("模型宽高两个分量各自生效：只写一个时另一个保持 1", () => {
    expect(imageLayerSize({ material: MATERIAL, width: 100 }, [], TEXTURE, PROJECTION)).toEqual([100, 1]);
    expect(imageLayerSize({ material: MATERIAL, height: 50 }, [], TEXTURE, PROJECTION)).toEqual([1, 50]);
  });

  it("模型宽高写成字符串不算（只认 JSON 数字）", () => {
    const model = { material: MATERIAL, width: "100", height: 50 } as unknown as ModelJson;
    expect(imageLayerSize(model, [], TEXTURE, PROJECTION)).toEqual([1, 50]);
    expect(
      imageLayerSize(
        { material: MATERIAL, width: "100", height: "50" } as unknown as ModelJson,
        [],
        TEXTURE,
        PROJECTION,
      ),
    ).toEqual([1, 1]);
  });

  it("autosize 没有纹理时不覆盖；autosize 写成 1、字符串不算", () => {
    expect(imageLayerSize({ material: MATERIAL, autosize: true }, [24, 20], undefined, PROJECTION)).toEqual([24, 20]);
    expect(imageLayerSize({ material: MATERIAL, autosize: true }, [], undefined, PROJECTION)).toEqual([1, 1]);
    expect(imageLayerSize({ material: MATERIAL, autosize: 1 }, [24, 20], TEXTURE, PROJECTION)).toEqual([24, 20]);
    expect(imageLayerSize({ material: MATERIAL, autosize: "true" }, [], TEXTURE, PROJECTION)).toEqual([1, 1]);
  });
});

// ———— 编译：尺寸与两个标志落到图层上 ————

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), new Uint8Array([0]));
/** RGBA8 单 mip 的 `.tex`（TEXB0002）：纹理尺寸 64×64、图像尺寸 48×40。 */
function tex(): Uint8Array {
  const data = new Uint8Array(64 * 64 * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
    u32(64),
    u32(64),
    u32(48),
    u32(40),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(64),
    u32(64),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

/** 假翻译器：一律成功、没有接口，不依赖 wasm。 */
const translator = {
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

async function compileImage(model: Record<string, unknown>, object: Partial<SceneObject> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [{ id: 1, name: "a", image: "models/a.json", origin: "960 540 0", ...object }],
      }),
      "P:/p/models/a.json": JSON.stringify({ material: MATERIAL, ...model }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
      "P:/p/materials/a.tex": tex(),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("compileScene：图像层的尺寸与标志", () => {
  it("尺寸经 imageLayerSize：autosize 覆盖对象 size；没写 autosize 时三者都缺是 1×1", async () => {
    const auto = await compileImage({ autosize: true }, { size: "24 20" });
    expect(auto.unsupported).toEqual([]);
    expect(auto.textures[0]).toMatchObject({ width: 48, height: 40, textureWidth: 64, textureHeight: 64 });
    expect(auto.layers[0].size).toEqual([48, 40]);
    expect((await compileImage({})).layers[0].size).toEqual([1, 1]);
    expect((await compileImage({ width: 100, height: 50 })).layers[0].size).toEqual([100, 50]);
    expect((await compileImage({ width: 100, height: 50 }, { size: "24 20" })).layers[0].size).toEqual([24, 20]);
  });

  it("模型 nopadding（JSON true）→ noPadding，不报；写成 1 不算", async () => {
    const bundle = await compileImage({ nopadding: true });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ noPadding: true, perspective: false });
    expect((await compileImage({ nopadding: 1 })).layers[0].noPadding).toBe(false);
    expect((await compileImage({})).layers[0].noPadding).toBe(false);
  });

  it("对象 perspective（JSON true）→ perspective，不报；绑属性的照报、图层上不带", async () => {
    const bundle = await compileImage({}, { perspective: true });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ perspective: true, noPadding: false });
    const bound = await compileImage({}, { perspective: { user: "p", value: true } });
    expect(bound.unsupported).toEqual(["object:perspective"]);
    expect(bound.layers[0].perspective).toBe(false);
    expect((await compileImage({}, { perspective: false })).layers[0].perspective).toBe(false);
  });
});

// ———— 能力表 ————

function objectKeys(object: SceneObject): string[] {
  const keys = new Set<string>();
  checkObjectFeatures(object, keys);
  return [...keys].sort();
}
function modelKeys(model: ModelJson): string[] {
  const keys = new Set<string>();
  checkModelFeatures(model, keys);
  return [...keys].sort();
}

describe("能力表：图像层 perspective 与模型 nopadding（P5b 步骤 1）", () => {
  it("图像层 perspective: true / false 不报", () => {
    expect(objectKeys({ id: 1, image: "models/a.json", perspective: true })).toEqual([]);
    expect(objectKeys({ id: 1, image: "models/a.json", perspective: false })).toEqual([]);
  });
  it("图像层上绑属性、挂脚本、写成 1 或字符串：报 object:perspective（不重复报成未知键）", () => {
    expect(objectKeys({ id: 1, image: "models/a.json", perspective: { user: "p", value: true } })).toEqual([
      "object:perspective",
    ]);
    expect(
      objectKeys({ id: 1, image: "models/a.json", perspective: { script: "export function update(v) { return v; }" } }),
    ).toEqual(["object:perspective"]);
    expect(objectKeys({ id: 1, image: "models/a.json", perspective: 1 })).toEqual(["object:perspective"]);
    expect(objectKeys({ id: 1, image: "models/a.json", perspective: "true" })).toEqual(["object:perspective"]);
  });
  it("非图像对象上 perspective: true 照报：粒子、分组节点", () => {
    expect(objectKeys({ id: 1, particle: "particles/p.json", perspective: true })).toEqual(["object:perspective"]);
    expect(objectKeys({ id: 1, name: "group", perspective: true })).toEqual(["object:perspective"]);
  });
  it("整场检查：图像层 perspective: true 的场景没有 object:perspective", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [{ id: 1, image: "models/grid.json", origin: "960 540 0", angles: "-1.309 0 0", perspective: true }],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });
  it("模型 nopadding: true 不报 model:nopadding", () => {
    expect(modelKeys({ material: MATERIAL, nopadding: true })).toEqual([]);
    expect(modelKeys({ material: MATERIAL, width: 1920, height: 1080, nopadding: true, autosize: true })).toEqual([]);
  });
});

// ———— P5b 步骤 2：组合层（无子层）与 projectlayer ————

describe("imageLayerSize：projectlayer + autosize 取正交投影宽高（p5b-proj）", () => {
  const PROJECT_LAYER: ModelJson = { material: MATERIAL, passthrough: true, autosize: true, projectlayer: true };

  it("对象 size 500×300 被正交投影覆盖：1920×1080、1280×720", () => {
    expect(imageLayerSize(PROJECT_LAYER, [500, 300], undefined, [1920, 1080])).toEqual([1920, 1080]);
    expect(imageLayerSize(PROJECT_LAYER, [500, 300], undefined, [1280, 720])).toEqual([1280, 720]);
  });
  it("排在纹理之前：槽 0 有纹理也取正交投影", () => {
    expect(imageLayerSize(PROJECT_LAYER, [500, 300], TEXTURE, [1280, 720])).toEqual([1280, 720]);
  });
  it("正交投影取整（WPE `0x1401875eb`）", () => {
    expect(imageLayerSize(PROJECT_LAYER, [], undefined, [1280.7, 720.2])).toEqual([1280, 720]);
  });
  it("没有 autosize 时 projectlayer 不改尺寸：照常取对象 size、模型宽高", () => {
    const noAuto: ModelJson = { material: MATERIAL, passthrough: true, projectlayer: true };
    expect(imageLayerSize(noAuto, [500, 300], TEXTURE, [1920, 1080])).toEqual([500, 300]);
    expect(imageLayerSize({ ...noAuto, width: 100, height: 50 }, [], TEXTURE, [1920, 1080])).toEqual([100, 50]);
    expect(imageLayerSize(noAuto, [], undefined, [1920, 1080])).toEqual([1, 1]);
  });
  it("projectlayer 写成 1 不算：autosize 回到纹理尺寸", () => {
    const model = { material: MATERIAL, autosize: true, projectlayer: 1 } as unknown as ModelJson;
    expect(imageLayerSize(model, [500, 300], TEXTURE, [1920, 1080])).toEqual([48, 40]);
  });
  it("普通 composelayer（没有 autosize）的尺寸就是对象 size", () => {
    expect(imageLayerSize({ material: MATERIAL, passthrough: true }, [600, 300], undefined, [1920, 1080])).toEqual([
      600, 300,
    ]);
  });
});

/** WPE 的 `materials/util/composelayer.json`：槽 0 是 `_rt_FullFrameBuffer`，没有静态纹理。 */
const COMPOSE_MATERIAL = {
  passes: [
    {
      shader: "composelayer",
      depthtest: "disabled",
      depthwrite: "disabled",
      blending: "translucent",
      cullmode: "nocull",
      textures: ["_rt_FullFrameBuffer"],
    },
  ],
};
/** WPE 自带的三个组合层模型（`assets/models/util/*.json`），材质都换成上面那份。 */
const UTIL_MODELS: Record<string, ModelJson> = {
  composelayer: { material: "materials/util/composelayer.json", passthrough: true },
  projectlayer: { material: "materials/util/composelayer.json", passthrough: true, autosize: true, projectlayer: true },
  fullscreenlayer: { material: "materials/util/composelayer.json", fullscreen: true, passthrough: true },
};

/**
 * 场景里放一组对象；`models/util/*` 是组合层，`models/a.json` 是普通图像层（同 `compileImage`）。`extra` 是另加的文件
 * （键是工程内路径，同名覆盖上面的默认文件）。
 */
async function compileObjects(
  objects: Record<string, unknown>[],
  general: Record<string, unknown> = {},
  extra: Record<string, Uint8Array | string> = {},
) {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({
      general: { orthogonalprojection: { width: 1920, height: 1080 }, ...general },
      objects,
    }),
    "P:/p/models/a.json": JSON.stringify({ material: MATERIAL }),
    "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
    "P:/p/materials/a.tex": tex(),
    "P:/p/materials/util/composelayer.json": JSON.stringify(COMPOSE_MATERIAL),
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
    "P:/p/shaders/composelayer.vert": "void main() {}",
    "P:/p/shaders/composelayer.frag": "void main() {}",
  };
  for (const [name, model] of Object.entries(UTIL_MODELS))
    files[`P:/p/models/util/${name}.json`] = JSON.stringify(model);
  for (const [path, value] of Object.entries(extra)) files[`P:/p/${path}`] = value;
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}
/** `p5b-cl` 的 CL1 那样的 composelayer 对象（`ignore/p5/b0/gen_b.py` 的 `p_cl`）。 */
const compose = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `CL${id}`,
  image: "models/util/composelayer.json",
  origin: "500 300 0",
  size: "600 300",
  angles: "0 0 0.4",
  ...extra,
});

describe("compileScene：组合层的两个字段与照报项（P5b 步骤 2）", () => {
  it("composelayer：passthroughModel，copybackground 缺省 true，尺寸 = 对象 size，不报", async () => {
    const bundle = await compileObjects([compose(10)]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({
      passthroughModel: true,
      copyBackground: true,
      size: [600, 300],
      perspective: false,
    });
    // 基础 pass 的槽 0 是快照：需要帧缓冲、没有静态纹理
    expect(bundle.layers[0].passes[0]).toMatchObject({ runtime: { 0: "_rt_FullFrameBuffer" }, framebuffer: true });
    expect(bundle.layers[0].passes[0].textures[0]).toBeUndefined();
  });

  it("copybackground：只有 JSON false 才关；true、写成 0 / 字符串都按缺省 true", async () => {
    const bundle = await compileObjects([
      compose(10, { copybackground: false }),
      compose(11, { copybackground: true }),
      compose(12, { copybackground: 0 }),
      compose(13, { copybackground: "false" }),
    ]);
    expect(bundle.layers.map((layer) => layer.copyBackground)).toEqual([false, true, true, true]);
  });

  it("projectlayer：尺寸取正交投影宽高（对象 size 500×300 被覆盖），1280×720 的场景同样", async () => {
    const object = (id: number) => ({
      id,
      image: "models/util/projectlayer.json",
      origin: "960 540 0",
      size: "500 300",
    });
    const full = await compileObjects([object(10)]);
    expect(full.unsupported).toEqual([]);
    expect(full.layers[0]).toMatchObject({ passthroughModel: true, size: [1920, 1080] });
    const small = await compileObjects([object(10)], { orthogonalprojection: { width: 1280, height: 720 } });
    expect(small.unsupported).toEqual([]);
    expect(small.layers[0].size).toEqual([1280, 720]);
  });

  it("带子层：报 model:passthrough:children；子层是分组节点也算", async () => {
    const bundle = await compileObjects([
      compose(10),
      { id: 11, image: "models/a.json", origin: "0 0 0", parent: 10 },
      compose(12),
    ]);
    expect(bundle.unsupported).toEqual(["model:passthrough:children"]);
    const group = await compileObjects([compose(10), { id: 11, name: "group", origin: "0 0 0", parent: 10 }]);
    expect(group.unsupported).toEqual(["model:passthrough:children"]);
  });

  it("普通图像层带子层不报；组合层作为子层（父是普通图像层）不报", async () => {
    const plain = await compileObjects([
      { id: 10, image: "models/a.json", origin: "960 540 0" },
      { id: 11, image: "models/a.json", origin: "0 0 0", parent: 10 },
    ]);
    expect(plain.unsupported).toEqual([]);
    const child = await compileObjects([
      { id: 10, image: "models/a.json", origin: "960 540 0" },
      compose(11, { parent: 10 }),
    ]);
    expect(child.unsupported).toEqual([]);
    expect(child.layers[1].passthroughModel).toBe(true);
  });

  it("组合层又 perspective: true：报 object:perspective（普通图像层不报）", async () => {
    const bundle = await compileObjects([compose(10, { perspective: true })]);
    expect(bundle.unsupported).toEqual(["object:perspective"]);
    expect(bundle.layers[0]).toMatchObject({ passthroughModel: true, perspective: true });
    const plain = await compileObjects([{ id: 10, image: "models/a.json", origin: "960 540 0", perspective: true }]);
    expect(plain.unsupported).toEqual([]);
  });

  it("fullscreenlayer 不报（P5b 步骤 3 起；以前报 model:fullscreen）", async () => {
    const bundle = await compileObjects([{ id: 10, image: "models/util/fullscreenlayer.json", origin: "960 540 0" }]);
    expect(bundle.unsupported).toEqual([]);
  });

  it("普通图像层、分组节点：passthroughModel false；copyBackground 在普通图像层上照记、分组节点缺省 true", async () => {
    const bundle = await compileObjects([
      { id: 10, image: "models/a.json", origin: "960 540 0", copybackground: false },
      { id: 11, name: "group", origin: "0 0 0" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    // 普通图像层上 copybackground 中性：渲染图只在组合层上读它
    expect(bundle.layers[0]).toMatchObject({ passthroughModel: false, copyBackground: false });
    expect(bundle.layers[1]).toMatchObject({ passthroughModel: false, copyBackground: true });
  });
});

describe("能力表：组合层与 projectlayer 模型（P5b 步骤 2）", () => {
  it("composelayer、projectlayer 模型不报", () => {
    expect(modelKeys(UTIL_MODELS.composelayer)).toEqual([]);
    expect(modelKeys(UTIL_MODELS.projectlayer)).toEqual([]);
    // 单独写 projectlayer（没有 autosize）只剩透明排序键，正交场景中性
    expect(modelKeys({ material: MATERIAL, projectlayer: true })).toEqual([]);
  });
  it("fullscreenlayer 不报（P5b 步骤 3 起）；instanced 的组合层照报 model:instanced", () => {
    expect(modelKeys(UTIL_MODELS.fullscreenlayer)).toEqual([]);
    expect(modelKeys({ material: MATERIAL, passthrough: true, instanced: true })).toEqual(["model:instanced"]);
  });
  it("对象上的 copybackground 不报（true / false 都是）", () => {
    expect(objectKeys({ id: 1, image: "models/util/composelayer.json", copybackground: false })).toEqual([]);
    expect(objectKeys({ id: 1, image: "models/util/composelayer.json", copybackground: true })).toEqual([]);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const utilModel = (name: string) => join(root ?? "", "assets", "models", "util", `${name}.json`);
describe.skipIf(!root || !existsSync(utilModel("composelayer")))("WPE 自带的组合层模型（assets/models/util）", () => {
  it.each<[string, string[]]>([
    ["composelayer", []],
    ["composelayer_depthtest", []],
    ["projectlayer", []],
    // P5b 步骤 3 起不报（以前报 model:fullscreen）
    ["fullscreenlayer", []],
  ])("%s → %j", (name, expected) => {
    expect(modelKeys(parseModel(readFileSync(utilModel(name), "utf8")))).toEqual(expected);
  });
});

// ———— P5b 步骤 3：fullscreen ————

/** WPE 的 `materials/util/fullscreenlayer.json`：passthrough 着色器，槽 0 是 `_rt_FullFrameBuffer`。 */
const FULLSCREEN_MATERIAL = {
  passes: [
    {
      shader: "passthrough",
      depthtest: "disabled",
      depthwrite: "disabled",
      blending: "translucent",
      cullmode: "nocull",
      textures: ["_rt_FullFrameBuffer"],
    },
  ],
};
/** fullscreenlayer 换成 WPE 原样的材质（上面那份）；`p5b-fs` 的 F1 那样的对象（`ignore/p5/b0/gen_b.py` 的 `p_fs`）。 */
const FULLSCREEN_FILES = {
  "models/util/fullscreenlayer.json": JSON.stringify({
    material: "materials/util/fullscreenlayer.json",
    fullscreen: true,
    passthrough: true,
  }),
  "materials/util/fullscreenlayer.json": JSON.stringify(FULLSCREEN_MATERIAL),
  "shaders/passthrough.vert": "void main() {}",
  "shaders/passthrough.frag": "void main() {}",
};
const f1 = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: "F1",
  image: "models/util/fullscreenlayer.json",
  origin: "100 50 0",
  size: "300 200",
  scale: "0.5 0.5 1",
  angles: "0 0 0.7",
  ...extra,
});

describe("compileScene：fullscreen 的两份尺寸（P5b 步骤 3）", () => {
  it("fullscreenlayer（槽 0 是 _rt_FullFrameBuffer）：size 固定 2×2，fullscreenSize 取场景尺寸，不报", async () => {
    const bundle = await compileObjects([f1(11)], {}, FULLSCREEN_FILES);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({
      fullscreen: true,
      passthroughModel: true,
      size: [2, 2],
      fullscreenSize: [1920, 1080],
    });
    // 槽 0 没有静态纹理，在运行时表里
    expect(bundle.layers[0].passes[0]).toMatchObject({ runtime: { 0: "_rt_FullFrameBuffer" }, framebuffer: true });
    expect(bundle.layers[0].passes[0].textures[0]).toBeUndefined();
  });

  it("fullscreenlayer 在 1280×720 的场景里：fullscreenSize 跟着场景尺寸", async () => {
    const bundle = await compileObjects(
      [f1(11)],
      { orthogonalprojection: { width: 1280, height: 720 } },
      FULLSCREEN_FILES,
    );
    expect(bundle.layers[0]).toMatchObject({ size: [2, 2], fullscreenSize: [1280, 720] });
  });

  it("非组合层的 fullscreen 模型、槽 0 是静态纹理：fullscreenSize 取图像尺寸（48×40，不是纹理尺寸 64×64），size 2×2", async () => {
    const bundle = await compileImage({ fullscreen: true }, { size: "300 300", scale: "50 50 1" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({
      fullscreen: true,
      passthroughModel: false,
      size: [2, 2],
      fullscreenSize: [48, 40],
    });
  });

  it("fullscreen 排在 autosize、模型宽高、对象 size 之前：几何仍是 2×2", async () => {
    for (const [model, object] of [
      [{ fullscreen: true, autosize: true }, { size: "24 20" }],
      [{ fullscreen: true, width: 100, height: 50 }, {}],
      [{ fullscreen: true, autosize: true, projectlayer: true, passthrough: true }, { size: "500 300" }],
    ] as const) {
      const bundle = await compileImage(model, object);
      expect(bundle.layers[0].size, JSON.stringify(model)).toEqual([2, 2]);
      expect(bundle.layers[0].fullscreenSize, JSON.stringify(model)).toEqual([48, 40]);
    }
  });

  it("槽 0 没有纹理（材质不写 textures）：fullscreenSize 取场景尺寸", async () => {
    const bundle = await compileObjects(
      [{ id: 10, image: "models/notex.json", origin: "960 540 0" }],
      {},
      {
        "models/notex.json": JSON.stringify({ material: "materials/notex.json", fullscreen: true }),
        "materials/notex.json": JSON.stringify({ passes: [{ shader: "s" }] }),
      },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ fullscreen: true, size: [2, 2], fullscreenSize: [1920, 1080] });
  });

  it("`fullscreen: 1` 不算：普通图像层，尺寸照 imageLayerSize，fullscreenSize 为 null", async () => {
    const bundle = await compileImage({ fullscreen: 1 }, { size: "300 300" });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ fullscreen: false, size: [300, 300], fullscreenSize: null });
  });

  it("普通图像层、组合层、分组节点：fullscreen false、fullscreenSize null", async () => {
    const bundle = await compileObjects([
      { id: 10, image: "models/a.json", origin: "960 540 0" },
      compose(11),
      { id: 12, name: "group", origin: "0 0 0" },
    ]);
    for (const layer of bundle.layers) expect(layer).toMatchObject({ fullscreen: false, fullscreenSize: null });
  });
});

describe("能力表：fullscreen 模型（P5b 步骤 3）", () => {
  it("fullscreen 模型、fullscreenlayer 都不报 model:fullscreen", () => {
    expect(modelKeys({ material: MATERIAL, fullscreen: true })).toEqual([]);
    expect(modelKeys({ material: "materials/util/fullscreenlayer.json", fullscreen: true, passthrough: true })).toEqual(
      [],
    );
    // 和 autosize 等一起写也不报
    expect(modelKeys({ material: MATERIAL, fullscreen: true, autosize: true, nopadding: true })).toEqual([]);
  });
  it("对象上的 fullscreen 键是另一回事，照报 object:fullscreen", () => {
    expect(objectKeys({ id: 1, image: "models/a.json", fullscreen: true })).toEqual(["object:fullscreen"]);
  });
  it("整场检查：fullscreenlayer 场景没有 model:fullscreen（能力表只看模型 JSON，这里经 compileScene）", async () => {
    const bundle = await compileObjects([f1(11, { effects: [] })], {}, FULLSCREEN_FILES);
    expect(bundle.unsupported.filter((key) => key.includes("fullscreen"))).toEqual([]);
  });
});

const utilMaterial = join(root ?? "", "assets", "materials", "util", "fullscreenlayer.json");
describe.skipIf(!root || !existsSync(utilModel("fullscreenlayer")) || !existsSync(utilMaterial))(
  "WPE 自带的 fullscreenlayer（assets/models/util、assets/materials/util）",
  () => {
    it("原样的模型与材质：不报，size 2×2，fullscreenSize 取场景尺寸", async () => {
      const bundle = await compileObjects(
        [f1(11)],
        {},
        {
          ...FULLSCREEN_FILES,
          "models/util/fullscreenlayer.json": readFileSync(utilModel("fullscreenlayer"), "utf8"),
          "materials/util/fullscreenlayer.json": readFileSync(utilMaterial, "utf8"),
        },
      );
      expect(bundle.unsupported).toEqual([]);
      expect(bundle.layers[0]).toMatchObject({
        fullscreen: true,
        passthroughModel: true,
        size: [2, 2],
        fullscreenSize: [1920, 1080],
      });
    });
  },
);
