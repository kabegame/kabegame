/**
 * P8 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase8/phase-8-image-material.md`「步骤 1」）：
 * - 能力表：对象 `clampuvs` / `nointerpolation` 的 JSON 布尔值放行（null 同没写）；绑属性、挂脚本、别的取值照报
 *   `object:clampuvs` / `object:nointerpolation`（WPE 运行中改这两位不重建合成 RT，rea-p8-layer §3，推断，没有实测）；
 * - 图层上的两个字段：`clampUVs` 缺省 true、只有 JSON false 才关，`noInterpolation` 缺省 false、只认 JSON true。WPE 基类构造给图层
 *   `+0x304` 置 bit15（clampuvs）、清 bit14（nointerpolation），之后只有对象 JSON（和脚本）写这两位，基础纹理 `.tex` 的标志不写
 *   （rea-p8-layer §3.1，p8-REPORT「合成 RT 与基础纹理的采样」）。
 * 合成 RT 按这两个字段怎么采样见 `render/p8.test.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { checkObjectFeatures, checkSceneFeatures } from "./features";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";
import { TEX_FLAGS } from "./tex";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 能力表 ————

function objectKeys(object: SceneObject): string[] {
  const keys = new Set<string>();
  checkObjectFeatures(object, keys);
  return [...keys].sort();
}
const image = (extra: Record<string, unknown>): SceneObject => ({ id: 1, image: "models/a.json", ...extra });

describe("能力表：clampuvs / nointerpolation（P8 步骤 1）", () => {
  it.each(["clampuvs", "nointerpolation"])("%s：JSON true / false 不报，null 同没写", (key) => {
    expect(objectKeys(image({ [key]: true }))).toEqual([]);
    expect(objectKeys(image({ [key]: false }))).toEqual([]);
    expect(objectKeys(image({ [key]: null }))).toEqual([]);
    expect(objectKeys(image({ clampuvs: true, nointerpolation: true }))).toEqual([]);
    expect(objectKeys(image({ clampuvs: false, nointerpolation: false }))).toEqual([]);
  });

  it.each(["clampuvs", "nointerpolation"])(
    "%s：绑属性、挂脚本、写成 1 / 0 / 字符串照报（只报一次，不另报成未知键）",
    (key) => {
      const reported = [`object:${key}`];
      expect(objectKeys(image({ [key]: { user: "p", value: true } }))).toEqual(reported);
      expect(objectKeys(image({ [key]: { user: "p", value: false } }))).toEqual(reported);
      expect(objectKeys(image({ [key]: { script: "export function update(v) { return v; }", value: true } }))).toEqual(
        reported,
      );
      expect(objectKeys(image({ [key]: 1 }))).toEqual(reported);
      expect(objectKeys(image({ [key]: 0 }))).toEqual(reported);
      expect(objectKeys(image({ [key]: "true" }))).toEqual(reported);
    },
  );

  it("两个键各报各的", () => {
    expect(objectKeys(image({ clampuvs: { user: "a", value: true }, nointerpolation: "true" }))).toEqual([
      "object:clampuvs",
      "object:nointerpolation",
    ]);
    expect(objectKeys(image({ clampuvs: true, nointerpolation: 1 }))).toEqual(["object:nointerpolation"]);
  });

  it("没有基础纹理的对象同一规则（rea-p8-layer §3.3）：分组节点、文本上的 JSON 布尔值不报", () => {
    expect(objectKeys({ id: 1, name: "group", clampuvs: true, nointerpolation: false })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", clampuvs: true })).toEqual([]);
    expect(objectKeys({ id: 1, text: "a", clampuvs: { user: "p", value: true } })).toEqual(["object:clampuvs"]);
  });

  it("整场检查：写了这两个键的场景（语料的 15 + 3 张都是 JSON 布尔）不再报", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [
          { id: 1, image: "models/a.json", origin: "960 540 0", clampuvs: true },
          { id: 2, image: "models/a.json", origin: "960 540 0", nointerpolation: true },
        ],
      },
      keys,
    );
    expect([...keys]).toEqual([]);
  });
});

// ———— 编译：图层上的两个字段 ————

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
/** RGBA8 单 mip 的 `.tex`（TEXB0002），64×64，`flags` 是头里的标志字（`TEX_FLAGS`）。 */
function tex(flags: number): Uint8Array {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(flags),
    u32(size),
    u32(size),
    u32(size),
    u32(size),
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

/** 一组对象；`models/a.json` 是普通图像层，基础纹理的 `.tex` 标志由 `texFlags` 给（缺省 0）。 */
async function compileObjects(objects: Record<string, unknown>[], texFlags = 0) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "s", textures: ["a"] }] }),
      "P:/p/materials/a.tex": tex(texFlags),
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}
const object = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  image: "models/a.json",
  origin: "960 540 0",
  ...extra,
});
const flagsOf = (bundle: Awaited<ReturnType<typeof compileObjects>>) =>
  bundle.layers.map(({ clampUVs, noInterpolation }) => [clampUVs, noInterpolation]);

describe("compileScene：图层的 clampUVs / noInterpolation（P8 步骤 1）", () => {
  it("缺省 clampUVs 真、noInterpolation 假（WPE 基类构造 +0x304 = 0x8040）；JSON true / false 照取，不报", async () => {
    const bundle = await compileObjects([
      object(1),
      object(2, { clampuvs: true }),
      object(3, { clampuvs: false }),
      object(4, { nointerpolation: true }),
      object(5, { nointerpolation: false }),
      object(6, { clampuvs: true, nointerpolation: true }),
      object(7, { clampuvs: false, nointerpolation: false }),
      object(8, { clampuvs: null, nointerpolation: null }),
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [true, false],
      [false, false],
      [true, true],
      [true, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
  });

  it("基础纹理的 .tex 标志不写图层的两位（只管基础纹理自己的采样器）", async () => {
    const all = TEX_FLAGS.clampUVs | TEX_FLAGS.noInterpolation;
    const bundle = await compileObjects([object(1), object(2, { clampuvs: false })], all);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.textures[0]).toMatchObject({ clampUVs: true, noInterpolation: true });
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [false, false],
    ]);
    // 纹理标志 0：图层照样缺省钳制
    expect(flagsOf(await compileObjects([object(1)]))).toEqual([[true, false]]);
  });

  it("非布尔值：照报，图层按缺省取（clampuvs 只有 JSON false 才关，nointerpolation 只认 JSON true）", async () => {
    const bundle = await compileObjects([
      object(1, { clampuvs: 0, nointerpolation: 1 }),
      object(2, { clampuvs: { user: "p", value: false }, nointerpolation: { user: "q", value: true } }),
    ]);
    expect(bundle.unsupported).toEqual(["object:clampuvs", "object:nointerpolation"]);
    expect(flagsOf(bundle)).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it("分组节点同样填（用不到，无害）", async () => {
    const bundle = await compileObjects([
      { id: 1, name: "group", origin: "0 0 0", clampuvs: false, nointerpolation: true },
      { id: 2, name: "group2", origin: "0 0 0" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(flagsOf(bundle)).toEqual([
      [false, true],
      [true, false],
    ]);
  });
});
