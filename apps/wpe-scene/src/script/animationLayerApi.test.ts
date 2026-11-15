/**
 * P12c-2：脚本侧的动画层 API（`getAnimationLayerCount` / `getAnimationLayer`、`IAnimationLayer` 包装对象、动画层字段脚本的 `thisObject`）。
 * 落点用真的 `ScenePuppets`，realm 用不碰 DOM 的假 realm（同 `animationApi.test.ts`）；WPE 日志的逐帧比对见 `puppet/p12script.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { PuppetAnimation, PuppetLayerDef } from "../compile/puppet";
import type { SceneScript } from "../compile/scripts";
import { ScenePuppets, type PuppetRig } from "../puppet/player";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import { readScriptState, writeScriptState } from "./stateWrite";
import { ScriptRuntime, type ScriptRealm, type ScriptTarget, type ScriptValue } from "./runtime";

class Vec {
  constructor(..._values: number[]) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array, SyntaxError, Function };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown>>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    return this.modules.get(label) ?? {};
  }
  dispose() {}
}

function animation(mode: 0 | 1 | 2, extra: Partial<PuppetAnimation> = {}): PuppetAnimation {
  const length = 10;
  const frames = new Float32Array((length + 1) * 10);
  for (let k = 0; k <= length; k++) frames.set([0, 0, 0, 1, 0, 0, 0, 1, 1, 1], k * 10);
  return {
    id: 1,
    name: "a",
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
    animations: [animation(0)],
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

const script = (id: string, owner: SceneScript["owner"], layerIndex: number | null): SceneScript => ({
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
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

/** 对象 0 是 puppet（三层：a、b、b 重名），对象 1 是普通图层，对象 2 是静态 puppet（没有骨骼）；`hosted: false` 时不给宿主视图（语料诊断）。 */
function setup(options: { hosted?: boolean } = {}) {
  const realm = new FakeRealm();
  const puppetRig = rig([def(0, { name: "a" }), def(1, { name: "b" }), def(2, { name: "b", rate: 2 })]);
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
    layers: [layer(0, puppetRig), layer(1), layer(2, rig([def(0)], false))],
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: [],
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const puppets = new ScenePuppets([{ object: 0, puppet: puppetRig }]);
  const writes: { target: ScriptTarget; value: unknown }[] = [];
  const h = {
    realm,
    puppets,
    state,
    writes,
    api: null as unknown as ScriptApi,
    layer: (object: number) => h.api.layer(object) as Api,
    /** 以某段脚本的身份读 `thisObject` / `thisLayer`。 */
    as(current: SceneScript | null) {
      h.api.enterScript(current);
      return { object: realm.global.thisObject as Api, layer: realm.global.thisLayer as Api };
    },
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: (target, value) => {
      writes.push({ target, value });
      return writeScriptState(state, target as ScriptTarget, value as ScriptValue) === "applied";
    },
    ...(options.hosted === false
      ? {}
      : {
          puppetLayers: (object: number) => ({
            count: () => puppets.layerCount(object),
            find: (name: string) => puppets.findLayer(object, name),
            control: (index: number) => puppets.layer(object, index),
          }),
        }),
  });
  return h;
}

describe("getAnimationLayerCount / getAnimationLayer（p12-REPORT 用例 9 的查找表）", () => {
  it("所有图层都有这两个方法；非 puppet 与静态 puppet 计数 0、查找 null", () => {
    const h = setup();
    for (const object of [0, 1, 2]) {
      expect("getAnimationLayerCount" in h.layer(object)).toBe(true);
      expect("getAnimationLayer" in h.layer(object)).toBe(true);
    }
    expect(h.layer(0).getAnimationLayerCount()).toBe(3);
    for (const object of [1, 2]) {
      expect(h.layer(object).getAnimationLayerCount()).toBe(0);
      expect(h.layer(object).getAnimationLayer(0)).toBeNull();
      expect(h.layer(object).getAnimationLayer("a")).toBeNull();
    }
  });

  it("number 只认整数下标；字符串按当前名字找、最后一个匹配；其余一律 null", () => {
    const h = setup();
    const get = h.layer(0).getAnimationLayer as (x?: unknown) => Api | null;
    expect(get(0)!.name).toBe("a");
    expect(get(2)!.name).toBe("b");
    for (const bad of [3, -1, 1.5, NaN, "1", "", "nosuch", "A", null, undefined, {}, true])
      expect(get(bad), String(bad)).toBeNull();
    expect(get()).toBeNull();
    // 同名取最后一个（下标 2，rate 来自定义里的 2 —— 状态里是第三层的值）
    expect(get("b")).toBe(get(2));
    expect(get("b")).not.toBe(get(1));
    // 同一性：下标与名字拿到同一个对象
    expect(get(0)).toBe(get("a"));
    expect(get(0)).toBe(get(0));
  });

  it("没有宿主视图（语料诊断）时按 bundle 的层定义回答：计数、名字查找、只读三项；方法空操作", () => {
    const h = setup({ hosted: false });
    expect(h.layer(0).getAnimationLayerCount()).toBe(3);
    expect(h.layer(1).getAnimationLayerCount()).toBe(0);
    expect(h.layer(2).getAnimationLayerCount()).toBe(0);
    const walk = h.layer(0).getAnimationLayer("b") as Api;
    expect(walk).toBe(h.layer(0).getAnimationLayer(2));
    expect([walk.fps, walk.frameCount, walk.duration]).toEqual([10, 10, 1]);
    walk.play();
    expect(walk.isPlaying()).toBe(false);
    expect(walk.getFrame()).toBe(0);
    walk.name = "renamed";
    expect(h.layer(0).getAnimationLayer("renamed")).toBe(walk);
  });
});

describe("IAnimationLayer 的成员", () => {
  it("19 个自有可枚举成员，顺序照实测；原型只有 constructor", () => {
    const layerApi = setup().layer(0).getAnimationLayer(0) as Api;
    const keys: string[] = [];
    for (const key in layerApi) keys.push(key);
    expect(keys).toEqual([
      "duration",
      "frameCount",
      "fps",
      "blend",
      "name",
      "blendout",
      "blendin",
      "rate",
      "additive",
      "visible",
      "blendtime",
      "addEndedCallback",
      "play",
      "isPlaying",
      "stop",
      "pause",
      "setFrame",
      "getFrame",
      "getAnimation",
    ]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(layerApi))).toEqual(["constructor"]);
    expect(layerApi.id).toBeUndefined();
  });

  it("duration / frameCount / fps 是只读数据属性：严格模式赋值抛 TypeError，值不变", () => {
    const layerApi = setup().layer(0).getAnimationLayer(0) as Api;
    expect([layerApi.duration, layerApi.frameCount, layerApi.fps]).toEqual([1, 10, 10]);
    for (const key of ["duration", "frameCount", "fps"]) {
      expect(() => {
        "use strict";
        layerApi[key] = 99;
      }, key).toThrow(TypeError);
    }
    expect([layerApi.duration, layerApi.frameCount, layerApi.fps]).toEqual([1, 10, 10]);
  });

  it("rate / blend：只收 number（NaN、Infinity 也收，转 float32），别的静默忽略；写进 SceneState，走 animation-layer 目标", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(1) as Api;
    expect([layerApi.rate, layerApi.blend, layerApi.visible]).toEqual([1, 1, true]);
    layerApi.rate = 0.1;
    expect(layerApi.rate).toBe(Math.fround(0.1));
    expect(h.state.animationLayers.get("0:1")!.rate).toBe(Math.fround(0.1));
    expect(h.writes.at(-1)!.target).toEqual({ kind: "animation-layer", object: 0, layer: 1, field: "rate" });
    layerApi.rate = NaN;
    expect(layerApi.rate).toBeNaN();
    layerApi.rate = Infinity;
    expect(layerApi.rate).toBe(Infinity);
    layerApi.blend = 2;
    expect(layerApi.blend).toBe(2);
    layerApi.rate = 3;
    for (const ignored of ["2", true, null, undefined, {}, { x: 5 }, [4]]) {
      layerApi.rate = ignored;
      expect(layerApi.rate, String(ignored)).toBe(3);
    }
    // 别的层不受影响
    expect((h.layer(0).getAnimationLayer(0) as Api).rate).toBe(1);
  });

  it("visible：只收布尔，写进状态；0 / 1 / 字符串 / null 忽略", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    layerApi.visible = false;
    expect(layerApi.visible).toBe(false);
    expect(h.state.animationLayers.get("0:0")!.visible).toBe(false);
    for (const ignored of [1, 0, "true", null, undefined, {}]) {
      layerApi.visible = ignored;
      expect(layerApi.visible, String(ignored)).toBe(false);
    }
    layerApi.visible = true;
    expect(layerApi.visible).toBe(true);
  });

  it("name / additive / blendin / blendout / blendtime 读写控制口：转换照 rea-p12c-script 5", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    // name：null / undefined 忽略，其余 ToString，之后按新名字查；NUL 处截断
    layerApi.name = 5;
    expect(layerApi.name).toBe("5");
    expect(h.layer(0).getAnimationLayer("5")).toBe(layerApi);
    layerApi.name = 1.5;
    expect(layerApi.name).toBe("1.5");
    layerApi.name = true;
    expect(layerApi.name).toBe("true");
    layerApi.name = {};
    expect(layerApi.name).toBe("[object Object]");
    layerApi.name = "keep";
    for (const ignored of [null, undefined]) {
      layerApi.name = ignored;
      expect(layerApi.name).toBe("keep");
    }
    layerApi.name = "a\0b";
    expect(layerApi.name).toBe("a");
    // 三个布尔：只收布尔
    for (const key of ["additive", "blendin", "blendout"]) {
      layerApi[key] = true;
      expect(layerApi[key], key).toBe(true);
      for (const ignored of [0, 1, "false", null, undefined]) {
        layerApi[key] = ignored;
        expect(layerApi[key], `${key}=${String(ignored)}`).toBe(true);
      }
      layerApi[key] = false;
      expect(layerApi[key], key).toBe(false);
    }
    // blendtime：只收 number，float32
    expect(layerApi.blendtime).toBe(0.5);
    layerApi.blendtime = 0.3;
    expect(layerApi.blendtime).toBe(Math.fround(0.3));
    for (const ignored of ["1", true, null, undefined]) {
      layerApi.blendtime = ignored;
      expect(layerApi.blendtime, String(ignored)).toBe(Math.fround(0.3));
    }
  });

  it("方法：play / pause / stop / isPlaying / setFrame / getFrame 转调控制口；setFrame 的参数不是 number 时按 0", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    expect(layerApi.isPlaying()).toBe(true);
    layerApi.pause();
    expect(layerApi.isPlaying()).toBe(false);
    layerApi.setFrame(5);
    expect(layerApi.getFrame()).toBe(5);
    layerApi.setFrame("7");
    expect(layerApi.getFrame()).toBe(0);
    layerApi.play();
    expect(layerApi.isPlaying()).toBe(true);
    layerApi.stop();
    expect(layerApi.isPlaying()).toBe(false);
    expect(layerApi.getAnimation()).toBeUndefined();
  });

  it("包装对象不持有运行时：重编译换了 ScenePuppets 也接得上（每次现取）", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    layerApi.setFrame(4);
    expect(layerApi.getFrame()).toBe(4);
    // 宿主把落点换成另一份运行时
    const other = new ScenePuppets([{ object: 0, puppet: rig([def(0, { name: "a" })]) }]);
    (h.api as unknown as { access: { puppetLayers: unknown } }).access.puppetLayers = (object: number) => ({
      count: () => other.layerCount(object),
      find: (name: string) => other.findLayer(object, name),
      control: (index: number) => other.layer(object, index),
    });
    expect(layerApi.getFrame()).toBe(0);
    layerApi.setFrame(2);
    expect(other.layer(0, 0)!.getFrame()).toBe(2);
  });
});

describe("addEndedCallback", () => {
  it("非函数参数抛 TypeError（WPE 会存空指针、播完时崩溃，有意不同）", () => {
    const layerApi = setup().layer(0).getAnimationLayer(0) as Api;
    for (const bad of [123, "x", null, undefined, {}])
      expect(() => layerApi.addEndedCallback(bad), String(bad)).toThrow(TypeError);
    expect(() => layerApi.addEndedCallback()).toThrow(TypeError);
  });

  it("播完时经运行时进入登记它的脚本：this 是那段脚本的模块命名空间、不带参数；出错只记诊断、不影响别的回调", async () => {
    const h = setup();
    const seen: unknown[] = [];
    const exportsOfA = { marker: "A", init() {} };
    h.realm.modules.set("a", exportsOfA);
    const runtime = new ScriptRuntime(h.realm, {
      report: { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} },
      write: () => true,
      read: () => null,
      enterScript: (current) => h.api.enterScript(current),
    });
    h.api.attachRuntime(runtime);
    await runtime.load({ list: [script("a", { kind: "layer", object: 0 }, 0)] });
    h.api.enterScript(script("a", { kind: "layer", object: 0 }, 0));
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    layerApi.addEndedCallback(function (this: unknown, ...args: unknown[]) {
      seen.push([this, args.length, (h.realm.global.thisLayer as Api).name]);
      throw new Error("回调出错");
    });
    layerApi.addEndedCallback(() => seen.push("second"));
    h.api.enterScript(null);
    // 一轮 1 s：两帧 0.6 s 里第二帧回绕，两个回调都调（第一个抛错不影响第二个）
    h.puppets.frame(0.6);
    h.puppets.frame(0.6);
    expect(seen).toEqual([[exportsOfA, 0, "O0"], "second"]);
    expect(runtime.diagnostics.length).toBe(1);
  });

  it("没有当前脚本时不登记（没有东西能进入上下文）", () => {
    const h = setup();
    const layerApi = h.layer(0).getAnimationLayer(0) as Api;
    h.api.enterScript(null);
    layerApi.addEndedCallback(() => {
      throw new Error("不该被调");
    });
    h.puppets.frame(0.6);
    expect(() => h.puppets.frame(0.6)).not.toThrow();
  });
});

describe("动画层字段脚本：thisObject / thisLayer / update(value)", () => {
  const fieldScript = (field: "rate" | "blend" | "visible") =>
    ({
      ...script(`objects/0/animationlayers/1/${field}`, { kind: "animation-layer", object: 0, entry: 1, layer: 1 }, 0),
      target: { kind: "animation-layer", object: 0, layer: 1, field },
    }) as SceneScript;

  it("thisObject 是该动画层的 IAnimationLayer（不是图层）、thisLayer 是所属图层；'addEndedCallback' in thisObject 为真", () => {
    const h = setup();
    const { object, layer: owner } = h.as(fieldScript("rate"));
    expect(object).toBe(h.layer(0).getAnimationLayer(1));
    expect(object.name).toBe("b");
    expect(typeof object.getFrame).toBe("function");
    expect("addEndedCallback" in object).toBe(true);
    expect(object.getAnimationLayer).toBeUndefined();
    expect(owner).toBe(h.layer(0));
    expect(owner).not.toBe(object);
    // 图层脚本的 thisObject 仍是图层，没有 addEndedCallback
    const plain = h.as(script("objects/0/alpha", { kind: "layer", object: 0 }, 0));
    expect(plain.object).toBe(h.layer(0));
    expect("addEndedCallback" in plain.object).toBe(false);
  });

  it("readScriptState：update(value) 收到状态里的当前值（rate / blend 是 [x]，visible 是布尔）", () => {
    const h = setup();
    const target = (field: string) => ({ kind: "animation-layer", object: 0, layer: 1, field }) as ScriptTarget;
    expect(readScriptState(h.state, target("rate"))).toEqual([1]);
    expect(readScriptState(h.state, target("visible"))).toBe(true);
    (h.layer(0).getAnimationLayer(1) as Api).rate = 4;
    (h.layer(0).getAnimationLayer(1) as Api).visible = false;
    expect(readScriptState(h.state, target("rate"))).toEqual([4]);
    expect(readScriptState(h.state, target("visible"))).toBe(false);
    // 没有这一层：null
    expect(readScriptState(h.state, { kind: "animation-layer", object: 9, layer: 0, field: "rate" })).toBeNull();
  });
});
