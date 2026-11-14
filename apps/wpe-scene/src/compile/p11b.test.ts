/**
 * P11b 步骤 1 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase11/phase-11b-usertextures.md`「步骤 1」，读码 rea-p11-textures 第 1、2 节、
 * rea-p11b，实测 p11-REPORT「属性纹理」「P11b 补测」M1–M3、M8）：
 * - `parseUserTextures`：三种写法（字符串、`{name, type}`、null）与槽号；`textures[slot]` 为空、槽 ≥ 10 忽略；参考尺寸（缺省纹理的图像尺寸、
 *   精灵表帧尺寸、instanced 的对象 `size`、显式 `usertexturereference`、合成 RT 缺省）；采样位；能力键按来源 / 用法细分；
 * - `mergeUserTextures` / `instanceReferenceSize`；
 * - `compileScene`：`ScenePass.userTextures`、`SceneBundle.userTextures`、绑定表每个属性一条、instance 与 effect 实例的按槽合并、
 *   `material:usertextures` / `material:usertexturereference` / `material:keepaspect` 不再整个报。
 * 运行时（换纹理、槽 0 重建）是步骤 2，不在这里。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, type SceneBundle } from "./bundle";
import { LAYER_COMPOSITE_PREFIX } from "./dependencies";
import { checkInstanceFeatures, checkPassFeatures } from "./features";
import type { SceneReader } from "./fs";
import { TEX_FLAGS } from "./tex";
import {
  defaultOfTexture,
  instanceReferenceSize,
  mergeUserTextures,
  parseUserTextures,
  type UserTextureDefault,
} from "./usertextures";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— parseUserTextures ————

const texture = (
  width: number,
  height: number,
  extra: Partial<Extract<UserTextureDefault, { kind: "texture" }>> = {},
): UserTextureDefault => ({
  kind: "texture",
  width,
  height,
  clampUVs: false,
  noInterpolation: false,
  sheet: false,
  ...extra,
});
/** 前 12 个槽都有一张 100×60 的缺省纹理。 */
const all = (slot: number): UserTextureDefault | undefined => (slot < 12 ? texture(100, 60) : undefined);

describe("parseUserTextures：写法与槽号（rea-p11-textures 第 1 节）", () => {
  it("字符串 → 属性；对象读 name / type / keepaspect；null、数字、空名字、缺 name 跳过；槽号 = 数组下标", () => {
    const { slots, issues } = parseUserTextures(
      {
        usertextures: [
          "propA",
          { name: "propB" },
          null,
          { name: "$mediaThumbnail", type: "system" },
          { name: "sc", type: "usershortcut" },
          { name: "" },
          5,
          { type: "system" },
          "",
          { name: "propC", type: "user", keepaspect: false },
        ],
      },
      all,
    );
    expect(slots.map((s) => [s.slot, s.source.kind, s.source.name])).toEqual([
      [0, "property", "propA"],
      [1, "property", "propB"],
      [3, "system", "$mediaThumbnail"],
      [4, "usershortcut", "sc"],
      [9, "property", "propC"],
    ]);
    // `type` 写别的值（含 "user"）都按属性处理
    expect(issues.sort()).toEqual(["usertextures:system", "usertextures:usershortcut"]);
  });

  it('name 不是字符串、keepaspect 不是 JSON true 都不算（`keepaspect: 1`、"true" 是假）', () => {
    const { slots } = parseUserTextures(
      {
        usertextures: [
          { name: 3 },
          { name: "a", keepaspect: 1 },
          { name: "b", keepaspect: "true" },
          { name: "c", keepaspect: true },
        ],
      },
      all,
    );
    expect(slots.map((s) => [s.slot, s.keepAspect])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it("没有缺省纹理的槽（textures[slot] 为空 / 被渲染图占用 / 纹理缺失）与槽 ≥ 10 忽略", () => {
    const { slots, issues } = parseUserTextures(
      { usertextures: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] },
      (slot) => (slot === 1 || slot === 10 || slot === 11 ? texture(8, 8) : undefined),
    );
    expect(slots.map((s) => s.slot)).toEqual([1]);
    expect(issues).toEqual([]);
  });

  it("名字大小写敏感；同一个名字可以绑多个槽；usertextures 不是数组时没有槽", () => {
    const { slots } = parseUserTextures({ usertextures: ["Prop", "prop", "Prop"] }, all);
    expect(slots.map((s) => s.source.name)).toEqual(["Prop", "prop", "Prop"]);
    for (const usertextures of [undefined, null, "a", { name: "a" }, 1])
      expect(parseUserTextures({ usertextures }, all)).toEqual({ slots: [], issues: [] });
  });
});

describe("parseUserTextures：参考尺寸（rea-p11-textures 2.2，p11-REPORT M2、M3）", () => {
  const ref = (
    pass: Record<string, unknown>,
    defaultOf: (slot: number) => UserTextureDefault | undefined,
    options = {},
  ) => parseUserTextures({ usertextures: ["p"], ...pass }, defaultOf, options);

  it("缺省取缺省纹理的图像尺寸（调用方传的是 .tex 头的图像尺寸，不是纹理尺寸）", () => {
    expect(ref({}, () => texture(1162, 1162)).slots[0].reference).toEqual({ kind: "size", width: 1162, height: 1162 });
  });

  it("精灵表取帧尺寸：defaultOfTexture 把 renderVar1 的归一化帧宽高乘图像尺寸", () => {
    const sheet = { renderVar1: [0.25, 0.5, 8, 1] };
    const one = defaultOfTexture({ width: 512, height: 256, clampUVs: true, noInterpolation: false, sheet });
    expect(one).toEqual({
      kind: "texture",
      width: 128,
      height: 128,
      clampUVs: true,
      noInterpolation: false,
      sheet: true,
    });
    expect(defaultOfTexture({ width: 512, height: 256, clampUVs: false, noInterpolation: true })).toMatchObject({
      width: 512,
      height: 256,
      sheet: false,
    });
  });

  it("显式 usertexturereference（两个都是非 0 数字）优先于缺省纹理，非 instanced 报 usertextures:reference", () => {
    const parsed = ref({ usertexturereference: { width: 400, height: 300 } }, () => texture(100, 60));
    expect(parsed.slots[0].reference).toEqual({ kind: "size", width: 400, height: 300 });
    expect(parsed.issues).toEqual(["usertextures:reference"]);
  });

  it("显式参考无效（宽或高为 0、缺分量、不是数字、不是对象）等于没写：回到缺省纹理、不报", () => {
    for (const usertexturereference of [
      { width: 0, height: 5 },
      { width: 5 },
      { width: "5", height: "5" },
      3,
      [1, 2],
    ]) {
      const parsed = ref({ usertexturereference }, () => texture(100, 60));
      expect(parsed.slots[0].reference, JSON.stringify(usertexturereference)).toEqual({
        kind: "size",
        width: 100,
        height: 60,
      });
      expect(parsed.issues).toEqual([]);
    }
  });

  it("instanced：对象 size 优先于显式参考（WPE 把它写进 instance.usertexturereference，M2），不报 reference", () => {
    const parsed = ref({ usertexturereference: { width: 1, height: 1 } }, () => texture(32, 32), {
      instanceSize: { width: 900, height: 1000 },
    });
    expect(parsed.slots[0].reference).toEqual({ kind: "size", width: 900, height: 1000 });
    expect(parsed.issues).toEqual([]);
    // 对象 size 解析不出（null）时回到缺省纹理
    expect(ref({}, () => texture(32, 32), { instanceSize: null }).slots[0].reference).toEqual({
      kind: "size",
      width: 32,
      height: 32,
    });
  });

  it("缺省是被依赖图层的合成 RT：{ kind: layer }，夹取、线性（M3）；显式参考照样优先", () => {
    const [slot] = ref({}, () => ({ kind: "layer", object: 7 })).slots;
    expect(slot).toMatchObject({ reference: { kind: "layer", object: 7 }, clamp: true, nearest: false });
    expect(
      ref({ usertexturereference: { width: 10, height: 20 } }, () => ({ kind: "layer", object: 7 })).slots[0].reference,
    ).toEqual({ kind: "size", width: 10, height: 20 });
  });

  it("参考宽或高为 0：这个槽永远是缺省纹理，不登记", () => {
    expect(ref({}, () => texture(0, 60)).slots).toEqual([]);
    expect(ref({}, () => texture(100, 0)).slots).toEqual([]);
  });
});

describe("parseUserTextures：采样位与能力键", () => {
  it("nearest = 缺省纹理的 NoInterpolation 位，clamp = ClampUVs 位", () => {
    for (const [noInterpolation, clampUVs] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const [slot] = parseUserTextures({ usertextures: ["p"] }, () =>
        texture(8, 8, { noInterpolation, clampUVs }),
      ).slots;
      expect([slot.nearest, slot.clamp]).toEqual([noInterpolation, clampUVs]);
    }
  });

  it("keepaspect: true 报 usertextures:keepaspect（只看对象项）", () => {
    const parsed = parseUserTextures({ usertextures: [{ name: "p", keepaspect: true }] }, all);
    expect(parsed.slots[0].keepAspect).toBe(true);
    expect(parsed.issues).toEqual(["usertextures:keepaspect"]);
  });

  it("粒子材质槽 0 的缺省是精灵表：usertextures:particle-sheet；槽 1 或非粒子不报", () => {
    const sheet = (slot: number) => (slot < 2 ? texture(64, 64, { sheet: true }) : undefined);
    expect(parseUserTextures({ usertextures: ["a"] }, sheet, { particle: true }).issues).toEqual([
      "usertextures:particle-sheet",
    ]);
    expect(parseUserTextures({ usertextures: [null, "a"] }, sheet, { particle: true }).issues).toEqual([]);
    expect(parseUserTextures({ usertextures: ["a"] }, sheet).issues).toEqual([]);
    expect(parseUserTextures({ usertextures: ["a"] }, () => texture(64, 64), { particle: true }).issues).toEqual([]);
  });

  it("缺省是没被依赖的 RT（棋盘格）、运行时 RT：各报各的，槽不登记", () => {
    const placeholder = parseUserTextures({ usertextures: ["a"] }, () => ({ kind: "placeholder" }));
    expect(placeholder).toEqual({ slots: [], issues: ["usertextures:rendertarget:placeholder"] });
    const runtime = parseUserTextures({ usertextures: ["a"] }, () => ({
      kind: "runtime",
      name: "_rt_FullFrameBuffer",
    }));
    expect(runtime).toEqual({ slots: [], issues: ["usertextures:rendertarget:runtime"] });
  });
});

describe("mergeUserTextures / instanceReferenceSize", () => {
  it("按槽覆盖：覆盖项是非空字符串或对象才替换，null / 空串 / 别的保留材质自己的", () => {
    expect(mergeUserTextures(["a", "b", "c"], [null, "B", "", { name: "C" }, 7])).toEqual([
      "a",
      "B",
      "c",
      { name: "C" },
    ]);
    expect(mergeUserTextures(undefined, ["x"])).toEqual(["x"]);
    expect(mergeUserTextures(["x"], undefined)).toEqual(["x"]);
    expect(mergeUserTextures(undefined, undefined)).toBeUndefined();
    expect(mergeUserTextures("a", { name: "a" })).toBeUndefined();
  });

  it('对象 size："w h" 各取 atof；不是字符串、有 0、解析不出为 null', () => {
    expect(instanceReferenceSize("900 1000")).toEqual({ width: 900, height: 1000 });
    expect(instanceReferenceSize(" 12.5  3 ")).toEqual({ width: 12.5, height: 3 });
    for (const size of [undefined, 5, [1, 2], "0 5", "5 0", "x y", "5"])
      expect(instanceReferenceSize(size), String(size)).toBeNull();
  });
});

// ———— 能力表 ————

describe("checkPassFeatures / checkInstanceFeatures：不再整个报 usertextures 三个键", () => {
  it("pass 上的 usertextures / usertexturereference / keepaspect（pass 级，WPE 不读）都不在这里报", () => {
    const out = new Set<string>();
    checkPassFeatures(
      { shader: "s", usertextures: ["a"], usertexturereference: { width: 1, height: 1 }, keepaspect: true },
      out,
    );
    expect([...out]).toEqual([]);
  });

  it("instanced 的 instance.usertextures 不在这里报（合并进材质 pass，由 compilePass 按项报）", () => {
    const out = new Set<string>();
    checkInstanceFeatures(
      { id: 1, size: "10 10", instance: { id: 5, usertextures: [{ name: "$mediaThumbnail", type: "system" }] } },
      out,
    );
    expect([...out]).toEqual([]);
  });
});

// ———— compileScene ————

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
/** RGBA8 单 mip 的 `.tex`：纹理尺寸 `size`×`size`（补到 2 的幂）、图像尺寸 `image`（`yoshi 2` 那样的 NPOT：1162×1162 放在 2048 里）。 */
function tex(flags = 0, size = 128, image: [number, number] = [100, 60]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(flags),
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
const translator = {
  async translate() {
    return { ok: true, uniforms: [], textures: [], combos: [] };
  },
} as unknown as Wpesl2wgsl;

/**
 * 内存工程：`models/a.json` 的基础材质 `materials/a.json`（槽 0 是 128×128 里的 100×60 `a`，`.tex` 标志 `texFlags`）；`models/inst.json`
 * 是 instanced 纯色图层（槽 0 `util/white`，32×32）；effect `e` 的材质槽 1 默认是 `a`（槽 0 由渲染图填）。`base` 是基础材质 pass 的额外键，
 * `effectPass` 是 effect 材质 pass 的额外键，`effectTextures` 换掉 effect 材质的 `textures`。
 */
async function compile(
  objects: Record<string, unknown>[],
  options: {
    base?: Record<string, unknown>;
    effectPass?: Record<string, unknown>;
    texFlags?: number;
    effectTextures?: unknown[];
  } = {},
): Promise<SceneBundle> {
  const files: Record<string, Uint8Array | string> = {
    "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
    "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
    "P:/p/models/a.json": JSON.stringify({ material: "materials/a.json" }),
    "P:/p/models/inst.json": JSON.stringify({ instanced: true, solidlayer: true, material: "materials/inst.json" }),
    "P:/p/materials/a.json": JSON.stringify({
      passes: [{ shader: "s", blending: "translucent", textures: ["a"], ...options.base }],
    }),
    "P:/p/materials/inst.json": JSON.stringify({
      passes: [{ shader: "s", blending: "translucent", textures: ["util/white"], combos: { version: 2 } }],
    }),
    "P:/p/materials/a.tex": tex(options.texFlags ?? 0),
    "P:/p/materials/util/white.tex": tex(0, 32, [32, 32]),
    "P:/p/effects/e/effect.json": JSON.stringify({ passes: [{ material: "materials/effects/e.json" }] }),
    "P:/p/materials/effects/e.json": JSON.stringify({
      passes: [
        {
          shader: "effects/e",
          blending: "normal",
          textures: options.effectTextures ?? [null, "a"],
          ...options.effectPass,
        },
      ],
    }),
    // 被依赖的图层上屏走 passthrough 材质（P8 步骤 4）
    "P:/p/materials/util/effectpassthrough.json": JSON.stringify({
      passes: [{ shader: "genericimage3", blending: "normal", depthtest: "disabled", depthwrite: "disabled" }],
    }),
    "P:/p/shaders/genericimage3.vert": "void main() {}",
    "P:/p/shaders/genericimage3.frag": "void main() {}",
    "P:/p/shaders/s.vert": "void main() {}",
    "P:/p/shaders/s.frag": "void main() {}",
    "P:/p/shaders/effects/e.vert": "void main() {}",
    "P:/p/shaders/effects/e.frag": "void main() {}",
  };
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader(files),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });
}
const image = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `I${id}`,
  image: "models/a.json",
  origin: "960 540 0",
  ...extra,
});
const effect = (pass: Record<string, unknown> = {}) => ({
  file: "effects/e/effect.json",
  id: 1,
  name: "e",
  passes: [pass],
});
const userBindings = (bundle: SceneBundle) => bundle.bindings.filter((b) => b.target.kind === "user-texture");
const basePass = (bundle: SceneBundle, layer = 0) => bundle.layers[layer].passes[0];
const effectPass = (bundle: SceneBundle, layer = 0) => {
  const step = bundle.layers[layer].effects?.[0]?.steps.find((item) => item.kind === "draw");
  return step && step.kind === "draw" ? step.pass : undefined;
};

describe("compileScene：用户纹理（P11b 步骤 1）", () => {
  it("图像层槽 0：参考尺寸取 .tex 头的图像尺寸（100×60，不是 128×128 的纹理尺寸），不报；来源进 bundle 与绑定表", async () => {
    const bundle = await compile([image(1)], { base: { usertextures: ["bg"] } });
    expect(bundle.unsupported).toEqual([]);
    expect(basePass(bundle).userTextures).toEqual([
      {
        slot: 0,
        source: { kind: "property", name: "bg" },
        keepAspect: false,
        reference: { kind: "size", width: 100, height: 60 },
        nearest: false,
        clamp: false,
      },
    ]);
    expect(bundle.userTextures).toEqual([{ kind: "property", name: "bg" }]);
    expect(userBindings(bundle)).toEqual([{ property: "bg", target: { kind: "user-texture", name: "bg" } }]);
    // 缺省纹理照旧在 textures 里
    expect(basePass(bundle).textures[0]).toBeDefined();
  });

  it("没有 usertextures：pass 不带 userTextures 键，bundle.userTextures 为空，没有绑定", async () => {
    const bundle = await compile([image(1)]);
    expect(basePass(bundle)).not.toHaveProperty("userTextures");
    expect(bundle.userTextures).toEqual([]);
    expect(userBindings(bundle)).toEqual([]);
  });

  it("采样位取缺省纹理的 .tex 标志", async () => {
    const bundle = await compile([image(1)], {
      base: { usertextures: ["bg"] },
      texFlags: TEX_FLAGS.noInterpolation | TEX_FLAGS.clampUVs,
    });
    expect(basePass(bundle).userTextures?.[0]).toMatchObject({ nearest: true, clamp: true });
  });

  it("同一个属性绑多个槽 / 多个图层：每个属性只一条绑定、bundle 里只一项；不同属性按首次出现的顺序", async () => {
    const bundle = await compile(
      [
        image(1, { effects: [effect({ usertextures: [null, "shared"] })] }),
        image(2, { effects: [effect({ usertextures: [null, "other"] })] }),
        image(3, { effects: [effect({ usertextures: [null, "shared"] })] }),
      ],
      { base: { usertextures: ["shared"] } },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.userTextures).toEqual([
      { kind: "property", name: "shared" },
      { kind: "property", name: "other" },
    ]);
    expect(userBindings(bundle).map((b) => b.property)).toEqual(["shared", "other"]);
    expect(userBindings(bundle).every((b) => b.condition === undefined)).toBe(true);
  });

  it("textures[slot] 为空 / 槽 ≥ 10 的项忽略，不登记也不报", async () => {
    const bundle = await compile([image(1)], {
      base: {
        textures: ["a", null],
        usertextures: ["bg", "second", null, null, null, null, null, null, null, null, "eleven"],
      },
    });
    expect(bundle.unsupported).toEqual([]);
    expect(basePass(bundle).userTextures?.map((s) => s.slot)).toEqual([0]);
    expect(bundle.userTextures).toEqual([{ kind: "property", name: "bg" }]);
  });

  it("封面 / 快捷方式来源报细分键；只有属性来源登记绑定", async () => {
    const system = await compile([image(1)], {
      base: { usertextures: [{ name: "$mediaThumbnail", type: "system" }] },
    });
    expect(system.unsupported).toEqual(["usertextures:system"]);
    expect(system.bindings.some((b) => b.target.kind === "user-texture")).toBe(false);
    const shortcut = await compile([image(1)], { base: { usertextures: [{ name: "sc", type: "usershortcut" }] } });
    expect(shortcut.unsupported).toEqual(["usertextures:usershortcut"]);
  });

  it("pass 级 keepaspect 中性；对象项 keepaspect: true 报 usertextures:keepaspect；非 instanced 的显式参考报 usertextures:reference", async () => {
    expect((await compile([image(1)], { base: { keepaspect: true } })).unsupported).toEqual([]);
    expect(
      (await compile([image(1)], { base: { usertexturereference: { width: 9, height: 9 } } })).unsupported,
    ).toEqual([]);
    expect(
      (await compile([image(1)], { base: { usertextures: [{ name: "bg", keepaspect: true }] } })).unsupported,
    ).toEqual(["usertextures:keepaspect"]);
    const reference = await compile([image(1)], {
      base: { usertextures: ["bg"], usertexturereference: { width: 400, height: 300 } },
    });
    expect(reference.unsupported).toEqual(["usertextures:reference"]);
    expect(basePass(reference).userTextures?.[0].reference).toEqual({ kind: "size", width: 400, height: 300 });
  });

  it("effect 实例 pass 的 usertextures 放行并按槽合并进材质 pass（槽 1 是 effect 材质的 a）", async () => {
    // 材质自己写 [null, "mat"]，实例把槽 1 换成 "inst"
    const merged = await compile([image(1, { effects: [effect({ usertextures: [null, "inst"] })] })], {
      effectPass: { usertextures: [null, "mat"] },
    });
    expect(merged.unsupported).toEqual([]);
    expect(effectPass(merged)?.userTextures?.map((s) => [s.slot, s.source.name])).toEqual([[1, "inst"]]);
    // 实例写 null：保留材质自己的
    const kept = await compile([image(1, { effects: [effect({ usertextures: [null, null] })] })], {
      effectPass: { usertextures: [null, "mat"] },
    });
    expect(effectPass(kept)?.userTextures?.map((s) => s.source.name)).toEqual(["mat"]);
    // 只有实例写
    const only = await compile([image(1, { effects: [effect({ usertextures: [null, "inst"] })] })]);
    expect(only.unsupported).toEqual([]);
    expect(effectPass(only)?.userTextures?.[0]).toMatchObject({
      slot: 1,
      source: { kind: "property", name: "inst" },
      reference: { kind: "size", width: 100, height: 60 },
    });
    expect(only.userTextures).toEqual([{ kind: "property", name: "inst" }]);
  });

  it("effect 实例里的封面来源只报 usertextures:system，不再报 effect:e:pass:usertextures", async () => {
    const bundle = await compile([
      image(1, { effects: [effect({ usertextures: [null, { name: "$mediaThumbnail", type: "system" }] })] }),
    ]);
    expect(bundle.unsupported).toEqual(["usertextures:system"]);
  });

  it("槽 0（planned，渲染图填）与没有 textures 的槽上的用户纹理不生效", async () => {
    const bundle = await compile([image(1, { effects: [effect({ usertextures: ["slot0", "slot1", "slot2"] })] })]);
    expect(bundle.unsupported).toEqual([]);
    expect(effectPass(bundle)?.userTextures?.map((s) => s.slot)).toEqual([1]);
  });

  describe("instanced", () => {
    const INSTANCE = { id: 5, textures: ["util/white"], combos: { version: 2 } };
    const solid = (id: number, instance: Record<string, unknown> = { ...INSTANCE, usertextures: ["custom"] }) => ({
      id,
      name: `J${id}`,
      image: "models/inst.json",
      origin: "960 540 0",
      size: "900 1000",
      instance,
    });

    it("instance.usertextures 合并进材质 pass，参考尺寸取对象 size（900×1000，不是 util/white 的 32×32），不报", async () => {
      const bundle = await compile([solid(1)]);
      expect(bundle.unsupported).toEqual([]);
      expect(basePass(bundle).userTextures).toEqual([
        {
          slot: 0,
          source: { kind: "property", name: "custom" },
          keepAspect: false,
          reference: { kind: "size", width: 900, height: 1000 },
          nearest: false,
          clamp: false,
        },
      ]);
      expect(userBindings(bundle).map((b) => b.property)).toEqual(["custom"]);
    });

    it("instance 里写显式 usertexturereference 也被对象 size 盖掉，不报 reference", async () => {
      const bundle = await compile([
        solid(1, { ...INSTANCE, usertextures: ["custom"], usertexturereference: { width: 5, height: 5 } }),
      ]);
      expect(bundle.unsupported.filter((key) => key.startsWith("usertextures:"))).toEqual([]);
      expect(basePass(bundle).userTextures?.[0].reference).toEqual({ kind: "size", width: 900, height: 1000 });
    });

    it("instance 里的封面来源：usertextures:system（不再是 material:usertextures）", async () => {
      const bundle = await compile([
        solid(1, { ...INSTANCE, usertextures: [{ name: "$mediaThumbnail", type: "system" }] }),
      ]);
      expect(bundle.unsupported).toEqual(["usertextures:system"]);
    });

    it("非 instanced 图层上的 instance.usertextures 不合并（WPE 只在 instanced 时读它）", async () => {
      const bundle = await compile([image(1, { instance: { usertextures: ["ignored"] } })]);
      expect(basePass(bundle)).not.toHaveProperty("userTextures");
      expect(bundle.userTextures).toEqual([]);
    });
  });

  describe("缺省纹理是 RT（M3、M8）", () => {
    const rt = (id: number) => `${LAYER_COMPOSITE_PREFIX}${id}_a`;

    it("被依赖图层的合成 RT：参考是 { kind: layer, object }，夹取、线性，不报", async () => {
      const bundle = await compile(
        [
          image(10, { name: "target" }),
          image(2, { dependencies: [10], effects: [effect({ usertextures: [null, "mask"] })] }),
        ],
        { effectTextures: [null, rt(10)] },
      );
      expect(bundle.unsupported).toEqual([]);
      expect(effectPass(bundle, 1)?.userTextures).toEqual([
        {
          slot: 1,
          source: { kind: "property", name: "mask" },
          keepAspect: false,
          reference: { kind: "layer", object: 0 },
          nearest: false,
          clamp: true,
        },
      ]);
    });

    it("没被依赖的 RT（P8 绑棋盘格）：usertextures:rendertarget:placeholder", async () => {
      const bundle = await compile([image(10), image(2, { effects: [effect({ usertextures: [null, "mask"] })] })], {
        effectTextures: [null, rt(10)],
      });
      expect(bundle.unsupported).toEqual(["usertextures:rendertarget:placeholder"]);
    });

    it("运行时 RT（_rt_FullFrameBuffer）：usertextures:rendertarget:runtime", async () => {
      const bundle = await compile([image(1, { effects: [effect({ usertextures: [null, "mask"] })] })], {
        effectTextures: [null, "_rt_FullFrameBuffer"],
      });
      expect(bundle.unsupported).toEqual(["usertextures:rendertarget:runtime"]);
    });
  });
});
