/**
 * P5b 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`）：
 * - 步骤 1：图像层尺寸的取值顺序（`imageLayerSize`）、图层上的 `noPadding` / `perspective` 两个标志、能力表放开 `nopadding` 与
 *   图像层的 `perspective: true`；
 * - 步骤 2：组合层（无子层）的 `passthroughModel` / `copyBackground`、`projectlayer` 取正交投影宽高、能力表放开 `passthrough` 与
 *   `projectlayer`，带子层报 `model:passthrough:children`、组合层又透视报 `object:perspective`；
 * - 步骤 3：`fullscreen` 模型的 `fullscreen` / `fullscreenSize`（几何 2×2，合成 RT 取槽 0 静态纹理的图像尺寸或场景尺寸）、能力表放开
 *   `fullscreen`（fullscreenlayer 不再报）；
 * - 步骤 4：组（带子层的组合层）的归属 `group` 与子树 `subtree`（`assignGroups`）、上屏材质 `groupUpload`，不再报
 *   `model:passthrough:children`，组里还不支持的用法细分成 `model:passthrough:children:framebuffer` / `:fullscreen` / `:perspective`
 *   （`groupChildIssues`），fullscreenlayer 带子层报 `model:fullscreen:children`。
 * - 步骤 5：`instanced` 模型不再报 `model:instanced`，图层上 `solidLayer` 与 `instanced` 分开记；对象的 `instance` 在编译材质前覆盖
 *   pass 的 `textures`（按槽）与 `combos`，`checkInstanceFeatures` 的细分键；非 instanced 对象上的 `instance` 中性。
 * 依据是 p5-REPORT「P5b 语义的实测核对」：`p5b-autosize`（`autosize` 覆盖 `size`，三者都缺时 1×1）、`p5b-nopad`、`p5b-persp`、
 * `p5b-cl`、`p5b-proj`、`p5b-fs`、`p5b-fsmvp`、`p5b-inst`、`p5b-inst2`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assignGroups, compileScene, imageLayerSize, type SceneLayer, type ScenePass } from "./bundle";
import {
  checkInstanceFeatures,
  checkModelFeatures,
  checkObjectFeatures,
  checkSceneFeatures,
  groupChildIssues,
} from "./features";
import type { SceneParticle } from "./particles";
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
/** RGBA8 单 mip 的 `.tex`（TEXB0002）：缺省纹理尺寸 64×64、图像尺寸 48×40；`size` / `image` 给别的尺寸（P5b 步骤 5 的 `util/white`）。 */
function tex(size = 64, image: [number, number] = [48, 40]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
    u32(size),
    u32(size),
    u32(image[0]),
    u32(image[1]),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(size),
    u32(size),
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
 * （键是工程内路径，同名覆盖上面的默认文件）；`tr` 缺省是上面的假翻译器（P5b 步骤 5 的 combos 用例换成记录请求的）。
 */
async function compileObjects(
  objects: Record<string, unknown>[],
  general: Record<string, unknown> = {},
  extra: Record<string, Uint8Array | string> = {},
  tr: Wpesl2wgsl = translator,
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
    translator: tr,
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

/**
 * 组的上屏材质（P5b 步骤 4）：WPE 的 `materials/util/effectpassthrough.json` / `_4.json`（genericimage3 / 4，normal、没有纹理），
 * 着色器是空壳（假翻译器不读）。
 */
const GROUP_FILES: Record<string, string> = {
  "materials/util/effectpassthrough.json": JSON.stringify({
    passes: [{ shader: "genericimage3", blending: "normal", depthtest: "disabled", depthwrite: "disabled" }],
  }),
  "materials/util/effectpassthrough_4.json": JSON.stringify({
    passes: [{ shader: "genericimage4", blending: "normal", depthtest: "disabled", depthwrite: "disabled" }],
  }),
  "shaders/genericimage3.vert": "// genericimage3\nvoid main() {}",
  "shaders/genericimage3.frag": "// genericimage3\nvoid main() {}",
  "shaders/genericimage4.vert": "// genericimage4\nvoid main() {}",
  "shaders/genericimage4.frag": "// genericimage4\nvoid main() {}",
};

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

  it("带子层（P5b 步骤 4 起不再报 model:passthrough:children）：是组，子层是分组节点也算", async () => {
    const bundle = await compileObjects(
      [compose(10), { id: 11, image: "models/a.json", origin: "0 0 0", parent: 10 }, compose(12)],
      {},
      GROUP_FILES,
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => [layer.group, layer.subtree])).toEqual([
      [null, [1]],
      [0, []],
      [null, []],
    ]);
    const group = await compileObjects(
      [compose(10), { id: 11, name: "group", origin: "0 0 0", parent: 10 }],
      {},
      GROUP_FILES,
    );
    expect(group.unsupported).toEqual([]);
    expect(group.layers[0].subtree).toEqual([1]);
    expect(group.layers[0].groupUpload).not.toBeNull();
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
  it("fullscreenlayer 不报（P5b 步骤 3 起）；instanced 的组合层也不再报 model:instanced（步骤 5 起，对象另查，见下）", () => {
    expect(modelKeys(UTIL_MODELS.fullscreenlayer)).toEqual([]);
    expect(modelKeys({ material: MATERIAL, passthrough: true, instanced: true })).toEqual([]);
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
  it('fullscreenlayer（槽 0 是 _rt_FullFrameBuffer）：size 固定 2×2，fullscreenSize 记 "scene"（渲染时取场景目标尺寸），不报', async () => {
    const bundle = await compileObjects([f1(11)], {}, FULLSCREEN_FILES);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({
      fullscreen: true,
      passthroughModel: true,
      size: [2, 2],
      fullscreenSize: "scene",
    });
    // 槽 0 没有静态纹理，在运行时表里
    expect(bundle.layers[0].passes[0]).toMatchObject({ runtime: { 0: "_rt_FullFrameBuffer" }, framebuffer: true });
    expect(bundle.layers[0].passes[0].textures[0]).toBeUndefined();
  });

  it('fullscreenlayer 在 1280×720 的场景里：fullscreenSize 同样记 "scene"（P5d 步骤 2 起渲染时取场景目标尺寸）', async () => {
    const bundle = await compileObjects(
      [f1(11)],
      { orthogonalprojection: { width: 1280, height: 720 } },
      FULLSCREEN_FILES,
    );
    expect(bundle.layers[0]).toMatchObject({ size: [2, 2], fullscreenSize: "scene" });
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

  it('槽 0 没有纹理（材质不写 textures）：fullscreenSize 记 "scene"', async () => {
    const bundle = await compileObjects(
      [{ id: 10, image: "models/notex.json", origin: "960 540 0" }],
      {},
      {
        "models/notex.json": JSON.stringify({ material: "materials/notex.json", fullscreen: true }),
        "materials/notex.json": JSON.stringify({ passes: [{ shader: "s" }] }),
      },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ fullscreen: true, size: [2, 2], fullscreenSize: "scene" });
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
    it('原样的模型与材质：不报，size 2×2，fullscreenSize 记 "scene"', async () => {
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
        fullscreenSize: "scene",
      });
    });
  },
);

// ———— P5b 步骤 4：组（带子层的组合层） ————

type GroupNode = Pick<SceneLayer, "object" | "parent" | "passthroughModel" | "group" | "subtree">;
/** `[object, parent, 是不是组合层]` → assignGroups 的输入，按给的顺序（即 `objects` 顺序）。 */
const nodes = (list: [number, number | null, boolean][]): GroupNode[] =>
  list.map(([object, parent, passthroughModel]) => ({ object, parent, passthroughModel, group: -1, subtree: [-1] }));
const groupsOf = (layers: GroupNode[]) =>
  Object.fromEntries(layers.map((layer) => [layer.object, { group: layer.group, subtree: layer.subtree }]));

describe("assignGroups：归属与先序子树（rea-p5-modelflags §2.2）", () => {
  it("p5b-grp：组下三个子层，按 objects 下标；组之后的顶层层不归组", () => {
    const layers = nodes([
      [0, null, false],
      [1, null, true],
      [2, 1, false],
      [3, 1, false],
      [4, 1, false],
      [5, null, false],
    ]);
    assignGroups(layers);
    expect(groupsOf(layers)).toEqual({
      0: { group: null, subtree: [] },
      1: { group: null, subtree: [2, 3, 4] },
      2: { group: 1, subtree: [] },
      3: { group: 1, subtree: [] },
      4: { group: 1, subtree: [] },
      5: { group: null, subtree: [] },
    });
  });

  it("p5b-nest：嵌套组只收它本身，它的子孙归它；外层的兄弟层排在前面", () => {
    const layers = nodes([
      [0, null, false],
      [1, null, true],
      [2, 1, false],
      [3, 1, true],
      [4, 3, false],
    ]);
    assignGroups(layers);
    expect(groupsOf(layers)).toEqual({
      0: { group: null, subtree: [] },
      1: { group: null, subtree: [2, 3] },
      2: { group: 1, subtree: [] },
      3: { group: 1, subtree: [4] },
      4: { group: 3, subtree: [] },
    });
  });

  it("分组节点下的子孙也归组，先序：节点自己 → 它的子树 → 下一个子层", () => {
    // 组 G(1) 下：分组节点 N(2)、图层 A(5)；N 下：B(3)、C(4)；C 下 D(6)
    const layers = nodes([
      [0, null, false],
      [1, null, true],
      [2, 1, false],
      [3, 2, false],
      [4, 2, false],
      [5, 1, false],
      [6, 4, false],
    ]);
    assignGroups(layers);
    expect(layers[1].subtree).toEqual([2, 3, 4, 6, 5]);
    for (const object of [2, 3, 4, 5, 6]) expect(layers[object].group, String(object)).toBe(1);
  });

  it("objects 顺序与父子顺序不一致：子在父前、子层之间按 objects 下标", () => {
    // 子 4、2 排在组 3 前面；2 的子 0 排在最前
    const layers = nodes([
      [0, 2, false],
      [1, null, false],
      [2, 3, false],
      [3, null, true],
      [4, 3, false],
    ]);
    assignGroups(layers);
    expect(layers[3].subtree).toEqual([2, 0, 4]);
    expect([layers[0].group, layers[2].group, layers[4].group, layers[1].group]).toEqual([3, 3, 3, null]);
  });

  it("没有子层的组合层不是组；组合层的子孙再往上有组合层时取最近的；父不在表里当根", () => {
    const layers = nodes([
      [0, null, true],
      [1, null, true],
      [2, 1, true],
      [3, 2, false],
      [4, 99, false],
    ]);
    assignGroups(layers);
    expect(groupsOf(layers)).toEqual({
      0: { group: null, subtree: [] },
      1: { group: null, subtree: [2] },
      2: { group: 1, subtree: [3] },
      3: { group: 2, subtree: [] },
      4: { group: null, subtree: [] },
    });
  });
});

function scenePass(extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key: "k",
    program: 0,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}
type ChildIssueLayer = Parameters<typeof groupChildIssues>[0];
const child = (extra: Partial<ChildIssueLayer> = {}): ChildIssueLayer => ({
  passthroughModel: false,
  passes: [scenePass()],
  effects: [],
  colorBlendMode: 0,
  fullscreen: false,
  perspective: false,
  particle: null,
  ...extra,
});
const effect = (framebuffer: boolean, enabled = true) =>
  ({
    source: 0,
    id: 1,
    name: "fx",
    file: "effects/fx/effect.json",
    fbos: [],
    steps: [{ kind: "draw", pass: scenePass({ framebuffer }), target: null, compose: false, binds: null }],
    enabled,
    visibleBound: !enabled,
    unsupported: [],
  }) as SceneLayer["effects"][number];
/** 粒子系统树：根与一个 static 子系统，只填 `groupChildIssues` 读的字段。 */
const particle = (
  root: { flags?: number; framebuffer?: boolean },
  sub: { flags?: number; framebuffer?: boolean } = {},
) =>
  ({
    flags: root.flags ?? 0,
    passes: [scenePass({ framebuffer: root.framebuffer ?? false })],
    children: [
      {
        type: "static",
        system: { flags: sub.flags ?? 0, passes: [scenePass({ framebuffer: sub.framebuffer ?? false })], children: [] },
      },
    ],
  }) as unknown as SceneParticle;

describe("groupChildIssues：组里还不支持的用法", () => {
  it("普通图层、带不读快照的 effect、colorBlendMode 31、本地 / 世界空间粒子：不报", () => {
    expect(groupChildIssues(child())).toEqual([]);
    expect(groupChildIssues(child({ effects: [effect(false)] }))).toEqual([]);
    expect(groupChildIssues(child({ colorBlendMode: 31 }))).toEqual([]);
    expect(groupChildIssues(child({ passes: [], particle: particle({ flags: 1 }, { flags: 2 }) }))).toEqual([]);
  });

  it("要拷快照：基础 pass、启用 effect 的 pass、colorBlendMode ∉ {0, 31}、粒子树里任一 pass（含子系统）", () => {
    const key = ["model:passthrough:children:framebuffer"];
    expect(groupChildIssues(child({ passes: [scenePass({ framebuffer: true })] }))).toEqual(key);
    expect(groupChildIssues(child({ effects: [effect(false), effect(true)] }))).toEqual(key);
    expect(groupChildIssues(child({ colorBlendMode: 2 }))).toEqual(key);
    expect(groupChildIssues(child({ passes: [], particle: particle({ framebuffer: true }) }))).toEqual(key);
    expect(groupChildIssues(child({ passes: [], particle: particle({}, { framebuffer: true }) }))).toEqual(key);
    // 关着的 effect 不算（它自己的不支持项由 compileScene 补，见下）
    expect(groupChildIssues(child({ effects: [effect(true, false)] }))).toEqual([]);
  });

  it("嵌套组：基础 pass（composelayer 读快照）不算；它的 effect 读快照、colorBlendMode 混合照报", () => {
    const nested = child({ passthroughModel: true, passes: [scenePass({ framebuffer: true })] });
    expect(groupChildIssues(nested)).toEqual([]);
    expect(groupChildIssues({ ...nested, effects: [effect(true)] })).toEqual([
      "model:passthrough:children:framebuffer",
    ]);
    expect(groupChildIssues({ ...nested, colorBlendMode: 5 })).toEqual(["model:passthrough:children:framebuffer"]);
  });

  it("fullscreen；perspective 图层、粒子树里有透视系统（flags & 4，含子系统）", () => {
    expect(groupChildIssues(child({ fullscreen: true }))).toEqual(["model:passthrough:children:fullscreen"]);
    const perspective = ["model:passthrough:children:perspective"];
    expect(groupChildIssues(child({ perspective: true }))).toEqual(perspective);
    expect(groupChildIssues(child({ passes: [], particle: particle({ flags: 4 }) }))).toEqual(perspective);
    expect(groupChildIssues(child({ passes: [], particle: particle({ flags: 1 }, { flags: 5 }) }))).toEqual(
      perspective,
    );
  });
});

/** 读快照的 effect（槽 1 是 `_rt_FullFrameBuffer`）与不读的 effect。 */
const FX_FILES: Record<string, string> = {
  "effects/fb/effect.json": JSON.stringify({ passes: [{ material: "materials/fxfb.json" }] }),
  "materials/fxfb.json": JSON.stringify({ passes: [{ shader: "s", textures: [null, "_rt_FullFrameBuffer"] }] }),
  "effects/plain/effect.json": JSON.stringify({ passes: [{ material: "materials/fxplain.json" }] }),
  "materials/fxplain.json": JSON.stringify({ passes: [{ shader: "s" }] }),
};
const image = (id: number, parent: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  name: `I${id}`,
  image: "models/a.json",
  origin: "0 0 0",
  ...(parent === null ? {} : { parent }),
  ...extra,
});
const compileGroup = (objects: Record<string, unknown>[], general: Record<string, unknown> = {}) =>
  compileObjects(objects, general, { ...GROUP_FILES, ...FX_FILES });

describe("compileScene：组（P5b 步骤 4）", () => {
  it("p5b-grp 的结构：组的 subtree、子层的 group、groupUpload（effectpassthrough，g_Color4 = 1，槽 0 由渲染图填）", async () => {
    const bundle = await compileGroup([
      image(1, null),
      compose(10, { origin: "960 540 0", size: "800 400", angles: "0 0 0.2" }),
      image(20, 10),
      image(21, 10),
      image(22, 10),
      image(30, null),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => layer.group)).toEqual([null, null, 1, 1, 1, null]);
    expect(bundle.layers[1].subtree).toEqual([2, 3, 4]);
    const upload = bundle.layers[1].groupUpload!;
    expect(upload).toMatchObject({ key: "objects/1/groupupload", blending: "normal", framebuffer: false });
    expect(upload.program).not.toBeNull();
    expect(upload.uniforms.g_Color4).toEqual([1, 1, 1, 1]);
    expect(upload.textures[0]).toBeUndefined();
    expect(upload.runtime[0]).toBeUndefined();
    // 子层、普通图层、没有子层的组合层都没有
    for (const index of [0, 2, 3, 4, 5]) expect(bundle.layers[index].groupUpload, String(index)).toBeNull();
    expect((await compileGroup([compose(10)])).layers[0].groupUpload).toBeNull();
  });

  it("上屏材质按场景 version（同 colorBlendMode 混合的 passthrough）：> 2 用 effectpassthrough_4；缺材质报 material:missing", async () => {
    const objects = [compose(10), image(11, 10)];
    const shaderOf = async (version: number | undefined) => {
      const shaders: string[] = [];
      const recording = {
        async translate(input: unknown) {
          shaders.push(JSON.stringify(input).match(/genericimage\d/)?.[0] ?? "");
          return { ok: true, uniforms: [], textures: [], combos: [] };
        },
      } as unknown as Wpesl2wgsl;
      const scene = JSON.stringify({
        version,
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects,
      });
      const files: Record<string, string | Uint8Array> = { "P:/p/scene.json": scene };
      for (const [path, value] of Object.entries({ ...GROUP_FILES, ...FX_FILES })) files[`P:/p/${path}`] = value;
      const bundle = await compileScene({
        projectDir: "P:/p",
        sceneAssets: ["A:/assets"],
        reader: memoryReader({
          "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
          "P:/p/models/util/composelayer.json": JSON.stringify(UTIL_MODELS.composelayer),
          "P:/p/materials/util/composelayer.json": JSON.stringify(COMPOSE_MATERIAL),
          "P:/p/models/a.json": JSON.stringify({ material: MATERIAL }),
          "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
          "P:/p/materials/a.tex": tex(),
          "P:/p/shaders/s.vert": "void main() {}",
          "P:/p/shaders/s.frag": "void main() {}",
          "P:/p/shaders/composelayer.vert": "void main() {}",
          "P:/p/shaders/composelayer.frag": "void main() {}",
          ...files,
        }),
        translator: recording,
        postprocess: "disabled",
        exhaustive: true,
      });
      expect(bundle.unsupported).toEqual([]);
      expect(bundle.layers[0].groupUpload).not.toBeNull();
      return shaders.filter(Boolean);
    };
    expect(await shaderOf(undefined)).toEqual(["genericimage3"]);
    expect(await shaderOf(2)).toEqual(["genericimage3"]);
    expect(await shaderOf(3)).toEqual(["genericimage4"]);
    const missing = await compileObjects(objects, {}, {});
    expect(missing.unsupported).toEqual(["material:missing:materials/util/effectpassthrough.json"]);
    expect(missing.layers[0].groupUpload).toBeNull();
  });

  it("组里的照报：读快照的 effect、colorBlendMode 混合、fullscreen、perspective；嵌套组本身不报", async () => {
    const fb = await compileGroup([
      compose(10),
      image(11, 10, { effects: [{ file: "effects/fb/effect.json" }] }),
      image(12, 10, { effects: [{ file: "effects/plain/effect.json" }] }),
    ]);
    expect(fb.unsupported).toEqual(["model:passthrough:children:framebuffer"]);
    expect((await compileGroup([compose(10), image(11, 10, { colorBlendMode: 2 })])).unsupported).toEqual([
      "model:passthrough:children:framebuffer",
    ]);
    expect((await compileGroup([compose(10), image(11, 10, { perspective: true })])).unsupported).toEqual([
      "model:passthrough:children:perspective",
    ]);
    const fullscreen = await compileObjects(
      [compose(10), image(11, 10, { image: "models/fs.json" })],
      {},
      { ...GROUP_FILES, "models/fs.json": JSON.stringify({ material: MATERIAL, fullscreen: true }) },
    );
    expect(fullscreen.unsupported).toEqual(["model:passthrough:children:fullscreen"]);
    // p5b-nest：嵌套组（composelayer 读快照）与它的子层都不报
    const nest = await compileGroup([
      image(1, null),
      compose(10, { size: "1200 600", effects: [{ file: "effects/plain/effect.json" }] }),
      image(11, 10),
      compose(12, { parent: 10, size: "300 300", effects: [{ file: "effects/plain/effect.json" }] }),
      image(13, 12),
    ]);
    expect(nest.unsupported).toEqual([]);
    expect(nest.layers.map((layer) => layer.group)).toEqual([null, null, 1, 1, 3]);
    expect(nest.layers[1].subtree).toEqual([2, 3]);
    expect(nest.layers[3].subtree).toEqual([4]);
    // 组外的同样用法不报
    expect(
      (await compileGroup([compose(10), image(11, 10), image(12, null, { colorBlendMode: 2, perspective: true })]))
        .unsupported,
    ).toEqual([]);
  });

  it("关着、绑了属性的 effect 读快照：场景级不报，记进那个 effect 自己的不支持项（打开时整场重编译）", async () => {
    const bundle = await compileGroup([
      compose(10),
      image(11, 10, { effects: [{ file: "effects/fb/effect.json", visible: { user: "p", value: false } }] }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[1].effects[0]).toMatchObject({
      enabled: false,
      visibleBound: true,
      unsupported: ["model:passthrough:children:framebuffer"],
    });
  });

  it("fullscreenlayer 带子层：报 model:fullscreen:children（没有子层时不报）", async () => {
    const files = { ...FULLSCREEN_FILES, ...GROUP_FILES };
    expect((await compileObjects([f1(10), image(11, 10)], {}, files)).unsupported).toEqual([
      "model:fullscreen:children",
    ]);
    expect((await compileObjects([f1(10)], {}, files)).unsupported).toEqual([]);
  });
});

// ———— P5b 步骤 5：instanced ————

/**
 * 编辑器的纯色图层（`ignore/p5/b5/gen_b5.py` 的 `p5b-inst2`）：模型固定是 `{instanced, solidlayer, material}`，材质是 translucent 的
 * genericimage2、槽 0 是 `util/white`（32×32），`combos` 同语料写 `{"version": 2}`。着色器是空壳（假翻译器不读）。
 */
const INSTANCE_MATERIAL = "materials/util/solidlayer_instance.json";
const INSTANCE_FILES: Record<string, Uint8Array | string> = {
  "models/util/solidlayer_instance.json": JSON.stringify({
    instanced: true,
    solidlayer: true,
    material: INSTANCE_MATERIAL,
  }),
  [INSTANCE_MATERIAL]: JSON.stringify({
    passes: [
      {
        shader: "genericimage2",
        blending: "translucent",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: ["util/white"],
        combos: { version: 2 },
      },
    ],
  }),
  "materials/util/white.tex": tex(32, [32, 32]),
  "shaders/genericimage2.vert": "void main() {}",
  "shaders/genericimage2.frag": "void main() {}",
};
/** 编辑器写的 `instance`：`id`、槽 0 纹理、和材质相同的 `combos`（语料 167 个对象都是这个形状）。 */
const EDITOR_INSTANCE = { id: 5, textures: ["util/white"], combos: { version: 2 } };
/** `p5b-inst2` 的 J1 那样的对象（`size` 900×1000）；`extra` 里写 `undefined` 的键序列化后就是缺键。 */
const solid = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `J${id}`,
  image: "models/util/solidlayer_instance.json",
  origin: "960 540 0",
  size: "900 1000",
  instance: EDITOR_INSTANCE,
  ...extra,
});
const compileInstanced = (objects: Record<string, unknown>[], extra: Record<string, Uint8Array | string> = {}) =>
  compileObjects(objects, {}, { ...INSTANCE_FILES, ...extra });
/** 图层基础 pass 槽 0 的纹理。 */
const slot0 = (bundle: Awaited<ReturnType<typeof compileScene>>, layer = 0) =>
  bundle.textures[bundle.layers[layer].passes[0].textures[0]];

describe("compileScene：instanced（P5b 步骤 5）", () => {
  it("纯色图层不再报 model:instanced：solidLayer 与 instanced 都为真，size 照对象 900×1000，槽 0 是 util/white（32×32）", async () => {
    const bundle = await compileInstanced([solid(10)]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({
      solidLayer: true,
      instanced: true,
      passthroughModel: false,
      size: [900, 1000],
    });
    expect(slot0(bundle)).toMatchObject({
      path: "materials/util/white.tex",
      width: 32,
      height: 32,
      textureWidth: 32,
      textureHeight: 32,
    });
  });

  it("instance.textures 覆盖槽 0（p5b-inst2 的 J2：补边纹理，图像 48×40、纹理 64×64）；材质原来的 util/white 不再读", async () => {
    const bundle = await compileInstanced([solid(10, { instance: { ...EDITOR_INSTANCE, textures: ["a"] } })]);
    expect(bundle.unsupported).toEqual([]);
    expect(slot0(bundle)).toMatchObject({
      path: "materials/a.tex",
      width: 48,
      height: 40,
      textureWidth: 64,
      textureHeight: 64,
    });
    expect(bundle.textures.map((texture) => texture.path)).toEqual(["materials/a.tex"]);
  });

  it("instance.combos 合进材质的 combos：新键加入、材质的保留，同名取 instance 的；值绑属性报 combo:user-binding", async () => {
    const combosOf = async (combos: unknown) => {
      const seen: unknown[] = [];
      const recording = {
        async translate(input: { combos?: unknown }) {
          seen.push(input.combos);
          return { ok: true, uniforms: [], textures: [], combos: [] };
        },
      } as unknown as Wpesl2wgsl;
      const bundle = await compileObjects(
        [solid(10, { instance: { ...EDITOR_INSTANCE, combos } })],
        {},
        INSTANCE_FILES,
        recording,
      );
      expect(bundle.unsupported).toEqual([]);
      return seen;
    };
    expect(await combosOf({ EXTRA: 1 })).toEqual([{ version: 2, EXTRA: 1 }]);
    expect(await combosOf({ version: 3 })).toEqual([{ version: 3 }]);
    expect(await combosOf({})).toEqual([{ version: 2 }]);
    // 合并后由材质 pass 的检查报（WPE 按整数读 COMBO，I3）
    const bound = await compileInstanced([solid(10, { instance: { combos: { EXTRA: { user: "p", value: 1 } } } })]);
    expect(bound.unsupported).toEqual(["combo:user-binding"]);
  });

  it("没写 instance：报 model:instanced:instance；instance 不是对象、size 不是字符串：各报各的，instance 不合并", async () => {
    const missing = await compileInstanced([solid(10, { instance: undefined })]);
    expect(missing.unsupported).toEqual(["model:instanced:instance"]);
    expect(missing.layers[0]).toMatchObject({ solidLayer: true, instanced: true });
    const odd = await compileInstanced([solid(10, { instance: "a", size: 900 })]);
    expect(odd.unsupported).toEqual(["model:instanced:instance", "model:instanced:size"]);
    expect(slot0(odd).path).toBe("materials/util/white.tex");
    // textures 不合规照报；合并时非字符串的槽保留材质的
    const badTextures = await compileInstanced([solid(10, { instance: { textures: [null, "a"] } })]);
    expect(badTextures.unsupported).toEqual(["object:instance:textures"]);
    expect(slot0(badTextures).path).toBe("materials/util/white.tex");
  });

  it("instanced 的组合层（passthrough + instanced）：不报 model:instanced；没写 instance 报 model:instanced:instance", async () => {
    const bundle = await compileObjects(
      [compose(10, { image: "models/ci.json" })],
      {},
      {
        "models/ci.json": JSON.stringify({
          material: "materials/util/composelayer.json",
          passthrough: true,
          instanced: true,
        }),
      },
    );
    expect(bundle.unsupported).toEqual(["model:instanced:instance"]);
    expect(bundle.layers[0]).toMatchObject({ passthroughModel: true, solidLayer: false, instanced: true });
  });

  it("`instanced: 1` 不算：不是 instanced 图层，instance 不合并、不检查", async () => {
    const bundle = await compileInstanced([solid(10, { instance: { textures: ["a"], foo: 1 }, size: 900 })], {
      "models/util/solidlayer_instance.json": JSON.stringify({
        instanced: 1,
        solidlayer: true,
        material: INSTANCE_MATERIAL,
      }),
    });
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ solidLayer: true, instanced: false });
    expect(bundle.textures.map((texture) => texture.path)).toEqual(["materials/util/white.tex"]);
  });

  it("非 instanced 对象上的 instance 中性：不报、不合并", async () => {
    const bundle = await compileInstanced([
      { id: 10, image: "models/a.json", origin: "960 540 0", instance: { textures: ["util/white"], foo: 1 } },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0]).toMatchObject({ solidLayer: false, instanced: false });
    expect(bundle.textures.map((texture) => texture.path)).toEqual(["materials/a.tex"]);
  });
});

describe("能力表：instanced（P5b 步骤 5）", () => {
  const instanceKeys = (extra: Record<string, unknown>) => {
    const keys = new Set<string>();
    checkInstanceFeatures(solid(10, extra) as SceneObject, keys);
    return [...keys].sort();
  };

  it("纯色图层模型（instanced + solidlayer）不报；编辑器写的对象不报（id 中性）", () => {
    expect(modelKeys({ material: INSTANCE_MATERIAL, instanced: true, solidlayer: true })).toEqual([]);
    expect(instanceKeys({})).toEqual([]);
    expect(instanceKeys({ instance: { id: 5 } })).toEqual([]);
    expect(instanceKeys({ instance: {} })).toEqual([]);
  });

  it("instance 缺失或不是对象：model:instanced:instance", () => {
    for (const instance of [undefined, null, "util/white", ["util/white"], 1])
      expect(instanceKeys({ instance }), JSON.stringify(instance)).toEqual(["model:instanced:instance"]);
  });

  it("对象 size 不是字符串（缺键也算）：model:instanced:size", () => {
    for (const size of [undefined, 900, [900, 1000], { user: "s", value: "900 1000" }])
      expect(instanceKeys({ size }), JSON.stringify(size)).toEqual(["model:instanced:size"]);
  });

  it("textures 不是非空字符串组成的数组：object:instance:textures；空数组、null 不报", () => {
    for (const textures of ["util/white", [""], [null], ["a", 1], [{ name: "a" }], { 0: "a" }])
      expect(instanceKeys({ instance: { textures } }), JSON.stringify(textures)).toEqual(["object:instance:textures"]);
    for (const textures of [["a"], ["a", "b"], [], null])
      expect(instanceKeys({ instance: { textures } }), JSON.stringify(textures)).toEqual([]);
  });

  it("combos 不是对象：object:instance:combos（值绑属性不在这里报）", () => {
    for (const combos of ["x", [1], 2, true])
      expect(instanceKeys({ instance: { combos } }), JSON.stringify(combos)).toEqual(["object:instance:combos"]);
    for (const combos of [{}, { version: 2 }, { A: { user: "p", value: 1 } }, null])
      expect(instanceKeys({ instance: { combos } }), JSON.stringify(combos)).toEqual([]);
  });

  it("usertextures 取值有效：material:usertextures", () => {
    for (const usertextures of [["$mediaThumbnail"], "usershortcut", [null]])
      expect(instanceKeys({ instance: { usertextures } }), JSON.stringify(usertextures)).toEqual([
        "material:usertextures",
      ]);
    for (const usertextures of [null, false, ""])
      expect(instanceKeys({ instance: { usertextures } }), JSON.stringify(usertextures)).toEqual([]);
  });

  it("其它键取值有效：object:instance:<键>", () => {
    expect(
      instanceKeys({
        instance: { ...EDITOR_INSTANCE, constantshadervalues: { alpha: 0.5 }, blending: "additive", foo: 0, bar: "" },
      }),
    ).toEqual(["object:instance:blending", "object:instance:constantshadervalues"]);
  });

  it("对象上的 instance 不再按未知键报 object:instance（checkObjectFeatures 不看它，instanced 时另查）", () => {
    expect(objectKeys(solid(10) as SceneObject)).toEqual([]);
    expect(objectKeys({ id: 1, image: "models/a.json", instance: { textures: ["a"], foo: 1 } })).toEqual([]);
    expect(objectKeys({ id: 1, image: "models/a.json", instance: "x" })).toEqual([]);
  });
});
