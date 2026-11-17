/**
 * 活的场景图 L1：编译会话与对象片段（`compile/fragment.ts` + `bundle.ts` 的 `openCompileSession`）。
 * 内存工程，每种对象各一个，两种来源互为判据（A = `compileFragment` 真编，B = `rekeyFragment(fragmentOf(bundle, i))` 改键），再加会话的不变量：
 * - 不支持项只记在记录器里，编完会话恢复原样、`settled()` 不变；
 * - `fragmentBlocker` 的四条；
 * - 用 `getEffect` 的脚本让 `sceneFlips` 含 `effect-access`；
 * - 已有下标不带 `overrides` 抛错、`finalize` 前后的调用顺序；
 * - 单对象重编译（L6）：`overrides: {}` 等于 `fragmentOf`，带覆盖等于带同样 `scriptOverrides` 整场编的 `fragmentOf`；旧条目摘掉、`configs` 不变。
 * 全语料的对照在 `ignore/live/l1/fragments.test.ts`。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene, openCompileSession, type SceneBundle, type SceneCompileSession, type ScenePass } from "./bundle";
import type { SceneReader } from "./fs";
import { GROUP_CHILD_FRAMEBUFFER } from "./features";
import { fragmentBlocker, fragmentOf, rekeyFragment, type ObjectFragment } from "./fragment";
import { mdlStride } from "./mdl";
import { collectObjectScriptsSync } from "./scripts";
import { TEXT_MATERIALS } from "./texts";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
const ASSETS = "A:/assets";

// ———— 工程文件 ————

/** 最小的 mdl（同 `p5c.test.ts`）：一个网格、材质 `materials/a.json`。 */
function mdl(): Uint8Array {
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
  cstr("materials/a.json");
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

const lin = (frame: number, value: number) => ({
  frame,
  value,
  back: { enabled: false, x: -1, y: 0, magic: false },
  front: { enabled: false, x: -1, y: 0, magic: false },
  lockangle: true,
  locklength: true,
});
const CURVE = [lin(0, 0), lin(60, 1)];
/** 关键帧值：`channels` 依次是 `c0`、`c1`…，`options` 并进缺省（fps 30、length 60、loop）。 */
function kf(channels: unknown[], options: Record<string, unknown> = {}, value: unknown = 0) {
  const animation: Record<string, unknown> = { options: { fps: 30, length: 60, mode: "loop", ...options } };
  channels.forEach((channel, i) => (animation[`c${i}`] = channel));
  return { animation, value };
}

const script = (extra = "") => `export function update(value) { return value; }${extra}`;

/** 场景里的对象，下标即 `objects` 下标（顺序有意义：测试按下标取）。 */
const OBJECTS: Record<string, unknown>[] = [
  // 0 图像层，两个 effect（第二个带材质常量脚本），alpha 带脚本与 scriptproperties 的属性绑定
  {
    id: 10,
    name: "image",
    image: "models/a.json",
    origin: "960 540 0",
    alpha: { script: script(), value: 1, scriptproperties: { k: { user: "p", value: 1 } } },
    effects: [
      { id: 1, file: "effects/x/effect.json" },
      {
        id: 2,
        file: "effects/x/effect.json",
        passes: [{ id: 3, constantshadervalues: { multiply: { script: script(" // c"), value: 1 } } }],
      },
    ],
  },
  // 1 粒子：两个 renderer，一个静态子系统
  { id: 11, name: "particle", particle: "particles/p.json", origin: "100 100 0", parent: 10 },
  // 2 文本
  { id: 12, name: "text", text: "12:34", origin: "200 200 0" },
  // 3 声音
  { id: 13, name: "sound", sound: "sounds/a.mp3", volume: { user: "p", value: 1 } },
  // 4 普通灯
  { id: 14, name: "lamp", light: "lpoint", color: "1 1 1", intensity: { user: "p", value: 1 }, radius: 3 },
  // 5 静态模型
  { id: 15, name: "model", model: "models/a.mdl", origin: "300 300 0" },
  // 6 带 script-property 与材质常量脚本的图像层（effect 常量）
  {
    id: 16,
    name: "scripted",
    image: "models/a.json",
    effects: [
      {
        id: 4,
        file: "effects/x/effect.json",
        passes: [
          {
            id: 5,
            constantshadervalues: {
              multiply: { script: script(" // m"), value: 1, scriptproperties: { q: { user: "p", value: 2 } } },
            },
          },
        ],
      },
    ],
  },
  // 7 带关键帧的图像层：alpha 联动 brightness，origin 三通道
  {
    id: 17,
    name: "animated",
    image: "models/a.json",
    alpha: kf([CURVE], { parent: { key: "brightness" } }, 1),
    brightness: kf([CURVE], {}, 1),
    origin: kf([CURVE, CURVE, CURVE], {}, "0 0 0"),
  },
  // 8 相机对象：fov / zoom 绑属性（就地目标 camera）
  { id: 18, name: "cam", camera: "camera", fov: { user: "p", value: 50 }, zoom: 1 },
];

const FX_UNIFORMS = [
  { name: "g_Multiply", type: "f32", declared: "float", offset: 0, size: 4, meta: { material: "multiply" } },
];

/** 假翻译器：effect 着色器 `fx` 有 float 常量 `multiply`；其余没有接口。 */
const translator = {
  async translate(input: { fragment: string }) {
    const fx = input.fragment.startsWith("// fx");
    return { ok: true, uniforms: fx ? FX_UNIFORMS : [], textures: [], combos: [], attributes: [] };
  },
} as unknown as Wpesl2wgsl;

function files(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const shader = (name: string) => ({
    [`P:/p/shaders/${name}.vert`]: `// ${name}`,
    [`P:/p/shaders/${name}.frag`]: `// ${name}`,
  });
  const assetShader = (name: string) => ({
    [`${ASSETS}/shaders/${name}.vert`]: "void main(){}",
    [`${ASSETS}/shaders/${name}.frag`]: "void main(){}",
  });
  const textPass = (shader: string, extraPass: Record<string, unknown> = {}) => ({
    passes: [
      {
        shader,
        blending: "translucent",
        depthtest: "disabled",
        depthwrite: "disabled",
        cullmode: "nocull",
        ...extraPass,
      },
    ],
  });
  return {
    "P:/p/project.json": { file: "scene.json", general: { properties: { p: { type: "slider", value: 1 } } } },
    "P:/p/scene.json": { general: { ...ORTHO, lightconfig: { point: 1 } }, objects },
    "P:/p/models/a.json": { material: "materials/a.json", width: 4, height: 4 },
    "P:/p/materials/a.json": { passes: [{ shader: "base" }] },
    "P:/p/models/a.mdl": mdl(),
    "P:/p/effects/x/effect.json": { passes: [{ material: "materials/fx.json" }] },
    "P:/p/materials/fx.json": { passes: [{ shader: "fx" }] },
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 4,
      renderer: [{ name: "sprite" }, { name: "spritetrail" }],
      children: [{ name: "particles/c.json", type: "static" }],
    },
    "P:/p/particles/c.json": { material: "materials/pm.json", maxcount: 2, renderer: [{ name: "sprite" }] },
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", blending: "additive" }] },
    "P:/p/sounds/a.mp3": "a",
    ...shader("base"),
    ...shader("fx"),
    ...shader("genericparticle"),
    ...assetShader("font"),
    ...assetShader("flat"),
    ...assetShader("composelayer"),
    [`${ASSETS}/${TEXT_MATERIALS.glyphs}`]: textPass("font"),
    [`${ASSETS}/${TEXT_MATERIALS.color}`]: textPass("font", { combos: { COLORFONT: 1 } }),
    [`${ASSETS}/${TEXT_MATERIALS.background}`]: textPass("flat"),
    [`${ASSETS}/${TEXT_MATERIALS.clearAlpha}`]: textPass("composelayer", {
      blending: "normal",
      textures: ["_rt_FullFrameBuffer"],
      combos: { CLEARALPHA: 1 },
    }),
    ...extra,
  };
}

function reader(map: Record<string, unknown>): SceneReader {
  const bytes = (path: string) => {
    const value = map[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    if (value instanceof Uint8Array) return value.slice();
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    readWhole: async (path) => bytes(path),
    readRange: async (path, start, end) => bytes(path).slice(start, end),
  };
}

/** 开会话、整场编完（`exhaustive` 缺省真；给 false 时和产品一样，确定退回后 `settled()` 为真）。 */
async function open(
  objects: unknown[] = OBJECTS,
  options: { exhaustive?: boolean; extra?: Record<string, unknown>; postprocess?: "disabled" | "ultra" } = {},
) {
  const session = await openCompileSession({
    projectDir: "P:/p",
    sceneAssets: [ASSETS],
    reader: reader(files(objects, options.extra)),
    translator,
    postprocess: options.postprocess ?? "disabled",
    reflection: "disabled",
    exhaustive: options.exhaustive ?? true,
  });
  return { session, bundle: await finish(session) };
}

async function finish(session: SceneCompileSession): Promise<SceneBundle> {
  for (let index = 0; index < session.objectCount; index++) {
    if (session.settled()) break;
    await session.compileObject(index);
  }
  return session.finalize();
}

// ———— 规范化与比较 ————

/** 类型化数组、Map、Set、undefined 键都规整成可比较的普通值（同全库摘要的 normalize）。 */
function canon(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (ArrayBuffer.isView(value))
    return { $view: value.constructor.name, $data: Array.from(value as unknown as number[]) };
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [canon(k), canon(v)]) };
  if (value instanceof Set) return { $set: [...value].map(canon) };
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = canon((value as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return value;
}
const comparable = (fragment: ObjectFragment) => {
  const { unsupported: _u, sceneFlips: _s, ...rest } = fragment;
  return canon(rest);
};

/** A = `compileFragment`，B = `rekeyFragment(fragmentOf)`：同一个对象配置、新下标 / 新 id / 模板的父。 */
async function pair(session: SceneCompileSession, bundle: SceneBundle, object: number, next: number, id: number) {
  const layer = bundle.layers.find((item) => item.object === object)!;
  const template = fragmentOf(bundle, object);
  expect(template, `对象 ${object} 取不到片段（${fragmentBlocker(bundle, object)}）`).not.toBeNull();
  const b = rekeyFragment(template!, { object: next, id, parent: layer.parent });
  const delta = await session.compileFragment({
    object: next,
    config: JSON.stringify({ ...OBJECTS[object], id }),
    parent: layer.parent,
    bone: null,
    properties: {},
  });
  return { a: delta.fragment, b, delta };
}

describe("会话：整场编译不变", () => {
  it("compileScene = 开会话、逐个 compileObject、finalize：和手动驱动的会话产物相同", async () => {
    const input = {
      projectDir: "P:/p",
      sceneAssets: [ASSETS],
      reader: reader(files(OBJECTS)),
      translator,
      postprocess: "disabled" as const,
      reflection: "disabled" as const,
      exhaustive: true,
    };
    const whole = await compileScene(input);
    const { bundle } = await open();
    expect(canon(whole)).toEqual(canon(bundle));
    expect(bundle.layers.map((layer) => layer.object)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("finalize 只能调一次；finalize 之前不能 compileFragment", async () => {
    const session = await openCompileSession({
      projectDir: "P:/p",
      sceneAssets: [ASSETS],
      reader: reader(files(OBJECTS)),
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
    await expect(
      session.compileFragment({ object: 20, config: "{}", parent: null, bone: null, properties: {} }),
    ).rejects.toThrow("finalize");
    for (let index = 0; index < session.objectCount; index++) await session.compileObject(index);
    await session.finalize();
    await expect(session.finalize()).rejects.toThrow("只能调一次");
  });

  it("已有下标不带 overrides 仍抛错（单对象重编译要带 overrides，L6）", async () => {
    const { session } = await open();
    await expect(
      session.compileFragment({
        object: 3,
        config: JSON.stringify(OBJECTS[3]),
        parent: null,
        bone: null,
        properties: {},
      }),
    ).rejects.toThrow("overrides");
  });
});

describe("片段：compileFragment 与 rekeyFragment(fragmentOf) 逐字段相同", () => {
  const cases: [string, number][] = [
    ["图像层（两个 effect、脚本与属性绑定）", 0],
    ["粒子（两个 renderer、静态子系统）", 1],
    ["文本", 2],
    ["声音", 3],
    ["普通灯", 4],
    ["静态模型", 5],
    ["带 script-property 与材质常量脚本", 6],
    ["带关键帧（含联动）", 7],
    ["相机对象", 8],
  ];
  for (const [name, object] of cases) {
    it(name, async () => {
      const { session, bundle } = await open();
      const { a, b, delta } = await pair(session, bundle, object, 40 + object, 900000 + object);
      expect(comparable(a)).toEqual(comparable(b));
      // 同场景的配置：不翻转场景级不变量，增量为空（程序、纹理、用户纹理、场景级绑定都命中缓存）
      expect(a.sceneFlips).toEqual([]);
      expect(delta.programs.list).toEqual([]);
      expect(delta.textures.list).toEqual([]);
      expect(delta.userTextures.list).toEqual([]);
      expect(delta.bindings).toEqual([]);
      // 改键：片段里的键全部指向新下标，没有旧下标的残留
      const text = JSON.stringify(canon(a));
      expect(text).not.toContain(`objects/${object}/`);
      expect(a.layer.object).toBe(40 + object);
      expect(a.layer.id).toBe(900000 + object);
    });
  }

  it("片段内容：脚本带 script-property 绑定与定型后的材质常量目标、关键帧联动用片段内下标、灯槽位为 -1", async () => {
    const { session, bundle } = await open();
    const image = (await pair(session, bundle, 6, 41, 900001)).a;
    expect(image.scripts.map((item) => item.id)).toEqual([
      "objects/41/effects/0/passes/0/constantshadervalues/multiply",
    ]);
    expect(image.scripts[0].target).toMatchObject({ kind: "constant", uniforms: ["g_Multiply"], type: "float" });
    expect(image.bindings.map((item) => item.target.kind).sort()).toEqual(["script-property"]);
    const animated = (await pair(session, bundle, 7, 42, 900002)).a;
    expect(animated.animations.map((item) => [item.id, item.parent])).toEqual([
      ["objects/42/alpha", 1],
      ["objects/42/brightness", null],
      ["objects/42/origin", null],
    ]);
    // 会话里的整场关键帧表继续增长，联动的 parent 是整场列表里的下标
    const all = bundle.animations!;
    const added = all.slice(all.length - 3);
    expect(added.map((item) => item.id)).toEqual(animated.animations.map((item) => item.id));
    expect(added[0].parent).toBe(all.length - 2);
    const lamp = (await pair(session, bundle, 4, 43, 900003)).a;
    expect(lamp.light).toMatchObject({ object: 43, legacySlot: -1 });
    expect(bundle.lightObjects!.map((item) => item.object)).toEqual([4]);
  });

  it("位置相关的字段是空值：group null、subtree []、没有 attachment、effect 的不支持项不含 GROUP_CHILD_FRAMEBUFFER", async () => {
    const { session, bundle } = await open();
    const { a, b } = await pair(session, bundle, 0, 40, 900000);
    for (const fragment of [a, b]) {
      expect(fragment.layer.group).toBeNull();
      expect(fragment.layer.subtree).toEqual([]);
      expect(fragment.layer).not.toHaveProperty("attachment");
      expect(fragment.layer.groupUpload).toBeNull();
      expect(fragment.layer.parent).toBeNull();
    }
  });

  it("rekeyFragment 只读入参：改键前后模板片段不变", async () => {
    const { bundle } = await open();
    const template = fragmentOf(bundle, 0)!;
    const before = JSON.stringify(canon(template));
    rekeyFragment(template, { object: 99, id: 5, parent: 3 });
    expect(JSON.stringify(canon(template))).toBe(before);
  });
});

describe("不支持项记录与会话恢复", () => {
  /** 带两个缺失 effect 的图像层：两个 `effect:missing:*` 都要进片段（编译期间 settled() 恒为假，不会在第一个之后截断）。 */
  const broken = {
    id: 30,
    image: "models/a.json",
    effects: [{ file: "effects/none1/effect.json" }, { file: "effects/none2/effect.json" }],
  };

  it("片段的 unsupported 正确；编完后会话的 unsupported 恢复原样，settled() 仍为假、之后的片段不受影响", async () => {
    // 不列全：和产品一样，会话一旦有不支持项 settled() 就为真，所以这个场景自己必须干净
    const { session, bundle } = await open([OBJECTS[3]], { exhaustive: false });
    expect(bundle.unsupported).toEqual([]);
    expect(session.settled()).toBe(false);
    const delta = await session.compileFragment({
      object: 5,
      config: JSON.stringify(broken),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.unsupported).toEqual([
      "effect:missing:effects/none1/effect.json",
      "effect:missing:effects/none2/effect.json",
    ]);
    expect(session.settled()).toBe(false);
    // 再编一个干净的片段：不带上一次的键
    const clean = await session.compileFragment({
      object: 6,
      config: JSON.stringify({ ...OBJECTS[3], id: 31 }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(clean.fragment.unsupported).toEqual([]);
    expect(session.settled()).toBe(false);
  });

  it("新脚本用了没实现的 API：unsupported 带 script:api，不写进会话", async () => {
    const { session } = await open([OBJECTS[3]], { exhaustive: false });
    const delta = await session.compileFragment({
      object: 5,
      config: JSON.stringify({
        id: 32,
        image: "models/a.json",
        alpha: { script: "export function update(v) { return engine.userProperties; }", value: 1 },
      }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.scripts).toHaveLength(1);
    expect(delta.fragment.unsupported.every((key) => key.startsWith("script:"))).toBe(true);
    expect(session.settled()).toBe(false);
  });
});

describe("场景级不变量的翻转（sceneFlips）", () => {
  it("新脚本用 getEffect 而场景没有 usesEffectAccess：effect-access", async () => {
    const { session, bundle } = await open([OBJECTS[3]]);
    expect(bundle.scripts.usesEffectAccess).toBe(false);
    const delta = await session.compileFragment({
      object: 5,
      config: JSON.stringify({
        id: 33,
        image: "models/a.json",
        alpha: { script: "export function update(v) { thisLayer.getEffect('x'); return v; }", value: 1 },
      }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.sceneFlips).toContain("effect-access");
  });

  it("体积光灯：volumetrics（GPU 资源加载时按灯列表建，运行中增删属 L8）", async () => {
    const { session } = await open([OBJECTS[3]]);
    const delta = await session.compileFragment({
      object: 5,
      config: JSON.stringify({ ...OBJECTS[4], id: 34, castvolumetrics: true }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.sceneFlips).toContain("volumetrics");
  });
});

describe("fragmentBlocker", () => {
  it("missing：bundle 里没有这个对象", async () => {
    const { bundle } = await open();
    expect(fragmentBlocker(bundle, 99)).toBe("missing");
    expect(fragmentOf(bundle, 99)).toBeNull();
    expect(fragmentBlocker(bundle, 0)).toBeNull();
  });

  it("depended：被别的对象的 dependencies 依赖的图像层", async () => {
    const { bundle } = await open([
      { id: 20, image: "models/a.json" },
      { id: 21, image: "models/a.json", dependencies: [20] },
    ]);
    expect(bundle.layers[0].dependedOn).toBe(true);
    expect(fragmentBlocker(bundle, 0)).toBe("depended");
    expect(fragmentOf(bundle, 0)).toBeNull();
    expect(fragmentBlocker(bundle, 1)).toBeNull();
  });

  it("hdr-layer-composites：HDR 场景且某个 pass 引用别的图层的合成 RT", async () => {
    const { bundle } = await open([{ id: 20, image: "models/a.json" }]);
    const pass: ScenePass = bundle.layers[0].passes[0];
    pass.layerComposites = { 1: 3 };
    expect(fragmentBlocker(bundle, 0)).toBeNull();
    bundle.general.postprocess.hdr = true;
    expect(fragmentBlocker(bundle, 0)).toBe("hdr-layer-composites");
  });

  it("group-upload：模板带子层（有组上屏 pass）", async () => {
    const { bundle } = await open([{ id: 20, image: "models/a.json" }]);
    bundle.layers[0].groupUpload = { ...bundle.layers[0].passes[0], key: "objects/0/groupupload" };
    expect(fragmentBlocker(bundle, 0)).toBe("group-upload");
  });
});

// 全语料对照覆盖不到的三条路径（L1 验收的变异检查没抓到的）：语料里没有组内关着的读帧缓冲 effect、没有开着的平面反射名单、
// 没有被 `layerDefs` 滤掉的动画层字段脚本
describe("语料覆盖不到的位置规整与过滤", () => {
  it("fragmentOf：组归属、子树、挂点清空，effect 去掉 GROUP_CHILD_FRAMEBUFFER（别的键保留），reflected 取反射名单", async () => {
    const { bundle } = await open();
    const layer = bundle.layers.find((item) => item.object === 0)!;
    layer.group = 5;
    layer.subtree = [1];
    layer.attachment = { parent: 5, bone: 0, matrix: new Float32Array(16) } as unknown as typeof layer.attachment;
    layer.effects[0].unsupported = ["effect:keep", GROUP_CHILD_FRAMEBUFFER];
    bundle.reflection = { planar: true, enabled: true, list: [0, 7] };
    const fragment = fragmentOf(bundle, 0)!;
    expect(fragment.layer.group).toBeNull();
    expect(fragment.layer.subtree).toEqual([]);
    expect(fragment.layer).not.toHaveProperty("attachment");
    expect(fragment.layer.effects[0].unsupported).toEqual(["effect:keep"]);
    expect(fragment.reflected).toBe(true);
    // 不在名单里的为假；整场 bundle 本身不被改
    expect(fragmentOf(bundle, 6)!.reflected).toBe(false);
    expect(layer.group).toBe(5);
    expect(layer.effects[0].unsupported).toContain(GROUP_CHILD_FRAMEBUFFER);
  });

  it("compileFragment：不是 puppet 的对象上的动画层字段脚本被滤掉（同 finalize），和 fragmentOf 相同", async () => {
    const withLayers = {
      id: 30,
      name: "layers",
      image: "models/a.json",
      animationlayers: [{ rate: { script: script(), value: 1 } }],
    };
    // 前提：收集时确实有一条动画层属主的脚本（否则这条用例是空测）
    const collected = collectObjectScriptsSync(withLayers, 0, {});
    expect(collected.some((item) => item.owner.kind === "animation-layer")).toBe(true);
    const { session, bundle } = await open([withLayers]);
    expect(bundle.scripts.list.some((item) => item.owner.kind === "animation-layer")).toBe(false);
    const delta = await session.compileFragment({
      object: 5,
      config: JSON.stringify({ ...withLayers, id: 900030 }),
      parent: null,
      bone: null,
      properties: {},
    });
    expect(delta.fragment.scripts.some((item) => item.owner.kind === "animation-layer")).toBe(false);
    expect(bundle.scripts.list.some((item) => item.owner.kind === "animation-layer")).toBe(false);
    const b = rekeyFragment(fragmentOf(bundle, 0)!, { object: 5, id: 900030, parent: null });
    expect(comparable(delta.fragment)).toEqual(comparable(b));
  });
});

describe("单对象重编译（L6）", () => {
  /** 带 `scriptOverrides` 整场编（判据：带同样覆盖整场编的 `fragmentOf`）。 */
  async function openWith(scriptOverrides: Record<string, number[] | boolean | string>, objects: unknown[] = OBJECTS) {
    const session = await openCompileSession({
      projectDir: "P:/p",
      sceneAssets: [ASSETS],
      reader: reader(files(objects)),
      translator,
      postprocess: "disabled",
      reflection: "disabled",
      exhaustive: true,
      scriptOverrides,
    });
    return { session, bundle: await finish(session) };
  }
  const recompile = (session: SceneCompileSession, object: number, overrides: Record<string, unknown> = {}) =>
    session.compileFragment({
      object,
      config: "",
      overrides: overrides as Record<string, number[] | boolean | string>,
      parent: null,
      bone: null,
      properties: {},
    });

  for (const object of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`overrides 为空：片段等于整场的 fragmentOf（对象 ${object}）`, async () => {
      const { session, bundle } = await open();
      // B 先取：重编会往会话的表里追加
      const b = fragmentOf(bundle, object)!;
      const layer = bundle.layers.find((item) => item.object === object)!;
      const delta = await session.compileFragment({
        object,
        config: "",
        overrides: {},
        parent: layer.parent,
        bone: null,
        properties: {},
      });
      expect(comparable(delta.fragment)).toEqual(comparable(b));
      expect(delta.fragment.layer.object).toBe(object);
      expect(delta.fragment.sceneFlips).toEqual([]);
    });
  }

  it("旧条目摘掉：会话的图层表里这个对象只剩新编的一个（find 找到新的）；声音、灯同理；configs 不变", async () => {
    const { session, bundle } = await open();
    const configs = [...bundle.configs!];
    const before = bundle.layers.find((item) => item.object === 3)!;
    const sound = await recompile(session, 3);
    expect(bundle.layers.filter((item) => item.object === 3)).toEqual([sound.fragment.layer]);
    expect(bundle.layers.find((item) => item.object === 3)).not.toBe(before);
    expect(bundle.sounds!.filter((item) => item.object === 3)).toEqual([sound.fragment.sound]);
    await recompile(session, 4);
    expect(bundle.lightObjects!.filter((item) => item.object === 4)).toEqual([]);
    // 再编一次照样只有一个；配置原文（`getInitialLayerConfig`）不变
    const again = await recompile(session, 3, { volume: 0.5 });
    expect(bundle.layers.filter((item) => item.object === 3)).toEqual([again.fragment.layer]);
    expect(bundle.configs).toEqual(configs);
  });

  it("overrides 的相对路径套到对象字段与 effect 常量上：等于带同样 scriptOverrides 整场编的 fragmentOf", async () => {
    const overrides = { origin: [1, 2, 3], "effects/1/passes/0/constantshadervalues/multiply": [2] };
    const expected = await openWith({
      "objects/0/origin": [1, 2, 3],
      "objects/0/effects/1/passes/0/constantshadervalues/multiply": [2],
    });
    const b = fragmentOf(expected.bundle, 0)!;
    const { session } = await open();
    const a = (await recompile(session, 0, overrides)).fragment;
    expect(comparable(a)).toEqual(comparable(b));
    expect(a.layer.origin).toEqual([1, 2, 3]);
    // 绑脚本的常量（带 `value` 的对象）只换 `value`：脚本仍在
    expect(a.scripts.map((item) => item.id)).toContain("objects/0/effects/1/passes/0/constantshadervalues/multiply");
  });

  it("每次从原文起套：上一次的覆盖不残留（覆盖是这个对象累计的全部，由调用方给全）", async () => {
    const { session, bundle } = await open();
    const original = fragmentOf(bundle, 0)!;
    await recompile(session, 0, { origin: [5, 5, 5] });
    const back = (await recompile(session, 0, {})).fragment;
    expect(comparable(back)).toEqual(comparable(original));
  });

  it("配置里没写 id 的对象：新图层沿用旧图层的 id（整场编时按表内位置发的）", async () => {
    const objects = [OBJECTS[3], { name: "no-id", image: "models/a.json" }];
    const { session, bundle } = await open(objects);
    const before = bundle.layers.find((item) => item.object === 1)!;
    expect(before.id).toBe(1);
    const a = (await recompile(session, 1)).fragment;
    expect(a.layer.id).toBe(before.id);
  });

  it("运行中建的对象：会话编过的按它的配置原文重编；会话没见过的（L5 命中缓存）按请求带来的 config 登记", async () => {
    const config = JSON.stringify({ ...OBJECTS[0], id: 777 });
    const { session } = await open();
    const created = await session.compileFragment({ object: 20, config, parent: null, bone: null, properties: {} });
    const again = await recompile(session, 20);
    expect(comparable(again.fragment)).toEqual(comparable(created.fragment));
    // 另一个会话：没编过 21，请求带 config
    const other = await open();
    const fresh = await other.session.compileFragment({
      object: 21,
      config,
      overrides: { origin: [9, 9, 9] },
      parent: null,
      bone: null,
      properties: {},
    });
    expect(fresh.fragment.layer.origin).toEqual([9, 9, 9]);
    expect(fresh.fragment.layer.id).toBe(777);
    expect(other.bundle.configs![21]).toBe(created.fragment.config);
    // 没见过、也没带 config：抛错
    await expect(recompile(other.session, 30)).rejects.toThrow("没有原文");
  });
});
