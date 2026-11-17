// P6d3b 点 9–11（运行时半）：`thisScene.createLayer` 的 API、`ScriptRuntime.addScripts` / `refreshScripts` / `currentWorkshopId` 与宿主共用的
// `createStructureObject`。真值：步骤 0（P6d3b）实测日志 `ignore/p6/d3/out/wpe-{bars,clone,order,asset}.log`（序列与下标，逐条对照）。
// 用真 `rewriteModule` + `compileModule`（`vmRealm`）跑真脚本源码，`collectObjectScriptsSync` 收条目，所以克隆的脚本是同一条路径。
import { init } from "es-module-lexer";
import { beforeAll, describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { normalizeConfig } from "../compile/config";
import type { SceneStructure } from "../compile/protocol";
import { collectObjectScriptsSync, type SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import { ScriptApi, type ScriptApiState } from "./api";
import { ScriptRuntime, type ScriptRealm } from "./runtime";
import { readScriptState, writeScriptState } from "./stateWrite";
import { createStructureObject, syncAllocator, type ObjectAllocator } from "./structure";
import { vmRealm } from "./testing/vmRealm";

beforeAll(async () => {
  await init;
});

const report = { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} };

type Json = Record<string, unknown>;

function bundleOf(objects: Json[], assetPaths?: string[], perspective = false): SceneBundle {
  const layers = objects.map(
    (object, index) =>
      ({
        id: typeof object.id === "number" ? object.id : index + 1,
        object: index,
        parent: null,
        name: typeof object.name === "string" ? object.name : "",
        origin: [0, 0, 0],
        scale: [1, 1, 1],
        angles: [0, 0, 0],
        size: [100, 100],
        alpha: 1,
        color: [1, 1, 1],
        brightness: 1,
        visible: true,
        parallaxDepth: [1, 1],
        effects: [],
        passes: [],
        camera: null,
        puppet: null,
        // 图像层（有 `alignment`）才装对齐与骨骼成员
        ...(typeof object.alignment === "string" ? { alignment: object.alignment } : {}),
      }) as unknown as SceneLayer,
  );
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      ...(perspective ? { perspective: true } : {}),
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
    configs: objects.map((object) => normalizeConfig(object)),
    ...(assetPaths ? { assetPaths } : {}),
  } as unknown as SceneBundle;
}

function harness(
  objects: Json[],
  options: {
    assetPaths?: string[];
    perspective?: boolean;
    /** 宿主在 `createLayer` 里建好壳之后再做的事（L5：命中片段缓存时当场把编好的对象接进 bundle） */
    afterCreate?: (object: number, bundle: SceneBundle) => void;
  } = {},
) {
  const vm = vmRealm();
  const logs: string[] = [];
  vm.global.console = { log: (text: string) => logs.push(text), error: (text: string) => logs.push(text) };
  vm.run(`
    class Vec3 {
      constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
      toConfigString() { return this.x + " " + this.y + " " + this.z; }
    }
    globalThis.Vec3 = Vec3;
    globalThis.Vec2 = class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } };
    globalThis.Vec4 = class Vec4 { constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w; } };
  `);
  const stringify = vm.run<(value: unknown) => string>(
    `(value) => JSON.stringify(value, (key, item) => (item && typeof item.toConfigString === "function" ? item.toConfigString() : item))`,
  );
  const ready = new Map<string, Awaited<ReturnType<typeof vm.prepareModule>>>();
  const internal = {
    updateScriptProperties() {},
    convertUserProperties: () => ({}),
    stringifyConfig(this: unknown, value: unknown) {
      return stringify(value);
    },
  };
  const realm: ScriptRealm = {
    global: vm.global,
    prototypes: {
      Vec2: vm.run("Vec2.prototype"),
      Vec3: vm.run("Vec3.prototype"),
      Vec4: vm.run("Vec4.prototype"),
      Mat3: {},
      Mat4: {},
    },
    internal,
    prepareModule(source, label) {
      const task = vm.prepareModule(source, label);
      void task.then((module) => ready.set(source, module));
      return task;
    },
    preparedModule: (source) => ready.get(source) ?? null,
    dispose() {},
  };
  const bundle = bundleOf(objects, options.assetPaths, options.perspective);
  const state = SceneState.fromBundle(bundle);
  const structure: SceneStructure = { destroyed: [], parents: [], created: [] };
  const allocator: ObjectAllocator = { next: 0 };
  const created: number[] = [];
  let runtime!: ScriptRuntime;
  let api!: ScriptApi;
  const access: ScriptApiState = {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write(target, value) {
      if (writeScriptState(state, target, value) === "unsupported") return false;
      runtime.rememberWrite(target, value);
      return true;
    },
    read: (target) => readScriptState(state, target),
    structure: () => structure,
    workshopId: () => runtime.currentWorkshopId(),
    createLayer(config, parent) {
      syncAllocator(allocator, bundle);
      const object = createStructureObject(state, structure, allocator, config, parent);
      if (object !== null) {
        created.push(object);
        options.afterCreate?.(object, bundle);
      }
      return object;
    },
    addScripts: (scripts) => runtime.addScripts(scripts),
  };
  api = new ScriptApi(realm, access);
  runtime = new ScriptRuntime(realm, {
    report,
    write: (target, value) => writeScriptState(state, target, value) !== "unsupported",
    read: (target) => readScriptState(state, target),
    enterScript: (script) => api.enterScript(script),
    setProperties: (full) => api.setProperties(full),
    setModuleEvaluating: (evaluating) => api.setModuleEvaluating(evaluating),
  });
  api.attachRuntime(runtime);
  /** 把 `objects` 里的脚本收成条目（同宿主：路径 `objects/<下标>/…`）。 */
  const scriptsOf = (): SceneScript[] =>
    objects.flatMap((object, index) => collectObjectScriptsSync(object, index, {}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene = api.thisScene as Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (n: number) => api.layer(n) as Record<string, any>;
  return { vm, realm, bundle, state, structure, allocator, created, runtime, api, scene, layer, logs, scriptsOf };
}

const BASE: Json[] = [
  { id: 1, name: "BG" },
  { id: 2, name: "SV" },
  { id: 3, name: "TOP" },
];

describe("createLayer 的返回、下标与整理（wpe-bars / wpe-order 的行）", () => {
  it("新对象追加在对象表尾、名字空串；之后 sortLayer(bar, thisIndex) 把它排到 thisIndex、原位的往后挪（wpe-bars: create i / sort i）", () => {
    const h = harness(BASE);
    const bar = h.scene.createLayer("models/bar.json");
    expect(bar).not.toBeNull();
    expect(h.scene.getLayerIndex(bar)).toBe(3);
    expect(bar.name).toBe("");
    expect(h.scene.getLayerCount()).toBe(4);
    // 第一个 bar 排到 SV（下标 1）的位置：新层在 1，SV 变 2
    expect(h.scene.sortLayer(bar, 1)).toBe(true);
    expect(h.scene.getLayerIndex(bar)).toBe(1);
    expect(h.scene.getLayerIndex(h.layer(1))).toBe(2);
    // 每次建一个、都排到同一个位置：后建的在前（wpe-bars 的 `enum BG,,,,,,,,SV,TOP`）
    const bar2 = h.scene.createLayer("models/bar.json");
    expect(h.scene.getLayerIndex(bar2)).toBe(4);
    h.scene.sortLayer(bar2, 1);
    expect(h.scene.enumerateLayers().map((item: { name: string }) => item.name)).toEqual(["BG", "", "", "SV", "TOP"]);
    expect(h.state.order).toEqual([0, 4, 3, 1, 2]);
  });

  it("下标分配器从原对象数起、只增不复用，记进结构；配置原文是整理后的 JSON，末尾写进建出时发的 id", () => {
    const h = harness(BASE);
    h.scene.createLayer("models/bar.json");
    h.scene.createLayer({ image: "models/a.json", name: "N" });
    expect(h.created).toEqual([3, 4]);
    expect(h.structure.created).toEqual([
      { object: 3, config: '{"image":"models/bar.json","id":4}' },
      { object: 4, config: '{"image":"models/a.json","name":"N","id":5}' },
    ]);
    // 删掉后下标不复用
    h.scene.destroyLayer(4);
    h.state.flushDestroy();
    h.scene.createLayer("models/bar.json");
    expect(h.created).toEqual([3, 4, 5]);
  });

  it("参数整理：无参数 / 多参数是缺省纯色层（正交 solidlayer_depthtest，透视 solidlayer）；Vec3、数字、null 返回 null", () => {
    const h = harness(BASE);
    h.scene.createLayer();
    h.scene.createLayer(1, 2);
    expect(h.structure.created.map((item) => item.config)).toEqual([
      '{"image":"models/util/solidlayer_depthtest.json","id":4}',
      '{"image":"models/util/solidlayer_depthtest.json","id":5}',
    ]);
    const perspective = harness(BASE, { perspective: true });
    perspective.scene.createLayer();
    perspective.scene.createLayer({ color: "1 0 0" });
    expect(perspective.structure.created.map((item) => item.config)).toEqual([
      '{"image":"models/util/solidlayer.json","id":4}',
      JSON.stringify({ color: "1 0 0", image: "models/util/solidlayer.json", id: 5 }),
    ]);
    const vec = h.vm.run("new Vec3(1, 2, 3)");
    for (const bad of [vec, 5, null, undefined, true, "scripts/a.js"])
      expect(h.scene.createLayer(bad), String(bad)).toBeNull();
    // 没建出来的不占下标、不进结构
    expect(h.created).toEqual([3, 4]);
  });

  it("Vec 经 stringifyConfig 变成 'x y z'；数组配置建出空名分组节点，没有 alignment", () => {
    const h = harness(BASE);
    const bar = h.scene.createLayer(h.vm.run('({ image: "models/a.json", origin: new Vec3(1, 2, 3) })'));
    expect(bar).not.toBeNull();
    expect(JSON.parse(h.structure.created[0].config)).toEqual({ image: "models/a.json", origin: "1 2 3", id: 4 });
    expect(h.state.layers.get(3)?.origin).toEqual([1, 2, 3]);
    const group = h.scene.createLayer(h.vm.run("[1]"));
    expect(group).not.toBeNull();
    expect(group.name).toBe("");
    expect(Object.hasOwn(group, "alignment")).toBe(false);
    expect(h.scene.getInitialLayerConfig(group)).toEqual([1]);
  });

  it("图层 name 可写（wpe-clone 的 C1 / C2）：之后按名字查找、enumerateLayers 都用新名字；null / undefined 不写，数字照 ToString", () => {
    const h = harness(BASE);
    const top = h.scene.getLayer("TOP");
    top.name = "T2";
    expect(top.name).toBe("T2");
    expect(h.scene.getLayer("T2")).toBe(top);
    expect(h.scene.getLayer("TOP")).toBeNull();
    const c = h.scene.createLayer("models/bar.json");
    c.name = "C1";
    expect(h.scene.getLayer("C1")).toBe(c);
    expect(h.scene.enumerateLayers().map((item: { name: string }) => item.name)).toEqual(["BG", "SV", "T2", "C1"]);
    c.name = null;
    c.name = undefined;
    expect(c.name).toBe("C1");
    c.name = 5;
    expect(c.name).toBe("5");
  });

  it("待编的图像层与已编译的图像层成员相同（含骨骼方法，wpe-bars 的 bar1 keys）；编译前没有骨骼", () => {
    const h = harness([{ id: 1, name: "SV", alignment: "center" }]);
    const sv = h.scene.getLayer("SV");
    const bar = h.scene.createLayer("models/bar.json");
    expect(Object.keys(bar)).toEqual(Object.keys(sv));
    expect(bar.getBoneCount()).toBe(0);
    expect(Array.from(bar.getBoneTransform(0).m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("getInitialLayerConfig(新层)：去掉 id、键按字典序；name 写进图层名；编进 bundle 后读 bundle.configs", () => {
    const h = harness(BASE);
    const bar = h.scene.createLayer({ name: "N", id: 77, image: "models/a.json", alpha: 0.5 });
    expect(bar.name).toBe("N");
    expect(JSON.stringify(h.scene.getInitialLayerConfig(bar))).toBe('{"alpha":0.5,"image":"models/a.json","name":"N"}');
    expect(h.scene.getInitialLayerConfig(3)).toEqual(h.scene.getInitialLayerConfig(bar));
    // 同一对象上读一份新的（改它不影响下一次）
    h.scene.getInitialLayerConfig(bar).alpha = 9;
    expect(h.scene.getInitialLayerConfig(bar).alpha).toBe(0.5);
  });

  it("id：配置有非 0 数字照用；否则取现有最大 id + 1 起第一个没被占的；getLayerByID 找得到待编对象", () => {
    const h = harness(BASE);
    const a = h.scene.createLayer("models/a.json");
    const b = h.scene.createLayer("models/b.json");
    const c = h.scene.createLayer({ image: "models/c.json", id: 40 });
    const d = h.scene.createLayer({ image: "models/d.json", id: 0 });
    expect(h.scene.getLayerByID("4")).toBe(a);
    expect(h.scene.getLayerByID("5")).toBe(b);
    expect(h.scene.getLayerByID("40")).toBe(c);
    expect(h.scene.getLayerByID("41")).toBe(d);
    expect(h.scene.getLayerByID("999")).toBeNull();
    // 发出的 id 写进结构里的配置原文（编译按它发 SceneLayer.id，重编译前后一致、不和已有的撞）
    expect(h.structure.created.map((item) => JSON.parse(item.config).id)).toEqual([4, 5, 40, 41]);
    // 按 id 字符串也能解析（getLayerIndex / getLayer 的 strtol 分支）
    expect(h.scene.getLayerIndex("40")).toBe(5);
    // 待删的找不到
    h.scene.destroyLayer(a);
    expect(h.scene.getLayerByID("4")).toBeNull();
  });

  it("id 单调（L4）：登记表从活的 bundle 摘掉最大 id 的层之后再建，id 不回落、不重发", () => {
    const h = harness(BASE);
    // 宿主换上场景时（beforeFirstFrame）调一次
    h.api.adoptBundle();
    // 删除生效、登记表 removeObject：TOP（id 3）从活的 bundle.layers 里摘掉
    h.scene.destroyLayer(2);
    h.state.flushDestroy();
    h.bundle.layers.splice(2, 1);
    const a = h.scene.createLayer("models/a.json");
    expect(JSON.parse(h.structure.created[0].config).id).toBe(4);
    expect(h.scene.getLayerByID("4")).toBe(a);
    // 建出的层编进 bundle（adoptBundle）后又被删、从 bundle 摘掉：下一个照样往后数
    h.bundle.layers.push({ ...h.bundle.layers[0], id: 4, object: 3, name: "" });
    h.api.adoptBundle();
    h.bundle.layers.pop();
    h.scene.createLayer("models/b.json");
    expect(JSON.parse(h.structure.created[1].config).id).toBe(5);
    // 配置里带的 id 照用，不动下界之外的分配
    h.scene.createLayer({ image: "models/c.json", id: 2 });
    h.scene.createLayer("models/d.json");
    expect(h.structure.created.map((item) => JSON.parse(item.config).id)).toEqual([4, 5, 2, 6]);
  });

  it("id：脚本看到的 bundle 换了（重编译）时按新 bundle 抬高下界，旧下界更大时照旧", () => {
    const h = harness(BASE);
    h.scene.createLayer("models/a.json");
    expect(JSON.parse(h.structure.created[0].config).id).toBe(4);
    // 第一次分配时已按当时的 bundle 定了下界：之后摘掉 id 3 也不回落
    h.bundle.layers.splice(2, 1);
    h.scene.createLayer("models/b.json");
    expect(JSON.parse(h.structure.created[1].config).id).toBe(5);
  });

  it("配置里的父 id 在当时存在的对象里找（编译的图层与待编对象）；找不到 / 待删的当根", () => {
    const h = harness(BASE);
    const kid = h.scene.createLayer({ image: "models/a.json", parent: 2 });
    expect(h.state.layers.get(3)?.parent).toBe(1);
    expect(h.state.childrenOf(1)).toEqual([3]);
    expect(kid.getParent()).toBe(h.layer(1));
    const grand = h.scene.createLayer({ image: "models/a.json", parent: 4 });
    expect(h.state.layers.get(4)?.parent).toBe(3);
    expect(grand.getParent()).toBe(kid);
    h.scene.createLayer({ image: "models/a.json", parent: 12345 });
    expect(h.state.layers.get(5)?.parent).toBeNull();
    h.scene.destroyLayer(1);
    h.scene.createLayer({ image: "models/a.json", parent: 2 });
    expect(h.state.layers.get(6)?.parent).toBeNull();
  });

  it("待编对象按类别装成员：图像层有 alignment（读写落到状态），声音层有 play，粒子层有 emitParticles，分组节点都没有", () => {
    const h = harness(BASE);
    const image = h.scene.createLayer("models/a.json");
    expect(image.alignment).toBe("center");
    image.alignment = "bottom";
    expect(image.alignment).toBe("bottom");
    expect(h.state.layers.get(3)?.alignment).toBeGreaterThan(0);
    const sound = h.scene.createLayer("sounds/a.mp3");
    expect(typeof sound.play).toBe("function");
    expect(sound.isPlaying()).toBe(false);
    const particle = h.scene.createLayer("particles/a.json");
    expect(typeof particle.emitParticles).toBe("function");
    const group = h.scene.createLayer({ name: "G" });
    expect(group.name).toBe("G");
    expect(Object.hasOwn(group, "alignment")).toBe(false);
    expect(Object.hasOwn(group, "play")).toBe(false);
  });

  it("图层字段读写落到状态（origin / scale / color），编译期字段给缺省（size 自动尺寸）", () => {
    const h = harness(BASE);
    const bar = h.scene.createLayer("models/a.json");
    bar.origin = h.vm.run("new Vec3(200, 300, 0)");
    bar.scale = h.vm.run("new Vec3(30, 20, 1)");
    expect(h.state.layers.get(3)?.origin).toEqual([200, 300, 0]);
    expect(h.state.layers.get(3)?.scale).toEqual([30, 20, 1]);
    expect(bar.origin.x).toBe(200);
    // 编译前没有尺寸（WPE 当场就有：bar.size 是 {4, 4}，已知差异）
    expect(bar.size.x).toBe(0);
  });

  it("模块顶层调用抛 SyntaxError（createLayer cannot be called from global scope.）", async () => {
    const h = harness(BASE);
    const list: SceneScript[] = [
      {
        id: "objects/0/alpha",
        source: `thisScene.createLayer('models/a.json'); export function init(v) { return v; }`,
        target: { kind: "layer", object: 0, field: "alpha" },
        valueType: "float",
        initial: 1,
        owner: { kind: "layer", object: 0 },
        layer: 0,
        scriptProperties: null,
        imports: [],
        errors: [],
      },
    ];
    await h.runtime.load({ list } as never);
    const diagnostics = h.runtime.diagnostics as { state: string; errors: string[] }[];
    expect(diagnostics[0].state).toBe("failed");
    expect(diagnostics[0].errors[0]).toContain("createLayer cannot be called from global scope.");
    expect(h.created).toEqual([]);
  });
});

describe("__workshopId 改写（wpe-asset / wpe-bars 的 cfg bar1）", () => {
  const source = (workshopId: string, call: string) => `
export let __workshopId = ${workshopId};
export function init(value) {
  const layer = ${call};
  console.log(JSON.stringify(thisScene.getInitialLayerConfig(layer)));
  return value;
}`;
  const scriptOf = (src: string): SceneScript => ({
    id: "objects/0/alpha",
    source: src,
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    initial: 1,
    owner: { kind: "layer", object: 0 },
    layer: 0,
    scriptProperties: null,
    imports: [],
    errors: [],
  });

  it("当前脚本有字符串 __workshopId：不在 assets 里的路径改写成 first/workshop/<id>/其余", async () => {
    const h = harness(BASE);
    await h.runtime.load({
      list: [scriptOf(source("'2652493753'", "thisScene.createLayer('models/bar.json')"))],
    } as never);
    expect(h.logs).toEqual(['{"image":"models/workshop/2652493753/bar.json"}']);
    expect(JSON.parse(h.structure.created[0].config)).toEqual({ image: "models/workshop/2652493753/bar.json", id: 4 });
  });

  it("路径在 assets 名单里不改；__workshopId 不是字符串不改", async () => {
    const inAssets = harness(BASE, { assetPaths: ["models/bar.json"] });
    await inAssets.runtime.load({
      list: [scriptOf(source("'1'", "thisScene.createLayer('models/bar.json')"))],
    } as never);
    expect(inAssets.logs).toEqual(['{"image":"models/bar.json"}']);
    const numeric = harness(BASE);
    await numeric.runtime.load({ list: [scriptOf(source("5", "thisScene.createLayer('models/bar.json')"))] } as never);
    expect(numeric.logs).toEqual(['{"image":"models/bar.json"}']);
  });

  it("对象参数里的 image / sound / effects[].passes[].textures 都改写；已经带 workshop 段的先去掉旧的", async () => {
    const h = harness(BASE);
    const call = `thisScene.createLayer({ image: "models/workshop/9/a.json", sound: ["sounds/s.mp3"], effects: [{ file: "effects/e.json", passes: [{ textures: ["t.png"] }] }] })`;
    await h.runtime.load({ list: [scriptOf(source("'7'", call))] } as never);
    expect(JSON.parse(h.logs[0])).toEqual({
      effects: [{ file: "effects/workshop/7/e.json", passes: [{ textures: ["workshop/7/t.png"] }] }],
      image: "models/workshop/7/a.json",
      sound: ["sounds/workshop/7/s.mp3"],
    });
  });
});

describe("克隆带脚本的对象（wpe-clone：before → 新层 init → after，新条目同一轮 update）", () => {
  const SHARED = `
let _f = 0;
const L = (...a) => console.log(a.join(' '));
`;
  const A = `${SHARED}
export function init(value) {
  const config = thisScene.getInitialLayerConfig('T');
  for (let i = 1; i <= 2; i++) {
    L('init' + i + ' before');
    const clone = thisScene.createLayer(config);
    L('init' + i + ' after', clone.name, 'idx', thisScene.getLayerIndex(clone), 'count', thisScene.getLayerCount());
  }
  return value;
}
export function update(value) {
  _f++;
  if (_f === 3) {
    L('f3 before');
    const clone = thisScene.createLayer(thisScene.getInitialLayerConfig('T'));
    L('f3 after', clone.name, 'idx', thisScene.getLayerIndex(clone), 'count', thisScene.getLayerCount());
  }
  return value;
}`;
  const TALPHA = `${SHARED}
let m = 100;
export function init(value) { m++; L('T.alpha init', thisLayer.name, 'm', m); return value; }
export function update(value) { m++; if (m <= 102) L('T.alpha update', thisLayer.name, 'm', m); return value; }`;
  const TORIGIN = `${SHARED}
let n = 0;
export function init(value) { n++; L('T.origin init', thisLayer.name, 'n', n, 'idx', thisScene.getLayerIndex(thisLayer)); return value; }
export function update(value) { n++; if (n <= 3) L('T.origin update', thisLayer.name, 'n', n); return value; }`;
  const OBJECTS: Json[] = [
    { id: 1, name: "A", image: "models/util/solidlayer.json", alpha: { script: A, value: 1 } },
    {
      id: 2,
      name: "T",
      image: "models/util/solidlayer.json",
      alpha: { script: TALPHA, value: 1 },
      origin: { script: TORIGIN, value: "300 500 0" },
    },
  ];

  it("A 的 init 里克隆两次：每次 before → 新层各段 init（alpha 在 origin 前）→ after；原来的 T 在 A 之后才 init；各实例模块状态独立", async () => {
    const h = harness(OBJECTS);
    await h.runtime.load({ list: h.scriptsOf() } as never);
    expect(h.logs).toEqual([
      "init1 before",
      "T.alpha init T m 101",
      "T.origin init T n 1 idx 2",
      "init1 after T idx 2 count 3",
      "init2 before",
      "T.alpha init T m 101",
      "T.origin init T n 1 idx 3",
      "init2 after T idx 3 count 4",
      // 原来的 T 的 init 在 A 的 init 之后（条目顺序）
      "T.alpha init T m 101",
      "T.origin init T n 1 idx 1",
    ]);
    expect(h.created).toEqual([2, 3]);
    // 克隆的条目 id 是 objects/<新下标>/…，追加在 records 尾
    expect((h.runtime.diagnostics as { id: string }[]).map((item) => item.id)).toEqual([
      "objects/0/alpha",
      "objects/1/alpha",
      "objects/1/origin",
      "objects/2/alpha",
      "objects/2/origin",
      "objects/3/alpha",
      "objects/3/origin",
    ]);
  });

  it("第一帧 update：T、C1、C2 各 alpha 在前 origin 在后（wpe-clone 的 update 顺序）", async () => {
    const h = harness(OBJECTS);
    await h.runtime.load({ list: h.scriptsOf() } as never);
    h.logs.length = 0;
    h.runtime.frame(0.016);
    expect(h.logs).toEqual([
      "T.alpha update T m 102",
      "T.origin update T n 2",
      "T.alpha update T m 102",
      "T.origin update T n 2",
      "T.alpha update T m 102",
      "T.origin update T n 2",
    ]);
  });

  it("update 里克隆：新条目同一轮 update 遍历到（C3 当帧收到第一次 update，排在已有条目之后）", async () => {
    const h = harness(OBJECTS);
    await h.runtime.load({ list: h.scriptsOf() } as never);
    h.runtime.frame(0.016);
    h.runtime.frame(0.016);
    h.logs.length = 0;
    h.runtime.frame(0.016);
    expect(h.logs.slice(0, 4)).toEqual([
      "f3 before",
      "T.alpha init T m 101",
      "T.origin init T n 1 idx 4",
      "f3 after T idx 4 count 5",
    ]);
    // 同一帧：T、C1、C2 的计数已超过打印上限（不再打印），C3 当帧第一次 update，排在已有条目之后
    expect(h.logs.slice(4)).toEqual(["T.alpha update T m 102", "T.origin update T n 2"]);
    expect(h.created).toEqual([2, 3, 4]);
  });

  it("克隆的配置原文带着字段脚本、没有 id、键按字典序（cfg c1 的形状）", async () => {
    const h = harness(OBJECTS);
    await h.runtime.load({ list: h.scriptsOf() } as never);
    const config = h.scene.getInitialLayerConfig(2);
    expect(Object.keys(config)).toEqual(["alpha", "image", "name", "origin"]);
    expect(config.alpha.script).toBe(TALPHA);
    expect(config.origin.value).toBe("300 500 0");
    expect("id" in config).toBe(false);
  });
});

describe("命中片段缓存（L5）：createLayer 里对象已经编好", () => {
  it("交给运行时的是 bundle 里的定型条目，只有 scriptProperties 按当前属性收集；不当待编对象；名字、size 读编好的", () => {
    const source = "export function update(value) { return value; }";
    const config = {
      name: "clone",
      alpha: { script: source, value: 1, scriptproperties: { speed: { user: "s", value: 1 } } },
    };
    const added: SceneScript[][] = [];
    const h = harness(BASE, {
      afterCreate: (object, bundle) => {
        // 宿主命中缓存：图层与定型条目（带编译期填的标记，scriptProperties 是编片段那一刻的旧值）进 bundle
        bundle.layers.push({ ...bundle.layers[0], object, id: 9, name: "clone", size: [64, 32] });
        const [collected] = collectObjectScriptsSync(config, object, { s: 1 });
        bundle.scripts.list.push({ ...collected, scriptProperties: { speed: 1 }, valueType: "float", initial: 0.5 });
      },
    });
    h.api.setProperties(new Map([["s", { type: "slider", value: 7 }]]));
    const original = h.runtime.addScripts.bind(h.runtime);
    h.runtime.addScripts = (scripts) => {
      added.push([...scripts]);
      original(scripts);
    };
    const clone = h.scene.createLayer(config);
    expect(clone.name).toBe("clone");
    expect([clone.size.x, clone.size.y]).toEqual([64, 32]);
    expect(added).toHaveLength(1);
    // 定型条目（initial 是 bundle 里的 0.5），scriptProperties 是当前属性 s = 7
    expect(added[0].map((script) => [script.id, script.initial, script.scriptProperties])).toEqual([
      ["objects/3/alpha", 0.5, { speed: 7 }],
    ]);
    // 不是待编对象：adoptBundle 之后也不变
    h.api.adoptBundle();
    expect(clone.name).toBe("clone");
  });
});

describe("ScriptRuntime.addScripts / refreshScripts / currentWorkshopId", () => {
  const entry = (id: string, source: string, object = 0): SceneScript => ({
    id,
    source,
    target: { kind: "layer", object, field: "alpha" },
    valueType: "float",
    initial: 1,
    owner: { kind: "layer", object },
    layer: object,
    scriptProperties: null,
    imports: [],
    errors: [],
  });

  it("__workshopId 只认字符串，求值后读一次；currentWorkshopId 取当前正在调用的条目的", async () => {
    const h = harness(BASE);
    const seen: (string | null)[] = [];
    h.vm.global.probe = () => seen.push(h.runtime.currentWorkshopId());
    expect(h.runtime.currentWorkshopId()).toBeNull();
    await h.runtime.load({
      list: [
        entry(
          "objects/0/alpha",
          `export let __workshopId = 'w1'; export function init(v) { probe(); __workshopId = 'late'; return v; } export function update(v) { probe(); return v; }`,
        ),
        entry("objects/1/alpha", `export let __workshopId = 42; export function init(v) { probe(); return v; }`, 1),
        entry("objects/2/alpha", `export function init(v) { probe(); return v; }`, 2),
      ],
    } as never);
    h.runtime.frame(0.016);
    // 之后改导出变量不生效
    expect(seen).toEqual(["w1", null, null, "w1"]);
    expect(h.runtime.currentWorkshopId()).toBeNull();
  });

  it("addScripts：已备好的模块同步 init；没备过的源码晚一段 init；出错的条目不影响别的", async () => {
    const h = harness(BASE);
    await h.runtime.load({ list: [entry("objects/0/alpha", `export function init(v) { return v; }`)] } as never);
    h.vm.global.log = (text: string) => h.logs.push(text);
    const preparedSource = `export function init(v) { log('prepared init'); return v; }`;
    // 先备一份（同 load 里备过的源码）
    await h.realm.prepareModule(preparedSource, "x");
    h.runtime.addScripts([entry("objects/5/alpha", preparedSource, 5)]);
    expect(h.logs).toEqual(["prepared init"]);
    const fresh = `export function init(v) { log('fresh init'); return v; }`;
    h.runtime.addScripts([entry("objects/6/alpha", fresh, 6)]);
    // 没备过：当场没有 init
    expect(h.logs).toEqual(["prepared init"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.logs).toEqual(["prepared init", "fresh init"]);
    // 导入说明符无效的条目标失败，不影响同批别的
    const bad = { ...entry("objects/7/alpha", preparedSource, 7), errors: ["bad"] };
    h.runtime.addScripts([bad, entry("objects/8/alpha", preparedSource, 8)]);
    expect(h.logs.at(-1)).toBe("prepared init");
    const states = (h.runtime.diagnostics as { id: string; state: string }[]).map((item) => `${item.id}:${item.state}`);
    expect(states).toContain("objects/7/alpha:failed");
    expect(states).toContain("objects/8/alpha:inited");
  });

  it("refreshScripts：按 id 换成新 bundle 的条目，运行时没有的不加、新 bundle 里没有的不删", async () => {
    const h = harness(BASE);
    await h.runtime.load({ list: [entry("objects/0/alpha", `export function init(v) { return v; }`)] } as never);
    const next = entry("objects/0/alpha", `export function init(v) { return v; }`);
    next.initial = 7;
    const other = entry("objects/9/alpha", `export function init(v) { return v; }`, 9);
    h.runtime.refreshScripts([next, other]);
    expect((h.runtime.diagnostics as { id: string }[]).map((item) => item.id)).toEqual(["objects/0/alpha"]);
    h.runtime.refreshScripts([]);
    expect(h.runtime.diagnostics.length).toBe(1);
  });
});
