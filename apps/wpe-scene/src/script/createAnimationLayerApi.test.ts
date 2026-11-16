/**
 * P12e-2：脚本侧的运行时建删动画层（`createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`）：初值与包装同一性、返回 `null` 的各种情形、
 * `destroyAnimationLayer` 的参数与返回值、包装作废（读 `undefined`、写忽略、方法 `undefined`、`isObjectValid` 假）、动画层字段脚本在层释放时收 `destroy`。
 * 落点用真的 `ScenePuppets`，realm 用不碰 DOM 的假 realm（同 `animationLayerApi.test.ts`）；WPE 日志的逐帧比对见 `puppet/p12create.test.ts`。
 * 对照表行：6、9、19、25、28、29、31。
 */
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { PuppetAnimation, PuppetLayerDef } from "../compile/puppet";
import type { SceneScript } from "../compile/scripts";
import { ScenePuppets, stateSink, type PuppetHooks, type PuppetRig } from "../puppet/player";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import { ScriptRuntime, type ScriptRealm } from "./runtime";
import { readScriptState, writeScriptState } from "./stateWrite";
import type { ScriptTarget, ScriptValue } from "./runtime";

class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array, SyntaxError, Function };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown>>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(_source: string, label: string): Promise<ScriptModule> {
    return fakeModule(this.modules.get(label) ?? {});
  }
  dispose() {}
}

/** 动画：每秒 10 帧，第 k 帧平移 x = 10k；id 900 loop、901 single（1.5 s）、902 mirror、903 与 904 同名、905 用到不支持的特性。 */
function animation(
  id: number,
  name: string,
  mode: 0 | 1 | 2,
  length = 10,
  extra: Partial<PuppetAnimation> = {},
): PuppetAnimation {
  const frames = new Float32Array((length + 1) * 10);
  for (let k = 0; k <= length; k++) frames.set([10 * k, 0, 0, 1, 0, 0, 0, 1, 1, 1], k * 10);
  return {
    id,
    name,
    mode,
    fps: 10,
    length,
    mask: new Uint8Array([1]),
    frames,
    alpha: null,
    alphaMask: new Uint8Array(0),
    morph: null,
    events: [],
    ...extra,
  };
}

function def(index: number, extra: Partial<PuppetLayerDef> = {}): PuppetLayerDef {
  return {
    animation: 0,
    entry: index,
    name: `L${index}`,
    rate: 1,
    blend: 1,
    visible: true,
    additive: false,
    blendin: false,
    blendout: false,
    blendtime: 0.5,
    bindings: [],
    ...extra,
  };
}

function rig(layers: PuppetLayerDef[], skinned = true): PuppetRig {
  return {
    skeleton: skinned
      ? {
          parents: new Int32Array([-1]),
          inverseBind: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          rest: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1, 1]),
          restMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        }
      : null,
    animations: [
      animation(900, "loopA", 0),
      animation(901, "singleB", 2, 15),
      animation(902, "mirrorC", 1, 20),
      animation(903, "dup", 0, 10),
      animation(904, "dup", 0, 12),
      animation(905, "broken", 0, 10, { unsupported: ["mdl:animation:tracks"] }),
    ],
    layers,
    boneAlpha: false,
  };
}

function layer(object: number, puppet: PuppetRig | null = null): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `O${object}`,
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
    effects: [],
    passes: [],
    particle: null,
    puppet,
  } as unknown as SceneLayer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

/**
 * 对象 0 与 1 是两个骨骼 puppet（各有层 id 0，分别叫 a / b），2 是静态 puppet（没有骨骼），3 是普通图层；
 * `hosted: false` 时不给宿主视图（语料诊断）。
 */
function setup(options: { hosted?: boolean } = {}) {
  const realm = new FakeRealm();
  const rig0 = rig([def(0, { name: "a" })]);
  const rig1 = rig([def(0, { name: "b" })]);
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
    programs: [],
    textures: [],
    bloom: null,
    layers: [layer(0, rig0), layer(1, rig1), layer(2, rig([def(0)], false)), layer(3)],
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: [],
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const puppets = new ScenePuppets([
    { object: 0, puppet: rig0 },
    { object: 1, puppet: rig1 },
  ]);
  const warnings: string[] = [];
  const released: [number, number][] = [];
  const hooks: PuppetHooks = {
    released: (object, id) => {
      released.push([object, id]);
      state.removeAnimationLayer(object, id);
    },
  };
  const h = {
    realm,
    puppets,
    state,
    warnings,
    released,
    hooks,
    api: null as unknown as ScriptApi,
    layer: (object: number) => h.api.layer(object) as Api,
    engine: () => realm.global.engine as Api,
    /** 推进一帧（puppet 先走，释放走 `hooks`）。 */
    step: (dt: number) => puppets.frame(dt, stateSink(state), hooks),
    /** 脚本阶段之后的释放（宿主 `beforeFrame` 末尾）。 */
    settle: () => puppets.settle(hooks),
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    warn: (message) => warnings.push(message),
    write: (target, value) => writeScriptState(state, target as ScriptTarget, value as ScriptValue) === "applied",
    read: (target) => readScriptState(state, target as ScriptTarget),
    ...(options.hosted === false
      ? {}
      : {
          puppetLayers: (object: number) => ({
            ids: () => puppets.ids(object),
            find: (name: string) => puppets.findLayer(object, name),
            control: (id: number) => puppets.control(object, id),
            alive: (id: number) => puppets.alive(object, id),
            animations: () => puppets.rig(object)?.animations ?? [],
            create: (item, single) => puppets.createLayer(object, item, single),
            destroy: (selector) => puppets.destroyLayers(object, selector),
          }),
        }),
  });
  return h;
}

describe("createAnimationLayer：初值与包装（对照表 6、9）", () => {
  it("字符串按名字建层：名字空串、rate 1、blend 1、visible、blendin 缺省补的 true、在播放、getFrame 为 0；id 读 undefined", () => {
    const h = setup();
    const created = h.layer(0).createAnimationLayer("loopA") as Api;
    expect(created).not.toBeNull();
    expect([created.name, created.rate, created.blend, created.visible, created.additive]).toEqual([
      "",
      1,
      1,
      true,
      false,
    ]);
    // loop 动画：缺省补的 blendout 被清掉（非 single）；blendin 保留
    expect([created.blendin, created.blendout, created.blendtime]).toEqual([true, false, 0.5]);
    expect([created.fps, created.frameCount, created.duration]).toEqual([10, 10, 1]);
    expect(created.isPlaying()).toBe(true);
    expect(created.getFrame()).toBe(0);
    expect(created.id).toBeUndefined();
    expect(h.layer(0).getAnimationLayerCount()).toBe(2);
    expect(h.engine().isObjectValid(created)).toBe(true);
    // single 动画保留 blendout
    const single = h.layer(0).createAnimationLayer("singleB") as Api;
    expect(single.blendout).toBe(true);
    expect([single.frameCount, single.duration]).toEqual([15, 1.5]);
  });

  it("返回的包装与之后 getAnimationLayer(count − 1)、按名字找到的是同一个对象", () => {
    const h = setup();
    const created = h.layer(0).createAnimationLayer("loopA", { name: "n" }) as Api;
    const count = h.layer(0).getAnimationLayerCount();
    expect(h.layer(0).getAnimationLayer(count - 1)).toBe(created);
    expect(h.layer(0).getAnimationLayer("n")).toBe(created);
    expect(h.layer(0).getAnimationLayer("")).toBeNull();
  });

  it("三方共写的字段（rate / blend / visible）写进状态；config 的取值经 JSON setter", () => {
    const h = setup();
    const created = h.layer(0).createAnimationLayer("loopA", { rate: 2, blend: 0.5, visible: false, name: "x" }) as Api;
    const fields = h.state.animationLayers.get("0:-1");
    expect(fields).toEqual({ rate: 2, blend: 0.5, visible: false });
    expect([created.rate, created.blend, created.visible, created.name]).toEqual([2, 0.5, false, "x"]);
    // 脚本写 rate 走同一个状态项
    created.rate = 3;
    expect(h.state.animationLayers.get("0:-1")!.rate).toBe(3);
    // 不合规的取值不写
    const bad = h.layer(0).createAnimationLayer("loopA", { rate: "3", blend: true, visible: 0, name: 5 }) as Api;
    expect([bad.rate, bad.blend, bad.visible, bad.name]).toEqual([1, 1, true, ""]);
  });

  it("参数是对象（animation 为 id）、dup 取第一条、config 覆盖第一参", () => {
    const h = setup();
    expect((h.layer(0).createAnimationLayer({ animation: 900.5 }) as Api).frameCount).toBe(10);
    expect((h.layer(0).createAnimationLayer("dup") as Api).frameCount).toBe(10);
    expect((h.layer(0).createAnimationLayer({ animation: 900, blendin: false }) as Api).blendin).toBe(true);
    expect((h.layer(0).createAnimationLayer({ animation: 900 }, { blendin: false }) as Api).blendin).toBe(false);
  });

  it("insert：index 0 插到最前；每个 puppet 的层 id 各自递减", () => {
    const h = setup();
    const first = h.layer(0).createAnimationLayer("loopA", { index: 0, name: "front" }) as Api;
    expect(h.layer(0).getAnimationLayer(0)).toBe(first);
    expect(h.puppets.ids(0)).toEqual([-1, 0]);
    h.layer(1).createAnimationLayer("loopA");
    expect(h.puppets.ids(1)).toEqual([0, -1]);
  });
});

describe("createAnimationLayer / playSingleAnimation 返回 null 的情形（对照表 1、29、31）", () => {
  it("找不到、大小写不对、非字符串非对象、不支持的动画：null；不支持的另 warn", () => {
    const h = setup();
    const create = h.layer(0).createAnimationLayer as (...a: unknown[]) => unknown;
    for (const bad of [
      "loopa",
      "nosuch",
      5,
      0,
      true,
      "",
      null,
      undefined,
      { animation: "loopA" },
      { animation: 12345 },
    ])
      expect(create(bad), String(bad)).toBeNull();
    expect(create()).toBeNull();
    expect(h.puppets.ids(0)).toEqual([0]);
    expect(h.warnings).toEqual([]);
    expect(create("broken")).toBeNull();
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("broken");
    expect(h.puppets.ids(0)).toEqual([0]);
  });

  it("config 解析成非对象：null 并 warn", () => {
    const h = setup();
    expect(h.layer(0).createAnimationLayer("loopA", "5")).toBeNull();
    expect(h.warnings.length).toBe(1);
  });

  it("非 puppet 的图层、静态 puppet（另 warn）、没有宿主视图：null", () => {
    const h = setup();
    expect(h.layer(3).createAnimationLayer("loopA")).toBeNull();
    expect(h.warnings).toEqual([]);
    expect(h.layer(2).createAnimationLayer("loopA")).toBeNull();
    expect(h.warnings.length).toBe(1);
    expect(h.layer(2).getAnimationLayerCount()).toBe(0);
    const bare = setup({ hosted: false });
    expect(bare.layer(0).createAnimationLayer("loopA")).toBeNull();
    expect(bare.layer(0).playSingleAnimation("loopA")).toBeNull();
    expect(bare.layer(0).destroyAnimationLayer(0)).toBe(false);
  });
});

describe("playSingleAnimation：播完即删（对照表 13、15）", () => {
  it("single 到头那一帧调回调（层有效、计数未减），帧末当场释放；之后包装作废、计数已减", () => {
    const h = setup();
    const created = h.layer(0).playSingleAnimation("singleB") as Api;
    const seen: string[] = [];
    const tl = h.layer(0);
    // 包装的 `addEndedCallback` 经脚本运行时 `callFor` 进入登记它的脚本（这里没有运行时）：直接登记到控制口，回调里读包装的有效性与计数
    h.puppets
      .control(0, -1)!
      .addEndedCallback(() =>
        seen.push(`ctl valid=${h.engine().isObjectValid(created)} count=${tl.getAnimationLayerCount()}`),
      );
    h.step(1.4);
    expect(h.puppets.alive(0, -1)).toBe(true);
    h.step(0.2);
    expect(seen).toEqual(["ctl valid=true count=2"]);
    expect(h.released).toEqual([[0, -1]]);
    expect(tl.getAnimationLayerCount()).toBe(1);
    expect(h.engine().isObjectValid(created)).toBe(false);
    expect(created.rate).toBeUndefined();
    expect(h.state.animationLayers.has("0:-1")).toBe(false);
  });
});

describe("destroyAnimationLayer（对照表 19、20）", () => {
  /** 对象 0 上依次有 a（id 0）、A、B、x、x、tail（id −1 … −5，名字如各自）。 */
  function layered() {
    const h = setup();
    const tl = h.layer(0);
    const make = (name: string, animation = "loopA") => tl.createAnimationLayer(animation, { name }) as Api;
    return {
      h,
      tl,
      A: make("A"),
      B: make("B", "singleB"),
      x1: make("x"),
      x2: make("x", "singleB"),
      tail: make("tail"),
    };
  }

  it("下标：0 ≤ i < 层数；−1、99、1.5、−0 是 false；摘表当场（计数、下标、名字查找立刻看不到），同帧包装仍可读写、调方法", () => {
    const { h, tl, A } = layered();
    expect(tl.getAnimationLayerCount()).toBe(6);
    for (const bad of [-1, 99, 6, 1.5, -0, NaN, Infinity, 2 ** 31])
      expect(tl.destroyAnimationLayer(bad), String(bad)).toBe(false);
    expect(tl.getAnimationLayerCount()).toBe(6);
    expect(tl.destroyAnimationLayer(1)).toBe(true);
    expect(tl.getAnimationLayerCount()).toBe(5);
    expect(tl.getAnimationLayer("A")).toBeNull();
    expect(tl.getAnimationLayer(1)).not.toBe(A);
    // 摘出还没释放：包装有效、可读可写、方法照调
    expect(h.puppets.detachedCount(0)).toBe(1);
    expect(h.engine().isObjectValid(A)).toBe(true);
    expect(A.rate).toBe(1);
    A.setFrame(3);
    expect(A.getFrame()).toBe(3);
    // 释放之后作废
    h.settle();
    expect(h.puppets.detachedCount(0)).toBe(0);
    expect(h.engine().isObjectValid(A)).toBe(false);
  });

  it("对象：层表里有就删、true；别的 puppet 的层（层 id 同为 0）、已摘出的层（同帧再删）、作废的包装都是 false", () => {
    const { h, tl, A, B } = layered();
    const other = h.layer(1).getAnimationLayer(0) as Api;
    const own = tl.getAnimationLayer(0) as Api;
    // 两个 puppet 的编译期层 id 都是 0：别人的包装传进来不能删掉自己的 id 0 层
    expect(tl.destroyAnimationLayer(other)).toBe(false);
    expect(h.layer(1).getAnimationLayerCount()).toBe(1);
    expect(tl.getAnimationLayerCount()).toBe(6);
    expect(tl.destroyAnimationLayer(A)).toBe(true);
    expect(tl.destroyAnimationLayer(A)).toBe(false);
    h.settle();
    expect(tl.destroyAnimationLayer(A)).toBe(false);
    expect(tl.destroyAnimationLayer(B)).toBe(true);
    expect(tl.destroyAnimationLayer(own)).toBe(true);
    expect(tl.getAnimationLayerCount()).toBe(3);
  });

  it("名字：空串 false；删掉所有同名（相邻两个 x 都删）；大小写不同 false；createAnimationLayer 不给名字时按名字删不掉", () => {
    const { h, tl, x1, x2, tail } = layered();
    const unnamed = tl.createAnimationLayer("loopA") as Api;
    expect(tl.destroyAnimationLayer("")).toBe(false);
    expect(tl.destroyAnimationLayer("X")).toBe(false);
    expect(tl.destroyAnimationLayer("zzz")).toBe(false);
    expect(tl.destroyAnimationLayer("x")).toBe(true);
    expect(tl.getAnimationLayerCount()).toBe(5);
    expect(tl.getAnimationLayer("x")).toBeNull();
    expect(h.engine().isObjectValid(x1) && h.engine().isObjectValid(x2)).toBe(true);
    h.settle();
    expect(h.engine().isObjectValid(x1) || h.engine().isObjectValid(x2)).toBe(false);
    expect(h.engine().isObjectValid(tail)).toBe(true);
    expect(h.engine().isObjectValid(unnamed)).toBe(true);
  });

  it("末尾同名也删（图像层在最后一层匹配时 WPE 崩溃，我们照删，有意不同）", () => {
    const { tl } = layered();
    expect(tl.destroyAnimationLayer("tail")).toBe(true);
    expect(tl.getAnimationLayerCount()).toBe(5);
  });

  it("其余参数 false：{}、null、'1' 之外的字符串名、undefined、布尔、普通对象、数组", () => {
    const { tl } = layered();
    for (const bad of [{}, null, undefined, true, [0], () => 0])
      expect(tl.destroyAnimationLayer(bad), String(bad)).toBe(false);
    // '1' 是名字，没有叫 "1" 的层
    expect(tl.destroyAnimationLayer("1")).toBe(false);
    expect(tl.getAnimationLayerCount()).toBe(6);
    expect(tl.destroyAnimationLayer()).toBe(false);
  });

  it("非 puppet 与静态 puppet 上 false", () => {
    const h = setup();
    expect(h.layer(3).destroyAnimationLayer(0)).toBe(false);
    expect(h.layer(2).destroyAnimationLayer("a")).toBe(false);
  });
});

describe("作废的包装（对照表 25）", () => {
  function dead() {
    const h = setup();
    const tl = h.layer(0);
    const created = tl.createAnimationLayer("loopA", { name: "gone" }) as Api;
    expect(tl.destroyAnimationLayer(created)).toBe(true);
    h.settle();
    return { h, tl, created };
  }

  it("读字段 undefined（含只读三项），写入忽略（含只读三项，不抛错）", () => {
    const { created, h } = dead();
    for (const key of [
      "name",
      "rate",
      "blend",
      "visible",
      "additive",
      "blendin",
      "blendout",
      "blendtime",
      "duration",
      "frameCount",
      "fps",
    ])
      expect(created[key], key).toBeUndefined();
    created.rate = 5;
    created.name = "again";
    created.fps = 99;
    expect(created.rate).toBeUndefined();
    expect(h.state.animationLayers.has("0:-1")).toBe(false);
  });

  it("方法返回 undefined 且不抛错（含 addEndedCallback 的非函数参数）；不再影响层表", () => {
    const { created, tl } = dead();
    for (const name of ["play", "pause", "stop", "isPlaying", "getFrame", "getAnimation"])
      expect(created[name](), name).toBeUndefined();
    expect(created.setFrame(3)).toBeUndefined();
    expect(created.addEndedCallback(() => 1)).toBeUndefined();
    expect(() => created.addEndedCallback(5)).not.toThrow();
    expect(tl.getAnimationLayerCount()).toBe(1);
  });

  it("engine.isObjectValid 为假；作参数 destroyAnimationLayer 为 false", () => {
    const { created, h, tl } = dead();
    expect(h.engine().isObjectValid(created)).toBe(false);
    expect(tl.destroyAnimationLayer(created)).toBe(false);
  });

  it("活着的只读三项赋值抛 TypeError，值不变；成员顺序与 P12c 相同（19 个自有可枚举成员）", () => {
    const h = setup();
    const live = h.layer(0).getAnimationLayer(0) as Api;
    for (const key of ["duration", "frameCount", "fps"]) {
      expect(() => {
        "use strict";
        live[key] = 99;
      }, key).toThrow(TypeError);
    }
    expect([live.duration, live.frameCount, live.fps]).toEqual([1, 10, 10]);
    const keys: string[] = [];
    for (const key in live) keys.push(key);
    expect(keys.length).toBe(19);
    expect(keys.slice(0, 3)).toEqual(["duration", "frameCount", "fps"]);
  });

  it("isObjectValid：编译期层的包装、普通对象、undefined 的结果", () => {
    const h = setup();
    expect(h.engine().isObjectValid(h.layer(0).getAnimationLayer(0))).toBe(true);
    expect(h.engine().isObjectValid({})).toBe(false);
    expect(h.engine().isObjectValid(undefined)).toBe(false);
  });
});

describe("动画层字段脚本的 destroy 与重放表（对照表 28）", () => {
  const script = (id: string, object: number, layerId: number): SceneScript =>
    ({
      id,
      source: "",
      target: { kind: "animation-layer", object, layer: layerId, field: "rate" },
      valueType: "float",
      initial: 1,
      owner: { kind: "animation-layer", object, entry: layerId, layer: layerId },
      layer: object,
      scriptProperties: null,
      imports: [],
      errors: [],
    }) as unknown as SceneScript;

  it("destroyAnimationLayer(object, id)：属主是这个层的字段脚本收 destroy 后摘掉；别的层与别的对象的脚本不动；重放表里它的项去掉", async () => {
    const realm = new FakeRealm();
    const events: string[] = [];
    const runtime = new ScriptRuntime(realm, {
      report: { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} },
      write: () => true,
      read: () => null,
    });
    const list = [
      script("objects/0/animationlayers/0/rate", 0, 0),
      script("objects/0/animationlayers/1/rate", 0, 1),
      script("objects/1/animationlayers/0/rate", 1, 0),
    ];
    for (const item of list)
      realm.modules.set(item.id, { update: () => 1, destroy: () => void events.push(`destroy:${item.id}`) });
    await runtime.load({ list } as never);
    const target = (object: number, layer: number): ScriptTarget =>
      ({ kind: "animation-layer", object, layer, field: "rate" }) as ScriptTarget;
    runtime.rememberWrite(target(0, 0), [2]);
    runtime.rememberWrite(target(0, 1), [3]);
    runtime.rememberWrite(target(1, 0), [4]);
    runtime.destroyAnimationLayer(0, 0);
    expect(events).toEqual(["destroy:objects/0/animationlayers/0/rate"]);
    expect((runtime.diagnostics as { id: string }[]).map((entry) => entry.id)).toEqual([
      "objects/0/animationlayers/1/rate",
      "objects/1/animationlayers/0/rate",
    ]);
    expect(runtime.hasWrite("objects/0/animationlayers/0/rate")).toBe(false);
    expect(runtime.hasWrite("objects/0/animationlayers/1/rate")).toBe(true);
    expect(runtime.hasWrite("objects/1/animationlayers/0/rate")).toBe(true);
    // 运行时建的层（负 id）没有字段脚本，只清重放表；再调一次什么都不发生
    runtime.rememberWrite(target(0, -1), [5]);
    runtime.destroyAnimationLayer(0, -1);
    runtime.destroyAnimationLayer(0, 0);
    expect(events.length).toBe(1);
    expect(runtime.hasWrite("objects/0/animationlayers/-1/rate")).toBe(false);
  });
});
