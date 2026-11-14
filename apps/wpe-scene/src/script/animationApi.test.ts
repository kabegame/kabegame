/**
 * P10b 步骤 2：脚本侧的 `getAnimation`（图层 / effect / 材质 / general / `thisScene`）与 `IAnimation` 包装对象。落点用真的
 * `SceneAnimations.control`，realm 用不碰 DOM 的假 realm（同 `api.test.ts` 的写法，另给 `SyntaxError`）。
 */
import { describe, expect, it } from "vitest";
import { SceneAnimations } from "../animation/player";
import type { SceneAnimation } from "../animation/types";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import type { ScriptRealm } from "./runtime";

class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array, SyntaxError };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async importModule(): Promise<Record<string, unknown>> {
    return {};
  }
  dispose() {}
}

function layer(object: number): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `L${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
  } as unknown as SceneLayer;
}

const CLOCK = { fps: 10, length: 100, mode: 0 as const, startpaused: false };
const PASS = "objects/0/effects/0/passes/0";

/** 一条动画：`owner` 默认是 `id` 去掉最后一段，`object` 取 `objects/<n>` 里的 n（general 为 null）。 */
function anim(id: string, extra: Partial<SceneAnimation> = {}): SceneAnimation {
  const owner = id.slice(0, id.lastIndexOf("/"));
  const match = /^objects\/(\d+)/.exec(id);
  return {
    id,
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    channels: [],
    clock: CLOCK,
    parent: null,
    events: [],
    writes: false,
    name: "",
    object: match ? Number(match[1]) : null,
    owner,
    inert: false,
    ...extra,
  };
}

const constant = (uniforms: string[]): SceneAnimation["target"] => ({
  kind: "constant",
  pass: PASS,
  material: "multiply",
  uniforms,
  type: "float",
});

function script(id: string, owner: SceneScript["owner"], layerIndex: number | null): SceneScript {
  return {
    id,
    source: "",
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    initial: 1,
    owner,
    layer: layerIndex,
    scriptProperties: null,
    imports: [],
    errors: [],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

function setup(list: SceneAnimation[], options: { player?: boolean } = {}) {
  const realm = new FakeRealm();
  const bundle = {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
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
    layers: [layer(0), layer(1)],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: list,
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const h = {
    realm,
    player: options.player === false ? null : new SceneAnimations(list),
    api: null as unknown as ScriptApi,
    /** 以某段脚本的身份读 `thisObject`。 */
    object(current: SceneScript | null): Api {
      h.api.enterScript(current);
      return realm.global.thisObject as Api;
    },
    scene: () => h.api.thisScene as Api,
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: () => true,
    animation: (id) => h.player?.control(id) ?? null,
  });
  return h;
}

const layerScript = (prop = "alpha", object = 0) =>
  script(`objects/${object}/${prop}`, { kind: "layer", object }, object);

describe("getAnimation 的查找（P10b 步骤 2）", () => {
  it("对象上只在自己的属主里找：图层找不到 effect 常量上的，材质脚本找得到自己的（不是按图层找）", () => {
    const h = setup([
      anim("objects/0/alpha", { name: "Fade" }),
      anim(`${PASS}/constantshadervalues/multiply`, { target: constant(["g_Multiply"]), object: 0 }),
    ]);
    const onLayer = h.object(layerScript("origin"));
    expect(onLayer.getAnimation("multiply")).toBeUndefined();
    expect((onLayer.getAnimation("Fade") as Api).name).toBe("Fade");
    const material = h.object(
      script(`${PASS}/constantshadervalues/multiply`, { kind: "material", pass: PASS, layer: 0 }, 0),
    );
    // 不带参数：取脚本所挂属性（multiply）
    expect(material.getAnimation()).toBeDefined();
    expect(material.getAnimation("alpha")).toBeUndefined();
    // 别的图层上的同名属性动画也不在范围内
    const other = setup([anim("objects/1/alpha", { name: "Other" })]);
    expect(other.object(layerScript("alpha", 0)).getAnimation("Other")).toBeUndefined();
    expect(other.object(layerScript("alpha", 1)).getAnimation("Other")).toBeDefined();
  });

  it("按 options.name 或属性名找；不带参数取当前脚本所挂属性的名字", () => {
    const h = setup([anim("objects/0/alpha", { name: "Fade" }), anim("objects/0/scale")]);
    const onAlpha = h.object(layerScript("alpha"));
    const byName = onAlpha.getAnimation("Fade");
    expect(byName).toBeDefined();
    expect(onAlpha.getAnimation("alpha")).toBe(byName);
    expect(onAlpha.getAnimation()).toBe(byName);
    // 挂在 scale 上的脚本不带参数：找 scale 的那条，不是 alpha 的
    const onScale = h.object(layerScript("scale"));
    const scale = onScale.getAnimation() as Api;
    expect(scale).toBeDefined();
    expect(scale).not.toBe(byName);
    // 挂在 origin 上、没有 origin 的动画：undefined
    expect(h.object(layerScript("origin")).getAnimation()).toBeUndefined();
    expect(onAlpha.getAnimation("nothing")).toBeUndefined();
  });

  it("空串与非字符串参数都当作没给，取当前脚本的属性名；没有当前脚本时是空串", () => {
    const h = setup([anim("objects/0/alpha", { name: "Fade" }), anim("objects/0/scale", { name: "" })]);
    const onAlpha = h.object(layerScript("alpha"));
    const expected = onAlpha.getAnimation();
    expect(expected).toBeDefined();
    for (const value of ["", 5, null, undefined, {}, true]) expect(onAlpha.getAnimation(value)).toBe(expected);
    // 没有当前脚本（thisObject 是 null，直接用 general 上的方法）：名字是空串，匹配 name 为空的 scale 动画？general 属主的才算
    h.api.enterScript(null);
    const general = h.api.general as Api;
    expect(general.getAnimation()).toBeUndefined();
    // 有一条 general 属主、name 为空串的动画时，空串取到它
    const g = setup([anim("general/bloomstrength")]);
    g.api.enterScript(null);
    expect(((g.api.general as Api).getAnimation as () => unknown)()).toBeDefined();
  });

  it("惰性（丢弃）的找得到；没有 uniform 的常量找不到；同名取登记顺序里的第一条", () => {
    const h = setup([
      anim("objects/0/alpha", { name: "dup", inert: true }),
      anim("objects/0/scale", { name: "dup" }),
      anim(`${PASS}/constantshadervalues/multiply`, { name: "const", target: constant([]), object: 0 }),
    ]);
    const onLayer = h.object(layerScript("origin"));
    const first = onLayer.getAnimation("dup") as Api;
    expect(first).toBe(h.object(layerScript("alpha")).getAnimation());
    expect(first.fps).toBe(1); // 惰性的那条（Q7）
    const material = h.object(
      script(`${PASS}/constantshadervalues/multiply`, { kind: "material", pass: PASS, layer: 0 }, 0),
    );
    expect(material.getAnimation()).toBeUndefined();
    expect(material.getAnimation("const")).toBeUndefined();
  });

  it("effect 与 general 的属主", () => {
    const h = setup([anim("objects/0/effects/1/visible", { target: { kind: "effect", object: 0, effect: 1 } })]);
    const effect = h.object(script("objects/0/effects/1/visible", { kind: "effect", object: 0, effect: 1 }, 0));
    expect(effect.getAnimation()).toBeDefined();
    // 同一图层的另一个 effect、图层本身都找不到它
    const other = h.object(script("objects/0/effects/0/visible", { kind: "effect", object: 0, effect: 0 }, 0));
    expect(other.getAnimation("visible")).toBeUndefined();
    expect(h.object(layerScript("alpha")).getAnimation("visible")).toBeUndefined();
    const g = setup([anim("general/bloomstrength")]);
    const onGeneral = g.object(script("general/bloomstrength", { kind: "general" }, null));
    expect(onGeneral.getAnimation()).toBeDefined();
  });

  it("thisScene：全场景按名字找第一条，不看属主；不带参数 / 非字符串 / 找不到都是 null；空串匹配第一条没写 name 的", () => {
    const h = setup([
      anim("objects/0/alpha", { name: "" }),
      anim("objects/1/scale", { name: "Spin" }),
      anim(`${PASS}/constantshadervalues/multiply`, { target: constant([]), name: "Hidden", object: 0 }),
      anim("objects/1/alpha", { name: "Spin" }),
    ]);
    const scene = h.scene();
    expect(scene.getAnimation()).toBeNull();
    for (const value of [5, null, undefined, {}, true]) expect(scene.getAnimation(value)).toBeNull();
    expect(scene.getAnimation("nothing")).toBeNull();
    expect(scene.getAnimation("Hidden")).toBeNull(); // 没有 uniform 的常量
    const spin = scene.getAnimation("Spin") as Api;
    expect(spin).toBe(h.object(layerScript("scale", 1)).getAnimation());
    // 空串：第一条 name 为空串的（objects/0/alpha）；属性名为空串的不存在
    expect(scene.getAnimation("")).toBe(h.object(layerScript("alpha", 0)).getAnimation());
    // 属性名也认
    expect(scene.getAnimation("scale")).toBe(spin);
  });

  it("模块求值期间调用（对象上与 thisScene 上）抛 realm 的 SyntaxError，消息同 WPE", () => {
    const h = setup([anim("objects/0/alpha")]);
    const onLayer = h.object(layerScript());
    h.api.setModuleEvaluating(true);
    for (const call of [
      () => onLayer.getAnimation(),
      () => h.scene().getAnimation("x"),
      () => h.scene().getAnimation(),
    ]) {
      expect(call).toThrow(SyntaxError);
      expect(call).toThrow("getAnimation cannot be called from global scope.");
    }
    h.api.setModuleEvaluating(false);
    expect(onLayer.getAnimation()).toBeDefined();
  });
});

describe("IAnimation 包装对象（P10b 步骤 2）", () => {
  const list = () => [anim("objects/0/alpha", { name: "Fade" })];
  const wrapper = (h: ReturnType<typeof setup>) => h.object(layerScript()).getAnimation() as Api;

  it("12 个自有可枚举成员，顺序照 WPE；同一条每次是同一个对象", () => {
    const h = setup(list());
    const a = wrapper(h);
    expect(Object.keys(a)).toEqual([
      ...["name", "frameCount", "duration", "fps", "rate"],
      ...["play", "isPlaying", "stop", "pause", "setFrame", "getFrame", "getAnimation"],
    ]);
    expect(wrapper(h)).toBe(a);
    expect(h.scene().getAnimation("Fade")).toBe(a);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(a.getAnimation()).toBeUndefined();
  });

  it("只读成员取这一条时钟的值；严格模式下赋值抛 TypeError、值不变", () => {
    const h = setup(list());
    const a = wrapper(h);
    expect([a.name, a.frameCount, a.duration, a.fps]).toEqual(["Fade", 100, 10, 10]);
    for (const key of ["name", "frameCount", "duration", "fps"]) {
      expect(() => {
        (a as Record<string, unknown>)[key] = 7;
      }, key).toThrow(TypeError);
    }
    expect([a.name, a.frameCount, a.duration, a.fps]).toEqual(["Fade", 100, 10, 10]);
  });

  it("rate 只收数字（NaN 也收，转 float32），别的类型忽略", () => {
    const h = setup(list());
    const a = wrapper(h);
    expect(a.rate).toBe(1);
    a.rate = 2;
    expect(a.rate).toBe(2);
    for (const value of ["3", { x: 3 }, true, null, undefined, [4]]) {
      a.rate = value;
      expect(a.rate, String(JSON.stringify(value))).toBe(2);
    }
    a.rate = 0.1;
    expect(a.rate).toBe(Math.fround(0.1));
    a.rate = Number.NaN;
    expect(a.rate).toBeNaN();
    // 落在播放器的这一条上（跨重编译由 carryOver 接）
    expect(h.player!.control("objects/0/alpha")!.rate).toBeNaN();
  });

  it("方法落到 AnimationControl：play / pause / stop / isPlaying / setFrame / getFrame", () => {
    const h = setup([anim("objects/0/alpha", { name: "Fade", clock: { ...CLOCK, startpaused: true } })]);
    const a = wrapper(h);
    const control = h.player!.control("objects/0/alpha")!;
    expect(a.isPlaying()).toBe(false);
    a.play();
    expect(control.isPlaying()).toBe(true);
    expect(a.isPlaying()).toBe(true);
    a.pause();
    expect(a.isPlaying()).toBe(false);
    a.setFrame(5);
    expect(a.getFrame()).toBeCloseTo(5, 4);
    expect(control.getFrame()).toBeCloseTo(5, 4);
    a.play();
    a.stop();
    expect(a.isPlaying()).toBe(false);
    expect(a.getFrame()).toBe(0);
  });

  it("setFrame 的参数不是数字时按 0", () => {
    const h = setup(list());
    const a = wrapper(h);
    for (const value of ["30", undefined, null, {}, true]) {
      a.setFrame(40);
      expect(a.getFrame()).toBeGreaterThan(39);
      a.setFrame(value);
      expect(a.getFrame(), String(JSON.stringify(value))).toBe(0);
    }
    a.setFrame();
    expect(a.getFrame()).toBe(0);
  });

  it("没有落点时：方法空操作、isPlaying 假、getFrame 0、rate 读 1 且写入无效；只读成员取定义算出的值", () => {
    const h = setup(list(), { player: false });
    const a = wrapper(h);
    expect([a.name, a.frameCount, a.duration, a.fps]).toEqual(["Fade", 100, 10, 10]);
    a.play();
    a.pause();
    a.stop();
    a.setFrame(5);
    expect(a.isPlaying()).toBe(false);
    expect(a.getFrame()).toBe(0);
    a.rate = 3;
    expect(a.rate).toBe(1);
    // 惰性的：fps 1、duration 0
    const inert = setup([anim("objects/0/alpha", { inert: true })], { player: false });
    const b = wrapper(inert);
    expect([b.fps, b.duration]).toEqual([1, 0]);
  });

  it("每次调用现取落点：换了播放器（重编译）仍控制同一条", () => {
    const h = setup(list());
    const a = wrapper(h);
    a.rate = 2;
    const next = new SceneAnimations(list());
    next.carryOver(h.player);
    h.player = next;
    expect(a.rate).toBe(2);
    a.pause();
    expect(next.control("objects/0/alpha")!.isPlaying()).toBe(false);
    expect(wrapper(h)).toBe(a);
  });
});
