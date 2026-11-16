/**
 * 活的场景图 L3a：登记表（`compile/registry.ts`）的单测，手写的小 bundle，无 GPU。
 * - `applyDelta` 错位抛错、正常追加；
 * - 灯槽分配（和 `compileLightObjects` 一致）、删一盏后新灯拿到空出的槽；
 * - 关键帧联动的 `parent` 跨增删重排；
 * - `replaceObject` 留位置、条目留在按所属对象排序的位置、灯槽与粒子序号沿用；
 * - `particleOrdinal`（先后、删后不回收）、`cameraLayers`、反射名单、`emptyOf` 不动原 bundle；
 * - `restructure`：同步 `parent`、换父进组 / 出组、挂点（`override` 真 / 假）、组内 effect 标记加上与去掉、返回组内问题。
 * 全语料对照在 `ignore/live/l3/registry.test.ts`。
 */
import { describe, expect, it } from "vitest";
import type { SceneAnimation } from "../animation/types";
import { generalDefaults, type SceneBinding } from "./bindings";
import { GROUP_CHILD_FRAMEBUFFER } from "./features";
import type { SceneBundle, SceneEffect, SceneLayer } from "./bundle";
import type { ObjectFragment } from "./fragment";
import { compileLightObjects, type SceneLightObject } from "./lights";
import { particleFov } from "./particles";
import { BLOOM_DEFAULTS } from "./postprocess";
import { SceneRegistry } from "./registry";
import type { SceneScript } from "./scripts";
import { SceneState } from "../render/state";

// ———— 手写的 bundle 与片段 ————

function layerOf(object: number, partial: Partial<SceneLayer> = {}): SceneLayer {
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
    ...partial,
  } as SceneLayer;
}

function bundleOf(layers: SceneLayer[] = []): SceneBundle {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers,
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const scriptOf = (object: number, name = "origin"): SceneScript =>
  ({ id: `objects/${object}/${name}`, errors: [], source: "" }) as unknown as SceneScript;

const bindingOf = (object: number, field = "alpha"): SceneBinding =>
  ({ property: `p${object}`, target: { kind: "layer", object, field } }) as unknown as SceneBinding;

const animationOf = (object: number | null, name: string, parent: number | null = null): SceneAnimation =>
  ({
    id: `objects/${object}/${name}`,
    object,
    owner: `objects/${object}`,
    parent,
    name,
  }) as unknown as SceneAnimation;

function lightOf(object: number): SceneLightObject {
  return {
    object,
    light: "lpoint",
    kind: "point",
    legacy: true,
    legacySlot: -1,
    flags: 0,
    castVolumetrics: false,
    values: {},
  } as unknown as SceneLightObject;
}

function fragmentOf(object: number, partial: Partial<ObjectFragment> = {}): ObjectFragment {
  return {
    object,
    config: `{"n":${object}}`,
    layer: layerOf(object),
    bindings: [],
    scripts: [],
    animations: [],
    reflected: false,
    sceneFlips: [],
    audio: false,
    media: false,
    unsupported: [],
    ...partial,
  };
}

const objectsOf = (registry: SceneRegistry) => registry.bundle.layers.map((layer) => layer.object);
const NO_BONES = () => ({ name: null, override: false });

describe("applyDelta", () => {
  const empty = {
    programs: { from: 0, list: [] },
    textures: { from: 0, list: [] },
    userTextures: { from: 0, list: [] },
    bindings: [],
    assetPaths: [],
  };

  it("正常追加，错位抛错", () => {
    const registry = new SceneRegistry(bundleOf());
    registry.applyDelta({
      ...empty,
      programs: { from: 0, list: [{ id: "a" } as never, { id: "b" } as never] },
      assetPaths: ["scripts/a.js"],
    });
    registry.applyDelta({
      ...empty,
      programs: { from: 2, list: [{ id: "c" } as never] },
      assetPaths: ["scripts/a.js", "scripts/b.js"],
    });
    expect(registry.bundle.programs.length).toBe(3);
    expect(registry.bundle.assetPaths).toEqual(["scripts/a.js", "scripts/b.js"]);
    const ok = { ...empty, programs: { from: 3, list: [] } };
    expect(() => registry.applyDelta({ ...empty, programs: { from: 2, list: [] } })).toThrow(/programs/);
    expect(() => registry.applyDelta({ ...ok, textures: { from: 1, list: [] } })).toThrow(/textures/);
    expect(() => registry.applyDelta({ ...ok, userTextures: { from: 3, list: [] } })).toThrow(/userTextures/);
    // 抛错不改任何表
    expect(registry.bundle.programs.length).toBe(3);
  });
});

describe("灯槽", () => {
  it("和 compileLightObjects 的分配一致（含满槽取 0）", () => {
    const registry = new SceneRegistry(bundleOf());
    const objects = [0, 1, 2, 3, 4, 5, 6];
    for (const object of objects) registry.addObject(fragmentOf(object, { light: lightOf(object) }));
    const expected = compileLightObjects(
      objects.map(() => ({ light: "point" })),
      () => undefined,
    ).map((light) => light.legacySlot);
    expect(registry.bundle.lightObjects!.map((light) => light.legacySlot)).toEqual(expected);
    expect(expected).toEqual([0, 1, 2, 3, 0, 0, 0]);
  });

  it("删一盏后新灯拿到空出的槽；删光后键消失", () => {
    const registry = new SceneRegistry(bundleOf());
    for (const object of [0, 1, 2]) registry.addObject(fragmentOf(object, { light: lightOf(object) }));
    registry.removeObject(1);
    registry.addObject(fragmentOf(7, { light: lightOf(7) }));
    const slots = new Map(registry.bundle.lightObjects!.map((light) => [light.object, light.legacySlot]));
    expect(slots.get(7)).toBe(1);
    expect(slots.get(0)).toBe(0);
    expect(slots.get(2)).toBe(2);
    // 灯表按 objects 顺序
    expect(registry.bundle.lightObjects!.map((light) => light.object)).toEqual([0, 2, 7]);
    for (const object of [0, 2, 7]) registry.removeObject(object);
    expect(registry.bundle.lightObjects).toBeUndefined();
  });
});

describe("关键帧联动的 parent", () => {
  /** 对象 `object` 的两条关键帧，第二条联动到第一条（片段内下标 0）。 */
  const pairOf = (object: number): SceneAnimation[] => [animationOf(object, "a"), animationOf(object, "b", 0)];

  it("加进来时 parent 换成表内下标，删除后重排", () => {
    const registry = new SceneRegistry(bundleOf());
    for (const object of [1, 2, 3]) registry.addObject(fragmentOf(object, { animations: pairOf(object) }));
    const list = () => registry.bundle.animations!;
    expect(list().map((item) => item.parent)).toEqual([null, 0, null, 2, null, 4]);
    registry.removeObject(2);
    expect(list().map((item) => `${item.object}:${item.name}:${item.parent}`)).toEqual([
      "1:a:null",
      "1:b:0",
      "3:a:null",
      "3:b:2",
    ]);
    registry.removeObject(1);
    expect(list().map((item) => item.parent)).toEqual([null, 0]);
  });

  it("插回中间的对象时，后面联动的父跟着后移", () => {
    const registry = new SceneRegistry(bundleOf());
    for (const object of [1, 3]) registry.addObject(fragmentOf(object, { animations: pairOf(object) }));
    registry.addObject(fragmentOf(2, { animations: pairOf(2) }));
    // 2 比 3 小，插在 1 与 3 之间
    expect(registry.bundle.animations!.map((item) => `${item.object}:${item.name}:${item.parent}`)).toEqual([
      "1:a:null",
      "1:b:0",
      "2:a:null",
      "2:b:2",
      "3:a:null",
      "3:b:4",
    ]);
  });

  it("场景级（object 为 null）的关键帧在 emptyOf 里保留并重排下标", () => {
    const bundle = bundleOf([layerOf(1)]);
    bundle.animations = [
      animationOf(null, "g"),
      animationOf(1, "x"),
      animationOf(null, "h", 0),
      animationOf(1, "y", 1),
    ];
    const registry = SceneRegistry.emptyOf(bundle);
    expect(registry.bundle.animations!.map((item) => `${item.name}:${item.parent}`)).toEqual(["g:null", "h:0"]);
    // 不动原 bundle
    expect(bundle.animations.map((item) => item.parent)).toEqual([null, null, 0, 1]);
  });
});

describe("replaceObject", () => {
  it("图层留在原位置，别的表条目留在按对象排序的位置，灯槽与粒子序号沿用", () => {
    const registry = new SceneRegistry(bundleOf());
    const particle = { id: "p" } as never;
    for (const object of [1, 2, 3])
      registry.addObject(
        fragmentOf(object, {
          layer: layerOf(object, object === 2 ? { particle } : {}),
          scripts: [scriptOf(object)],
          bindings: [bindingOf(object)],
          animations: [animationOf(object, "a")],
          light: lightOf(object),
          sound: { object, volume: 1 } as never,
        }),
      );
    registry.addObject(fragmentOf(4, { layer: layerOf(4, { particle }) }));
    expect(registry.particleOrdinal(2)).toBe(0);
    expect(registry.particleOrdinal(4)).toBe(1);
    const before = JSON.stringify([
      registry.bundle.scripts.list,
      registry.bundle.bindings,
      registry.bundle.animations,
      registry.bundle.lightObjects,
      registry.bundle.sounds,
    ]);
    const versionBefore = registry.version;
    registry.replaceObject(
      fragmentOf(2, {
        layer: layerOf(2, { particle }),
        scripts: [scriptOf(2)],
        bindings: [bindingOf(2)],
        animations: [animationOf(2, "a")],
        light: lightOf(2),
        sound: { object: 2, volume: 1 } as never,
      }),
    );
    expect(objectsOf(registry)).toEqual([1, 2, 3, 4]);
    expect(
      JSON.stringify([
        registry.bundle.scripts.list,
        registry.bundle.bindings,
        registry.bundle.animations,
        registry.bundle.lightObjects,
        registry.bundle.sounds,
      ]),
    ).toBe(before);
    expect(registry.particleOrdinal(2)).toBe(0);
    expect(registry.particleOrdinal(4)).toBe(1);
    expect(registry.version).toBeGreaterThan(versionBefore);
    expect(() => registry.replaceObject(fragmentOf(9))).toThrow();
    expect(() => registry.addObject(fragmentOf(2))).toThrow();
  });

  it("新片段换了内容：旧条目消失、新条目进来", () => {
    const registry = new SceneRegistry(bundleOf());
    registry.addObject(fragmentOf(1, { scripts: [scriptOf(1, "origin")], config: "old" }));
    registry.addObject(fragmentOf(2, { scripts: [scriptOf(2)] }));
    registry.replaceObject(fragmentOf(1, { scripts: [scriptOf(1, "alpha"), scriptOf(1, "scale")], config: "new" }));
    expect(registry.bundle.scripts.list.map((script) => script.id)).toEqual([
      "objects/1/alpha",
      "objects/1/scale",
      "objects/2/origin",
    ]);
    expect(registry.bundle.configs![1]).toBe("new");
  });
});

describe("登记表的派生量", () => {
  it("particleOrdinal 按加入先后、删后不回收", () => {
    const particle = { id: "p" } as never;
    const registry = new SceneRegistry(bundleOf());
    registry.addObject(fragmentOf(5, { layer: layerOf(5, { particle }) }));
    registry.addObject(fragmentOf(1));
    registry.addObject(fragmentOf(3, { layer: layerOf(3, { particle }) }));
    expect([registry.particleOrdinal(5), registry.particleOrdinal(3), registry.particleOrdinal(1)]).toEqual([0, 1, 0]);
    registry.removeObject(5);
    registry.addObject(fragmentOf(7, { layer: layerOf(7, { particle }) }));
    expect(registry.particleOrdinal(7)).toBe(2);
    expect(registry.particleOrdinal(3)).toBe(1);
    // 构造时按 bundle.layers 的顺序编号
    const fresh = new SceneRegistry(bundleOf([layerOf(2), layerOf(4, { particle }), layerOf(6, { particle })]));
    expect([fresh.particleOrdinal(4), fresh.particleOrdinal(6)]).toEqual([0, 1]);
  });

  it("cameraLayers 随增删变", () => {
    const camera = { fov: 50, zoom: 1 } as never;
    const registry = new SceneRegistry(bundleOf());
    expect(registry.cameraLayers()).toEqual([]);
    registry.addObject(fragmentOf(1, { layer: layerOf(1, { camera }) }));
    registry.addObject(fragmentOf(2));
    registry.addObject(fragmentOf(3, { layer: layerOf(3, { camera }) }));
    expect(registry.cameraLayers().map((layer) => layer.object)).toEqual([1, 3]);
    const cached = registry.cameraLayers();
    expect(registry.cameraLayers()).toBe(cached);
    registry.removeObject(1);
    expect(registry.cameraLayers().map((layer) => layer.object)).toEqual([3]);
  });

  it("反射名单：开着时随片段的 reflected 维护，没开平面反射为 null", () => {
    const off = new SceneRegistry(bundleOf());
    expect(off.reflectionList()).toBeNull();
    const bundle = bundleOf();
    bundle.reflection = { planar: true, enabled: true, list: [] };
    const registry = new SceneRegistry(bundle);
    registry.addObject(fragmentOf(4, { reflected: true }));
    registry.addObject(fragmentOf(2));
    registry.addObject(fragmentOf(1, { reflected: true }));
    expect(registry.reflectionList()).toEqual([1, 4]);
    registry.removeObject(4);
    expect(registry.reflectionList()).toEqual([1]);
    const disabled = bundleOf();
    disabled.reflection = { planar: true };
    expect(new SceneRegistry(disabled).reflectionList()).toBeNull();
  });

  it("emptyOf 不动原 bundle，场景级条目保留", () => {
    const bundle = bundleOf([layerOf(1), layerOf(2)]);
    bundle.bindings = [
      bindingOf(1),
      { property: "g", target: { kind: "bloom", field: "strength" } } as unknown as SceneBinding,
    ];
    bundle.scripts.list = [scriptOf(1), { id: "general/x", errors: [], source: "" } as unknown as SceneScript];
    bundle.configs = ["a", "b", "c"];
    bundle.programs = [{ id: "p" } as never];
    const registry = SceneRegistry.emptyOf(bundle);
    expect(registry.bundle.layers).toEqual([]);
    expect(registry.bundle.bindings.map((binding) => binding.property)).toEqual(["g"]);
    expect(registry.bundle.scripts.list.map((script) => script.id)).toEqual(["general/x"]);
    // 对象 1、2 是图层，配置清掉；对象 0 不是图层，保留
    expect(registry.bundle.configs).toEqual(["a", null, null]);
    expect(registry.bundle.programs).toEqual(bundle.programs);
    expect(registry.bundle.programs).not.toBe(bundle.programs);
    expect(bundle.layers.length).toBe(2);
    expect(bundle.bindings.length).toBe(2);
    expect(bundle.configs).toEqual(["a", "b", "c"]);
    registry.addObject(fragmentOf(1));
    expect(bundle.layers.length).toBe(2);
  });

  it("removeObject：不在返回 false，configs 保留", () => {
    const registry = new SceneRegistry(bundleOf());
    registry.addObject(fragmentOf(3));
    expect(registry.removeObject(9)).toBe(false);
    expect(registry.removeObject(3)).toBe(true);
    expect(registry.bundle.configs![3]).toBe('{"n":3}');
    expect(objectsOf(registry)).toEqual([]);
  });
});

describe("restructure", () => {
  /** 带 passthrough 模型（组合层）的图层。 */
  const groupLayer = (object: number, partial: Partial<SceneLayer> = {}) =>
    layerOf(object, { passthroughModel: true, ...partial });

  function setup(layers: SceneLayer[]) {
    const registry = SceneRegistry.emptyOf(bundleOf());
    const state = SceneState.fromBundle(registry.bundle);
    for (const layer of layers) {
      registry.addObject(fragmentOf(layer.object, { layer }));
      state.addObject({ layer });
    }
    return { registry, state };
  }

  it("运行中换父进组、出组、删父：parent 同步，group / subtree / children 重算", () => {
    const { registry, state } = setup([groupLayer(1), layerOf(2), layerOf(3, { parent: 2 })]);
    registry.restructure(state, NO_BONES);
    const byObject = (object: number) => registry.bundle.layers.find((layer) => layer.object === object)!;
    expect(byObject(2).group).toBeNull();
    // 2 挂到组 1 下，3 是 2 的子：整棵进组
    state.setParent(2, 1);
    registry.restructure(state, NO_BONES);
    expect(byObject(2).parent).toBe(1);
    expect(byObject(2).group).toBe(1);
    expect(byObject(3).group).toBe(1);
    expect(byObject(1).subtree).toEqual([2, 3]);
    expect(registry.bundle.children).toEqual([
      [1, [2]],
      [2, [3]],
    ]);
    // 出组
    state.setParent(2, null);
    registry.restructure(state, NO_BONES);
    expect(byObject(2).parent).toBeNull();
    expect(byObject(2).group).toBeNull();
    expect(byObject(3).group).toBeNull();
    expect(byObject(1).subtree).toEqual([]);
    expect(registry.bundle.children).toEqual([[2, [3]]]);
    // 删父：flushDestroy 让子变根
    state.setParent(3, 1);
    registry.restructure(state, NO_BONES);
    expect(byObject(3).group).toBe(1);
    state.markDestroy(1);
    state.flushDestroy();
    state.dropObject(1);
    registry.removeObject(1);
    registry.restructure(state, NO_BONES);
    expect(byObject(3).parent).toBeNull();
    expect(byObject(3).group).toBeNull();
  });

  it("子表顺序决定组内先序（换父挂上的追加在尾）", () => {
    const { registry, state } = setup([groupLayer(1), layerOf(2), layerOf(3)]);
    state.setParent(3, 1);
    state.setParent(2, 1);
    registry.restructure(state, NO_BONES);
    expect(registry.bundle.layers.find((layer) => layer.object === 1)!.subtree).toEqual([3, 2]);
  });

  /** 一个有骨骼 `head` 的 puppet 父层。 */
  const puppetParent = (object: number) =>
    layerOf(object, {
      puppet: {
        skeleton: { parents: new Int32Array([-1, 0]) },
        layers: [],
        attachments: [{ name: "head", bone: 1, matrix: new Float32Array(16) }],
      } as never,
    });

  it("挂点：父排在前面时有，override 假时父排在后面不挂，override 真时允许", () => {
    const { registry, state } = setup([
      puppetParent(0),
      layerOf(1, { parent: 0 }),
      layerOf(2),
      layerOf(3, { parent: 2 }),
    ]);
    const byObject = (object: number) => registry.bundle.layers.find((layer) => layer.object === object)!;
    const head = (object: number) => (object === 1 || object === 3 ? { name: "head", override: false } : NO_BONES());
    registry.restructure(state, head);
    expect(byObject(1).attachment?.bone).toBe(1);
    expect(byObject(1).attachment?.parent).toBe(0);
    // 3 的父 2 不是 puppet：不挂
    expect(byObject(3).attachment).toBeUndefined();
    // 换成父排在后面（puppet 2 号位）：override 假不挂，真才挂
    const later = setup([layerOf(0, { parent: 1 }), puppetParent(1)]);
    const parentLater = (override: boolean) => (object: number) =>
      object === 0 ? { name: "head", override } : NO_BONES();
    later.registry.restructure(later.state, parentLater(false));
    expect(later.registry.bundle.layers[0].attachment).toBeUndefined();
    later.registry.restructure(later.state, parentLater(true));
    expect(later.registry.bundle.layers[0].attachment?.parent).toBe(1);
    // 骨骼名换成找不到的：挂点去掉
    later.registry.restructure(later.state, (object) => (object === 0 ? { name: "tail", override: true } : NO_BONES()));
    expect(later.registry.bundle.layers[0].attachment).toBeUndefined();
    // 出组 / 换父后不再有父：挂点去掉
    state.setParent(1, null);
    registry.restructure(state, head);
    expect(byObject(1).attachment).toBeUndefined();
  });

  /** 一个只在读快照时才能打开的 effect。 */
  const framebufferEffect = (enabled: boolean, unsupported: string[] = []): SceneEffect =>
    ({
      source: 0,
      id: 1,
      name: "e",
      file: "e.json",
      fbos: [],
      steps: [{ kind: "draw", pass: { key: "k", framebuffer: true } }],
      enabled,
      visibleBound: false,
      unsupported,
    }) as unknown as SceneEffect;

  it("进组 / 出组后状态的 effect 开关表跟着变：needsRecompile 随之变，运行中写的 enabled 不动", () => {
    const { registry, state } = setup([groupLayer(1), layerOf(2, { effects: [framebufferEffect(false)] })]);
    const open = { property: "p", target: { kind: "effect", object: 2, effect: 0 } } as unknown as SceneBinding;
    registry.restructure(state, NO_BONES);
    expect(state.needsRecompile(open, true)).toBe(false);
    state.setParent(2, 1);
    registry.restructure(state, NO_BONES);
    expect(state.needsRecompile(open, true)).toBe(true);
    expect(state.effectEnabled(2, 0)).toBe(false);
    // 出组：不再要求重编译；运行中写成开（enabled 为 true）之后再进组、出组，enabled 都保持
    state.setParent(2, null);
    registry.restructure(state, NO_BONES);
    expect(state.needsRecompile(open, true)).toBe(false);
    expect(state.write(open, true)).toBe("applied");
    expect(state.effectEnabled(2, 0)).toBe(true);
    state.setParent(2, 1);
    registry.restructure(state, NO_BONES);
    expect(state.effectEnabled(2, 0)).toBe(true);
    expect(state.needsRecompile(open, false)).toBe(false);
  });

  it("组内图层的 effect 标记：进组加上（关着的）、出组去掉，启用的 effect 报进返回值", () => {
    const off = framebufferEffect(false);
    const on = framebufferEffect(true);
    const { registry, state } = setup([groupLayer(1), layerOf(2, { effects: [off] }), layerOf(3, { effects: [on] })]);
    const effectsOf = (object: number) => registry.bundle.layers.find((layer) => layer.object === object)!.effects;
    expect(registry.restructure(state, NO_BONES).size).toBe(0);
    state.setParent(2, 1);
    state.setParent(3, 1);
    const issues = registry.restructure(state, NO_BONES);
    expect(effectsOf(2)[0].unsupported).toEqual([GROUP_CHILD_FRAMEBUFFER]);
    // 启用的 effect 读快照：对象级问题，不记在 effect 上
    expect(effectsOf(3)[0].unsupported).toEqual([]);
    expect([...issues]).toEqual([[3, [GROUP_CHILD_FRAMEBUFFER]]]);
    // effect 对象不原地改：原来的两个 effect 保持原样
    expect(off.unsupported).toEqual([]);
    expect(on.unsupported).toEqual([]);
    // 再调一次：不重复加
    registry.restructure(state, NO_BONES);
    expect(effectsOf(2)[0].unsupported).toEqual([GROUP_CHILD_FRAMEBUFFER]);
    // 出组去掉
    state.setParent(2, null);
    registry.restructure(state, NO_BONES);
    expect(effectsOf(2)[0].unsupported).toEqual([]);
  });

  it("状态里没有的图层不改 parent；children 只含登记表里的对象", () => {
    const registry = SceneRegistry.emptyOf(bundleOf());
    const state = SceneState.fromBundle(registry.bundle);
    registry.addObject(fragmentOf(1, { layer: layerOf(1, { parent: 9 }) }));
    registry.restructure(state, NO_BONES);
    expect(registry.bundle.layers[0].parent).toBe(9);
    state.addObject({ layer: layerOf(1, { parent: 9 }) });
    state.addObject({ layer: layerOf(2, { parent: 1 }) });
    registry.restructure(state, NO_BONES);
    expect(registry.bundle.children).toEqual([]);
  });
});
