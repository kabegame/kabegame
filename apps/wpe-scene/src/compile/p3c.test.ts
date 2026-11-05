import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
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
    // 绑定目标这一步不改：仍是整场重编译
    expect(bundle.bindings).toContainEqual({
      property: "p",
      condition: "1",
      target: { kind: "recompile", reason: "effect-visible", path: "objects/0/effects/0/visible" },
    });
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
