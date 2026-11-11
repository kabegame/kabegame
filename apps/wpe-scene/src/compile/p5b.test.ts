/**
 * P5b 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「步骤 1」）：图像层尺寸的取值顺序
 * （`imageLayerSize`）、图层上的 `noPadding` / `perspective` 两个标志、能力表放开 `nopadding` 与图像层的 `perspective: true`。
 * 依据是 p5-REPORT「P5b 语义的实测核对」：`p5b-autosize`（`autosize` 覆盖 `size`，三者都缺时 1×1）、`p5b-nopad`、`p5b-persp`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, imageLayerSize } from "./bundle";
import { checkModelFeatures, checkObjectFeatures, checkSceneFeatures } from "./features";
import type { SceneReader } from "./fs";
import type { ModelJson, SceneObject } from "./model";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** `p5b-autosize` 的纹理：纹理尺寸 64×64，图像尺寸 48×40（NPOT 图像补到 2 的幂）。 */
const TEXTURE = { width: 48, height: 40, textureWidth: 64, textureHeight: 64 };
const MATERIAL = "materials/a.json";

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
    expect(imageLayerSize(model, size, TEXTURE)).toEqual(expected);
  });

  it("对象 size 覆盖模型宽高（没有 autosize）", () => {
    expect(imageLayerSize({ material: MATERIAL, width: 100, height: 50 }, [24, 20], TEXTURE)).toEqual([24, 20]);
  });

  it("模型宽高两个分量各自生效：只写一个时另一个保持 1", () => {
    expect(imageLayerSize({ material: MATERIAL, width: 100 }, [], TEXTURE)).toEqual([100, 1]);
    expect(imageLayerSize({ material: MATERIAL, height: 50 }, [], TEXTURE)).toEqual([1, 50]);
  });

  it("模型宽高写成字符串不算（只认 JSON 数字）", () => {
    const model = { material: MATERIAL, width: "100", height: 50 } as unknown as ModelJson;
    expect(imageLayerSize(model, [], TEXTURE)).toEqual([1, 50]);
    expect(
      imageLayerSize({ material: MATERIAL, width: "100", height: "50" } as unknown as ModelJson, [], TEXTURE),
    ).toEqual([1, 1]);
  });

  it("autosize 没有纹理时不覆盖；autosize 写成 1、字符串不算", () => {
    expect(imageLayerSize({ material: MATERIAL, autosize: true }, [24, 20], undefined)).toEqual([24, 20]);
    expect(imageLayerSize({ material: MATERIAL, autosize: true }, [], undefined)).toEqual([1, 1]);
    expect(imageLayerSize({ material: MATERIAL, autosize: 1 }, [24, 20], TEXTURE)).toEqual([24, 20]);
    expect(imageLayerSize({ material: MATERIAL, autosize: "true" }, [], TEXTURE)).toEqual([1, 1]);
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
