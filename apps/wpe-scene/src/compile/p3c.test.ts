import { describe, expect, it, vi } from "vitest";
import { SceneState } from "../render/state";
import {
  GENERAL_FIELDS,
  generalDefaults,
  generalValue,
  type GeneralKey,
  type RecompileReason,
  type SceneBinding,
} from "./bindings";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { observePropertyReads, type SceneScalar } from "./model";
import { TEX_FLAGS } from "./tex";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

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
/** 1×1 的 RGBA8 `.tex`（TEXB0002）。 */
function tex(flags = 0): Uint8Array {
  const data = new Uint8Array([1, 2, 3, 4]);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(flags),
    u32(1),
    u32(1),
    u32(1),
    u32(1),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(1),
    u32(1),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

/** 假翻译器：片元源码含 `BAD` 时翻译失败，其余返回空接口；不依赖 wasm。`calls` 记翻译次数，用来确认确实命中了缓存。 */
function translator(): Wpesl2wgsl & { calls: TranslateRequest[] } {
  const calls: TranslateRequest[] = [];
  return {
    calls,
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      calls.push(request);
      if (request.fragment.includes("BAD")) return { ok: false, phase: "parse", errors: [{ message: "坏着色器" }] };
      return { ok: true, uniforms: [], textures: [], combos: [] };
    },
  } as unknown as Wpesl2wgsl & { calls: TranslateRequest[] };
}

/** 引用 `material` 的 effect.json。 */
const effectJson = (material: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ passes: [{ material }], ...extra });

const FILES: Record<string, Uint8Array | string> = {
  "P:/p/project.json": JSON.stringify({
    file: "scene.json",
    general: { properties: { p: { type: "bool", value: 0 } } },
  }),
  "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json", width: 4, height: 4 }),
  "P:/p/materials/a.json": JSON.stringify({ passes: [{ shader: "good" }] }),
  "P:/p/materials/good.json": JSON.stringify({ passes: [{ shader: "good" }] }),
  "P:/p/materials/bad-shader.json": JSON.stringify({ passes: [{ shader: "bad" }] }),
  "P:/p/materials/bad-tex.json": JSON.stringify({ passes: [{ shader: "good", textures: [null, "bad"] }] }),
  "P:/p/materials/bad.tex": tex(TEX_FLAGS.video),
  "P:/p/shaders/good.vert": "void main() {}",
  "P:/p/shaders/good.frag": "void main() {}",
  "P:/p/shaders/bad.vert": "void main() {}",
  "P:/p/shaders/bad.frag": "BAD",
  "P:/p/effects/good/effect.json": effectJson("materials/good.json"),
  "P:/p/effects/custom/effect.json": effectJson("materials/good.json", { custom: true }),
  "P:/p/effects/bad-shader/effect.json": effectJson("materials/bad-shader.json"),
  "P:/p/effects/bad-tex-a/effect.json": effectJson("materials/bad-tex.json"),
  "P:/p/effects/bad-tex-b/effect.json": effectJson("materials/bad-tex.json"),
  "P:/p/effects/broken/effect.json": "{ 坏 JSON",
};

/** 随属性值开关的绑定写法。 */
const bound = { user: { name: "p", condition: 1 }, value: false };

async function compile(effects: unknown[], p = 0, files: Record<string, Uint8Array | string> = {}, tr = translator()) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    userProperties: { p },
    reader: memoryReader({
      ...FILES,
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 64, height: 32 } },
        objects: [{ id: 1, name: "a", image: "models/a.json", effects }],
      }),
      ...files,
    }),
    translator: tr,
    postprocess: "disabled",
  });
}
const effectsOf = (bundle: SceneBundle) => bundle.layers[0].effects;

describe("可变 effect 进 bundle", () => {
  it("绑了用户属性、挂了脚本的关闭 effect 进 bundle，enabled 为 false、visibleBound 为 true", async () => {
    const bundle = await compile([
      { file: "effects/good/effect.json", visible: bound },
      { file: "effects/good/effect.json", visible: { script: "export function update() {}", value: false } },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(effectsOf(bundle).map(({ source, enabled, visibleBound }) => ({ source, enabled, visibleBound }))).toEqual([
      { source: 0, enabled: false, visibleBound: true },
      { source: 1, enabled: false, visibleBound: true },
    ]);
    expect(effectsOf(bundle)[0].steps).toHaveLength(1);
    // 用户绑定与脚本都是单图层重建的目标，坐标是 scene.json 下标
    expect(bundle.bindings).toContainEqual({
      property: "p",
      condition: "1",
      target: { kind: "effect", object: 0, effect: 0 },
    });
    expect(bundle.scripts.list[0].target).toEqual({ kind: "effect", object: 0, effect: 1 });
  });

  it("可变 effect 打开时 enabled 为 true，visibleBound 不变", async () => {
    const bundle = await compile([{ file: "effects/good/effect.json", visible: bound }], 1);
    expect(effectsOf(bundle)[0]).toMatchObject({ enabled: true, visibleBound: true });
  });

  it("写死关闭、没有绑定的不进 bundle，也不读它的文件；后面的 effect 的 source 仍是 JSON 下标", async () => {
    const bundle = await compile([
      { file: "effects/broken/effect.json", visible: false },
      { file: "effects/good/effect.json" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(effectsOf(bundle).map(({ source, enabled, visibleBound }) => ({ source, enabled, visibleBound }))).toEqual([
      { source: 1, enabled: true, visibleBound: false },
    ]);
  });
});

describe("不支持项的归属", () => {
  it("关着的 effect 的不支持项只在它自己的 unsupported，场景级为空", async () => {
    const bundle = await compile([{ file: "effects/custom/effect.json", visible: bound }]);
    expect(bundle.unsupported).toEqual([]);
    expect(effectsOf(bundle)[0].unsupported).toEqual(["effect:custom:custom"]);
  });

  it("打开时进场景级，effect 自己也留一份", async () => {
    const bundle = await compile([{ file: "effects/custom/effect.json", visible: bound }], 1);
    expect(bundle.unsupported).toEqual(["effect:custom:custom"]);
    expect(effectsOf(bundle)[0].unsupported).toEqual(["effect:custom:custom"]);
  });

  it("缓存：关着的 effect 先翻译坏着色器，启用的 effect 命中缓存时场景级仍有这一项", async () => {
    const tr = translator();
    const bundle = await compile(
      [{ file: "effects/bad-shader/effect.json", visible: bound }, { file: "effects/bad-shader/effect.json" }],
      0,
      {},
      tr,
    );
    // 基础 pass 的 good 一次、bad 一次：第二个 effect 确实走了缓存
    expect(tr.calls.filter((call) => call.fragment.includes("BAD"))).toHaveLength(1);
    expect(bundle.unsupported).toEqual(["shader:bad:parse:坏着色器"]);
    expect(effectsOf(bundle).map((effect) => effect.unsupported)).toEqual([
      ["shader:bad:parse:坏着色器"],
      ["shader:bad:parse:坏着色器"],
    ]);
  });

  it("缓存：关着的 effect 先解析不支持的纹理，启用的 effect 命中缓存时场景级仍有这一项", async () => {
    const bundle = await compile([
      { file: "effects/bad-tex-a/effect.json", visible: bound },
      { file: "effects/bad-tex-b/effect.json" },
    ]);
    expect(bundle.textures).toHaveLength(1);
    expect(bundle.unsupported).toEqual(["tex:video"]);
    expect(effectsOf(bundle).map((effect) => effect.unsupported)).toEqual([["tex:video"], ["tex:video"]]);
  });

  it("只有关着的 effect 用坏着色器 / 坏纹理时场景级为空", async () => {
    const bundle = await compile([
      { file: "effects/bad-shader/effect.json", visible: bound },
      { file: "effects/bad-tex-a/effect.json", visible: bound },
    ]);
    expect(bundle.unsupported).toEqual([]);
  });

  it("缓存命中时翻译结果仍是同一个对象：同一份程序只进 bundle 一次", async () => {
    const bundle = await compile([{ file: "effects/good/effect.json" }, { file: "effects/good/effect.json" }]);
    const programs = effectsOf(bundle).flatMap((effect) =>
      effect.steps.map((step) => (step.kind === "draw" ? step.pass.program : null)),
    );
    expect(programs).toEqual([programs[0], programs[0]]);
    expect(bundle.programs).toHaveLength(2); // 基础 pass 没有 scope，是另一份
  });
});

describe("关着的 effect 出错", () => {
  it("effect.json 坏了：编译成功，进一个空 effect，unsupported 里有 effect:error", async () => {
    const bundle = await compile([
      { file: "effects/broken/effect.json", visible: bound },
      { file: "effects/good/effect.json" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(effectsOf(bundle)).toHaveLength(2);
    expect(effectsOf(bundle)[0]).toMatchObject({
      source: 0,
      enabled: false,
      visibleBound: true,
      fbos: [],
      steps: [],
      unsupported: ["effect:error:effects/broken/effect.json"],
    });
    expect(effectsOf(bundle)[1].enabled).toBe(true);
  });

  it("启用时照旧抛错", async () => {
    await expect(compile([{ file: "effects/broken/effect.json", visible: bound }], 1)).rejects.toThrow();
    await expect(compile([{ file: "effects/broken/effect.json" }])).rejects.toThrow();
  });

  it("effect.json 缺失：关着时进一个空 effect；启用时维持现状，不进 layer.effects", async () => {
    const closed = await compile([{ file: "effects/none/effect.json", visible: bound }]);
    expect(closed.unsupported).toEqual([]);
    expect(effectsOf(closed)).toHaveLength(1);
    expect(effectsOf(closed)[0].unsupported).toEqual(["effect:missing:effects/none/effect.json"]);
    const open = await compile([{ file: "effects/none/effect.json", visible: bound }], 1);
    expect(open.unsupported).toEqual(["effect:missing:effects/none/effect.json"]);
    expect(effectsOf(open)).toEqual([]);
  });
});

describe("没有绑定的场景", () => {
  it("effect 都启用、visibleBound 为 false、unsupported 为空", async () => {
    const bundle = await compile([{ file: "effects/good/effect.json" }]);
    expect(effectsOf(bundle)).toHaveLength(1);
    expect(effectsOf(bundle)[0]).toMatchObject({ enabled: true, visibleBound: false, unsupported: [] });
  });
});

/** 只有基础图层的场景，`general` 并进投影设置之后；`extra` 写 scene.json 顶层（如 `camera`）。 */
async function compileGeneral(
  general: Record<string, unknown>,
  userProperties: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    userProperties,
    reader: memoryReader({
      ...FILES,
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 64, height: 32 }, ...general },
        objects: [{ id: 1, name: "a", image: "models/a.json" }],
        ...extra,
      }),
    }),
    translator: translator(),
    postprocess: "disabled",
  });
}

describe("general 字段表", () => {
  const keys = Object.keys(GENERAL_FIELDS) as GeneralKey[];
  /** 全部字段都绑属性 `p_<键>`；`camerashake` 这类写成对象会被能力表报出来，这里只看绑定。 */
  const allBound = () => Object.fromEntries(keys.map((key) => [key, { user: `p_${key}`, value: null }]));

  it("缺键时取表里的缺省值（L1、L14）", async () => {
    const { general } = await compileGeneral({});
    expect(general.fields).toEqual(generalDefaults());
    expect(general.fields).toMatchObject({
      clearcolor: [0, 0, 0],
      clearenabled: true,
      fov: 50,
      nearz: 0.1,
      farz: 10000,
      camerafade: true,
      camerashake: false,
      camerashakespeed: 3,
      camerashakeamplitude: 0.5,
      camerashakeroughness: 1,
      cameraparallax: false,
      cameraparallaxamount: 0.5,
      cameraparallaxdelay: 0.1,
      cameraparallaxmouseinfluence: 0.5,
    });
    expect(general.clearVariable).toBe(false);
  });

  it("generalDefaults 每次一份新的，vec3 不共用数组", () => {
    generalDefaults().clearcolor[0] = 1;
    expect(generalDefaults().clearcolor).toEqual([0, 0, 0]);
    expect(GENERAL_FIELDS.clearcolor.fallback).toEqual([0, 0, 0]);
  });

  it("表里每个字段写成 {user} 都登记成 general 目标，写法含条件", async () => {
    const { bindings } = await compileGeneral(allBound());
    for (const key of keys) expect(bindings).toContainEqual({ property: `p_${key}`, target: { kind: "general", key } });
    const conditional = await compileGeneral({ clearenabled: { user: { name: "m", condition: "a" }, value: true } });
    expect(conditional.bindings).toContainEqual({
      property: "m",
      condition: "a",
      target: { kind: "general", key: "clearenabled" },
    });
  });

  it("编译期读过的属性都在绑定表里：完整性同 P3a", async () => {
    const read = new Set<string>();
    observePropertyReads((name) => read.add(name));
    try {
      const { bindings } = await compileGeneral(allBound());
      const bound = new Set(bindings.map((binding) => binding.property));
      expect([...read].filter((name) => !bound.has(name))).toEqual([]);
      expect(read.size).toBe(keys.length);
    } finally {
      observePropertyReads(null);
    }
  });

  it.each<[GeneralKey, SceneScalar, unknown]>([
    ["clearcolor", "0.25 0.5 0.75", [0.25, 0.5, 0.75]],
    ["clearcolor", 0.25, [0.25, 0.25, 0.25]],
    ["ambientcolor", "0.2 0.4 0.6", [0.2, 0.4, 0.6]],
    ["ambientcolor", 0.5, [0.5, 0.5, 0.5]],
    ["skylightcolor", "0.6 0.4 0.2 1", [0.6, 0.4, 0.2]],
    ["clearenabled", false, false],
    ["camerafade", false, false],
    ["camerashake", true, true],
    ["fov", 33, 33],
    ["nearz", 0.5, 0.5],
    ["cameraparallaxamount", "0.4", 0.4],
  ])("编译与就地写取值相同：%s = %j", async (key, value, expected) => {
    const bound = { [key]: { user: "v", value: null } };
    const compiled = await compileGeneral(bound, { v: value });
    expect(compiled.general.fields[key]).toEqual(expected);
    const before = await compileGeneral(bound);
    const state = SceneState.fromBundle(before);
    for (const binding of before.bindings.filter((item) => item.property === "v")) state.write(binding, value);
    expect(state.general).toEqual(compiled.general.fields);
  });

  it("条件：值换成布尔，编译与就地写相同", async () => {
    const bound = { clearenabled: { user: { name: "m", condition: "a" }, value: true } };
    expect((await compileGeneral(bound, { m: "a" })).general.fields.clearenabled).toBe(true);
    const off = await compileGeneral(bound, { m: "b" });
    expect(off.general.fields.clearenabled).toBe(false);
    const state = SceneState.fromBundle(off);
    state.write(
      off.bindings.find((item) => item.property === "m")!,
      "a",
    );
    expect(state.general.clearenabled).toBe(true);
  });

  it("bool 字段：{value: false} 算关，null 取缺省（neon_sunset 写的就是 null）", async () => {
    expect((await compileGeneral({ clearenabled: { value: false } })).general.fields.clearenabled).toBe(false);
    expect((await compileGeneral({ clearenabled: null })).general.fields.clearenabled).toBe(true);
    expect((await compileGeneral({ camerafade: { value: false } })).general.fields.camerafade).toBe(false);
  });

  it.each<[GeneralKey, SceneScalar | undefined]>([
    ["clearcolor", "a b c"],
    ["clearcolor", "1 2"],
    ["clearcolor", true],
    ["clearcolor", null],
    ["clearcolor", undefined],
    ["clearenabled", 0],
    ["clearenabled", "false"],
    ["camerashake", 1],
    ["fov", "1 2"],
    ["fov", true],
    ["fov", Number.POSITIVE_INFINITY],
    ["fov", Number.NaN],
  ])("不合法的值不改字段：%s = %j", async (key, value) => {
    expect(generalValue(key, value)).toBeUndefined();
    const state = SceneState.fromBundle(await compileGeneral({}));
    const before = state.general;
    if (value !== undefined) state.write({ property: "v", target: { kind: "general", key } }, value);
    expect(state.general).toBe(before);
  });

  it("不合法的值：编译取缺省值", async () => {
    const { general } = await compileGeneral({ clearcolor: "a b c", fov: "x", clearenabled: 0 });
    expect(general.fields).toEqual(generalDefaults());
  });

  it("camera.* 写成 {user} 时不登记、不读属性（L2）", async () => {
    const read = new Set<string>();
    observePropertyReads((name) => read.add(name));
    try {
      const { bindings, general, unsupported } = await compileGeneral(
        {},
        { e: "1 2 3", c: "4 5 6", u: "7 8 9" },
        { camera: { eye: { user: "e", value: "0 0 1" }, center: { user: "c" }, up: { user: "u" } } },
      );
      expect(bindings).toEqual([]);
      expect(read).toEqual(new Set());
      expect("camera" in general).toBe(false);
      expect(unsupported).toEqual([]);
    } finally {
      observePropertyReads(null);
    }
  });

  it.each<[string, unknown, boolean]>([
    ["缺键", undefined, false],
    ["写死 true", true, false],
    ["null", null, false],
    ["写死 false", false, true],
    ["{value: false}", { value: false }, true],
    ["绑了属性", { user: "c", value: true }, true],
    ["挂了脚本", { script: "export function update(v) { return v; }", value: true }, true],
  ])("clearVariable：%s", async (_name, clearenabled, expected) => {
    const bundle = await compileGeneral(clearenabled === undefined ? {} : { clearenabled });
    expect(bundle.general.clearVariable).toBe(expected);
    expect(bundle.unsupported).toEqual([]);
  });
});

describe("重编译原因", () => {
  it("只剩两项", () => {
    // 类型层面的穷举：多一项或少一项 tsc 都不过
    const reasons: Record<RecompileReason, true> = { "layer-structure": true, "postprocess-hdr": true };
    expect(Object.keys(reasons)).toHaveLength(2);
  });

  it("general 里只有 hdr 还是重编译目标", async () => {
    const { bindings } = await compileGeneral({
      clearcolor: { user: "a", value: "0 0 0" },
      hdr: { user: "h", value: false },
    });
    const of = (property: string): SceneBinding["target"] | undefined =>
      bindings.find((binding) => binding.property === property)?.target;
    expect(of("a")).toEqual({ kind: "general", key: "clearcolor" });
    expect(of("h")).toEqual({ kind: "recompile", reason: "postprocess-hdr", path: "general.hdr" });
  });
});
