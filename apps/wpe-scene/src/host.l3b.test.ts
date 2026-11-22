/**
 * L3b 点 6：宿主的两个函数 `addCompiledObject` / `removeObjectEverywhere`（`.claude/plans/wpe-import/3-scene/live/phase-l3b-host-subsystems.md`）。
 * 各子系统桩掉，记调用顺序：
 * - 加：登记表（场景级增量 → 对象）→ 状态 → restructure → 关键帧 → puppet → 文本 → 脚本（refreshScripts → replayWritesFor）→ adoptBundle → …；replace 先摘旧的
 *   （关键帧 L6 起走 replaceObjects，按 id 接回时钟）；
 * - 删：声音 → 文本排版引用 → puppet → 关键帧 → 状态按对象的表 →（structural 才有）登记表 → restructure 一次；
 * - 删除生效处（`onDestroyed`）：L7 起一律摘登记表并 restructure，变了的交给渲染器当帧重排，不再整场重载；
 * - 真的关键帧 / puppet 建删 100 次后不留残留。
 */
import { describe, expect, it, vi } from "vitest";
import type { ObjectFragment } from "./compile/fragment";
import { TEXT_DEFAULTS } from "./text/fields";
import type { ScriptRealm } from "./script/runtime";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./compile/client", () => ({ openSceneSession: vi.fn() }));
const createRealm = vi.fn<() => Promise<ScriptRealm>>();
vi.mock("./script/realm", () => ({ createIframeRealm: () => createRealm(), getJsModuleIndex: () => ({}) }));

const { SceneHost } = await import("./host");
const { SceneAnimations } = await import("./animation/player");
const { ScenePuppets } = await import("./puppet/player");

const report = { ready: vi.fn(), fallback: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type Internals = {
  registry: unknown;
  scriptState: unknown;
  sceneAnimations: unknown;
  scenePuppets: unknown;
  sceneTexts: unknown;
  sceneSounds: unknown;
  runtime: unknown;
  scriptApi: unknown;
  sceneMedia: unknown;
  addCompiledObject(delta: unknown, mode: "add" | "replace"): Promise<void>;
  removeObjectEverywhere(objects: number[], options?: { structural?: boolean }): unknown;
  onDestroyed(objects: number[]): void;
  requestScriptReload(): void;
};

function makeHost() {
  const host = new SceneHost({} as HTMLCanvasElement, { imageId: "1", report }) as unknown as Internals;
  const log: string[] = [];
  const stub = <T extends Record<string, unknown>>(name: string, methods: T): T =>
    Object.fromEntries(
      Object.entries(methods).map(([key, value]) => [
        key,
        typeof value === "function"
          ? (...args: unknown[]) => {
              log.push(`${name}.${key}`);
              return (value as (...args: unknown[]) => unknown)(...args);
            }
          : value,
      ]),
    ) as T;
  return { host, log, stub };
}

const fragment = (object: number, extra: Partial<ObjectFragment> = {}): ObjectFragment =>
  ({
    object,
    config: "{}",
    layer: { object, id: object + 1 },
    bindings: [],
    scripts: [{ id: `objects/${object}/alpha` }],
    animations: [],
    reflected: false,
    sceneFlips: [],
    audio: false,
    media: false,
    unsupported: [],
    ...extra,
  }) as unknown as ObjectFragment;

describe("SceneHost.addCompiledObject（L3b）", () => {
  it("add：登记表（场景级增量 → 对象）→ 状态 → restructure → 关键帧 → puppet → 脚本 → adoptBundle，顺序固定", async () => {
    const { host, log, stub } = makeHost();
    const unsupported: string[] = [];
    host.registry = stub("registry", {
      bundle: { unsupported, configs: [], layers: [{ object: 3, subtree: [] }], general: {} },
      applyDelta: () => {},
      addObject: () => {},
      replaceObject: () => {},
      restructure: () => ({
        changed: new Set([3]),
        issues: new Map([[3, ["model:passthrough:children:fullscreen"]]]),
      }),
    });
    host.scriptState = stub("state", {
      texts: new Map(),
      layers: new Map(),
      addObject: () => {},
      replaceObject: () => {},
    });
    host.sceneAnimations = stub("animations", { add: () => {}, removeObjects: () => {} });
    host.scenePuppets = stub("puppets", { add: () => {}, remove: () => {} });
    host.runtime = stub("runtime", { refreshScripts: () => {}, replayWritesFor: () => {} });
    host.scriptApi = stub("api", { adoptBundle: () => {} });
    const delta = {
      fragment: fragment(3),
      programs: { from: 0, list: [] },
      textures: { from: 0, list: [] },
      userTextures: { from: 0, list: [] },
      bindings: [],
    };
    await host.addCompiledObject(delta, "add");
    expect(log).toEqual([
      "registry.applyDelta",
      "registry.addObject",
      "state.addObject",
      "registry.restructure",
      "animations.add",
      "puppets.add",
      "runtime.refreshScripts",
      "runtime.replayWritesFor",
      "api.adoptBundle",
    ]);
    // restructure 返回的组内问题（L7）：不并进整场的不支持项（场景不退回），并进片段的不支持项（`LiveObjects` 据此不装 GPU、上报），记进组内问题表
    expect(unsupported).toEqual([]);
    expect(delta.fragment.unsupported).toEqual(["model:passthrough:children:fullscreen"]);
    expect((host as unknown as { groupIssues: Map<number, string[]> }).groupIssues.get(3)).toEqual([
      "model:passthrough:children:fullscreen",
    ]);
  });

  it("replace：关键帧走 replaceObjects（L6 按 id 接回时钟）、puppet 先摘旧的，登记表与状态走 replace；只给 fragment（没有场景级增量）时不调 applyDelta", async () => {
    const { host, log, stub } = makeHost();
    const previous = { mesh: null } as never;
    host.registry = stub("registry", {
      bundle: { unsupported: [], configs: [], layers: [{ object: 5, subtree: [] }], general: {} },
      applyDelta: () => {},
      addObject: () => {},
      replaceObject: () => {},
      restructure: () => ({ changed: new Set(), issues: new Map() }),
    });
    host.scriptState = stub("state", {
      texts: new Map([[5, previous]]),
      layers: new Map(),
      addObject: () => {},
      replaceObject: () => {},
    });
    host.sceneAnimations = stub("animations", { add: () => {}, removeObjects: () => {}, replaceObjects: () => {} });
    host.scenePuppets = stub("puppets", { add: () => {}, remove: () => {} });
    host.sceneTexts = stub("texts", { releaseLayout: () => {}, layoutInCurrent: async () => null });
    await host.addCompiledObject({ fragment: fragment(5) }, "replace");
    expect(log).toEqual([
      "registry.replaceObject",
      "state.replaceObject",
      "registry.restructure",
      "animations.replaceObjects",
      "puppets.remove",
      "puppets.add",
      // 旧排版的引用放回图集
      "texts.releaseLayout",
    ]);
  });

  it("文本层：排版异步起、回来写状态；对象这时已被删 / 换则放掉引用；返回的 Promise 等它", async () => {
    const { host, stub } = makeHost();
    const setText = vi.fn();
    const layers = new Map<number, unknown>([[7, {}]]);
    const layout = { mesh: null } as never;
    const release = vi.fn();
    host.registry = {
      bundle: { unsupported: [], configs: [], layers: [], general: {} },
      applyDelta() {},
      addObject() {},
      replaceObject() {},
      restructure: () => ({ changed: new Set(), issues: new Map() }),
    };
    host.scriptState = { texts: new Map(), textFields: new Map(), layers, addObject() {}, replaceObject() {}, setText };
    host.sceneTexts = stub("texts", { releaseLayout: release, layoutInCurrent: async () => layout });
    const textFragment = fragment(7, { layer: { object: 7, id: 8, text: {} } as never });
    await host.addCompiledObject({ fragment: textFragment }, "add");
    expect(setText).toHaveBeenCalledWith(7, layout);
    // 排版回来时对象不在状态里了
    layers.delete(7);
    setText.mockClear();
    await host.addCompiledObject({ fragment: textFragment }, "add");
    expect(setText).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(layout);
  });

  it("replace 文本层（L6 换字体）：旧排版先放回状态（旧的运行时照画要读），新排版回来换上之后才放掉旧的；排版不出来时旧的留着", async () => {
    const { host } = makeHost();
    const previous = { mesh: null, tag: "old" } as never;
    const next = { mesh: null, tag: "new" } as never;
    const texts = new Map<number, unknown>([[7, previous]]);
    const layers = new Map<number, unknown>([[7, {}]]);
    const release = vi.fn();
    let answer: (layout: unknown) => void = () => {};
    host.registry = {
      bundle: { unsupported: [], configs: [], layers: [{ object: 7, subtree: [] }], general: {} },
      applyDelta() {},
      addObject() {},
      replaceObject() {},
      restructure: () => ({ changed: new Set(), issues: new Map() }),
    };
    host.scriptState = {
      texts,
      textFields: new Map(),
      layers,
      addObject() {},
      // 同 `SceneState.replaceObject`：清掉这个对象的排版
      replaceObject: () => void texts.delete(7),
      setText: (object: number, layout: unknown) => void texts.set(object, layout),
    };
    host.sceneTexts = {
      releaseLayout: release,
      layoutInCurrent: () => new Promise((resolve) => (answer = resolve)),
    };
    const textFragment = fragment(7, { layer: { object: 7, id: 8, text: {} } as never });
    const done = host.addCompiledObject({ fragment: textFragment }, "replace");
    // 新排版回来之前：状态里仍是旧的，没放
    expect(texts.get(7)).toBe(previous);
    expect(release).not.toHaveBeenCalled();
    answer(next);
    await done;
    expect(texts.get(7)).toBe(next);
    expect(release).toHaveBeenCalledWith(previous);
    expect(release).toHaveBeenCalledTimes(1);
    // 排版不出来（缺字体等）：旧的留在状态里、不放
    release.mockClear();
    const again = host.addCompiledObject({ fragment: textFragment }, "replace");
    answer(null);
    await again;
    expect(texts.get(7)).toBe(next);
    expect(release).not.toHaveBeenCalled();
  });

  it("replace 文本层：排版按编译期字段排，回来时状态里的字段（脚本重放）不同就标脏重排，相同不标（3840287381 切文字模糊后停在初值）", async () => {
    const { host } = makeHost();
    const layers = new Map<number, unknown>([[7, {}]]);
    const textFields = new Map<number, unknown>();
    const touchText = vi.fn();
    host.registry = {
      bundle: { unsupported: [], configs: [], layers: [{ object: 7, subtree: [] }], general: {} },
      applyDelta() {},
      addObject() {},
      replaceObject() {},
      restructure: () => ({ changed: new Set(), issues: new Map() }),
    };
    host.scriptState = {
      texts: new Map(),
      textFields,
      layers,
      addObject() {},
      replaceObject() {},
      setText() {},
      touchText,
    };
    let answer: (layout: unknown) => void = () => {};
    host.sceneTexts = { releaseLayout() {}, layoutInCurrent: () => new Promise((resolve) => (answer = resolve)) };
    const compiled = { ...TEXT_DEFAULTS, text: "MORNING" };
    const textFragment = fragment(7, { layer: { object: 7, id: 8, text: { fields: compiled } } as never });
    // 重放（第 5 步，同步）在排版回来之前把脚本写过的值放回状态
    textFields.set(7, { ...compiled, text: "NIGHT" });
    const done = host.addCompiledObject({ fragment: textFragment }, "replace");
    answer({ mesh: null });
    await done;
    expect(touchText).toHaveBeenCalledWith(7);
    // 状态里的字段和编译期相同：不多排一次
    touchText.mockClear();
    textFields.set(7, { ...compiled });
    const again = host.addCompiledObject({ fragment: textFragment }, "replace");
    answer({ mesh: null });
    await again;
    expect(touchText).not.toHaveBeenCalled();
  });

  it("没有场景（登记表或状态没建）时抛错", () => {
    const { host } = makeHost();
    expect(() => host.addCompiledObject({ fragment: fragment(1) }, "add")).toThrow();
  });
});

describe("SceneHost.removeObjectEverywhere（L3b）", () => {
  function wired() {
    const { host, log, stub } = makeHost();
    host.sceneSounds = stub("sounds", { remove: () => {} });
    host.sceneTexts = stub("texts", { releaseLayout: () => {} });
    host.scenePuppets = stub("puppets", { remove: () => {} });
    host.sceneAnimations = stub("animations", { removeObjects: () => {} });
    host.scriptState = stub("state", { texts: new Map([[1, { mesh: null }]]), dropObject: () => {} });
    host.registry = stub("registry", {
      bundle: { configs: [], layers: [], general: {} },
      removeObject: () => true,
      restructure: () => ({ changed: new Set(), issues: new Map() }),
    });
    return { host, log };
  }

  it("完整形态：声音 → 文本排版 → puppet → 关键帧 → 状态按对象的表 → 登记表 → restructure 一次（最后）", () => {
    const { host, log } = wired();
    host.removeObjectEverywhere([1, 2]);
    expect(log).toEqual([
      "sounds.remove",
      "texts.releaseLayout",
      "puppets.remove",
      "animations.removeObjects",
      "state.dropObject",
      "state.dropObject",
      "registry.removeObject",
      "registry.removeObject",
      "registry.restructure",
    ]);
  });

  it("structural: false：登记表与 restructure 不碰", () => {
    const { host, log } = wired();
    host.removeObjectEverywhere([1, 2], { structural: false });
    expect(log).toEqual([
      "sounds.remove",
      "texts.releaseLayout",
      "puppets.remove",
      "animations.removeObjects",
      "state.dropObject",
      "state.dropObject",
    ]);
    // 空列表什么都不做
    log.length = 0;
    host.removeObjectEverywhere([]);
    expect(log).toEqual([]);
  });

  it("删除生效处（onDestroyed，L7）：一律摘登记表并 restructure 一次，不重载；照旧记结构、停声音；restructured 加一", () => {
    const { host, log } = wired();
    const reload = vi.fn();
    host.requestScriptReload = reload;
    host.onDestroyed([1]);
    expect(log).toEqual([
      "sounds.remove",
      "texts.releaseLayout",
      "puppets.remove",
      "animations.removeObjects",
      "state.dropObject",
      "registry.removeObject",
      "registry.restructure",
    ]);
    expect(reload).not.toHaveBeenCalled();
    expect((host as unknown as { structure: { destroyed: number[] } }).structure.destroyed).toEqual([1]);
    expect((host as unknown as { stats: { restructured: number; recompiled: unknown[] } }).stats).toMatchObject({
      restructured: 1,
      recompiled: [],
    });
  });

  it("删除生效处（onDestroyed，L7）：删组时派生量变了的子层交给渲染器（当前场景、渲染器画的正是脚本状态时），不重载", () => {
    const { host } = makeHost();
    const reload = vi.fn();
    host.requestScriptReload = reload;
    const state = { texts: new Map(), dropObject: () => {} };
    const restructure = vi.fn();
    host.scriptState = state;
    host.registry = {
      bundle: { configs: [], layers: [{ object: 2, subtree: [] }], general: {} },
      removeObject: () => true,
      restructure: () => ({ changed: new Set([2]), issues: new Map() }),
    };
    (host as unknown as { renderer: unknown }).renderer = { sceneState: state, restructure, forgetObjects() {} };
    host.onDestroyed([1]);
    expect(restructure).toHaveBeenCalledWith([2]);
    expect((host as unknown as { restructurePending: boolean }).restructurePending).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("真的关键帧 / puppet 建删 100 次：不留残留", () => {
    const { host } = makeHost();
    const animations = new SceneAnimations([]);
    const puppets = new ScenePuppets([]);
    const dropped: number[] = [];
    host.sceneAnimations = animations;
    host.scenePuppets = puppets;
    host.scriptState = { texts: new Map(), dropObject: (object: number) => dropped.push(object) };
    const key = { frame: 0, value: 0, flags: 0, bx: 0, by: 0, fx: 0, fy: 0 };
    for (let i = 0; i < 100; i++) {
      animations.add([
        {
          id: `objects/${i}/alpha`,
          target: { kind: "layer", object: i, field: "alpha" },
          valueType: "float",
          channels: [[key, { ...key, frame: 60, value: 1 }]],
          parent: null,
          events: [],
          writes: true,
          name: "",
          object: i,
          owner: `objects/${i}`,
          inert: false,
          clock: { fps: 30, length: 60, mode: 0, startpaused: false },
        } as never,
      ]);
      animations.control(`objects/${i}/alpha`);
      host.onDestroyed([i]);
    }
    expect(animations.size).toBe(0);
    const inner = animations as unknown as { byId: Map<string, unknown>; controls: Map<string, unknown> };
    expect([inner.byId.size, inner.controls.size]).toEqual([0, 0]);
    expect(puppets.objects().size).toBe(0);
    expect(dropped).toHaveLength(100);
  });
});
