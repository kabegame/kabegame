// P6d1a 点 4–5：effect 与材质对象的脚本 API（getEffectCount / getEffect / name / getMaterialCount / getMaterial / setMaterialProperty、
// 材质对象的键与状态字段）。真值：`ignore/p6/d0/out/p6d1-round2.log` 的 S0–S7（WPE 2.8.42 实测，make_p6d1b.py）。
// 键顺序照 WPE 的 MSVC `unordered_map` 迭代顺序（`materialKeyOrder.ts`，单测在 `materialKeyOrder.test.ts`）。
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass } from "../compile/bundle";
import { SceneState, scriptWriteValue } from "../render/state";
import type { UniformLayout } from "../wpesl2wgsl";
import { ScriptApi } from "./api";
import type { ScriptRealm } from "./runtime";

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
}
class Vec2 extends Vec {}
class Vec3 extends Vec {}
class Vec4 extends Vec {}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: Vec4.prototype, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(): Promise<ScriptModule> {
    return fakeModule({});
  }
  dispose() {}
}

const uniform = (
  name: string,
  declared: string,
  meta: Record<string, unknown>,
  extra: Partial<UniformLayout> = {},
): UniformLayout => ({ name, type: declared, declared, offset: 0, size: 16, meta, ...extra });

/** 程序表：0 tint；1 blur 的带 `scale` 的 pass；2 blur 的无 `scale` 的 pass；3 chromaticaberration MODE 1；4 MODE 0（方向键没被读）；5 transform。 */
const programs = [
  {
    uniforms: [
      uniform("g_BlendAlpha", "float", { material: "alpha" }),
      uniform("g_TintColor", "vec3", { material: "color" }),
      uniform("g_Hidden", "float", { material: "hidden" }, { unused: true }),
    ],
  },
  { uniforms: [uniform("g_Scale", "vec2", { material: "scale" })] },
  { uniforms: [] },
  {
    uniforms: [
      uniform("u_Direction", "float", { material: "dir", conversion: "rad2deg" }),
      uniform("u_Strength", "float", { material: "strength" }),
      uniform("u_Center", "vec2", { material: "center" }),
    ],
  },
  {
    uniforms: [
      uniform("u_Direction", "float", { material: "dir", conversion: "rad2deg" }, { unused: true }),
      uniform("u_Strength", "float", { material: "strength" }),
      uniform("u_Center", "vec2", { material: "center" }),
    ],
  },
  {
    uniforms: [
      uniform("g_Offset", "vec2", { material: "offset" }),
      uniform("g_Scale", "vec2", { material: "scale" }),
      uniform("g_Direction", "float", { material: "angle", conversion: "rad2deg" }),
    ],
  },
];

function pass(key: string, program: number, material: string, uniforms: Record<string, number[]> = {}): ScenePass {
  return {
    key,
    material,
    program,
    blending: "normal",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms,
    framebuffer: false,
  } as ScenePass;
}

function effect(source: number, name: string, passes: ScenePass[]): SceneEffect {
  return {
    source,
    id: source + 100,
    name,
    file: "",
    fbos: [],
    steps: passes.map((item) => ({ kind: "draw", pass: item, target: null, compose: false, binds: null })),
    enabled: true,
    visibleBound: false,
    unsupported: [],
  } as unknown as SceneEffect;
}

const E = (source: number) => `objects/0/effects/${source}/passes`;

function setup() {
  const layer = {
    id: 10,
    object: 0,
    parent: null,
    name: "L",
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    parallaxDepth: [1, 1],
    camera: null,
    // JSON 里 6 个 effect，最后一个（下标 5）没有进 bundle（编译缺文件）
    effectCount: 6,
    effects: [
      effect(0, "fx", [
        pass(`${E(0)}/0`, 0, "materials/effects/tint.json", { g_BlendAlpha: [1], g_TintColor: [1, 0, 0] }),
      ]),
      effect(1, "blur", [
        pass(`${E(1)}/0`, 2, "materials/effects/blur_down.json"),
        pass(`${E(1)}/1`, 1, "materials/effects/blur.json", { g_Scale: [1, 1] }),
        pass(`${E(1)}/2`, 1, "materials/effects/blur.json", { g_Scale: [1, 1] }),
        pass(`${E(1)}/3`, 2, "materials/effects/blur_combine.json"),
      ]),
      effect(2, "ca", [
        pass(`${E(2)}/0`, 3, "materials/effects/chromatic_aberration.json", {
          u_Direction: [1.57079632679],
          u_Strength: [1],
          u_Center: [0.5, 0.5],
        }),
      ]),
      effect(3, "ca0", [
        pass(`${E(3)}/0`, 4, "materials/effects/chromatic_aberration.json", {
          u_Direction: [1.57079632679],
          u_Strength: [1],
          u_Center: [0.5, 0.5],
        }),
      ]),
      effect(4, "fx", [
        pass(`${E(4)}/0`, 5, "materials/effects/transform.json", {
          g_Offset: [0, 0],
          g_Scale: [1, 1],
          g_Direction: [0],
        }),
      ]),
    ],
    passes: [],
  } as unknown as SceneLayer;
  const bundle = {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: 1,
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 1,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 0.5,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    layers: [layer],
    programs,
    textures: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const api = new ScriptApi(new FakeRealm(), {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write(target, value) {
      if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
        return false;
      state.write({ property: "test", target }, scriptWriteValue(value as number[]));
      return true;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = api.layer(0) as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const material = (key: string) => (api as any).material(key) as Record<string, any>;
  return { api, state, bundle, layer, l, material };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type O = Record<string, any>;

describe("getEffectCount / getEffect / effect.name", () => {
  it("getEffectCount 取 JSON 里的 effect 个数（含没进 bundle 的）；没写 effectCount 时退回 bundle 里的个数", () => {
    const h = setup();
    expect(h.l.getEffectCount()).toBe(6);
    delete (h.layer as { effectCount?: number }).effectCount;
    expect(h.l.getEffectCount()).toBe(5);
  });

  it("getEffect(整数)：JSON 下标；越界、负数、没进 bundle 的、非整数、别的类型都是 null", () => {
    const h = setup();
    expect(h.l.getEffect(0)).toBe(h.l.getEffect(0));
    expect(h.l.getEffect(2).name).toBe("ca");
    for (const bad of [-1, 5, 6, 99, 1.5, NaN, null, undefined, true, {}])
      expect(h.l.getEffect(bad), String(bad)).toBeNull();
    expect(h.l.getEffect()).toBeNull();
  });

  it("getEffect(名字)：区分大小写、同名取最后一个、空串 null", () => {
    const h = setup();
    expect(h.l.getEffect("ca")).toBe(h.l.getEffect(2));
    expect(h.l.getEffect("CA")).toBeNull();
    expect(h.l.getEffect("")).toBeNull();
    expect(h.l.getEffect("nope")).toBeNull();
    // "fx" 在下标 0 与 4：最后一个胜出
    expect(h.l.getEffect("fx")).toBe(h.l.getEffect(4));
    expect(h.l.getEffect("fx")).not.toBe(h.l.getEffect(0));
  });

  it("name 可写，写后按新名字找得到、旧名字找不到；非字符串按 ToString，null / undefined 不写", () => {
    const h = setup();
    const ca = h.l.getEffect(2);
    ca.name = "renamed";
    expect(ca.name).toBe("renamed");
    expect(h.l.getEffect("renamed")).toBe(ca);
    expect(h.l.getEffect("ca")).toBeNull();
    // 键序 name、visible（wpe-asset.log 的 fx name write：JSON.stringify(effect) 是 {"name":…,"visible":…}）
    expect(JSON.stringify(ca)).toBe('{"name":"renamed","visible":' + String(ca.visible) + "}");
    ca.name = 7;
    expect(ca.name).toBe("7");
    ca.name = null;
    ca.name = undefined;
    expect(ca.name).toBe("7");
    // 改掉最后一个同名者之后，同名查找落到下标 0
    h.l.getEffect(4).name = "other";
    expect(h.l.getEffect("fx")).toBe(h.l.getEffect(0));
  });
});

describe("getMaterialCount / getMaterial", () => {
  it("getMaterialCount 是绘制 pass 数", () => {
    const h = setup();
    expect(h.l.getEffect(0).getMaterialCount()).toBe(1);
    expect(h.l.getEffect(1).getMaterialCount()).toBe(4);
  });

  it("getMaterial(整数)：越界、负数 null，无参 = 0；与 material(pass 键) 是同一个对象（材质常量脚本的 thisObject）", () => {
    const h = setup();
    const blur = h.l.getEffect(1);
    expect(blur.getMaterial(2)).toBe(h.material(`${E(1)}/2`));
    expect(blur.getMaterial()).toBe(blur.getMaterial(0));
    expect(blur.getMaterial(0)).toBe(h.material(`${E(1)}/0`));
    for (const bad of [-1, 4, 1.5, null, true]) expect(blur.getMaterial(bad), String(bad)).toBeNull();
  });

  it("getMaterial(名字)：按材质文件路径不分大小写全等，空串匹配每一个，最后一个胜出", () => {
    const h = setup();
    const blur = h.l.getEffect(1);
    expect(blur.getMaterial("materials/effects/BLUR_down.json")).toBe(blur.getMaterial(0));
    // pass 1、2 同一个材质文件：最后一个胜出
    expect(blur.getMaterial("materials/effects/blur.json")).toBe(blur.getMaterial(2));
    expect(blur.getMaterial("")).toBe(blur.getMaterial(3));
    expect(blur.getMaterial("materials/effects/none.json")).toBeNull();
  });
});

describe("材质对象的键（p6d1-round2 S0 / S7keys / S7val）", () => {
  it("只登记被读到的常量，状态字段在常量之后、getAnimation 之前；键顺序照 WPE 的哈希表顺序", () => {
    const h = setup();
    const tail = ["depthwrite", "depthtest", "cullmode", "alphawriting", "blending", "getAnimation"];
    // WPE 实测 color、alpha；g_Hidden 没被读，不登记
    expect(Object.keys(h.l.getEffect(0).getMaterial(0))).toEqual(["color", "alpha", ...tail]);
    // MODE 0：方向键没被读（S7keys），MODE 1 才有（S7ca keys）
    expect(Object.keys(h.l.getEffect(3).getMaterial(0))).toEqual(["strength", "center", ...tail]);
    // 夹具里的短名（dir / strength / center），顺序是算法对这三个名字的结果
    expect(Object.keys(h.l.getEffect(2).getMaterial(0))).toEqual(["strength", "center", "dir", ...tail]);
    expect(Object.keys(h.l.getEffect(4).getMaterial(0))).toEqual(["scale", "offset", "angle", ...tail]);
  });

  it("五个状态字段是 pass 上的字符串；alphawriting 缺省 default；写入规整后读回规范名（P6d1b）", () => {
    const h = setup();
    const m = h.l.getEffect(3).getMaterial(0);
    expect([m.depthwrite, m.depthtest, m.cullmode, m.alphawriting, m.blending]).toEqual([
      "disabled",
      "disabled",
      "nocull",
      "default",
      "normal",
    ]);
    m.blending = "additive";
    m.cullmode = 7; // 数字先 ToString，不在表里取第一项 normal
    expect(m.blending).toBe("additive");
    expect(m.cullmode).toBe("normal");
    // 脚本写的不动 bundle，渲染器按 SceneState 里的覆盖拼有效 pass
    const step = h.bundle.layers[0].effects[3].steps[0];
    if (step.kind === "draw") expect(step.pass.blending).toBe("normal");
  });

  it("alphawriting 取 pass 上的值（enabled / disabled）", () => {
    const h = setup();
    const step = h.bundle.layers[0].effects[0].steps[0];
    if (step.kind === "draw") step.pass.alphaWriting = "enabled";
    expect(h.l.getEffect(0).getMaterial(0).alphawriting).toBe("enabled");
  });

  it("rad2deg 的键读写用度（S7ca a：方向缺省读 90）", () => {
    const h = setup();
    const m = h.l.getEffect(2).getMaterial(0);
    expect(m.dir).toBe(90);
    m.dir = 60;
    expect(h.state.constants.get(`${E(2)}/0`)!.u_Direction[0]).toBe(
      Math.fround(Math.fround(60) * Math.fround(0.017453292)),
    );
  });
});

describe("setMaterialProperty（p6d1-round2 S1–S7）", () => {
  const tint = (h: ReturnType<typeof setup>) => h.l.getEffect(0);
  const color = (m: O) => `${m.color.x} ${m.color.y} ${m.color.z}`;
  const v2 = (m: O) => (m ? `${m.x} ${m.y}` : "none");

  it("数写 float 常量（S1 / S2 / S3e：2.7 不钳，读回单精度）", () => {
    const h = setup();
    const t = tint(h);
    const m = t.getMaterial(0);
    expect(t.setMaterialProperty("alpha", 0.25)).toBeUndefined();
    expect(m.alpha).toBe(0.25);
    t.setMaterialProperty("alpha", 1);
    expect(m.alpha).toBe(1);
    t.setMaterialProperty("alpha", 2.7);
    expect(m.alpha).toBe(2.700000047683716);
    t.setMaterialProperty("alpha", NaN);
    expect(m.alpha).toBeNaN();
  });

  it("字符串、布尔、null、不传值都把 float 常量写成 0（S3a–S3d）", () => {
    const h = setup();
    const t = tint(h);
    const m = t.getMaterial(0);
    for (const value of ["0.5", true, null]) {
      t.setMaterialProperty("alpha", 1);
      t.setMaterialProperty("alpha", value);
      expect(m.alpha, String(value)).toBe(0);
    }
    t.setMaterialProperty("alpha", 1);
    t.setMaterialProperty("alpha");
    expect(m.alpha).toBe(0);
  });

  it("vec3 常量任何值都写不进（S4a–S4d）", () => {
    const h = setup();
    const t = tint(h);
    const m = t.getMaterial(0);
    for (const value of [new Vec3(0, 1, 0), new Vec4(0, 1, 0, 1), 0.5, new Vec2(0, 1)]) {
      t.setMaterialProperty("color", value);
      expect(color(m)).toBe("1 0 0");
    }
  });

  it("名字：uniform 名、大小写变体、状态字段、非字符串都不生效（S6a–S6d），没登记的键也不写", () => {
    const h = setup();
    const t = tint(h);
    const m = t.getMaterial(0);
    t.setMaterialProperty("g_BlendAlpha", 0.25);
    expect(m.alpha).toBe(1);
    t.setMaterialProperty("Alpha", 0.25);
    expect(m.alpha).toBe(1);
    t.setMaterialProperty("blending", 0.25);
    expect(m.blending).toBe("normal");
    t.setMaterialProperty(5 as unknown as string, 0.25);
    expect(m.alpha).toBe(1);
    // g_Hidden 的材质键 hidden 没被读到：没登记
    t.setMaterialProperty("hidden", 0.25);
    expect(h.state.constants.get(`${E(0)}/0`)!.g_Hidden).toBeUndefined();
  });

  it("任何对象只取 x、y 写 vec2 常量，对每个 pass 各查各写（S5a–S5f）", () => {
    const h = setup();
    const b = h.l.getEffect(1);
    b.setMaterialProperty("scale", new Vec3(0.3, 0.7, 9));
    expect([0, 1, 2, 3].map((i) => v2(b.getMaterial(i).scale)).join(" | ")).toBe(
      "none | 0.30000001192092896 0.699999988079071 | 0.30000001192092896 0.699999988079071 | none",
    );
    b.setMaterialProperty("scale", { x: 0.5, y: 0.25 });
    expect([v2(b.getMaterial(1).scale), v2(b.getMaterial(2).scale)]).toEqual(["0.5 0.25", "0.5 0.25"]);
    // 数组的 x、y 是 undefined → 0 0
    b.setMaterialProperty("scale", [2, 3]);
    expect(v2(b.getMaterial(1).scale)).toBe("0 0");
    // 非有限数当 0
    b.setMaterialProperty("scale", { x: Infinity, y: "7" });
    expect(v2(b.getMaterial(1).scale)).toBe("0 7");
    // 数、字符串写 vec2 常量：跳过
    b.setMaterialProperty("scale", 0.5);
    b.setMaterialProperty("scale", 1);
    b.setMaterialProperty("scale", "1");
    expect(v2(b.getMaterial(1).scale)).toBe("0 7");
    expect(b.setMaterialProperty("scale", new Vec2(1, 1))).toBeUndefined();
  });

  it("rad2deg 的常量按度读写（S7ca：45 读回 45；S7tr：30 读回 30.000001907348633，字段写 60 读回 60.000003814697266）", () => {
    const h = setup();
    const c = h.l.getEffect(2);
    const cm = c.getMaterial(0);
    expect(cm.dir).toBe(90);
    c.setMaterialProperty("dir", 45);
    expect(cm.dir).toBe(45);
    const t = h.l.getEffect(4);
    const tm = t.getMaterial(0);
    expect(tm.angle).toBe(0);
    t.setMaterialProperty("angle", 45);
    expect(tm.angle).toBe(45);
    t.setMaterialProperty("angle", 30);
    expect(tm.angle).toBe(30.000001907348633);
    tm.angle = 60;
    expect(tm.angle).toBe(60.000003814697266);
    t.setMaterialProperty("angle", 45);
    expect(tm.angle).toBe(45);
    // 字符串写 0（度）
    t.setMaterialProperty("angle", "x");
    expect(tm.angle).toBe(0);
  });

  it("写入进状态后当帧标脏（dirtyPasses）", () => {
    const h = setup();
    h.state.takeDirty();
    h.l.getEffect(0).setMaterialProperty("alpha", 0.5);
    expect(h.state.takeDirty().passes.has(`${E(0)}/0`)).toBe(true);
  });
});

// P6d1b：五个状态字段的取值规则（`p6d1-mat8`，tint 的 pass 0 上依次写；规则同 `compile/passState.test.ts`）
describe("材质状态字段的写入与读回（p6d1-mat8）", () => {
  /** 依次写入 `values`，每次写后读回。 */
  const run = (m: O, field: string, values: unknown[]): string[] =>
    values.map((value) => {
      m[field] = value;
      return m[field] as string;
    });

  it("blending：非法值复位成 normal，null / undefined 不写（保持上一个）", () => {
    const m = setup().l.getEffect(0).getMaterial(0);
    expect(
      run(m, "blending", ["additive", "bogus", "translucent", "Additive", "disabled", "normal", "additive", 3]),
    ).toEqual(["additive", "normal", "translucent", "normal", "normal", "normal", "additive", "normal"]);
    // 上一个是 normal 时 null 看不出来，换成 additive 再写 null
    m.blending = "additive";
    m.blending = null;
    expect(m.blending).toBe("additive");
    m.blending = undefined;
    expect(m.blending).toBe("additive");
    m.blending = "alphatocoverage";
    expect(m.blending).toBe("alphatocoverage");
  });

  it("alphawriting：非法值（含 Enabled、true）复位成 default", () => {
    const m = setup().l.getEffect(0).getMaterial(0);
    expect(run(m, "alphawriting", ["enabled", "bogus", "disabled", "default", "Enabled", "enabled", true])).toEqual([
      "enabled",
      "default",
      "disabled",
      "default",
      "default",
      "enabled",
      "default",
    ]);
  });

  it("depthtest / depthwrite：非法值（含 less、Disabled）复位成 disabled", () => {
    const m = setup().l.getEffect(0).getMaterial(0);
    expect(run(m, "depthtest", ["enabled", "bogus", "disabled", "enabled", "less", "Disabled"])).toEqual([
      "enabled",
      "disabled",
      "disabled",
      "enabled",
      "disabled",
      "disabled",
    ]);
    expect(run(m, "depthwrite", ["enabled", "bogus", "disabled", "enabled", "Disabled"])).toEqual([
      "enabled",
      "disabled",
      "disabled",
      "enabled",
      "disabled",
    ]);
  });

  it("cullmode：非法值（back / front / Normal / none）复位成 normal", () => {
    const m = setup().l.getEffect(0).getMaterial(0);
    expect(run(m, "cullmode", ["normal", "bogus", "nocull", "normal", "back", "front", "Normal", "none"])).toEqual([
      "normal",
      "normal",
      "nocull",
      "normal",
      "normal",
      "normal",
      "normal",
      "normal",
    ]);
  });

  it("区分大小写、空白也算字符；对象 / 布尔先 ToString；抛错的转换（Symbol）不写", () => {
    const m = setup().l.getEffect(0).getMaterial(0);
    m.depthtest = "enabled";
    m.depthtest = " enabled";
    expect(m.depthtest).toBe("disabled");
    m.depthtest = "enabled";
    m.depthtest = { toString: () => "disabled" };
    expect(m.depthtest).toBe("disabled");
    m.depthtest = "enabled";
    m.depthtest = Symbol("x");
    expect(m.depthtest).toBe("enabled");
    m.cullmode = true;
    expect(m.cullmode).toBe("normal");
  });

  it("写入记进 SceneState.passStates 并把图层记进 dirty.passStates；不动 bundle 与别的 pass；键顺序不变", () => {
    const h = setup();
    h.state.takeDirty();
    const before = Object.keys(h.l.getEffect(0).getMaterial(0));
    h.l.getEffect(1).getMaterial(2).blending = "additive";
    expect(h.state.passStates.get(`${E(1)}/2`)).toEqual({ blending: "additive" });
    expect(h.state.passStates.has(`${E(1)}/1`)).toBe(false);
    expect([...h.state.takeDirty().passStates]).toEqual([0]);
    expect(h.l.getEffect(1).getMaterial(1).blending).toBe("normal");
    expect(Object.keys(h.l.getEffect(0).getMaterial(0))).toEqual(before);
  });

  it("同值也照写：每次写入都把图层记进「要重建」；只读不标脏", () => {
    const h = setup();
    h.l.getEffect(0).getMaterial(0).blending = "additive";
    h.state.takeDirty();
    h.l.getEffect(0).getMaterial(0).blending = "additive";
    expect([...h.state.takeDirty().passStates]).toEqual([0]);
    void h.l.getEffect(0).getMaterial(0).blending;
    expect(h.state.takeDirty().passStates.size).toBe(0);
  });
});
