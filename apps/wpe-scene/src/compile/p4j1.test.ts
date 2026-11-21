/**
 * P4j 步骤 1 的单测（`.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md`「步骤 1」）：粒子 `layerimage` 发射器的编译期部分。
 * 依据 `rea-p4j-layerimage.md` 1.1–1.7。
 * - `particleDependencies`：三道门、`type` 大小写敏感、`mask` / `id 0` / 非对象元素；
 * - `dependencyIds`：粒子对象的对象元素进并集（两种类型、`id 0`），非粒子对象的不进，数字元素照旧；
 * - `bindLayerImages`：只数 `layerimage` 的槽序号、同槽后者覆盖前者、`id 0` 与碰撞模型不配；
 * - 模块表 / 能力表：缺省值、`flags` 白名单、过渡键 `particle:layerimage:pending`、不再报 `particle:dependencies`；
 * - 系统步进：`layerimage` 照常走发射计时、一颗不生；
 * - bundle：被依赖、顶层与子系统各自从 0 数、`mask` 纹理进 `bundle.textures`、引用 puppet / 文本层的照报键。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import { bindLayerImages, dependencyIds, particleDependencies, type ParticleDependency } from "./dependencies";
import { checkObjectFeatures, checkParticleFeatures } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject, SceneObject } from "./model";
import { parseParticle } from "./particles";
import { TEXT_MATERIALS } from "./texts";
import { readParticleModule } from "../particles/modules";
import { SeededRandom } from "../particles/random";
import { ParticleSystem } from "../particles/system";
import modes from "../puppet/fixtures/p12-modes.json";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const dep = (extra: Record<string, unknown> = {}) => ({ id: 2, type: "emitterimage", index: 0, mask: "", ...extra });
const particleObject = (dependencies: unknown, extra: Record<string, unknown> = {}): SceneObject =>
  ({ id: 1, particle: "particles/p.json", dependencies, ...extra }) as SceneObject;

describe("particleDependencies：三道门与类型", () => {
  it("正常的两种类型：type 映射成 1 / 3，mask 非字符串得空串，id 0 得 valid false", () => {
    const list = particleDependencies(
      particleObject([
        dep({ mask: "masks/m" }),
        dep({ id: 3, type: "collisionmodel", index: 5, mask: 7 }),
        dep({ id: 0, index: 1 }),
      ]),
    );
    expect(list).toEqual<ParticleDependency[]>([
      { type: 1, id: 2, index: 0, mask: "masks/m", valid: true },
      { type: 3, id: 3, index: 5, mask: "", valid: true },
      { type: 1, id: 0, index: 1, mask: "", valid: false },
    ]);
  });

  it("三道门：负 id、小数 id、缺 index、index 2^32、type 非字符串都跳过；type 大小写敏感；未知 type 跳过", () => {
    const bad = [
      dep({ id: -1 }),
      dep({ id: 1.5 }),
      dep({ id: "2" }),
      { id: 2, type: "emitterimage", mask: "" },
      dep({ index: 2 ** 32 }),
      dep({ index: -1 }),
      dep({ index: 0.5 }),
      dep({ type: 1 }),
      dep({ type: "EmitterImage" }),
      dep({ type: "other" }),
    ];
    expect(particleDependencies(particleObject(bad))).toEqual([]);
    // index 取 2^32 − 1 过门
    expect(particleDependencies(particleObject([dep({ index: 2 ** 32 - 1 })]))).toHaveLength(1);
  });

  it("非对象元素跳过；dependencies 是对象（非数组）时按值遍历", () => {
    expect(particleDependencies(particleObject([5, "x", null, [dep()], dep()]))).toHaveLength(1);
    expect(
      particleDependencies(particleObject({ a: dep({ id: 4 }), b: dep({ id: 5, index: 1 }) })).map((d) => d.id),
    ).toEqual([4, 5]);
    expect(particleDependencies(particleObject(undefined))).toEqual([]);
    expect(particleDependencies(particleObject("text"))).toEqual([]);
  });
});

describe("dependencyIds：粒子对象的对象元素进并集", () => {
  it("两种类型、id 0 都进；数字元素照旧", () => {
    const ids = dependencyIds([
      particleObject([dep({ id: 2 }), dep({ id: 3, type: "collisionmodel" }), dep({ id: 0 }), 9, "x", -1]),
    ]);
    expect([...ids].sort((a, b) => a - b)).toEqual([0, 2, 3, 9]);
  });

  it("过不了三道门的对象元素不进", () => {
    const ids = dependencyIds([particleObject([dep({ id: 2, index: -1 }), dep({ id: 3, type: "Emitterimage" })])]);
    expect([...ids]).toEqual([]);
  });

  it("非粒子对象的对象元素不进并集，它的数字元素照进", () => {
    const image = { id: 1, image: "models/a.json", dependencies: [dep({ id: 2 }), 7] } as SceneObject;
    expect([...dependencyIds([image])]).toEqual([7]);
  });
});

describe("bindLayerImages：槽序号与覆盖", () => {
  const emitters = (...names: string[]) => names.map((name) => ({ name }));
  const bound = (d: Partial<ParticleDependency>): ParticleDependency => ({
    type: 1,
    id: 2,
    index: 0,
    mask: "",
    valid: true,
    ...d,
  });

  it("只数 layerimage：中间夹 sphererandom 也分别配 index 0 / 1", () => {
    const result = bindLayerImages(emitters("layerimage", "sphererandom", "layerimage"), [
      bound({ id: 10, index: 0, mask: "a" }),
      bound({ id: 11, index: 1, mask: "b" }),
    ]);
    expect(result).toEqual([
      { id: 10, mask: "a" },
      { id: 11, mask: "b" },
    ]);
  });

  it("同一槽有多条取最后一条", () => {
    const result = bindLayerImages(emitters("layerimage"), [
      bound({ id: 10 }),
      bound({ id: 11 }),
      bound({ id: 12, index: 1 }),
    ]);
    expect(result).toEqual([{ id: 11, mask: "" }]);
  });

  it("id 0、collisionmodel、没有同 index 的不配，得 null；没有 layerimage 发射器得空数组", () => {
    expect(
      bindLayerImages(emitters("layerimage", "layerimage", "layerimage"), [
        bound({ id: 0, valid: false }),
        bound({ type: 3, index: 1 }),
      ]),
    ).toEqual([null, null, null]);
    expect(bindLayerImages(emitters("sphererandom"), [bound({})])).toEqual([]);
  });
});

describe("模块表与能力表", () => {
  const read = (module: JsonObject = {}, orthographic = true) =>
    readParticleModule("emitter", { name: "layerimage", ...module }, orthographic);
  const keys = (module: JsonObject = {}, orthographic = true): string[] => {
    const set = new Set<string>();
    checkParticleFeatures({ maxcount: 10, emitter: [{ name: "layerimage", ...module }] }, orthographic, set);
    return [...set].sort();
  };

  it("缺省：正交 offsetmin -5 -5 0 / offsetmax 5 5 0、透视 0；speedmin 0.1、speedmax 0.2；flags 0x10000", () => {
    const ortho = read().fields;
    expect(ortho.offsetmin).toEqual([-5, -5, 0]);
    expect(ortho.offsetmax).toEqual([5, 5, 0]);
    expect(ortho.speedmin).toBe(0.1);
    expect(ortho.speedmax).toBe(0.2);
    expect(ortho.flags).toBe(0x10000);
    const persp = read({}, false).fields;
    expect(persp.offsetmin).toEqual([0, 0, 0]);
    expect(persp.offsetmax).toEqual([0, 0, 0]);
  });

  it("flags 白名单：0x90006 不报字段问题；0x100000 报 particle:emitter:layerimage:flags（外加过渡键）", () => {
    expect(read({ flags: 0x90006 }).issues).toEqual([]);
    expect(read({ flags: 0x100000 }).issues.map((issue) => issue.field)).toEqual(["flags"]);
    expect(keys({ flags: 0x90006 })).toEqual(["particle:layerimage:pending"]);
    expect(keys({ flags: 0x100000 })).toEqual(["particle:emitter:layerimage:flags", "particle:layerimage:pending"]);
  });

  it("只报过渡键 particle:layerimage:pending，不再报 particle:emitter:layerimage", () => {
    expect(keys()).toEqual(["particle:layerimage:pending"]);
  });

  it("粒子对象的对象依赖不再报 particle:dependencies（字符串 / 数字元素也不报）", () => {
    const report = (dependencies: unknown) => {
      const set = new Set<string>();
      checkObjectFeatures(particleObject(dependencies), set);
      return [...set].sort();
    };
    const base = report(undefined);
    for (const value of [[dep()], [2, "3"], { a: { id: 2, type: "collisionmodel" } }])
      expect(report(value)).toEqual(base);
    expect(base).not.toContain("particle:dependencies");
  });
});

describe("系统步进：layerimage 照常算发射数、不生粒子", () => {
  const make = (name: string) =>
    new ParticleSystem(
      parseParticle(
        {
          maxcount: 50,
          emitter: [{ name, rate: 10, instantaneous: 3 }],
          initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
        } as JsonObject,
        { file: "p.json", orthographic: true },
      ),
      new SeededRandom(1),
      1,
    );

  it("rate 10 步进：layerimage 一颗不生，发射计时与 sphererandom 的相同", () => {
    const layer = make("layerimage");
    const sphere = make("sphererandom");
    for (const system of [layer, sphere]) system.step(0.5);
    expect(layer.skipped).toEqual([]);
    expect(layer.alive).toBe(0);
    expect(sphere.alive).toBeGreaterThan(0);
    const state = (system: ParticleSystem) =>
      (system as unknown as { emitters: { state: unknown }[] }).emitters[0].state;
    expect(state(layer)).toEqual(state(sphere));
  });
});

// bundle 级 ----------------------------------------------------------------------------------------------------------------------------

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
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
/** RGBA8 单 mip 的 `.tex`（TEXB0002），4×4。 */
function tex(): Uint8Array {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
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

const ASSETS = "A:/assets";
const FONT_PASS = { shader: "font", blending: "translucent", depthtest: "disabled", depthwrite: "disabled" };
const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const mdl = new Uint8Array(gunzipSync(Buffer.from(loop10.mdlGzip, "base64")));

const BASE_FILES: Record<string, unknown> = {
  "P:/p/models/a.json": { material: "materials/a.json" },
  "P:/p/models/pup.json": { material: "materials/a.json", puppet: "models/pup.mdl" },
  "P:/p/models/pup.mdl": mdl,
  "P:/p/materials/a.json": { passes: [{ shader: "s", blending: "translucent", textures: ["a"] }] },
  "P:/p/materials/a.tex": tex(),
  "P:/p/materials/masks/m.tex": tex(),
  "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
  "P:/p/materials/util/effectpassthrough.json": { passes: [{ shader: "s", blending: "normal" }] },
  "P:/p/shaders/s.vert": "void main(){}",
  "P:/p/shaders/s.frag": "void main(){}",
  "P:/p/shaders/genericparticle.vert": "void main(){}",
  "P:/p/shaders/genericparticle.frag": "void main(){}",
  [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: { passes: [FONT_PASS] },
  [`${ASSETS}/${TEXT_MATERIALS.color}`]: { passes: [{ ...FONT_PASS, combos: { COLORFONT: 1 } }] },
  [`${ASSETS}/${TEXT_MATERIALS.background}`]: { passes: [{ ...FONT_PASS, shader: "flat" }] },
  [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: {
    passes: [{ ...FONT_PASS, shader: "composelayer", textures: ["_rt_FullFrameBuffer"], combos: { CLEARALPHA: 1 } }],
  },
  ...Object.fromEntries(
    ["font", "flat", "composelayer"].flatMap((name) => [
      [`${ASSETS}/shaders/${name}.vert`, "void main(){}"],
      [`${ASSETS}/shaders/${name}.frag`, "void main(){}"],
    ]),
  ),
};

const LAYERIMAGE = { name: "layerimage", rate: 5 };
const image = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `img${id}`,
  image: "models/a.json",
  origin: "960 540 0",
  ...extra,
});

async function compile(
  objects: Record<string, unknown>[],
  particles: Record<string, unknown>,
): Promise<{ bundle: SceneBundle; keys: string[] }> {
  const files: Record<string, unknown> = {
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
    ...BASE_FILES,
  };
  for (const [name, json] of Object.entries(particles)) files[`P:/p/${name}`] = json;
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, keys: [...bundle.unsupported].sort() };
}
const particleLayer = (bundle: SceneBundle) => bundle.layers.find((layer) => layer.particle)!.particle!;
const withDeps = (dependencies: unknown[]) => ({
  id: 10,
  name: "P",
  particle: "particles/p.json",
  origin: "960 540 0",
  dependencies,
});

describe("compileScene：发射图依赖进 bundle（P4j 步骤 1）", () => {
  it("被引用的图层被依赖（dependedOn）；顶层 emitterImages 带 id、mask 与 mask 纹理下标；mask 纹理进 bundle.textures", async () => {
    const { bundle, keys } = await compile([image(2), image(3), withDeps([dep({ id: 2, mask: "masks/m" })])], {
      "particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [LAYERIMAGE] },
    });
    const layers = bundle.layers.filter((layer) => !layer.particle);
    expect(layers.map((layer) => !!layer.dependedOn)).toEqual([true, false]);
    const [slot] = particleLayer(bundle).emitterImages;
    expect(slot).toMatchObject({ id: 2, mask: "masks/m" });
    expect(slot!.maskTexture).not.toBeNull();
    expect(bundle.textures[slot!.maskTexture!].path).toContain("masks/m");
    expect(keys).toEqual(["particle:layerimage:pending"]);
  });

  it("没有 mask：maskTexture 为 null；没配上依赖的发射器为 null；id 引用不存在的对象中性", async () => {
    const { bundle, keys } = await compile([withDeps([dep({ id: 99 })])], {
      "particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [LAYERIMAGE, LAYERIMAGE] },
    });
    expect(particleLayer(bundle).emitterImages).toEqual([{ id: 99, mask: "", maskTexture: null }, null]);
    expect(keys).toEqual(["particle:layerimage:pending"]);
  });

  it("顶层与 static 子系统各自从 0 数，用同一个对象的依赖列表", async () => {
    const { bundle } = await compile([image(2), image(3), withDeps([dep({ id: 2 }), dep({ id: 3, index: 1 })])], {
      "particles/p.json": {
        material: "materials/pm.json",
        maxcount: 4,
        emitter: [LAYERIMAGE],
        children: [{ name: "particles/c.json", type: "static" }],
      },
      "particles/c.json": {
        material: "materials/pm.json",
        maxcount: 4,
        emitter: [{ name: "sphererandom" }, LAYERIMAGE],
      },
    });
    const top = particleLayer(bundle);
    expect(top.emitterImages).toEqual([{ id: 2, mask: "", maskTexture: null }]);
    // 子系统的第 0 个 layerimage 也配 index 0 的依赖（id 2），不是接着顶层数
    expect(top.children[0].system.emitterImages).toEqual([{ id: 2, mask: "", maskTexture: null }]);
  });

  it("引用 puppet 图层报 particle:layerimage:puppet；普通图层不报", async () => {
    const files = { "particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [LAYERIMAGE] } };
    const puppet = await compile([image(2, { image: "models/pup.json" }), withDeps([dep({ id: 2 })])], files);
    expect(puppet.keys).toContain("particle:layerimage:puppet");
    const plain = await compile([image(2), withDeps([dep({ id: 2 })])], files);
    expect(plain.keys).not.toContain("particle:layerimage:puppet");
    expect(plain.keys).not.toContain("particle:layerimage:text");
  });

  it("引用文本层报 particle:layerimage:text", async () => {
    const { keys } = await compile(
      [{ id: 2, name: "T", text: "Ab", font: "systemfont_arial", pointsize: 32 }, withDeps([dep({ id: 2 })])],
      { "particles/p.json": { material: "materials/pm.json", maxcount: 4, emitter: [LAYERIMAGE] } },
    );
    expect(keys).toContain("particle:layerimage:text");
  });
});
