/**
 * P4f 步骤 3 的脚本 API 单测：粒子层的 `IParticleSystem`（`play` / `pause` / `stop` / `isPlaying` / `emitParticles`）与只读的 `instance`
 * 子对象（24 个字段）只登记在粒子对象的图层代理上（rea-p4f-script.md 1.1–1.3），方法接到宿主给的落点，`instance` 读写
 * `SceneState.particleInstances`（WPE 的 `io`，5.1），写入经就地目标 `particle-instance`（`rate` 走 P4f 步骤 1 的单独路径）。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { FLT_MAX, parseParticle, type InstanceKey } from "../compile/particles";
import { SceneState, scriptWriteValue } from "../render/state";
import { ScriptApi, type ParticleScriptTarget } from "./api";
import type { ScriptRealm } from "./runtime";

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
class Vec4 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
    public w: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: Vec4.prototype, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: (json: string) => JSON.parse(json) };
  async importModule(): Promise<Record<string, unknown>> {
    return {};
  }
  dispose() {}
}

function layer(object: number, name: string, particle = false): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name,
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
    // 粒子层的实例覆盖：`alpha 0.5`、`colorn` 与控制点 1 设了，别的取缺省
    particle: particle
      ? parseParticle(
          { emitter: [{ name: "sphererandom", rate: 10 }] },
          {
            file: "p.json",
            orthographic: true,
            instanceoverride: { alpha: 0.5, colorn: "0 1 0", controlpoint1: "10 20 0" },
          },
        )
      : null,
  };
}

/** 图层 0 是普通图层（First），图层 1 是粒子层（Sparks）。 */
function bundle(): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
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
    layers: [layer(0, "First"), layer(1, "Sparks", true)],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as SceneBundle;
}

/** `target`：宿主交给粒子层方法的落点；null 时没有（场景还没建好等）。 */
function setup(target: ParticleScriptTarget | null) {
  const realm = new FakeRealm();
  const scene = bundle();
  const state = SceneState.fromBundle(scene);
  state.takeDirty();
  const api = new ScriptApi(realm, {
    bundle: () => scene,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 1,
    timeOfDay: () => 0.5,
    write(target, value) {
      if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
        return false;
      state.write({ property: "test", target }, scriptWriteValue(value));
      return true;
    },
    particles: (object) => (object === 1 ? target : null),
  });
  return { api, state, plain: api.layer(0)!, sparks: api.layer(1)! };
}

/** 记下每次调用的落点（`<方法>[:<参数>]`）。 */
function recorder() {
  const calls: string[] = [];
  let playing = true;
  const target: ParticleScriptTarget = {
    play: () => void calls.push("play"),
    pause: () => void calls.push("pause"),
    stop: () => void calls.push("stop"),
    isPlaying: () => {
      calls.push("isPlaying");
      return playing;
    },
    emitParticles: (...args: unknown[]) => void calls.push(`emit:${args.length ? String(args[0]) : "无参数"}`),
  };
  return {
    calls,
    target,
    setPlaying(value: boolean) {
      playing = value;
    },
  };
}

type Methods = Record<string, (...args: unknown[]) => unknown>;
const ALL_KEYS: string[] = [
  "alpha",
  "size",
  "count",
  "speed",
  "lifetime",
  "rate",
  "brightness",
  "colorn",
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `controlpoint${i}`),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `controlpointangle${i}`),
];
const vec = (value: unknown) => {
  const { x, y, z } = value as Vec3;
  return [x, y, z];
};

describe("粒子层的方法（IParticleSystem，rea-p4f-script.md 1.1）", () => {
  it("只登记在粒子对象的图层上：普通图层上没有这五个方法与 instance", () => {
    const { plain, sparks } = setup(null);
    for (const name of ["play", "pause", "stop", "isPlaying", "emitParticles", "instance"]) {
      expect(name in sparks, name).toBe(true);
      expect(name in plain, name).toBe(false);
    }
  });

  it("五个方法接到宿主给的落点；emitParticles 原样交出脚本的参数（缺参数时是 undefined，归一化在模拟器里）", () => {
    const record = recorder();
    const { sparks } = setup(record.target);
    const methods = sparks as Methods;
    methods.play();
    methods.pause();
    methods.stop();
    expect(methods.isPlaying()).toBe(true);
    record.setPlaying(false);
    expect(methods.isPlaying()).toBe(false);
    methods.emitParticles(3);
    methods.emitParticles();
    methods.emitParticles(2.7);
    expect(record.calls).toEqual([
      "play",
      "pause",
      "stop",
      "isPlaying",
      "isPlaying",
      "emit:3",
      "emit:undefined",
      "emit:2.7",
    ]);
  });

  it("没有落点时什么都不做，isPlaying 为假", () => {
    const { sparks } = setup(null);
    const methods = sparks as Methods;
    expect(() => {
      methods.play();
      methods.pause();
      methods.stop();
      methods.emitParticles(1);
    }).not.toThrow();
    expect(methods.isPlaying()).toBe(false);
  });
});

describe("instance 子对象（24 个字段，rea-p4f-script.md 1.3、5.1）", () => {
  it("只读字段：每次读是同一个对象，整体赋值忽略；24 个字段、没有别的成员", () => {
    const { sparks } = setup(null);
    const instance = sparks.instance as Record<string, unknown>;
    expect(sparks.instance).toBe(instance);
    sparks.instance = { alpha: 9 };
    expect(sparks.instance).toBe(instance);
    expect(Object.keys(instance).sort()).toEqual([...ALL_KEYS].sort());
  });

  it("读状态里的覆盖值：系数是数字，colorn 没设时 (−1, −1, −1)，控制点没设时 (FLT_MAX, 0, 0)（实测 a-inst-cp）", () => {
    const { sparks, state } = setup(null);
    const instance = sparks.instance as Record<string, unknown>;
    expect(["alpha", "size", "count", "speed", "lifetime", "rate", "brightness"].map((key) => instance[key])).toEqual([
      0.5, 1, 1, 1, 1, 1, 1,
    ]);
    expect(instance.colorn).toBeInstanceOf(Vec3);
    expect(vec(instance.colorn)).toEqual([0, 1, 0]);
    expect(vec(instance.controlpoint1)).toEqual([10, 20, 0]);
    expect(vec(instance.controlpoint0)).toEqual([FLT_MAX, 0, 0]);
    expect(vec(instance.controlpointangle7)).toEqual([FLT_MAX, 0, 0]);
    state.particleInstances.get(1)!.colorn = null;
    expect(vec(instance.colorn)).toEqual([-1, -1, -1]);
  });

  it("写经就地目标 particle-instance、当场读回：系数按 float，colorn 与控制点按 vec3（数字铺满、Vec3 / {x, y, z}），角度是弧度不换算", () => {
    const { sparks, state } = setup(null);
    const instance = sparks.instance as Record<string, unknown>;
    instance.count = 3;
    instance.colorn = new Vec3(1, 0, 0);
    instance.controlpoint2 = { x: 1, y: 2, z: 3 };
    instance.controlpoint3 = 5;
    instance.controlpointangle4 = new Vec3(0, 0, Math.PI);
    const values = state.particleInstances.get(1)!;
    expect(values.count).toBe(3);
    expect(values.colorn).toEqual([1, 0, 0]);
    expect(values.controlpoints[2]).toEqual([1, 2, 3]);
    expect(values.controlpoints[3]).toEqual([5, 5, 5]);
    expect(values.controlpointAngles[4]).toEqual([0, 0, Math.PI]);
    expect(instance.count).toBe(3);
    expect(vec(instance.controlpoint3)).toEqual([5, 5, 5]);
    expect(vec(instance.controlpointangle4)).toEqual([0, 0, Math.PI]);
    const dirty = state.takeDirty();
    expect([[...dirty.particles], [...dirty.rates]]).toEqual([[1], []]);
    // 写回 FLT_MAX：读回原样（不再覆盖由模拟器按 x 判断）
    instance.controlpoint2 = new Vec3(FLT_MAX, 7, 8);
    expect(vec(instance.controlpoint2)).toEqual([FLT_MAX, 7, 8]);
    // 类型不对的值不写（同图层字段）
    instance.alpha = "abc";
    instance.controlpoint5 = "1 2 3";
    expect([values.alpha, values.controlpoints[5]]).toEqual([0.5, null]);
  });

  it("写 rate 走单独路径：只进 rates、不标脏、不钳制（P4f 步骤 1，rea-p4f-script.md 5.4）", () => {
    const { sparks, state } = setup(null);
    const instance = sparks.instance as Record<string, unknown>;
    instance.rate = 0;
    expect(instance.rate).toBe(0);
    const dirty = state.takeDirty();
    expect([[...dirty.rates], [...dirty.particles]]).toEqual([[1], []]);
  });

  it("24 个键都写得进状态（每个键一个目标）", () => {
    const { sparks, state } = setup(null);
    const instance = sparks.instance as Record<string, unknown>;
    for (const key of ALL_KEYS) instance[key] = 2;
    const values = state.particleInstances.get(1)!;
    for (const key of ALL_KEYS as InstanceKey[]) {
      const point = /^controlpoint(angle)?(\d)$/.exec(key);
      const value = point
        ? (point[1] ? values.controlpointAngles : values.controlpoints)[Number(point[2])]
        : key === "colorn"
          ? values.colorn
          : values[key as "alpha"];
      expect(value, key).toEqual(key === "colorn" || point ? [2, 2, 2] : 2);
    }
  });
});
