/**
 * P12d-2：图像层上的骨骼脚本方法（`getBoneCount` / `getBoneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation`，
 * rea-p12d-bones）。落点用真的 `ScenePuppets`，realm 用不碰 DOM 的假 realm（同 `animationLayerApi.test.ts`）。
 * 假 realm 的 `Mat4` 没有 `translation()`，这里直接读自有键 `m`。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { MISSING_SCRIPT_API } from "../compile/scriptApi";
import { parseBonePhysics } from "../compile/puppet";
import { inverse4 } from "../puppet/math";
import { ScenePuppets, type PuppetRig, type PuppetSink } from "../puppet/player";
import { SceneState } from "../render/state";
import { ScriptApi } from "./api";
import { writeScriptState } from "./stateWrite";
import type { ScriptRealm, ScriptTarget, ScriptValue } from "./runtime";

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

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const T = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const PHYSICS = '{"t":true,"se":true,"ts":300,"tf":5,"ti":30,"tm":200}';

/** 两根根骨骼，静止世界平移 100 / 200；骨骼 0 开物理，骨骼 1 没开。 */
function rig(): PuppetRig & { names: string[]; boneCount: number } {
  const restMatrices = Float32Array.from([...T(100), ...T(200)]);
  const inverseBind = new Float32Array(32);
  inverse4(restMatrices, 0, inverseBind, 0);
  inverse4(restMatrices, 16, inverseBind, 16);
  return {
    skeleton: {
      parents: new Int32Array([-1, -1]),
      inverseBind,
      rest: new Float32Array(20),
      restMatrices,
      physics: [parseBonePhysics(PHYSICS), null],
    },
    names: ["root", "arm"],
    boneCount: 2,
    animations: [],
    layers: [],
    boneAlpha: false,
  } as PuppetRig & { names: string[]; boneCount: number };
}

/** `alignment: 0` 是「图像层」的标记（脚本骨骼方法只装在图像层上）。 */
function layer(object: number, extra: Record<string, unknown> = {}): SceneLayer {
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
    puppet: null,
    alignment: 0,
    ...extra,
  } as unknown as SceneLayer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, any>;

/**
 * 对象 0 是 puppet（2 根骨骼，mdl 骨骼数 2），对象 1 是普通图像层，对象 2 是静态 puppet（`skeleton: null`，mdl 有 4 根骨骼），
 * 对象 3 没有 `alignment`（不是图像层：模型对象等）。`hosted: false` 时不给宿主视图（语料诊断）。
 */
function setup(options: { hosted?: boolean } = {}) {
  const realm = new FakeRealm();
  const puppetRig = rig();
  const staticRig = { ...rig(), skeleton: null, boneCount: 4, names: ["a", "b", "c", "d"] };
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
    layers: [
      layer(0, { puppet: puppetRig }),
      layer(1),
      layer(2, { puppet: staticRig }),
      layer(3, { alignment: undefined }),
    ],
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
    animations: [],
  } as unknown as SceneBundle;
  const state = SceneState.fromBundle(bundle);
  const puppets = new ScenePuppets([{ object: 0, puppet: puppetRig }]);
  const world = Float32Array.from(T(10));
  const sink: PuppetSink = { animationLayer: () => undefined, world: () => world };
  const h = {
    puppets,
    frame: () => puppets.frame(0.016, sink),
    api: null as unknown as ScriptApi,
    layer: (object: number) => h.api.layer(object) as Api,
  };
  h.api = new ScriptApi(realm, {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: (target, value) => writeScriptState(state, target as ScriptTarget, value as ScriptValue) === "applied",
    ...(options.hosted === false
      ? {}
      : {
          puppetLayers: (object: number) => ({
            count: () => puppets.layerCount(object),
            find: (name: string) => puppets.findLayer(object, name),
            control: (index: number) => puppets.layer(object, index),
            boneTransform: (bone: number | string) => puppets.boneTransform(object, bone),
            setBoneTransform: (bone: number | string, matrix: ArrayLike<number>) =>
              puppets.setBoneTransform(object, bone, matrix),
            applyBonePhysicsImpulse: (bone: number | string, dir: ArrayLike<number>, ang: ArrayLike<number>) =>
              puppets.applyBonePhysicsImpulse(object, bone, dir, ang),
            resetBonePhysicsSimulation: (bone: number | string) => puppets.resetBonePhysicsSimulation(object, bone),
          }),
        }),
  });
  return h;
}

const METHODS = [
  "getBoneCount",
  "getBoneTransform",
  "setBoneTransform",
  "applyBonePhysicsImpulse",
  "resetBonePhysicsSimulation",
];

describe("骨骼方法的装载与 getBoneCount", () => {
  it("只装在图像层上（alignment 有值）：没有 alignment 的对象没有这五个方法", () => {
    const h = setup();
    for (const object of [0, 1, 2]) for (const name of METHODS) expect(name in h.layer(object), name).toBe(true);
    for (const name of METHODS) expect(name in h.layer(3), name).toBe(false);
  });

  it("非 puppet 返回 0；puppet 返回 mdl 骨骼数；静态 puppet（没有骨骼运行时）也返回骨骼数", () => {
    const h = setup();
    expect(h.layer(1).getBoneCount()).toBe(0);
    expect(h.layer(0).getBoneCount()).toBe(2);
    expect(h.layer(2).getBoneCount()).toBe(4);
  });

  it("缺失表里这五个已删，其余骨骼 / 混合形状方法仍在", () => {
    const names = new Set(MISSING_SCRIPT_API.layer.map((entry) => entry.name));
    for (const name of METHODS) expect(names.has(name), name).toBe(false);
    for (const name of ["getLocalBoneTransform", "getBoneIndex", "getBoneParentIndex", "getBlendShapeWeight"])
      expect(names.has(name), name).toBe(true);
  });
});

describe("getBoneTransform", () => {
  it("每次新建 Mat4（自有键 m，16 个 number）；推进之前与选骨失败返回单位阵，不是 null", () => {
    const h = setup();
    const before = h.layer(0).getBoneTransform(0);
    expect(before.m).toEqual(IDENTITY);
    h.frame();
    const a = h.layer(0).getBoneTransform(0);
    const b = h.layer(0).getBoneTransform(0);
    expect(a).not.toBe(b);
    expect(a.m).toHaveLength(16);
    expect(a.m.slice(12, 15)).toEqual([110, 0, 0]);
    expect(h.layer(0).getBoneTransform("arm").m.slice(12, 15)).toEqual([210, 0, 0]);
    for (const bad of [99, -1, 1.5, NaN, "", "nosuch", {}, null, undefined, true])
      expect(h.layer(0).getBoneTransform(bad).m, String(bad)).toEqual(IDENTITY);
    // 非 puppet、静态 puppet
    expect(h.layer(1).getBoneTransform(0).m).toEqual(IDENTITY);
    expect(h.layer(2).getBoneTransform(0).m).toEqual(IDENTITY);
  });

  it("没有宿主视图（语料诊断）：单位阵，其余方法空操作不抛错", () => {
    const h = setup({ hosted: false });
    h.frame();
    expect(h.layer(0).getBoneTransform(0).m).toEqual(IDENTITY);
    expect(() => {
      h.layer(0).setBoneTransform(0, { m: T(5) });
      h.layer(0).applyBonePhysicsImpulse(0, { x: 1, y: 2, z: 3 });
      h.layer(0).resetBonePhysicsSimulation(0);
    }).not.toThrow();
  });
});

describe("setBoneTransform", () => {
  it("收 Mat4（读 m 的 16 个数）：当帧读回就是它；下一帧被重算覆盖", () => {
    const h = setup();
    h.frame();
    expect(h.layer(0).setBoneTransform(1, { m: T(777, 5) })).toBeUndefined();
    expect(h.layer(0).getBoneTransform(1).m.slice(12, 15)).toEqual([777, 5, 0]);
    h.frame();
    expect(h.layer(0).getBoneTransform(1).m.slice(12, 15)).toEqual([210, 0, 0]);
  });

  it("不是对象 / 没有数组 m 时写单位阵；m 里不是数的元素取单位阵对应位的值", () => {
    const h = setup();
    h.frame();
    h.layer(0).setBoneTransform(1, 5);
    expect(h.layer(0).getBoneTransform(1).m).toEqual(IDENTITY);
    h.layer(0).setBoneTransform(1, { m: "x" });
    expect(h.layer(0).getBoneTransform(1).m).toEqual(IDENTITY);
    const partial = T(9, 9, 9).map((v, i) => (i === 13 ? "bad" : v));
    h.layer(0).setBoneTransform(1, { m: partial });
    expect(h.layer(0).getBoneTransform(1).m.slice(12, 15)).toEqual([9, 0, 9]);
  });

  it("选骨失败什么都不做", () => {
    const h = setup();
    h.frame();
    h.layer(0).setBoneTransform(9, { m: T(1) });
    h.layer(0).setBoneTransform("", { m: T(1) });
    h.layer(1).setBoneTransform(0, { m: T(1) });
    expect(h.layer(0).getBoneTransform(0).m.slice(12, 15)).toEqual([110, 0, 0]);
  });
});

describe("applyBonePhysicsImpulse / resetBonePhysicsSimulation", () => {
  it("两个参数不抛错（缺的 ang 当零）：vel 加 dir、q 不变；开了物理的骨骼才有状态", () => {
    const h = setup();
    h.frame();
    h.frame();
    expect(() => h.layer(0).applyBonePhysicsImpulse(0, { x: 500, y: 0, z: 0 })).not.toThrow();
    const states = h.puppets.physicsStates(0)!;
    expect(Array.from(states[0]!.vel)).toEqual([500, 0, 0]);
    expect(Array.from(states[0]!.q)).toEqual([1, 0, 0, 0]);
    // 没开物理的骨骼、越界、非对象的 dir：不抛错、没有效果
    expect(() => {
      h.layer(0).applyBonePhysicsImpulse(1, { x: 5, y: 5, z: 5 });
      h.layer(0).applyBonePhysicsImpulse(7, { x: 5, y: 5, z: 5 });
      h.layer(0).applyBonePhysicsImpulse(0, 3, 4);
      h.layer(1).applyBonePhysicsImpulse(0, { x: 5, y: 5, z: 5 });
    }).not.toThrow();
    expect(states[1]).toBeNull();
    expect(Array.from(states[0]!.vel)).toEqual([500, 0, 0]);
  });

  it("带 ang 的冲量改 q；空串落到骨骼 0；复位把状态置回初值", () => {
    const h = setup();
    h.frame();
    h.frame();
    h.layer(0).applyBonePhysicsImpulse("", { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 90 });
    const state = h.puppets.physicsStates(0)![0]!;
    expect(state.vel[0]).toBe(1);
    expect(state.q[3]).toBeCloseTo(Math.SQRT1_2, 5);
    h.layer(0).resetBonePhysicsSimulation("root");
    expect(Array.from(state.vel)).toEqual([0, 0, 0]);
    expect(Array.from(state.q)).toEqual([1, 0, 0, 0]);
  });
});
