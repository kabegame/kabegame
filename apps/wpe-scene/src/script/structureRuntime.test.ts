// P6d3a 点 5、点 4：`ScriptRuntime.destroyObjects`（派发 destroy、摘条目、计时器、重放表）与宿主 / 探针共用的 `settleDestroyed`、
// 换父与删除是否要重编译的判断、结构记录。
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneStructure } from "../compile/protocol";
import type { SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import { ScriptRuntime, type ScriptRealm } from "./runtime";
import {
  destroyNeedsRecompile,
  recordDestroyed,
  recordReparent,
  reparentNeedsRecompile,
  settleDestroyed,
} from "./structure";

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = {};
  prototypes = { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  modules = new Map<string, Record<string, unknown>>();
  async prepareModule(_source: string, label: string): Promise<ScriptModule> {
    return fakeModule(this.modules.get(label) ?? {});
  }
  dispose() {}
}

const script = (id: string, overrides: Partial<SceneScript> = {}): SceneScript => ({
  id,
  source: "",
  target: { kind: "layer", object: 0, field: "alpha" },
  valueType: "float",
  initial: 1,
  owner: { kind: "layer", object: 0 },
  layer: 0,
  scriptProperties: null,
  imports: [],
  errors: [],
  ...overrides,
});

const report = { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} };

/** 图层 0 与 1 各一段字段脚本；1 另有一段 effect 的脚本；2 的脚本不导出 destroy。 */
function harness() {
  const realm = new FakeRealm();
  const events: string[] = [];
  const writes: string[] = [];
  const timers: string[] = [];
  const runtime = new ScriptRuntime(realm, {
    report,
    write(target, _value, source) {
      const key =
        target.kind === "layer"
          ? `objects/${target.object}/${target.field}`
          : target.kind === "effect"
            ? `objects/${target.object}/effects/${target.effect}/visible`
            : source;
      writes.push(`${key}:${source}`);
      return true;
    },
    read: () => null,
  });
  const list: SceneScript[] = [
    script("objects/0/alpha"),
    script("objects/1/alpha", {
      target: { kind: "layer", object: 1, field: "alpha" },
      owner: { kind: "layer", object: 1 },
      layer: 1,
    }),
    script("objects/1/effects/0/visible", {
      target: { kind: "effect", object: 1, effect: 0 },
      valueType: "bool",
      owner: { kind: "effect", object: 1, effect: 0 },
      layer: 1,
    }),
    script("objects/2/alpha", {
      target: { kind: "layer", object: 2, field: "alpha" },
      owner: { kind: "layer", object: 2 },
      layer: 2,
    }),
  ];
  for (const item of list.slice(0, 3))
    realm.modules.set(item.id, {
      init: () => (events.push(`init:${item.id}`), 0.5),
      update: () => (events.push(`update:${item.id}`), item.valueType === "bool" ? true : 0.7),
      destroy: () => void events.push(`destroy:${item.id}`),
    });
  realm.modules.set("objects/2/alpha", { update: () => (events.push("update:objects/2/alpha"), 0.2) });
  return { runtime, realm, events, writes, timers, list };
}

describe("ScriptRuntime.destroyObjects（点 5）", () => {
  it("属主在集合里的条目（图层字段、effect）按条目顺序收 destroy，之后摘掉；别的对象不动", async () => {
    const h = harness();
    await h.runtime.load({ list: h.list } as never);
    h.runtime.frame(0.016);
    h.events.length = 0;
    h.runtime.destroyObjects(new Set([1]));
    expect(h.events).toEqual(["destroy:objects/1/alpha", "destroy:objects/1/effects/0/visible"]);
    expect((h.runtime.diagnostics as { id: string }[]).map((item) => item.id)).toEqual([
      "objects/0/alpha",
      "objects/2/alpha",
    ]);
    h.events.length = 0;
    h.runtime.frame(0.016);
    expect(h.events).toEqual(["update:objects/0/alpha", "update:objects/2/alpha"]);
    // 空集合什么都不做
    h.runtime.destroyObjects(new Set());
    expect(h.runtime.diagnostics.length).toBe(2);
  });

  it("没导出 destroy 的不调；没跑 init 的（求值失败）不调", async () => {
    const h = harness();
    h.realm.modules.set("objects/1/alpha", { update: () => 1 });
    h.list[2].errors = ["导入说明符无效"];
    await h.runtime.load({ list: h.list } as never);
    h.events.length = 0;
    h.runtime.destroyObjects(new Set([1]));
    expect(h.events).toEqual([]);
    expect((h.runtime.diagnostics as { id: string }[]).map((item) => item.id)).toEqual([
      "objects/0/alpha",
      "objects/2/alpha",
    ]);
  });

  it("摘条目的计时器一并去掉，别的脚本的计时器保留", async () => {
    const h = harness();
    await h.runtime.load({ list: h.list } as never);
    h.runtime.setTimeout(() => h.timers.push("one"), 100, "objects/1/alpha");
    h.runtime.setInterval(() => h.timers.push("zero"), 100, "objects/0/alpha");
    h.runtime.setTimeout(() => h.timers.push("fx"), 100, "objects/1/effects/0/visible");
    expect(h.runtime.timerCount).toBe(3);
    h.runtime.destroyObjects(new Set([1]));
    expect(h.runtime.timerCount).toBe(1);
    h.runtime.frame(0.2);
    expect(h.timers).toEqual(["zero"]);
    // 摘掉的脚本 id 不能再登记计时器
    expect(() => h.runtime.setTimeout(() => {}, 1, "objects/1/alpha")).toThrow();
  });

  it("重放表里键以 objects/<i>/ 开头的项去掉（objects/1 不误伤 objects/12）", async () => {
    const h = harness();
    await h.runtime.load({ list: h.list } as never);
    h.runtime.frame(0.016);
    h.runtime.rememberWrite({ kind: "layer", object: 12, field: "alpha" }, [0.4]);
    h.writes.length = 0;
    h.runtime.replayWrites();
    expect(h.writes.sort()).toEqual(
      [
        "objects/0/alpha:script-replay",
        "objects/1/alpha:script-replay",
        "objects/12/alpha:script-replay",
        "objects/1/effects/0/visible:script-replay",
        "objects/2/alpha:script-replay",
      ].sort(),
    );
    h.runtime.destroyObjects(new Set([1]));
    h.writes.length = 0;
    h.runtime.replayWrites();
    expect(h.writes.sort()).toEqual(
      ["objects/0/alpha:script-replay", "objects/12/alpha:script-replay", "objects/2/alpha:script-replay"].sort(),
    );
  });
});

// ———— settleDestroyed 与判断函数 ————

/** 0 = 组 K（组合层）、1 = 子层、2 = 另一个子层、3 = 根上的普通层、4 = 组 Z（空组）、5 = 根上另一个普通层。1、2 的父是 0。 */
function sceneOf(): { bundle: SceneBundle; state: SceneState } {
  const layers = [
    { object: 0, parent: null, group: null, passthroughModel: true },
    { object: 1, parent: 0, group: 0, passthroughModel: false },
    { object: 2, parent: 0, group: 0, passthroughModel: false },
    { object: 3, parent: null, group: null, passthroughModel: false },
    { object: 4, parent: null, group: null, passthroughModel: true },
    { object: 5, parent: null, group: null, passthroughModel: false },
  ].map(
    (spec) =>
      ({
        id: spec.object + 1,
        name: `L${spec.object}`,
        origin: [0, 0, 0],
        scale: [1, 1, 1],
        angles: [0, 0, 0],
        size: [10, 10],
        alpha: 1,
        color: [1, 1, 1],
        brightness: 1,
        visible: true,
        parallaxDepth: [1, 1],
        effects: [],
        passes: [],
        camera: null,
        ...spec,
      }) as unknown as SceneLayer,
  );
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
    layers,
    programs: [],
    textures: [],
    bindings: [],
    scripts: { list: [] },
    children: [[0, [1, 2]]],
  } as unknown as SceneBundle;
  return { bundle, state: SceneState.fromBundle(bundle) };
}

describe("settleDestroyed（宿主与探针共用）", () => {
  it("待删生效：先判组归属再摘表，脚本收 destroy，宿主 removed 收到对象与 regroup", () => {
    const { bundle, state } = sceneOf();
    const destroyed: number[][] = [];
    const removed: [number[], boolean][] = [];
    state.markDestroy(3);
    const out = settleDestroyed(state, {
      runtime: { destroyObjects: (objects) => destroyed.push([...objects]) },
      bundle,
      removed: (objects, regroup) => removed.push([objects, regroup]),
    });
    expect(out).toEqual([3]);
    expect(destroyed).toEqual([[3]]);
    expect(removed).toEqual([[[3], false]]);
    expect(state.layers.has(3)).toBe(false);
    // 删组合层：regroup 为真
    state.markDestroy(0);
    settleDestroyed(state, { bundle, removed: (objects, regroup) => removed.push([objects, regroup]) });
    expect(removed[1]).toEqual([[0], true]);
    expect(state.layers.get(1)!.parent).toBeNull();
  });

  it("没有待删时什么都不调", () => {
    const { bundle, state } = sceneOf();
    let called = 0;
    expect(
      settleDestroyed(state, {
        runtime: { destroyObjects: () => void called++ },
        bundle,
        removed: () => void called++,
      }),
    ).toEqual([]);
    expect(called).toBe(0);
    expect(state.structureVersion).toBe(0);
  });
});

describe("reparentNeedsRecompile / destroyNeedsRecompile（宁可多编）", () => {
  const input = (
    scene: ReturnType<typeof sceneOf>,
    object: number,
    oldParent: number | null,
    parent: number | null,
    oldBone: string | null = null,
    bone: string | null = null,
  ) => ({ ...scene, object, oldParent, parent, oldBone, bone });

  it("普通层在两个普通父之间换：不要", () => {
    const scene = sceneOf();
    expect(reparentNeedsRecompile(input(scene, 3, null, 5))).toBe(false);
    expect(reparentNeedsRecompile(input(scene, 3, 5, null))).toBe(false);
  });

  it("挂点在换父前后有一边不为空：要", () => {
    const scene = sceneOf();
    expect(reparentNeedsRecompile(input(scene, 3, null, 1, null, "tip"))).toBe(true);
    expect(reparentNeedsRecompile(input(scene, 3, 1, 3, "tip", null))).toBe(true);
  });

  it("新父或旧父是组合层、父链上有组合层、自己的子树里有组：要", () => {
    const scene = sceneOf();
    expect(reparentNeedsRecompile(input(scene, 3, null, 0))).toBe(true);
    expect(reparentNeedsRecompile(input(scene, 1, 0, null))).toBe(true);
    // 3 挂到 1：1 自己不是组，但它的父链上有组 0
    expect(reparentNeedsRecompile(input(scene, 3, null, 1))).toBe(true);
    // 1 离开组之后，3 挂到 1 不再要
    scene.state.setParent(1, null);
    expect(reparentNeedsRecompile(input(scene, 3, null, 1))).toBe(false);
    // 组 4 自己带着子树换父
    expect(reparentNeedsRecompile(input(scene, 4, null, 3))).toBe(true);
  });

  it("删除：组合层、在组里的层（有 group）、有在组里的子孙的层要；根上的普通层不要", () => {
    const scene = sceneOf();
    expect(destroyNeedsRecompile(scene.state, scene.bundle, [3])).toBe(false);
    expect(destroyNeedsRecompile(scene.state, scene.bundle, [0])).toBe(true);
    expect(destroyNeedsRecompile(scene.state, scene.bundle, [1])).toBe(true);
    expect(destroyNeedsRecompile(scene.state, scene.bundle, [4])).toBe(true);
    expect(destroyNeedsRecompile(scene.state, null, [0])).toBe(false);
  });
});

describe("结构记录", () => {
  it("recordDestroyed 追加去重，并去掉被删对象自己的换父记录", () => {
    const structure: SceneStructure = {
      destroyed: [],
      parents: [
        [1, 0, null],
        [2, 0, "tip"],
      ],
    };
    recordDestroyed(structure, [1, 3]);
    recordDestroyed(structure, [3]);
    expect(structure.destroyed).toEqual([1, 3]);
    expect(structure.parents).toEqual([[2, 0, "tip"]]);
  });

  it("recordReparent：同一个对象只留最后一条，位置在最后", () => {
    const structure: SceneStructure = { destroyed: [], parents: [] };
    recordReparent(structure, 1, 0, null);
    recordReparent(structure, 2, 0, "tip");
    recordReparent(structure, 1, null, null);
    expect(structure.parents).toEqual([
      [2, 0, "tip"],
      [1, null, null],
    ]);
  });
});
