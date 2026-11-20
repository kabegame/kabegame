// P6d3a 点 5、点 4：`ScriptRuntime.destroyObjects`（派发 destroy、摘条目、计时器、重放表）与宿主 / 探针共用的 `settleDestroyed`、
// 结构记录；L7 起换父与删除不再判断要不要重编译，改测组内不支持组合的跟踪（`groupSelfIssues` / `trackGroupIssues`）。
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
  addShellObject,
  createStructureObject,
  groupSelfIssues,
  recordDestroyed,
  recordReparent,
  settleDestroyed,
  trackGroupIssues,
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
  it("待删生效：摘表，脚本收 destroy，宿主 removed 收到对象（L7 起不再判组归属）", () => {
    const { state } = sceneOf();
    const destroyed: number[][] = [];
    const removed: number[][] = [];
    state.markDestroy(3);
    const out = settleDestroyed(state, {
      runtime: { destroyObjects: (objects) => destroyed.push([...objects]) },
      removed: (objects) => removed.push(objects),
    });
    expect(out).toEqual([3]);
    expect(destroyed).toEqual([[3]]);
    expect(removed).toEqual([[3]]);
    expect(state.layers.has(3)).toBe(false);
    // 删组合层：同样只交对象，子层变根
    state.markDestroy(0);
    settleDestroyed(state, { removed: (objects) => removed.push(objects) });
    expect(removed[1]).toEqual([0]);
    expect(state.layers.get(1)!.parent).toBeNull();
  });

  it("没有待删时什么都不调", () => {
    const { state } = sceneOf();
    let called = 0;
    expect(
      settleDestroyed(state, {
        runtime: { destroyObjects: () => void called++ },
        removed: () => void called++,
      }),
    ).toEqual([]);
    expect(called).toBe(0);
    expect(state.structureVersion).toBe(0);
  });
});

describe("组内不支持组合（L7，groupSelfIssues / trackGroupIssues）", () => {
  const layer = (object: number, extra: Partial<SceneLayer> = {}) =>
    ({ object, passthroughModel: false, subtree: [], ...extra }) as SceneLayer;

  it("groupSelfIssues：只有成了组（组合层且子树非空）才报，键同编译期；透视场景（P13h）、被依赖（P8 步骤 7）不再报", () => {
    const group = { passthroughModel: true, subtree: [2], dependedOn: true, fogPassthrough: true as const };
    expect(groupSelfIssues(group)).toEqual(["fog:group"]);
    expect(groupSelfIssues({ ...group, fogPassthrough: undefined })).toEqual([]);
    expect(groupSelfIssues({ ...group, subtree: [] })).toEqual([]);
    expect(groupSelfIssues({ ...group, passthroughModel: false })).toEqual([]);
    expect(groupSelfIssues({ passthroughModel: true, subtree: [2] })).toEqual([]);
  });

  it("trackGroupIssues：新出现的进 added 并记下；键不变时不再报；问题消失进 cleared；删掉的只摘", () => {
    const tracked = new Map<number, string[]>();
    const layers = [layer(1, { passthroughModel: true, subtree: [2] }), layer(2), layer(3)];
    const issues = new Map([[2, ["model:passthrough:children:fullscreen"]]]);
    let out = trackGroupIssues(tracked, { changed: new Set([1, 2]), issues }, layers);
    expect([...out.added]).toEqual([[2, ["model:passthrough:children:fullscreen"]]]);
    expect(out.cleared).toEqual([]);
    // 再来一次（同一批问题，2 不在 changed 里也照样看，因为它已记下）：不再报
    out = trackGroupIssues(tracked, { changed: new Set([3]), issues }, layers);
    expect(out.added.size).toBe(0);
    // 出组：问题消失
    out = trackGroupIssues(tracked, { changed: new Set([1, 2]), issues: new Map() }, layers);
    expect(out.cleared).toEqual([2]);
    expect(tracked.size).toBe(0);
    // 加载时就有、派生量没变过的组内问题不管（dev 强制渲染才走得到）
    out = trackGroupIssues(tracked, { changed: new Set(), issues }, layers);
    expect(out.added.size).toBe(0);
    // 记下之后对象被删（不在图层表里）：只摘，不进 cleared
    trackGroupIssues(tracked, { changed: new Set([2]), issues }, layers);
    out = trackGroupIssues(tracked, { changed: new Set(), issues: new Map() }, [layers[0]]);
    expect(out.cleared).toEqual([]);
    expect(tracked.size).toBe(0);
  });

  it("trackGroupIssues：组自身的条件并进组的键（组合层成了组且开雾）；键变了重报；被依赖不算（P8 步骤 7）", () => {
    const tracked = new Map<number, string[]>();
    const group = layer(1, { passthroughModel: true, subtree: [2], dependedOn: true });
    let out = trackGroupIssues(tracked, { changed: new Set([1]), issues: new Map() }, [group]);
    expect(out.added.size).toBe(0);
    group.fogPassthrough = true;
    out = trackGroupIssues(tracked, { changed: new Set([1]), issues: new Map() }, [group]);
    expect([...out.added]).toEqual([[1, ["fog:group"]]]);
    out = trackGroupIssues(tracked, { changed: new Set([1]), issues: new Map([[1, ["x:y"]]]) }, [group]);
    expect([...out.added]).toEqual([[1, ["fog:group", "x:y"]]]);
  });
});

describe("结构记录", () => {
  it("recordDestroyed 追加去重，并去掉被删对象自己的换父记录", () => {
    const structure: SceneStructure = {
      destroyed: [],
      created: [],
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

  it("recordDestroyed 去重（L5）：删掉新建对象时，同一规整配置的更早的已删新建对象从 created 与 destroyed 摘掉；每种配置留一个", () => {
    const config = (id: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ image: "models/a.json", alpha: 0.5, ...extra, id });
    const structure: SceneStructure = {
      destroyed: [],
      parents: [],
      created: [
        { object: 5, config: config(1) },
        // 键序不同、id 不同：规整后同一配置
        { object: 6, config: JSON.stringify({ id: 2, alpha: 0.5, image: "models/a.json" }) },
        { object: 7, config: config(3, { name: "other" }) },
        { object: 8, config: config(4) },
      ],
    };
    recordDestroyed(structure, [5]);
    expect(structure.created.map((item) => item.object)).toEqual([5, 6, 7, 8]);
    recordDestroyed(structure, [6]);
    // 5 与 6 同配置、都已删：摘掉更早的 5
    expect(structure.created.map((item) => item.object)).toEqual([6, 7, 8]);
    expect(structure.destroyed).toEqual([6]);
    // 配置不同的不动；8 还活着时 6 不受影响
    recordDestroyed(structure, [7]);
    expect(structure.created.map((item) => item.object)).toEqual([6, 7, 8]);
    recordDestroyed(structure, [8]);
    expect(structure.created.map((item) => item.object)).toEqual([7, 8]);
    expect(structure.destroyed).toEqual([7, 8]);
    // 加载时的对象（不在 created 里）照旧只追加
    recordDestroyed(structure, [0]);
    expect(structure.destroyed).toEqual([7, 8, 0]);
  });

  it("addShellObject：按给定下标建壳、不分配、不记结构；createStructureObject 分配下标并记结构", () => {
    const { state } = sceneOf();
    const structure: SceneStructure = { destroyed: [], parents: [], created: [] };
    const allocator = { next: 6 };
    expect(addShellObject(state, 9, '{"image":"models/a.json","origin":"1 2 3"}', null)).toBe(true);
    expect(state.layers.get(9)!.origin).toEqual([1, 2, 3]);
    expect(state.order.at(-1)).toBe(9);
    expect(allocator.next).toBe(6);
    expect(addShellObject(state, 10, "{", null)).toBe(false);
    expect(createStructureObject(state, structure, allocator, '{"image":"b"}', 9)).toBe(6);
    expect(allocator.next).toBe(7);
    expect(state.layers.get(6)!.parent).toBe(9);
    expect(state.childrenOf(9)).toEqual([6]);
    expect(structure.created).toEqual([{ object: 6, config: '{"image":"b"}' }]);
    // 配置不是 JSON：不分配、不记
    expect(createStructureObject(state, structure, allocator, "nope", null)).toBeNull();
    expect(allocator.next).toBe(7);
  });

  it("recordReparent：同一个对象只留最后一条，位置在最后", () => {
    const structure: SceneStructure = { destroyed: [], parents: [], created: [] };
    recordReparent(structure, 1, 0, null);
    recordReparent(structure, 2, 0, "tip");
    recordReparent(structure, 1, null, null);
    expect(structure.parents).toEqual([
      [2, 0, "tip"],
      [1, null, null],
    ]);
  });
});
