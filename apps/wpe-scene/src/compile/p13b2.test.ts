/**
 * P13b2 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13b2-reflection-on.md`「点 1」「点 5」）：
 * - `reflectionKind`：模型、直接上屏的图像层 / 文本层、普通粒子可画，组、形状、`perspective`、effect、合成路径、透视粒子、要快照的粒子照报；
 * - `reflectionList`：`objects` 顺序、`reflected: false` 与读反射图的模型排除；
 * - `compileScene`：反射开时 `bundle.reflection` 带 `enabled` 与名单，读反射图的模型整个不进名单（p13-REPORT C1），`reflected` 绑用户属性
 *   按当前值取、登记成重编译（已定 2），名单里画不了的种类报 `reflection:planar:<种类>`；反射关时不写名单、不登记。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, REFLECTION_RT, type SceneBundle, type SceneLayer } from "./bundle";
import type { SceneReader } from "./fs";
import { mdlStride } from "./mdl";
import type { SceneParticle } from "./particles";
import type { SceneReflectionSetting } from "./postprocess";
import { reflectionKind, reflectionList } from "./reflection";
import type { TextureBinding, TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— reflectionKind / reflectionList ————

type KindInput = Parameters<typeof reflectionKind>[0];
const image = (extra: Partial<KindInput> = {}): KindInput => ({
  group: null,
  subtree: [],
  shape: null,
  perspective: false,
  effects: [],
  colorBlendMode: 0,
  dependedOn: false,
  passthroughModel: false,
  particle: null,
  model: null,
  text: null,
  ...extra,
});
const system = (extra: Partial<SceneParticle> = {}) =>
  ({ flags: 0, passes: [{ framebuffer: false }], children: [], ...extra }) as unknown as SceneParticle;

describe("reflectionKind（已定 1）", () => {
  it("可画：直接上屏的图像层（含 cbm 31）、模型、文本、普通粒子", () => {
    expect(reflectionKind(image())).toBeNull();
    expect(reflectionKind(image({ colorBlendMode: 31 }))).toBeNull();
    expect(reflectionKind(image({ model: {} as never }))).toBeNull();
    expect(reflectionKind(image({ text: {} as never }))).toBeNull();
    expect(reflectionKind(image({ particle: system() }))).toBeNull();
  });
  it("照报：组、形状、perspective、effect、合成路径、透视粒子、要快照的粒子（子系统里也算）", () => {
    expect(reflectionKind(image({ group: 7 }))).toBe("group");
    expect(reflectionKind(image({ subtree: [3] }))).toBe("group");
    expect(reflectionKind(image({ shape: {} as never }))).toBe("shape");
    expect(reflectionKind(image({ perspective: true }))).toBe("perspective");
    expect(reflectionKind(image({ effects: [{}] as never }))).toBe("effect");
    expect(reflectionKind(image({ text: {} as never, effects: [{}] as never }))).toBe("effect");
    expect(reflectionKind(image({ colorBlendMode: 2 }))).toBe("composite");
    expect(reflectionKind(image({ dependedOn: true }))).toBe("composite");
    expect(reflectionKind(image({ passthroughModel: true }))).toBe("composite");
    expect(reflectionKind(image({ particle: system({ flags: 4 }) }))).toBe("particle-perspective");
    const child = system({ passes: [{ framebuffer: true }] as never });
    expect(reflectionKind(image({ particle: system({ children: [{ system: child }] as never }) }))).toBe(
      "particle-framebuffer",
    );
  });
});

describe("reflectionList", () => {
  const layers = [{ object: 4 }, { object: 1 }, { object: 2 }, { object: 7 }];
  it("按 objects 下标排序；排除名单与 reflected 为 false 的不进", () => {
    expect(reflectionList(layers, new Set([2]), (object) => object !== 7)).toEqual([1, 4]);
    expect(reflectionList([], new Set(), () => true)).toEqual([]);
  });
});

// ———— compileScene ————

/** 去掉内存工程里读不到 WPE 安装目录材质的那一项（与本节无关）。 */
const withoutMissing = (keys: readonly string[]) => keys.filter((key) => !key.startsWith("material:missing:"));

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
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

/** 一个网格的 mdl（v23，位置 + uv）。 */
function mdl(material: string): Uint8Array {
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
  u32(1);
  cstr(material);
  u32(0);
  out.push(...new Uint8Array(new Float32Array([-1, -1, 0, 1, 1, 0]).buffer));
  u32(0x9);
  block(new Uint8Array(4 * mdlStride(0x9)));
  block(new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer));
  out.push(0, 0);
  u32(0);
  out.push(0);
  return new Uint8Array(out);
}

const textureSlot = (slot: number): TextureBinding => ({
  slot,
  name: `g_Texture${slot}`,
  kind: "2d",
  binding: 1 + 2 * slot,
  samplerBinding: 2 + 2 * slot,
});

const translator = {
  async translate(_request: TranslateRequest): Promise<TranslateResult> {
    return { ok: true, uniforms: [], textures: [textureSlot(0), textureSlot(1)], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/**
 * 工程：对象 0 地面（模型，网格读 `_rt_Reflection`）、1 模型、2 图像层、3 图像层 `reflected: false`、4 图像层 `reflected` 绑属性 `p_r`、
 * 5 图像层 colorBlendMode 2（合成路径）。
 */
async function compile(
  options: { reflection?: SceneReflectionSetting; p_r?: boolean; extraObjects?: Record<string, unknown>[] } = {},
): Promise<SceneBundle> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({
      file: "scene.json",
      general: { properties: { p_r: { type: "bool", value: options.p_r ?? false } } },
    }),
    "P:/p/models/ground.mdl": mdl("materials/ground.json"),
    "P:/p/models/box.mdl": mdl("materials/box.json"),
    "P:/p/materials/ground.json": JSON.stringify({ passes: [{ shader: "s", textures: ["", REFLECTION_RT] }] }),
    "P:/p/materials/box.json": JSON.stringify({ passes: [{ shader: "s" }] }),
    "P:/p/models/img.json": JSON.stringify({ material: "materials/img.json" }),
    "P:/p/materials/img.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
    "P:/p/shaders/s.vert": "// s",
    "P:/p/shaders/s.frag": "// s",
  };
  const base = { origin: "960 540 0", size: "100 100" };
  const objects: Record<string, unknown>[] = [
    { id: 10, name: "ground", model: "models/ground.mdl", origin: "0 0 0" },
    { id: 11, name: "box", model: "models/box.mdl", origin: "0 0 0" },
    { id: 12, name: "img", image: "models/img.json", ...base },
    { id: 13, name: "hidden", image: "models/img.json", reflected: false, ...base },
    { id: 14, name: "bound", image: "models/img.json", reflected: { user: "p_r", value: true }, ...base },
    { id: 15, name: "blend", image: "models/img.json", colorBlendMode: 2, ...base },
    ...(options.extraObjects ?? []),
  ];
  files["P:/p/scene.json"] = JSON.stringify({
    general: { orthogonalprojection: { width: 1920, height: 1080 } },
    objects,
  });
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    reflection: options.reflection,
    exhaustive: true,
  });
}

describe("反射名单（compileScene，点 1）", () => {
  it("反射开：读反射图的模型整个排除，reflected: false 排除，绑属性按当前值；合成路径的图层照报", async () => {
    const off = await compile({ reflection: "enabled", p_r: false });
    expect(off.reflection).toEqual({ planar: true, enabled: true, list: [1, 2, 5] });
    // 对象 5 的 colorBlendMode 2 要读 WPE 安装目录里的 `effectpassthrough` 材质，内存工程里没有，那一项与本节无关
    expect(withoutMissing(off.unsupported)).toEqual(["reflection:planar:composite"]);
    const on = await compile({ reflection: "enabled", p_r: true });
    expect(on.reflection?.list).toEqual([1, 2, 4, 5]);
  });

  it("reflected 绑用户属性登记成重编译（已定 2）", async () => {
    const bundle = await compile({ reflection: "enabled" });
    expect(bundle.bindings).toContainEqual({
      property: "p_r",
      target: { kind: "recompile", reason: "layer-structure", path: "objects/4/reflected" },
    });
  });

  it("反射关：不写名单、不报种类、不登记 reflected 的绑定", async () => {
    const bundle = await compile({ reflection: "disabled" });
    expect(bundle.reflection).toEqual({ planar: true });
    // 图像层上的 `reflected`（真值、绑属性）不再报 `object:reflected`
    expect(withoutMissing(bundle.unsupported)).toEqual([]);
    expect(
      bundle.bindings.some(
        (binding) => binding.target.kind === "recompile" && binding.target.path.endsWith("/reflected"),
      ),
    ).toBe(false);
  });

  it("只有图像层、模型时名单里没有要照报的（P13b2 的可画种类）", async () => {
    const bundle = await compileOnly([
      { id: 10, name: "ground", model: "models/ground.mdl", origin: "0 0 0" },
      { id: 11, name: "box", model: "models/box.mdl", origin: "0 0 0" },
      { id: 12, name: "img", image: "models/img.json", origin: "960 540 0", size: "100 100" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.reflection).toEqual({ planar: true, enabled: true, list: [1, 2] });
  });
});

/** 只放给定对象（反射开）。 */
async function compileOnly(objects: Record<string, unknown>[]): Promise<SceneBundle> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/models/ground.mdl": mdl("materials/ground.json"),
    "P:/p/models/box.mdl": mdl("materials/box.json"),
    "P:/p/materials/ground.json": JSON.stringify({ passes: [{ shader: "s", textures: ["", REFLECTION_RT] }] }),
    "P:/p/materials/box.json": JSON.stringify({ passes: [{ shader: "s" }] }),
    "P:/p/models/img.json": JSON.stringify({ material: "materials/img.json" }),
    "P:/p/materials/img.json": JSON.stringify({ passes: [{ shader: "s", blending: "translucent" }] }),
    "P:/p/shaders/s.vert": "// s",
    "P:/p/shaders/s.frag": "// s",
    "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
  };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    reflection: "enabled",
    exhaustive: true,
  });
}

// 类型检查：`reflectionKind` 收的就是 `SceneLayer` 的这些字段
const _layerFits = (layer: SceneLayer) => reflectionKind(layer);
void _layerFits;
