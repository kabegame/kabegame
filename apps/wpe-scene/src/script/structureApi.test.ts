// P6d3a 点 5、点 6、点 7：运行时对象表与结构 API（`thisScene` 的下标 / `sortLayer` / `destroyLayer` / `getInitialLayerConfig`、图层对象的
// `getParent` / `getChildren` / `setParent`、`engine.registerAsset`、删除后对象的作废）。真值：步骤 0 实测日志 `ignore/p6/d3/out/wpe-parent.log`
// （s5 与 s2 的数字，逐位比较，-0 与 0 视同）与 `ignore/p6/rea/layers/adjust/sim_adjust.py`（复算脚本）。
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneStructure } from "../compile/protocol";
import type { SceneScript } from "../compile/scripts";
import { glmInverse } from "../render/adjust";
import { SceneState, scriptWriteValue } from "../render/state";
import { ScriptApi, type ScriptApiState } from "./api";
import { radiansToScript } from "./f32";
import type { ScriptRealm } from "./runtime";

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
}
class Mat4Proto {}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: Mat4Proto.prototype };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(): Promise<ScriptModule> {
    return fakeModule({});
  }
  dispose() {}
}

interface LayerSpec {
  name?: string;
  id?: number;
  parent?: number | null;
  origin?: number[];
  angles?: number[];
  scale?: number[];
  /** 组（模型 JSON `passthrough: true`）。 */
  group?: boolean;
  /** 挂点表（父 puppet 的 `attachments`）。 */
  attachments?: { name: string; bone: number }[];
  effect?: boolean;
}

function bundleOf(specs: LayerSpec[], configs?: (string | null)[]): SceneBundle {
  const layers = specs.map(
    (spec, object) =>
      ({
        id: spec.id ?? object + 10,
        object,
        parent: spec.parent ?? null,
        name: spec.name ?? `L${object}`,
        origin: spec.origin ?? [0, 0, 0],
        scale: spec.scale ?? [1, 1, 1],
        angles: spec.angles ?? [0, 0, 0],
        size: [100, 100],
        alpha: 1,
        color: [1, 1, 1],
        brightness: 1,
        visible: true,
        parallaxDepth: [1, 1],
        passthroughModel: spec.group === true,
        effects: spec.effect ? [{ source: 0, name: "fx", enabled: true, steps: [], unsupported: [] }] : [],
        passes: [],
        camera: null,
        puppet: spec.attachments
          ? {
              attachments: spec.attachments.map((item) => ({ ...item, matrix: new Float32Array(16) })),
              skeleton: { parents: [0, 0] },
              layers: [],
            }
          : null,
      }) as unknown as SceneLayer,
  );
  return {
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
    layers,
    programs: [],
    textures: [],
    bindings: [],
    scripts: { list: [] },
    ...(configs ? { configs } : {}),
  } as unknown as SceneBundle;
}

interface Change {
  object: number;
  oldParent: number | null;
  oldBone: string | null;
  parent: number | null;
  bone: string | null;
}

function setup(specs: LayerSpec[], configs?: (string | null)[]) {
  const bundle = bundleOf(specs, configs);
  const state = SceneState.fromBundle(bundle);
  const changes: Change[] = [];
  const warns: string[] = [];
  const structure: SceneStructure = { destroyed: [], parents: [], created: [] };
  const access: ScriptApiState = {
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
    structure: () => structure,
    reparented: (change) => {
      changes.push(change);
      structure.parents = structure.parents.filter(([object]) => object !== change.object);
      structure.parents.push([change.object, change.parent, change.bone]);
    },
    warn: (message) => warns.push(message),
  };
  const api = new ScriptApi(new FakeRealm(), access);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (n: number) => api.layer(n) as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene = api.thisScene as Record<string, any>;
  return { bundle, state, api, layer, scene, changes, warns, structure };
}

const nz = (v: number): number => v + 0;
function bits(actual: readonly number[], expected: readonly number[], tag: string): void {
  expect(actual.length, tag).toBe(expected.length);
  actual.forEach((value, i) =>
    expect(Object.is(nz(value), nz(expected[i])), `${tag}[${i}] ${value} vs ${expected[i]}`).toBe(true),
  );
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mOf = (layer: Record<string, any>): number[] => Array.from(layer.getTransformMatrix().m as number[]);

describe("thisScene 的下标表（点 6，rea-p6d-layers 3.3、rea-p6d-script 5.1）", () => {
  const specs = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "B", id: 99 }, { name: "E", id: 7 }];

  it("getLayerCount = order.length − 待删；enumerateLayers 按 order 跳过待删", () => {
    const h = setup(specs);
    expect(h.scene.getLayerCount()).toBe(5);
    h.scene.destroyLayer(1);
    expect(h.scene.getLayerCount()).toBe(4);
    expect(h.scene.enumerateLayers()).toEqual([h.layer(0), h.layer(2), h.layer(3), h.layer(4)]);
    h.scene.sortLayer(4, 0);
    expect(h.scene.enumerateLayers()).toEqual([h.layer(4), h.layer(0), h.layer(2), h.layer(3)]);
  });

  it("getLayerIndex：对象 / 数字 / 名字，返回 order 里的原始下标（含待删）；别的类型 −1", () => {
    const h = setup(specs);
    h.scene.sortLayer(2, 0);
    expect(h.scene.getLayerIndex(h.layer(2))).toBe(0);
    expect(h.scene.getLayerIndex(h.layer(0))).toBe(1);
    expect(h.scene.getLayerIndex(3)).toBe(3);
    expect(h.scene.getLayerIndex(99)).toBe(-1);
    expect(h.scene.getLayerIndex(-1)).toBe(-1);
    expect(h.scene.getLayerIndex("A")).toBe(1);
    // 重名取第一个；id 字符串（strtol）在没有同名时才用
    expect(h.scene.getLayerIndex("B")).toBe(2);
    expect(h.scene.getLayerIndex("7")).toBe(5 - 1);
    expect(h.scene.getLayerIndex("nosuch")).toBe(-1);
    for (const bad of [undefined, null, true, Symbol("x"), 1n]) expect(h.scene.getLayerIndex(bad)).toBe(-1);
    expect(h.scene.getLayerIndex()).toBe(-1);
    // 待删照常返回下标（名字也是）
    h.scene.destroyLayer("A");
    expect(h.scene.getLayerIndex(h.layer(0))).toBe(1);
    expect(h.scene.getLayerIndex("A")).toBe(1);
    expect(h.scene.getLayerIndex(1)).toBe(1);
  });

  it("getLayer：数字按原始下标（ToInt32，待删与越界 null）、名字取第一个同名（它待删就 null、不往后找）、对象本身", () => {
    const h = setup(specs);
    expect(h.scene.getLayer()).toBeUndefined();
    expect(h.scene.getLayer(2)).toBe(h.layer(2));
    expect(h.scene.getLayer(2.9)).toBe(h.layer(2));
    expect(h.scene.getLayer(5)).toBeNull();
    expect(h.scene.getLayer(-1)).toBeNull();
    expect(h.scene.getLayer("C")).toBe(h.layer(2));
    expect(h.scene.getLayer("B")).toBe(h.layer(1));
    expect(h.scene.getLayer(undefined)).toBeNull();
    expect(h.scene.getLayer(h.layer(4))).toBe(h.layer(4));
    expect(h.scene.getLayer({})).toBeNull();
    h.scene.destroyLayer(1);
    expect(h.scene.getLayer(1)).toBeNull();
    // 第一个同名的待删：返回 null，不再找后面那个 B
    expect(h.scene.getLayer("B")).toBeNull();
    // 对象参数不看待删（dll 的对象分支直接取指针）
    expect(h.scene.getLayer(h.layer(1))).toBe(h.layer(1));
    expect(h.scene.getLayer(3)).toBe(h.layer(3));
  });

  it("getLayerByID：只收字符串、strtol；待删 null", () => {
    const h = setup(specs);
    expect(h.scene.getLayerByID()).toBeUndefined();
    expect(h.scene.getLayerByID(10)).toBeNull();
    expect(h.scene.getLayerByID("12")).toBe(h.layer(2));
    expect(h.scene.getLayerByID("  12abc")).toBe(h.layer(2));
    expect(h.scene.getLayerByID("abc")).toBeNull();
    h.scene.destroyLayer(2);
    expect(h.scene.getLayerByID("12")).toBeNull();
  });

  it("sortLayer：参数规则、越界与负数到末尾、名字指向待删返回 false", () => {
    const h = setup(specs);
    expect(h.scene.sortLayer(1)).toBe(false);
    expect(h.scene.sortLayer()).toBe(false);
    expect(h.scene.sortLayer(undefined, 1)).toBe(false);
    expect(h.scene.sortLayer(true, 1)).toBe(false);
    expect(h.scene.sortLayer(1, "3")).toBe(false);
    expect(h.scene.sortLayer(1, undefined)).toBe(false);
    expect(h.scene.sortLayer(99, 1)).toBe(false);
    expect(h.scene.sortLayer(null, 1)).toBe(false);
    expect(h.state.order).toEqual([0, 1, 2, 3, 4]);
    expect(h.scene.sortLayer(h.layer(4), 0)).toBe(true);
    expect(h.state.order).toEqual([4, 0, 1, 2, 3]);
    expect(h.scene.sortLayer("A", 99)).toBe(true);
    expect(h.state.order).toEqual([4, 1, 2, 3, 0]);
    expect(h.scene.sortLayer(1, -1)).toBe(true);
    expect(h.state.order).toEqual([4, 2, 3, 0, 1]);
    // ToInt32：1.9 → 1；先摘掉再插
    expect(h.scene.sortLayer(2, 1.9)).toBe(true);
    expect(h.state.order).toEqual([4, 3, 2, 0, 1]);
    h.scene.destroyLayer("C");
    expect(h.scene.sortLayer("C", 0)).toBe(false);
    // 对象参数不看待删：照样排（它还在表里）
    expect(h.scene.sortLayer(h.layer(2), 0)).toBe(true);
    expect(h.state.order).toEqual([2, 4, 3, 0, 1]);
  });

  it("destroyLayer：无参 / 解析不到 / null 是 false；记待删（返回 true），同帧用对象再删仍是 true、用下标或名字是 false；生效后再删是 false", () => {
    const h = setup(specs);
    expect(h.scene.destroyLayer()).toBe(false);
    expect(h.scene.destroyLayer(null)).toBe(false);
    expect(h.scene.destroyLayer(undefined)).toBe(false);
    expect(h.scene.destroyLayer("nosuch")).toBe(false);
    expect(h.scene.destroyLayer(9)).toBe(false);
    expect(h.scene.destroyLayer(h.layer(1))).toBe(true);
    expect([...h.state.pendingDestroy]).toEqual([1]);
    expect(h.scene.destroyLayer(1)).toBe(false);
    expect(h.scene.destroyLayer("B")).toBe(false);
    // 0c 实测（p6d-frame f=70 `destroy B again`）：同帧用对象再删一次仍是 true
    expect(h.scene.destroyLayer(h.layer(1))).toBe(true);
    expect([...h.state.pendingDestroy]).toEqual([1]);
    expect(h.state.flushDestroy()).toEqual([1]);
    expect(h.scene.destroyLayer(h.layer(1))).toBe(false);
    expect(h.scene.getLayerCount()).toBe(4);
    // 生效之后下标整体前移
    expect(h.scene.getLayer(1)).toBe(h.layer(2));
    expect(h.scene.getLayerIndex(h.layer(2))).toBe(1);
  });

  it("模块顶层调用抛 realm 的 SyntaxError，文案照 dll（getLayerByID 与 getInitialLayerConfig 抄错的名字）", () => {
    const h = setup(specs);
    h.api.setModuleEvaluating(true);
    const cases: [string, string][] = [
      ["getLayer", "getLayer"],
      ["getLayerByID", "getLayer"],
      ["getLayerCount", "getLayerCount"],
      ["enumerateLayers", "enumerateLayers"],
      ["destroyLayer", "destroyLayer"],
      ["sortLayer", "sortLayer"],
      ["getLayerIndex", "getLayerIndex"],
      ["getInitialLayerConfig", "destroyLayer"],
    ];
    for (const [name, shown] of cases) {
      expect(() => h.scene[name](), name).toThrow(SyntaxError);
      expect(() => h.scene[name](), name).toThrow(`${shown} cannot be called from global scope.`);
    }
    h.api.setModuleEvaluating(false);
    expect(h.scene.getLayerCount()).toBe(5);
  });
});

describe("getInitialLayerConfig（点 7）", () => {
  const configs = [null, '{"origin":"1 2 3","visible":true,"effects":[{"file":"a"}]}', '{"x":0.12345679}'];
  const specs = [{ name: "A" }, { name: "B" }, { name: "B" }];

  it("在 realm 里新解析一份；没有配置、解析不到返回 null", () => {
    const h = setup(specs, configs);
    const first = h.scene.getInitialLayerConfig("B");
    expect(first).toEqual({ origin: "1 2 3", visible: true, effects: [{ file: "a" }] });
    expect(h.scene.getInitialLayerConfig(1)).not.toBe(first);
    expect(h.scene.getInitialLayerConfig(h.layer(2))).toEqual({ x: 0.12345679 });
    expect(h.scene.getInitialLayerConfig(0)).toBeNull();
    expect(h.scene.getInitialLayerConfig("nosuch")).toBeNull();
    expect(h.scene.getInitialLayerConfig(7)).toBeNull();
    expect(h.scene.getInitialLayerConfig()).toBeNull();
    expect(setup(specs).scene.getInitialLayerConfig(1)).toBeNull();
  });

  it("不看待删（数字、对象），名字解析里第一个同名对象待删时仍是 null", () => {
    const h = setup(specs, configs);
    h.scene.destroyLayer(1);
    expect(h.scene.getInitialLayerConfig(1)).toEqual(h.scene.getInitialLayerConfig(h.layer(1)));
    expect(h.scene.getInitialLayerConfig(1)).not.toBeNull();
    expect(h.scene.getInitialLayerConfig("B")).toBeNull();
    h.state.flushDestroy();
    expect(h.scene.getInitialLayerConfig("B")).toEqual({ x: 0.12345679 });
  });

  it("字符串按 id 命中（没有同名）的待删对象不看待删（同数字），先查一次进了缓存也一样", () => {
    const h = setup(specs, configs);
    // 对象 1 的 id 是 11（bundleOf 缺省 object + 10），没有叫「11」的图层
    expect(h.scene.getInitialLayerConfig("11")).toEqual({ origin: "1 2 3", visible: true, effects: [{ file: "a" }] });
    h.scene.destroyLayer(1);
    expect(h.scene.getInitialLayerConfig("11")).toEqual({ origin: "1 2 3", visible: true, effects: [{ file: "a" }] });
    // getLayer 的 id 命中照常拒绝待删
    expect(h.scene.getLayer("11")).toBeNull();
  });
});

describe("engine.registerAsset（点 7）", () => {
  it("只能在模块顶层调；非字符串返回 null；同一段脚本重复登记同一路径返回 null；否则返回路径本身", () => {
    const h = setup([{}]);
    const engine = h.api.engine as Record<string, (...args: unknown[]) => unknown>;
    // 回调里调：抛 realm 的 SyntaxError
    expect(() => engine.registerAsset("a.json")).toThrow(SyntaxError);
    expect(() => engine.registerAsset("a.json")).toThrow("registerAsset can only be called from global scope.");
    h.api.setModuleEvaluating(true);
    h.api.enterScript({ id: "s1" } as SceneScript);
    expect(engine.registerAsset("a.json", true)).toBe("a.json");
    expect(engine.registerAsset("a.json")).toBeNull();
    expect(engine.registerAsset("b.json")).toBe("b.json");
    expect(engine.registerAsset(5)).toBeNull();
    expect(engine.registerAsset()).toBeNull();
    // 另一段脚本有自己的登记表
    h.api.enterScript({ id: "s2" } as SceneScript);
    expect(engine.registerAsset("a.json")).toBe("a.json");
    h.api.setModuleEvaluating(false);
  });
});

describe("删除后的对象作废（点 6）", () => {
  it("图层对象：读字段 undefined、写入忽略、方法返回 undefined、isObjectValid 为假；其它对象不受影响", () => {
    const h = setup([{ name: "A", origin: [5, 6, 0] }, { name: "B" }]);
    const a = h.layer(0);
    const b = h.layer(1);
    const valid = (h.api.engine as { isObjectValid(value: unknown): boolean }).isObjectValid;
    expect(a.origin.x).toBe(5);
    expect(valid(a)).toBe(true);
    h.scene.destroyLayer(a);
    // 待删时同一帧照常可读写
    expect(a.name).toBe("A");
    a.origin = new Vec(7, 8, 0);
    expect(h.state.layers.get(0)!.origin).toEqual([7, 8, 0]);
    expect(valid(a)).toBe(true);
    h.state.flushDestroy();
    expect(a.name).toBeUndefined();
    expect(a.origin).toBeUndefined();
    expect(a.visible).toBeUndefined();
    expect(() => {
      a.origin = new Vec(1, 1, 1);
      a.visible = false;
    }).not.toThrow();
    expect(a.getParent()).toBeUndefined();
    expect(a.getChildren()).toBeUndefined();
    expect(a.getTransformMatrix()).toBeUndefined();
    expect(a.setParent(b)).toBeUndefined();
    expect(a.rotateObjectSpace(new Vec(1, 0, 0))).toBeUndefined();
    expect(valid(a)).toBe(false);
    expect(valid(b)).toBe(true);
    expect(b.name).toBe("B");
    expect(h.scene.getLayer(a)).toBeNull();
    expect(h.scene.getLayerIndex(a)).toBe(-1);
  });

  it("effect 对象跟着属主作废", () => {
    const h = setup([{ effect: true }, {}]);
    const fx = h.layer(0).getEffect(0) as Record<string, unknown>;
    const valid = (h.api.engine as { isObjectValid(value: unknown): boolean }).isObjectValid;
    expect(fx.name).toBe("fx");
    expect(valid(fx)).toBe(true);
    h.scene.destroyLayer(0);
    h.state.flushDestroy();
    expect(fx.name).toBeUndefined();
    expect(fx.visible).toBeUndefined();
    expect((fx.getMaterialCount as () => unknown)()).toBeUndefined();
    expect(valid(fx)).toBe(false);
  });
});

describe("getParent / getChildren 读状态（点 6）", () => {
  it("换父之后读新的；子表追加在尾；每次新数组", () => {
    const h = setup([{}, { parent: 0 }, { parent: 0 }, {}]);
    expect(h.layer(0).getChildren()).toEqual([h.layer(1), h.layer(2)]);
    expect(h.layer(0).getChildren()).not.toBe(h.layer(0).getChildren());
    h.layer(3).setParent(h.layer(0));
    expect(h.layer(3).getParent()).toBe(h.layer(0));
    expect(h.layer(0).getChildren()).toEqual([h.layer(1), h.layer(2), h.layer(3)]);
    h.layer(1).setParent(h.layer(3));
    expect(h.layer(0).getChildren()).toEqual([h.layer(2), h.layer(3)]);
    expect(h.layer(3).getChildren()).toEqual([h.layer(1)]);
    // sortLayer 不改子表
    h.scene.sortLayer(3, 0);
    expect(h.layer(0).getChildren()).toEqual([h.layer(2), h.layer(3)]);
  });
});

describe("setParent：解析、检查与不 adjust（点 6，步骤 0 实测）", () => {
  const specs = [{ name: "P" }, { name: "Q", origin: [10, 20, 0] }, { name: "S", parent: 0 }, { name: "T", parent: 2 }];

  it("第一参：对象 / 名字 / id 字符串 / 下标；解析不到（undefined、null、找不到、待删）是解除父子", () => {
    const h = setup(specs);
    const q = h.layer(1);
    expect(q.setParent(h.layer(0))).toBeUndefined();
    expect(h.state.layers.get(1)!.parent).toBe(0);
    q.setParent("S");
    expect(h.state.layers.get(1)!.parent).toBe(2);
    q.setParent("13");
    expect(h.state.layers.get(1)!.parent).toBe(3);
    q.setParent(0);
    expect(h.state.layers.get(1)!.parent).toBe(0);
    for (const none of [undefined, null, "nosuch", 99, {}, true]) {
      q.setParent(h.layer(0));
      q.setParent(none);
      expect(h.state.layers.get(1)!.parent, String(none)).toBeNull();
    }
    q.setParent(h.layer(0));
    h.scene.destroyLayer(0);
    q.setParent(h.layer(2));
    q.setParent(h.layer(0));
    expect(h.state.layers.get(1)!.parent).toBeNull();
  });

  it("不 adjust：本地字段不动，世界矩阵按新父重算；通知 reparented（父与挂点都没变时不通知）", () => {
    const h = setup(specs);
    h.layer(0).origin = new Vec(100, 0, 0);
    h.layer(1).setParent(h.layer(0));
    expect(h.state.layers.get(1)!.origin).toEqual([10, 20, 0]);
    expect(mOf(h.layer(1)).slice(12, 15)).toEqual([110, 20, 0]);
    expect(h.changes).toEqual([{ object: 1, oldParent: null, oldBone: null, parent: 0, bone: null }]);
    const version = h.state.structureVersion;
    h.layer(1).setParent(h.layer(0));
    h.layer(1).setParent(h.layer(0), true);
    expect(h.changes.length).toBe(1);
    expect(h.state.structureVersion).toBe(version);
    h.layer(1).setParent(undefined);
    expect(h.changes[1]).toEqual({ object: 1, oldParent: 0, oldBone: null, parent: null, bone: null });
    expect(h.structure.parents).toEqual([[1, null, null]]);
  });

  it("成环（新父是自己或自己的子孙）：不改、记 warn、不通知", () => {
    const h = setup(specs);
    h.layer(0).setParent(h.layer(3));
    h.layer(0).setParent(h.layer(0));
    h.layer(0).setParent(h.layer(2));
    expect(h.state.layers.get(0)!.parent).toBeNull();
    expect(h.warns.length).toBe(3);
    expect(h.changes).toEqual([]);
    expect(h.state.childrenOf(0)).toEqual([2]);
  });
});

describe("setParent：组深度（步骤 0 的四例）", () => {
  // K1 ⊃ K2 ⊃ K3 三层组合层；K4 普通层挂 K3；R3 普通；Z 组合层带子层 Z1；Z0 组合层没有子层
  const specs: LayerSpec[] = [
    { name: "K1", group: true },
    { name: "K2", group: true, parent: 0 },
    { name: "K3", group: true, parent: 1 },
    { name: "K4", parent: 2 },
    { name: "R3" },
    { name: "Z", group: true },
    { name: "Z1", parent: 5 },
    { name: "Z0", group: true },
  ];

  it("普通层挂 K3 可以（3 + 0）", () => {
    const h = setup(specs);
    h.layer(4).setParent(h.layer(2));
    expect(h.state.layers.get(4)!.parent).toBe(2);
    expect(h.state.childrenOf(2)).toEqual([3, 4]);
  });

  it("没有子层的组合层挂 K3 失败（3 + 1）：抛 Invalid parent configuration.，之后父是 null、本地字段不动", () => {
    const h = setup(specs);
    h.layer(7).origin = new Vec(3, 4, 0);
    expect(() => h.layer(7).setParent(h.layer(2))).toThrow("Invalid parent configuration.");
    expect(h.state.layers.get(7)!.parent).toBeNull();
    expect(h.state.layers.get(7)!.origin).toEqual([3, 4, 0]);
    expect(h.layer(7).getParent()).toBeNull();
    expect(h.state.childrenOf(2)).toEqual([3]);
    // 失败也通知宿主（它已离开旧父、父置空）
    expect(h.changes).toEqual([{ object: 7, oldParent: null, oldBone: null, parent: null, bone: null }]);
  });

  it("带子层的组合层挂 K3 失败（3 + 1），挂 K2 可以（2 + 1）；失败时已从旧父摘掉", () => {
    const h = setup(specs);
    h.layer(5).setParent(h.layer(1));
    expect(h.state.layers.get(5)!.parent).toBe(1);
    const g = setup(specs);
    g.layer(6).setParent(g.layer(2)); // 普通层先挂 K3：Z1 离开 Z
    expect(g.state.childrenOf(5)).toEqual([]);
    const f = setup(specs);
    expect(() => f.layer(5).setParent(f.layer(2))).toThrow("Invalid parent configuration.");
    expect(f.state.layers.get(5)!.parent).toBeNull();
    expect(f.state.childrenOf(5)).toEqual([6]);
  });

  it("从旧父换到超限的新父失败后，旧父的子表里已没有它", () => {
    const h = setup([...specs.slice(0, 3), { name: "Z0", group: true, parent: 3 - 3 }]);
    // Z0 在 K1 下（up = 1），换到 K3 下（up = 3，down = 1）超限
    expect(() => h.layer(3).setParent(h.layer(2))).toThrow("Invalid parent configuration.");
    expect(h.state.childrenOf(0)).toEqual([1]);
    expect(h.state.layers.get(3)!.parent).toBeNull();
  });
});

describe("setParent：adjust 数学（rea-p6d3-adjust，逐位对步骤 0 日志）", () => {
  it("s5：Q.setParent(R) 不 adjust → a；Q.setParent(P, false, true) → b；Q.setParent(undefined, true) → c", () => {
    // 0 = G（960, 540）、1 = R（G 的子）、2 = P（500, 300，z 0.5，缩放 2,1,1）、3 = Q（P 的子，60, 30，z 0.25，缩放 1,1.5,1）
    const h = setup([
      { name: "G", origin: [960, 540, 0] },
      { name: "R", origin: [1150, 540, 0], parent: 0 },
      { name: "P", origin: [500, 300, 0], angles: [0, 0, 0.5], scale: [2, 1, 1] },
      { name: "Q", origin: [60, 30, 0], angles: [0, 0, 0.25], scale: [1, 1.5, 1], parent: 2 },
    ]);
    const q = h.layer(3);
    q.setParent(h.layer(1));
    bits(
      mOf(q),
      [
        0.9689124226570129, 0.24740396440029144, 0, 0, -0.37110593914985657, 1.4533686637878418, 0, 0, 0, 0, 1, 0, 2170,
        1110, 0, 1,
      ],
      "s5 mat a",
    );
    q.setParent(h.layer(2), false, true);
    const state = h.state.layers.get(3)!;
    bits(
      mOf(q),
      [
        0.9312325716018677, 0.3644257187843323, 0, 0, -0.041757404804229736, 1.4994186162948608, 0, 0, 0, 0, 1, 0, 2170,
        1110, 0, 1,
      ],
      "s5 mat b",
    );
    bits(state.origin, [926.9488525390625, -89.79876708984375, 0], "s5 origin b");
    bits(state.angles.map(radiansToScript), [0, 0, -14.323946952819824], "s5 angles b");
    bits(state.scale, [0.5118875503540039, 1.3787450790405273, 1], "s5 scale b");
    // 3×3 由角度重建（rotateObjectSpace 乘出来的那份清掉）
    expect(state.rotation ?? null).toBeNull();
    // 同父同挂点再 adjust：什么都不做
    const before = [...state.origin];
    q.setParent(h.layer(2), true);
    bits(state.origin, before, "s5 same parent");
    q.setParent(undefined, true);
    bits(
      mOf(q),
      [
        0.9689124226570129, 0.24740394949913025, 0, 0, -0.3711059093475342, 1.4533686637878418, 0, 0, 0, 0, 1, 0, 2170,
        1110, 0, 1,
      ],
      "s5 mat c",
    );
    bits(state.origin, [2170, 1110, 0], "s5 origin c");
    bits(state.angles.map(radiansToScript), [0, 0, 14.323944091796875], "s5 angles c");
    bits(state.scale, [1, 1.5, 1], "s5 scale c");
    // 每次换父都通知宿主，挂点都是 null
    expect(h.changes.map((c) => [c.object, c.oldParent, c.parent, c.bone])).toEqual([
      [3, 2, 1, null],
      [3, 1, 2, null],
      [3, 2, null, null],
    ]);
  });

  it("s2：R2（1600,700，z 0.3，缩放 1.5,1,1）挂进 H（1500,700）带 adjust：世界矩阵保持，origin 变成 (100, 0, 0)", () => {
    const h = setup([
      { name: "H", origin: [1500, 700, 0], group: true },
      { name: "R2", origin: [1600, 700, 0], angles: [0, 0, 0.3], scale: [1.5, 1, 1] },
    ]);
    const want = [
      1.4330047369003296, 0.44328033924102783, 0, 0, -0.29552021622657776, 0.9553365111351013, 0, 0, 0, 0, 1, 0, 1600,
      700, 0, 1,
    ];
    bits(mOf(h.layer(1)), want, "s2 before");
    h.layer(1).setParent(h.layer(0), true);
    bits(mOf(h.layer(1)), want, "s2 after");
    bits(h.state.layers.get(1)!.origin, [100, 0, 0], "s2 origin");
    expect(h.state.childrenOf(0)).toEqual([1]);
  });

  it("glmInverse：单位阵与平移矩阵的逆", () => {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = 3;
    m[13] = -4;
    const inv = glmInverse(m);
    expect(Array.from(inv).map(nz)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, 4, 0, 1]);
  });
});

describe("setParent：挂点（P12 的挂点表）", () => {
  const specs: LayerSpec[] = [
    {
      name: "body",
      origin: [700, 500, 0],
      attachments: [
        { name: "tipA", bone: 0 },
        { name: "tipB", bone: 1 },
      ],
    },
    { name: "img", origin: [20, 30, 0], angles: [0, 0, 0.5], scale: [2, 3, 1] },
  ];

  it("字符串挂点名与整数下标都挂上，本地字段不动；记进结构的挂点名", () => {
    const h = setup(specs);
    h.layer(1).setParent(h.layer(0), "tipA");
    expect(h.changes).toEqual([{ object: 1, oldParent: null, oldBone: null, parent: 0, bone: "tipA" }]);
    expect(h.state.layers.get(1)!.origin).toEqual([20, 30, 0]);
    h.layer(1).setParent(h.layer(0), 1);
    expect(h.changes[1]).toEqual({ object: 1, oldParent: 0, oldBone: "tipA", parent: 0, bone: "tipB" });
    // 同父同挂点：直接返回
    h.layer(1).setParent(h.layer(0), "tipB");
    expect(h.changes.length).toBe(2);
    // 取不到的挂点名 / 下标当没有挂点
    h.layer(1).setParent(h.layer(0), "nosuch");
    expect(h.changes[2]).toEqual({ object: 1, oldParent: 0, oldBone: "tipB", parent: 0, bone: null });
    h.layer(1).setParent(h.layer(0), 9);
    expect(h.changes.length).toBe(3);
  });

  it("带 adjust 与挂点：origin 与 angles 归零、缩放不变", () => {
    const h = setup(specs);
    h.layer(1).setParent(h.layer(0), "tipB", true);
    const state = h.state.layers.get(1)!;
    bits(state.origin, [0, 0, 0], "origin");
    bits(state.angles, [0, 0, 0], "angles");
    bits(state.scale, [2, 3, 1], "scale");
    expect(state.rotation ?? null).toBeNull();
    // 整数下标 + adjust（第三参）
    const g = setup(specs);
    g.layer(1).setParent(g.layer(0), 0, true);
    bits(g.state.layers.get(1)!.origin, [0, 0, 0], "origin（整数下标）");
    expect(g.changes[0].bone).toBe("tipA");
  });

  it("读结构里的挂点名：运行中换过父的取最后一条（改挂同一个父、不带挂点算变了）", () => {
    const h = setup(specs);
    h.layer(1).setParent(h.layer(0), "tipA");
    h.layer(1).setParent(h.layer(0));
    expect(h.changes[1]).toEqual({ object: 1, oldParent: 0, oldBone: "tipA", parent: 0, bone: null });
  });
});

describe("按名字解析图层的缓存（3662790108 每帧几百次 getLayer('名字')）：先查一次进缓存，结构、改名、待编对象变了之后拿到新结果", () => {
  const specs = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "B", id: 99 }, { name: "E", id: 7 }];

  it("对象表顺序变了（sortLayer，structureVersion 加一）：取新的第一个同名", () => {
    const h = setup(specs);
    expect(h.scene.getLayer("B")).toBe(h.layer(1));
    expect(h.scene.sortLayer(3, 0)).toBe(true);
    expect(h.scene.getLayer("B")).toBe(h.layer(3));
    expect(h.scene.getLayerIndex("B")).toBe(0);
  });

  it("脚本改名：找不到的名字缓存成 null 之后改名能找到，旧名字找不到；名字优先于 id", () => {
    const h = setup(specs);
    expect(h.scene.getLayer("Z")).toBeNull();
    h.layer(4).name = "Z";
    expect(h.scene.getLayer("Z")).toBe(h.layer(4));
    expect(h.scene.getLayer("E")).toBeNull();
    // 没有同名时按 strtol 当 id：「99」先命中 id 99 的对象 3，再有对象改名成「99」后按名字取它
    expect(h.scene.getLayer("99")).toBe(h.layer(3));
    h.layer(0).name = "99";
    expect(h.scene.getLayer("99")).toBe(h.layer(0));
  });

  it("图层被原地换掉（L6 重编译：登记表 splice、状态 structureVersion 加一）：按新图层的名字找", () => {
    const h = setup(specs);
    expect(h.scene.getLayer("C")).toBe(h.layer(2));
    h.bundle.layers.splice(2, 1, { ...h.bundle.layers[2], name: "Q" } as SceneLayer);
    h.state.structureVersion++;
    expect(h.scene.getLayer("Q")).toBe(h.layer(2));
    expect(h.scene.getLayer("C")).toBeNull();
  });

  it("命中的对象之后才标待删：缓存只记对象，待删每次照常判断（名字 null，getLayerIndex 不看待删）", () => {
    const h = setup(specs);
    expect(h.scene.getLayer("C")).toBe(h.layer(2));
    h.scene.destroyLayer(2);
    expect(h.scene.getLayer("C")).toBeNull();
    expect(h.scene.getLayerIndex("C")).toBe(2);
  });
});
