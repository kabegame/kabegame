/**
 * 活的场景图 L5 点 3：运行中建层的两条路（`script/createLayerChange.ts` 的 `LiveObjects`），接进场景的那一侧换成记调用的替身。
 * - 命中缓存：改键（新下标、id、父）→ adopt → 同步备好 → 装上，都在 `create` 返回之前；同步备不好、文本层排 install，下一次 drain 装上；
 * - 没命中：排 create → 会话编 → 到达（场景级增量进登记表、预热）→ drain：adopt → GPU → 进缓存；到达前已删只进缓存；
 * - sceneFlips、编失败、装失败 → reload；不支持项：不装 GPU、上报、计数；
 * - `rebindFragment`：不挂脚本的目标写当前属性值、挂脚本的不写；`configBone`。
 */
import { describe, expect, it } from "vitest";
import type { SceneLayer } from "../compile/bundle";
import type { FragmentDelta, FragmentRequest, ObjectFragment } from "../compile/fragment";
import { fragmentKey } from "../fragmentCache";
import { configBone, LiveObjects, rebindFragment, type LiveTarget } from "./createLayerChange";

const TEMPLATE_CONFIG = { name: "bar", image: "models/a.json", origin: "1 2 3" };
const KEY = fragmentKey(JSON.stringify(TEMPLATE_CONFIG))!;
const configOf = (id: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...TEMPLATE_CONFIG, ...extra, id });

function fragment(object: number, extra: Partial<ObjectFragment> = {}): ObjectFragment {
  return {
    object,
    config: KEY,
    layer: {
      object,
      id: 100,
      parent: null,
      group: null,
      subtree: [],
      effects: [],
      text: null,
    } as unknown as SceneLayer,
    bindings: [],
    scripts: [
      {
        id: `objects/${object}/alpha`,
        target: { kind: "layer", object, field: "alpha" },
        owner: { kind: "layer", object },
        layer: object,
      },
    ],
    animations: [],
    reflected: false,
    sceneFlips: [],
    audio: false,
    media: false,
    unsupported: [],
    ...extra,
  } as unknown as ObjectFragment;
}
const deltaOf = (fragmentValue: ObjectFragment): FragmentDelta => ({
  fragment: fragmentValue,
  programs: { from: 0, list: [] },
  textures: { from: 0, list: [] },
  userTextures: { from: 0, list: [] },
  bindings: [],
  assetPaths: [],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 记调用的接入替身：`alive` 看 `objects`；GPU 的同步备好可以设成 null（缺程序）、抛错。 */
function harness(
  options: {
    compile?: (request: FragmentRequest) => Promise<FragmentDelta>;
    prepareSync?: "ok" | "null" | "throw";
    install?: "ok" | "throw";
    gpu?: boolean;
  } = {},
) {
  const log: string[] = [];
  const objects = new Set<number>();
  const adopted: ObjectFragment[] = [];
  const reloads: string[] = [];
  const unsupported: string[][] = [];
  const requests: FragmentRequest[] = [];
  let sync = options.prepareSync ?? "ok";
  const target: LiveTarget<{ layer: SceneLayer; tag: string }> = {
    alive: (object) => objects.has(object),
    applyDelta: (delta) => void log.push(`applyDelta ${delta.fragment.object}`),
    adopt: (input) => {
      log.push(`adopt ${input.fragment.object}`);
      adopted.push(input.fragment);
      return Promise.resolve();
    },
    gpu: () => options.gpu ?? true,
    prepareSync: (layer) => {
      log.push(`prepareSync ${layer.object}`);
      if (sync === "throw") throw new Error("坏计划");
      return sync === "null" ? null : { layer, tag: "sync" };
    },
    prepare: async (layer) => {
      log.push(`prepare ${layer.object}`);
      return { layer, tag: "async" };
    },
    install: (prepared) => {
      log.push(`install ${prepared.layer.object} ${prepared.tag}`);
      if (options.install === "throw") throw new Error("装不上");
    },
    discard: (prepared) => void log.push(`discard ${prepared.layer.object} ${prepared.tag}`),
    warm: async (layer) => void log.push(`warm ${layer.object}`),
    unsupported: (_object, keys) => void unsupported.push([...keys]),
    reload: (reason) => void reloads.push(reason),
    properties: () => ({ p: 1 }),
  };
  const live = new LiveObjects(
    target,
    options.compile ??
      (async (request) => {
        requests.push(request);
        return deltaOf(fragment(request.object));
      }),
  );
  return {
    live,
    log,
    objects,
    adopted,
    reloads,
    unsupported,
    requests,
    setSync: (value: "ok" | "null" | "throw") => (sync = value),
  };
}

describe("LiveObjects 命中缓存", () => {
  it("改键（新下标、配置里的 id、父）→ adopt → 同步备好 → 装上，都在 create 返回之前；计数 sync", () => {
    const { live, log, objects, adopted } = harness();
    live.cache.put(KEY, fragment(2));
    objects.add(7);
    // 配置原文的 id 与键序都和模板不同，规整后同键
    const result = live.create(7, JSON.stringify({ id: 42, origin: "1 2 3", image: "models/a.json", name: "bar" }), 3);
    expect(result).toBe("sync");
    expect(log).toEqual(["adopt 7", "prepareSync 7", "install 7 sync"]);
    expect(adopted[0].object).toBe(7);
    expect(adopted[0].layer).toMatchObject({ object: 7, id: 42, parent: 3 });
    expect(adopted[0].scripts[0].id).toBe("objects/7/alpha");
    expect(live.stats).toEqual({ sync: 1, async: 0, unsupported: 0 });
    // 缓存里的模板不变
    expect(live.cache.get(KEY)!.object).toBe(2);
  });

  it("同步备不好（缺程序）：异步备，排 install，下一次 drain 按现在的状态同步再备（备得好就装它、放弃异步的）；计数 async", async () => {
    const { live, log, objects, setSync } = harness({ prepareSync: "null" });
    live.cache.put(KEY, fragment(2));
    objects.add(7);
    expect(live.create(7, configOf(42), null)).toBe("pending");
    await live.settled();
    setSync("ok");
    live.drain();
    expect(log).toEqual([
      "adopt 7",
      "prepareSync 7",
      "prepare 7",
      "prepareSync 7",
      "discard 7 async",
      "install 7 sync",
    ]);
    expect(live.stats).toEqual({ sync: 0, async: 1, unsupported: 0 });
  });

  it("文本层：一律异步（等排版）；装之前对象删了就放弃", async () => {
    const { live, log, objects } = harness();
    const text = fragment(2);
    text.layer.text = {} as never;
    live.cache.put(KEY, text);
    objects.add(7);
    expect(live.create(7, configOf(42), null)).toBe("pending");
    await live.settled();
    objects.delete(7);
    live.drain();
    expect(log).toEqual(["adopt 7", "prepare 7", "discard 7 async"]);
  });

  it("不支持项：adopt 照做、不装 GPU、上报键、计数 unsupported", () => {
    const { live, log, objects, unsupported } = harness();
    live.cache.put(KEY, fragment(2, { unsupported: ["effect:x"] }));
    objects.add(7);
    expect(live.create(7, configOf(42), null)).toBe("unsupported");
    expect(log).toEqual(["adopt 7"]);
    expect(unsupported).toEqual([["effect:x"]]);
    expect(live.stats).toEqual({ sync: 0, async: 0, unsupported: 1 });
  });

  it("装 GPU 出错（备的时候抛、装的时候抛）：reload", () => {
    const first = harness({ prepareSync: "throw" });
    first.live.cache.put(KEY, fragment(2));
    first.objects.add(7);
    expect(first.live.create(7, configOf(42), null)).toBe("reload");
    expect(first.reloads).toHaveLength(1);
    const second = harness({ install: "throw" });
    second.live.cache.put(KEY, fragment(2));
    second.objects.add(7);
    expect(second.live.create(7, configOf(42), null)).toBe("reload");
    expect(second.reloads).toHaveLength(1);
  });

  it("没有 GPU 场景（首次加载 init 期间）：只 adopt", () => {
    const { live, log, objects } = harness({ gpu: false });
    live.cache.put(KEY, fragment(2));
    objects.add(7);
    live.create(7, configOf(42), null);
    expect(log).toEqual(["adopt 7"]);
  });

  it("配置没有 id、是数组：不查缓存，排给会话", () => {
    const { live, requests } = harness();
    live.cache.put(KEY, fragment(2));
    expect(live.create(7, JSON.stringify(TEMPLATE_CONFIG), null)).toBe("queued");
    expect(live.create(8, "[]", null)).toBe("queued");
    expect(requests.map((request) => request.object)).toEqual([7, 8]);
  });
});

describe("LiveObjects 没命中", () => {
  it("排 create：请求带配置原文、父、挂点骨骼、当前属性；到达时场景级增量进登记表、预热；drain 时 adopt → GPU → 进缓存；计数 async", async () => {
    const { live, log, objects, requests } = harness();
    objects.add(7);
    const config = configOf(42, { attachment: "head" });
    expect(live.create(7, config, 3)).toBe("queued");
    expect(requests).toEqual([{ object: 7, config, parent: 3, bone: "head", properties: { p: 1 } }]);
    await live.settled();
    expect(log).toEqual(["applyDelta 7", "warm 7"]);
    live.drain();
    expect(log).toEqual(["applyDelta 7", "warm 7", "adopt 7", "prepareSync 7", "install 7 sync"]);
    expect(live.stats).toEqual({ sync: 0, async: 1, unsupported: 0 });
    // 进缓存：再建同一配置命中（不再要片段）
    const key = fragmentKey(config)!;
    expect(live.cache.get(key)!.object).toBe(7);
    objects.add(8);
    expect(live.create(8, configOf(43, { attachment: "head" }), null)).toBe("sync");
    expect(requests).toHaveLength(1);
  });

  it("没有父时不带挂点骨骼", () => {
    const { live, requests } = harness();
    live.create(7, configOf(42, { attachment: "head" }), null);
    expect(requests[0].bone).toBeNull();
  });

  it("到达前对象已删：只进缓存，不预热、不 adopt、不装", async () => {
    const { live, log } = harness();
    live.create(7, configOf(42), null);
    await live.settled();
    live.drain();
    expect(log).toEqual(["applyDelta 7"]);
    expect(live.cache.get(KEY)!.object).toBe(7);
  });

  it("缓存里的是装入之前的一份：装入后改图层的位置字段不影响缓存", async () => {
    const { live, objects, adopted } = harness();
    objects.add(7);
    live.create(7, configOf(42), null);
    await live.settled();
    live.drain();
    adopted[0].layer.group = 5;
    adopted[0].layer.parent = 9;
    expect(live.cache.get(KEY)!.layer).toMatchObject({ group: null, parent: null });
  });

  it("sceneFlips：reload，不进缓存", async () => {
    const { live, objects, reloads } = harness({
      compile: async (request) => deltaOf(fragment(request.object, { sceneFlips: ["lights"] })),
    });
    objects.add(7);
    live.create(7, configOf(42), null);
    await live.settled();
    live.drain();
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toContain("lights");
    expect(live.cache.has(KEY)).toBe(false);
  });

  it("编片段失败：reload", async () => {
    const { live, objects, reloads } = harness({
      compile: async () => {
        throw new Error("会话坏了");
      },
    });
    objects.add(7);
    live.create(7, configOf(42), null);
    await live.settled();
    live.drain();
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toContain("会话坏了");
  });

  it("dispose：排着的放弃、备好的交还 discard、缓存清空，之后 drain 不做事", async () => {
    const { live, log, objects } = harness({ prepareSync: "null" });
    live.cache.put(KEY, fragment(2));
    objects.add(7);
    live.create(7, configOf(42), null);
    await live.settled();
    live.dispose();
    expect(log.at(-1)).toBe("discard 7 async");
    expect(live.cache.size).toBe(0);
    expect(live.drain()).toBe(0);
  });
});

describe("rebindFragment / configBone", () => {
  it("不挂脚本的目标写当前属性值；挂脚本的不写；needsRecompile 挡下的不写", () => {
    const writes: unknown[] = [];
    const state = {
      needsRecompile: (binding: { target: { field?: string } }) => binding.target.field === "visible",
      write: (binding: { target: unknown }, value: unknown) => void writes.push([binding.target, value]),
    };
    const fragmentValue = fragment(7, {
      bindings: [
        { property: "c", target: { kind: "layer", object: 7, field: "color" } },
        { property: "p", target: { kind: "layer", object: 7, field: "alpha" } },
        { property: "v", target: { kind: "layer", object: 7, field: "visible" } },
      ],
    } as Partial<ObjectFragment>);
    const properties = new Map([
      ["c", { type: "color", value: "1 0 0" }],
      ["p", { type: "slider", value: 0.3 }],
      ["v", { type: "bool", value: false }],
    ]);
    expect(rebindFragment(state as never, fragmentValue, properties)).toBe(1);
    expect(writes).toEqual([[{ kind: "layer", object: 7, field: "color" }, "1 0 0"]]);
  });

  it("configBone：骨骼名取配置原文的 attachment，override 看 structure.parents", () => {
    const bundle = { configs: [null, JSON.stringify({ attachment: "head" }), "{}"] };
    expect(configBone(bundle, { parents: [[1, 0, null]] }, 1)).toEqual({ name: "head", override: true });
    expect(configBone(bundle, { parents: [] }, 2)).toEqual({ name: null, override: false });
  });
});
