// P14 步骤 1 点 2：`thisScene.createModelData` / `destroyModelData` 与句柄的 `applyData` / `replaceData`。
// 期望来自步骤 0 的 WPE 实测（S1–S17，`ignore/p14/0/` 的 `p14-api` / `p14-api2` 日志）与缺陷表 D1–D12 的建议做法；报错文字逐字断言。
import { init } from "es-module-lexer";
import { beforeAll, describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { normalizeConfig } from "../compile/config";
import type { SceneStructure } from "../compile/protocol";
import type { SceneScript } from "../compile/scripts";
import { ModelDataStore } from "../modeldata/store";
import type { MaterialCheck } from "../modeldata/types";
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

function bundleOf(): SceneBundle {
  const layer = {
    id: 1,
    object: 0,
    parent: null,
    name: "BG",
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
  } as unknown as SceneLayer;
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
    layers: [layer],
    programs: [],
    textures: [],
    bindings: [],
    scripts: { list: [] },
    configs: [normalizeConfig({ id: 1, name: "BG" })],
  } as unknown as SceneBundle;
}

interface Options {
  store?: boolean;
  check?: MaterialCheck;
}

function harness(options: Options = {}) {
  const vm = vmRealm();
  const logs: string[] = [];
  vm.global.console = { log: (text: string) => logs.push(text), error: (text: string) => logs.push(text) };
  vm.run(`
    globalThis.IModelData = class IModelData {
      static POSITION = 'position';
      toConfigString() { return this.__modelDataToken; }
    };
  `);
  const stringify = vm.run<(value: unknown) => string>(
    `(value) => JSON.stringify(value, (key, item) => (item && typeof item.toConfigString === "function" ? item.toConfigString() : item))`,
  );
  const ready = new Map<string, Awaited<ReturnType<typeof vm.prepareModule>>>();
  const realm: ScriptRealm = {
    global: vm.global,
    prototypes: { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} },
    internal: {
      updateScriptProperties() {},
      convertUserProperties: () => ({}),
      stringifyConfig(this: unknown, value: unknown) {
        return stringify(value);
      },
    },
    prepareModule(source, label) {
      const task = vm.prepareModule(source, label);
      void task.then((module) => ready.set(source, module));
      return task;
    },
    preparedModule: (source) => ready.get(source) ?? null,
    dispose() {},
  };
  const bundle = bundleOf();
  const state = SceneState.fromBundle(bundle);
  const structure: SceneStructure = { destroyed: [], parents: [], created: [] };
  const allocator: ObjectAllocator = { next: 0 };
  const store = new ModelDataStore();
  const checked: [string, number][] = [];
  const check: MaterialCheck =
    options.check ??
    ((material, format) => {
      checked.push([material, format]);
      return 0;
    });
  // 单测里手动指定当前回调；runtime 驱动的测试里取 `runtime.activeCallback`
  const current: { value: string | null } = { value: null };
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
    activeCallback: () => current.value ?? runtime.activeCallback,
    createLayer(config, parent) {
      syncAllocator(allocator, bundle);
      return createStructureObject(state, structure, allocator, config, parent);
    },
    addScripts: (scripts) => runtime.addScripts(scripts),
    ...(options.store === false ? {} : { modelData: store, materialCheck: check }),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene = api.thisScene as Record<string, any>;
  /** 在 realm 里求值一个表达式。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mk = (code: string): any => vm.run(code);
  return { vm, realm, store, state, structure, runtime, api, scene, logs, current, checked, mk, bundle };
}

type Harness = ReturnType<typeof harness>;

const SHAPE = `{
  vertexBuffer: new Float32Array(27),
  indexBuffer: new Uint16Array([0, 1, 2]),
  vertexFormat: ['position', 'uv', 'color'],
  material: 'materials/a.json',
  isVertexBufferDynamic: true,
  isIndexBufferDynamic: true,
}`;

/** 抓抛出的值（不抛返回 undefined）。 */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectSyntaxError(h: Harness, error: unknown, message: string): void {
  expect(error).toBeInstanceOf(h.vm.global.SyntaxError);
  expect((error as Error).message).toBe(message);
}

const scriptOf = (source: string): SceneScript => ({
  id: "objects/0/alpha",
  source,
  target: { kind: "layer", object: 0, field: "alpha" },
  valueType: "float",
  initial: 1,
  owner: { kind: "layer", object: 0 },
  layer: 0,
  scriptProperties: null,
  imports: [],
  errors: [],
});

describe("S1 作用域：模块顶层抛 SyntaxError，回调里都能调", () => {
  it("createModelData / destroyModelData 在模块顶层抛原文；init、update、计时器、光标回调里都建得出来", async () => {
    const top = harness();
    await top.runtime.load({
      list: [scriptOf(`thisScene.createModelData(${SHAPE}); export function init(v) { return v; }`)],
    } as never);
    const first = top.runtime.diagnostics as { state: string; errors: string[] }[];
    expect(first[0].state).toBe("failed");
    expect(first[0].errors[0]).toContain("createModelData cannot be called from global scope.");
    const destroy = harness();
    await destroy.runtime.load({
      list: [scriptOf(`thisScene.destroyModelData(1); export function init(v) { return v; }`)],
    } as never);
    expect((destroy.runtime.diagnostics as { errors: string[] }[])[0].errors[0]).toContain(
      "destroyModelData cannot be called from global scope.",
    );

    const h = harness();
    const source = `
const shape = ${SHAPE};
const make = (name) => { console.log(name + ' ' + typeof thisScene.createModelData(shape)); };
export function init(v) { make('init'); engine.setTimeout(() => make('timer'), 1); return v; }
export function update(v) { make('update'); return v; }
export function cursorClick() { make('cursor'); }
`;
    await h.runtime.load({ list: [scriptOf(source)] } as never);
    h.runtime.frame(0.5);
    h.runtime.cursorEvent(0, "cursorClick", [0, 0, 0], [0, 0]);
    expect(h.logs).toEqual(["init object", "timer object", "update object", "cursor object"]);
    expect(h.store.desc(4)).not.toBeNull();
  });
});

describe("S2–S4 参数整理", () => {
  it("没有参数 / 不是对象 / null → null，不抛；多余参数忽略", () => {
    const h = harness();
    expect(h.scene.createModelData()).toBeNull();
    expect(h.scene.createModelData(1)).toBeNull();
    expect(h.scene.createModelData("x")).toBeNull();
    expect(h.scene.createModelData(null)).toBeNull();
    expect(h.scene.createModelData(h.mk(`(${SHAPE})`), 5, "ignored")).not.toBeNull();
  });

  it("两种写法：shapes 数组逐个当形状；没有 shapes 数组则整个参数当一个形状", () => {
    const h = harness();
    const single = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const multi = h.scene.createModelData(h.mk(`({ shapes: [${SHAPE}, ${SHAPE}] })`));
    expect(h.store.desc(single.__modelDataToken)?.shapes).toHaveLength(1);
    expect(h.store.desc(multi.__modelDataToken)?.shapes).toHaveLength(2);
    // shapes 不是数组：整个配置当一个形状（缺 vertexBuffer）
    expectSyntaxError(
      h,
      thrown(() => h.scene.createModelData(h.mk(`({ shapes: 5 })`))),
      "Vertex buffer missing.",
    );
  });

  it("shapes: [] → Shapes missing.；顶层数组当一个形状 → Vertex buffer missing.", () => {
    const h = harness();
    expectSyntaxError(
      h,
      thrown(() => h.scene.createModelData(h.mk(`({ shapes: [] })`))),
      "Shapes missing.",
    );
    expectSyntaxError(
      h,
      thrown(() => h.scene.createModelData(h.mk(`([${SHAPE}])`))),
      "Vertex buffer missing.",
    );
  });
});

describe("D10 创建时非对象形状按缺 vertexBuffer 报错", () => {
  it("null / undefined / 数字形状都报 Vertex buffer missing.，失败不占 token", () => {
    const h = harness();
    for (const bad of ["null", "undefined", "5", "'x'"])
      expectSyntaxError(
        h,
        thrown(() => h.scene.createModelData(h.mk(`({ shapes: [${SHAPE}, ${bad}] })`))),
        "Vertex buffer missing.",
      );
    expect(h.scene.createModelData(h.mk(`(${SHAPE})`)).__modelDataToken).toBe(1);
  });
});

describe("S5 包围盒、D6", () => {
  it("两个都是对象才生效，读 x y z，非数字分量记 0；普通对象也行；只给一个当没给", () => {
    const h = harness();
    const bounds = (extra: string) =>
      h.store.desc(h.scene.createModelData(h.mk(`({ ...${SHAPE}, ${extra} })`)).__modelDataToken)!.bounds;
    expect(bounds(`boundingBoxMins: {x: -1, y: -2, z: -3}, boundingBoxMaxs: {x: 4, y: 5, z: 6}`)).toEqual([
      -1, -2, -3, 4, 5, 6,
    ]);
    expect(bounds(`boundingBoxMins: {x: 'a', y: 2}, boundingBoxMaxs: {z: 9}`)).toEqual([0, 2, 0, 0, 0, 9]);
    // 只给一个、或不是对象：按位置分量算（全 0 顶点 → 全 0）
    expect(bounds(`boundingBoxMins: {x: -1, y: -2, z: -3}`)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(bounds(`boundingBoxMins: 1, boundingBoxMaxs: 2`)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("没给：只取位置分量（格式 position,normal,uv,color，位置之外填大值）", () => {
    const h = harness();
    const md = h.scene.createModelData(
      h.mk(`({
        vertexBuffer: new Float32Array([1, 2, 3, 9, 9, 9, 8, 8, 7, 7, 7, 7, -4, 5, 6, 9, 9, 9, 8, 8, 7, 7, 7, 7]),
        vertexFormat: ['position', 'normal', 'uv', 'color'], material: 'm',
      })`),
    );
    expect(h.store.desc(md.__modelDataToken)!.bounds).toEqual([-4, 2, 3, 1, 5, 6]);
  });
});

describe("S6–S10 形状字段", () => {
  it("S6 vertexBuffer 必须是 Float32Array：Float64Array、普通数组 → Vertex buffer missing.；长度不是 stride 整数倍 → Inconsistent vertex buffer size", () => {
    const h = harness();
    for (const bad of ["new Float64Array(27)", "[0, 1, 2]", "'x'"])
      expectSyntaxError(
        h,
        thrown(() => h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexBuffer: ${bad} })`))),
        "Vertex buffer missing.",
      );
    expectSyntaxError(
      h,
      thrown(() => h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexBuffer: new Float32Array(7) })`))),
      "Inconsistent vertex buffer size",
    );
  });

  it("S7 indexBuffer 只收 Uint16Array / Uint32Array，别的类型当没给", () => {
    const h = harness();
    const index = (code: string) =>
      h.store.desc(h.scene.createModelData(h.mk(`({ ...${SHAPE}, indexBuffer: ${code} })`)).__modelDataToken)!
        .shapes[0];
    expect(index("new Uint16Array([0, 1, 2])")).toMatchObject({ indexFormat: "uint16", indexCount: 3 });
    expect(index("new Uint32Array([0, 1, 2, 3])")).toMatchObject({ indexFormat: "uint32", indexCount: 4 });
    for (const other of ["new Int32Array([0, 1, 2])", "new Uint8Array([0, 1, 2])", "[0, 1, 2]", "null"])
      expect(index(other), other).toMatchObject({ indexFormat: null, indexCount: 0 });
  });

  it("S8 vertexFormat：区分大小写、遇非字符串元素停、不认识的跳过；结果为 0 → Vertex format missing.", () => {
    const h = harness();
    const format = (code: string) =>
      h.store.desc(
        h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexFormat: ${code}, vertexBuffer: new Float32Array(720) })`))
          .__modelDataToken,
      )!.shapes[0].format;
    expect(format("['position', 'foo', 'uv']")).toBe(0x1 | 0x8);
    // 遇到第一个非字符串停：后面的 uv 不算
    expect(format("['position', 1, 'uv']")).toBe(0x1);
    expect(format("['position', 'normal', 'tangentSigned', 'uv', 'color']")).toBe(0x1 | 0x2 | 0x4 | 0x8 | 0x8000);
    for (const bad of ["[]", "['Position']", "['foo']", "[1, 'uv']", "'position'", "undefined"])
      expectSyntaxError(
        h,
        thrown(() => h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexFormat: ${bad} })`))),
        "Vertex format missing.",
      );
  });

  it("D2 顺序或重复不是严格按表序递增 → Vertex format in incorrect order.", () => {
    const h = harness();
    for (const bad of [
      "['uv', 'position']",
      "['position', 'position']",
      "['color', 'uv']",
      "['position', 'uv', 'normal']",
    ])
      expectSyntaxError(
        h,
        thrown(() => h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexFormat: ${bad} })`))),
        "Vertex format in incorrect order.",
      );
    // 不认识的串不参与顺序判断
    expect(
      h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexFormat: ['position', 'x', 'uv', 'color'] })`)),
    ).not.toBeNull();
  });

  it("S9 material 必须是字符串：缺 / 数字 → Material missing.；材质检查码 1 / 2 → 对应文字", () => {
    const h = harness();
    for (const bad of ["undefined", "5", "null"])
      expectSyntaxError(
        h,
        thrown(() => h.scene.createModelData(h.mk(`({ ...${SHAPE}, material: ${bad} })`))),
        "Material missing.",
      );
    expect(h.checked).toEqual([]);
    const invalid = harness({ check: (material) => (material === "bad" ? 1 : material === "few" ? 2 : 0) });
    expectSyntaxError(
      invalid,
      thrown(() => invalid.scene.createModelData(invalid.mk(`({ ...${SHAPE}, material: 'bad' })`))),
      "Invalid material",
    );
    expectSyntaxError(
      invalid,
      thrown(() => invalid.scene.createModelData(invalid.mk(`({ ...${SHAPE}, material: 'few' })`))),
      "Shader expecting more vertex data.",
    );
  });

  it("材质检查的参数是改写后的材质与格式位", () => {
    const h = harness();
    h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect(h.checked).toEqual([["materials/a.json", 0x1 | 0x8 | 0x8000]]);
  });

  it("S10 isVertexBufferDynamic / isIndexBufferDynamic 只认 JS 布尔：1、'true'、不给 → 非动态（applyData 报码 7）", () => {
    const h = harness();
    for (const value of ["1", "'true'", "undefined", "false"]) {
      const md = h.scene.createModelData(
        h.mk(`({ ...${SHAPE}, isVertexBufferDynamic: ${value}, isIndexBufferDynamic: ${value} })`),
      );
      expectSyntaxError(
        h,
        thrown(() => md.applyData(h.mk(`({ vertexBuffer: new Float32Array(27) })`))),
        "Model data not created as dynamic",
      );
    }
    const dynamic = h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect(thrown(() => dynamic.applyData(h.mk(`({ vertexBuffer: new Float32Array(27) })`)))).toBeUndefined();
  });

  it("宿主没给数据仓时不装这两个方法（thisScene 成员与以前相同）", () => {
    const h = harness({ store: false });
    expect(h.scene.createModelData).toBeUndefined();
    expect(h.scene.destroyModelData).toBeUndefined();
  });
});

describe("D12 材质路径经 __workshopId 改写、不截断", () => {
  it("有 id：materials/workshop/<id>/…，超过 255 字节也完整保留；没有 id 原样", async () => {
    const long = "x".repeat(300);
    const h = harness();
    await h.runtime.load({
      list: [
        scriptOf(`
export let __workshopId = '123';
export function init(v) {
  thisScene.createModelData({ vertexBuffer: new Float32Array(9), vertexFormat: ['position', 'uv', 'color'], material: 'materials/${long}.json' });
  return v;
}`),
      ],
    } as never);
    const material = h.store.desc(1)!.shapes[0].material;
    expect(material).toBe(`materials/workshop/123/${long}.json`);
    expect(material.length).toBeGreaterThan(255);
    const plain = harness();
    plain.scene.createModelData(plain.mk(`({ ...${SHAPE}, material: 'materials/${long}.json' })`));
    expect(plain.store.desc(1)!.shapes[0].material).toBe(`materials/${long}.json`);
  });
});

describe("S12 返回的句柄", () => {
  it("token 不可写 / 不可枚举 / 不可配置，从 1 起连续；原型是 IModelData.prototype；applyData / replaceData 是自有可枚举属性且所有句柄共用", () => {
    const h = harness();
    const a = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const b = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const c = h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect([a, b, c].map((md) => md.__modelDataToken)).toEqual([1, 2, 3]);
    const Obj = h.mk("Object");
    expect(Obj.getOwnPropertyDescriptor(a, "__modelDataToken")).toEqual({
      value: 1,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(Obj.keys(a)).toEqual(["applyData", "replaceData"]);
    expect(Obj.getPrototypeOf(a)).toBe(h.mk("IModelData.prototype"));
    expect(a instanceof h.mk("IModelData")).toBe(true);
    expect(Object.hasOwn(a, "applyData")).toBe(true);
    expect(a.applyData).toBe(b.applyData);
    expect(a.replaceData).toBe(c.replaceData);
    expect(a.applyData).not.toBe(a.replaceData);
    // 失败的创建不占号
    expect(thrown(() => h.scene.createModelData(h.mk(`({ shapes: [] })`)))).toBeDefined();
    expect(h.scene.createModelData(h.mk(`(${SHAPE})`)).__modelDataToken).toBe(4);
  });

  it("md.POSITION 是 undefined（static 成员）；toConfigString() 返回数字 token；严格模式写 token 抛 TypeError", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect(md.POSITION).toBeUndefined();
    expect(h.mk("IModelData.POSITION")).toBe("position");
    expect(md.toConfigString()).toBe(1);
    const write = h.mk(`(md) => { 'use strict'; md.__modelDataToken = 9; }`);
    expect(thrown(() => write(md))).toBeInstanceOf(h.vm.global.TypeError);
  });
});

describe("applyData 的参数整理与报错（S14、S17、D3–D5）", () => {
  const make = (h: Harness) => h.scene.createModelData(h.mk(`(${SHAPE})`));
  const fail = (h: Harness, md: { applyData(x: unknown): void }, code: string, message: string) =>
    expectSyntaxError(
      h,
      thrown(() => md.applyData(h.mk(code))),
      message,
    );

  it("S17 applyData() / applyData(undefined) 是 realm 的 TypeError（读 boundingBoxMins）；applyData(null) 当 null 形状 → 码 11；数字是全零形状（不改）", () => {
    const h = harness();
    const md = make(h);
    for (const call of [() => md.applyData(), () => md.applyData(undefined), () => md.replaceData()]) {
      const error = thrown(call);
      expect(error).toBeInstanceOf(h.vm.global.TypeError);
      expect((error as Error).message).toBe("Cannot read properties of undefined (reading 'boundingBoxMins')");
    }
    fail(h, md, "null", "Cannot delete shape or buffers in IModelData.update");
    const version = h.store.shape(1, 0)!.version;
    expect(thrown(() => md.applyData(5))).toBeUndefined();
    expect(h.store.shape(1, 0)!.version).toBe(version);
  });

  it("数组 / { shapes: [...] } 逐个当形状；其它对象当一个形状；形状数多于现有 → 码 10", () => {
    const h = harness();
    const md = make(h);
    md.applyData(h.mk(`([{ vertexBuffer: new Float32Array(27).fill(2) }])`));
    expect(new Float32Array(h.store.shape(1, 0)!.vertices.buffer)[0]).toBe(2);
    md.applyData(h.mk(`({ shapes: [{ vertexBuffer: new Float32Array(27).fill(3) }] })`));
    expect(new Float32Array(h.store.shape(1, 0)!.vertices.buffer)[0]).toBe(3);
    fail(h, md, "([{}, {}])", "Cannot add shapes in IModelData.update");
    fail(h, md, "({ shapes: [{}, {}] })", "Cannot add shapes in IModelData.update");
    fail(h, md, "[]", "Shapes missing.");
  });

  it("码 11（删形状 / 删索引）、12（换材质）、13（换格式）、7、D3 的 5 / 6、9", () => {
    const h = harness();
    const md = make(h);
    fail(h, md, "({ indexBuffer: null })", "Cannot delete shape or buffers in IModelData.update");
    fail(h, md, "({ material: 'materials/b.json' })", "Material cannot be changed in IModelData.update");
    fail(h, md, "({ vertexFormat: ['position', 'normal'] })", "Vertex format cannot be changed in IModelData.update");
    fail(h, md, "({ vertexBuffer: new Float32Array(36) })", "Vertex buffer size cannot increase");
    fail(h, md, "({ indexBuffer: new Uint16Array(4) })", "Index buffer size cannot increase");
    fail(h, md, "({ indexBuffer: new Uint32Array(3) })", "Incorrect index buffer type");
    // 同材质（大小写不同）与同格式不算换
    md.applyData(h.mk(`({ material: 'MATERIALS/A.JSON', vertexFormat: ['position', 'uv', 'color'] })`));
    // 缺 vertexBuffer / vertexFormat / material 都不报错
    md.applyData(h.mk(`({})`));
  });

  it("D4 只拷给出的长度；D5 绘制数 = 这次的索引个数", () => {
    const h = harness();
    const md = h.scene.createModelData(
      h.mk(
        `({ ...${SHAPE}, vertexBuffer: new Float32Array(27).fill(1), indexBuffer: new Uint16Array([0, 1, 2, 2, 1, 0]) })`,
      ),
    );
    expect(h.store.shape(1, 0)!.drawCount).toBe(6);
    md.applyData(h.mk(`({ vertexBuffer: new Float32Array(9).fill(5), indexBuffer: new Uint16Array([0, 1, 2]) })`));
    const data = new Float32Array(h.store.shape(1, 0)!.vertices.buffer);
    expect([data[0], data[8], data[9], data[26]]).toEqual([5, 5, 1, 1]);
    expect(h.store.shape(1, 0)!.drawCount).toBe(3);
  });

  it("D5 无索引网格：绘制数 = 顶点数", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`({ ...${SHAPE}, indexBuffer: undefined })`));
    expect(h.store.shape(1, 0)!.drawCount).toBe(3);
    md.applyData(h.mk(`({ vertexBuffer: new Float32Array(18) })`));
    expect(h.store.shape(1, 0)!.drawCount).toBe(2);
  });

  it("D8 / S14：replaceData 可以加形状、删形状、变长；没写格式沿用原格式", () => {
    const h = harness();
    const md = make(h);
    md.replaceData(h.mk(`({ vertexBuffer: new Float32Array(45) })`)); // 变长，没写格式
    expect(h.store.desc(1)!.shapes[0]).toMatchObject({ format: 0x1 | 0x8 | 0x8000, vertexCount: 5 });
    md.replaceData(
      h.mk(
        `([{}, { vertexBuffer: new Float32Array(9), vertexFormat: ['position', 'uv', 'color'], material: 'materials/b.json' }])`,
      ),
    );
    expect(h.store.desc(1)!.shapes).toHaveLength(2);
    md.replaceData(h.mk(`([null])`));
    expect(h.store.desc(1)!.shapes.map((item) => item.material)).toEqual(["materials/b.json"]);
    // 加的形状缺顶点 → dll 的文字
    expectSyntaxError(
      h,
      thrown(() => md.replaceData(h.mk(`([{}, { material: 'm' }])`))),
      "Vertex buffer missing.",
    );
  });

  it("this 不是句柄：什么都不做、不抛", () => {
    const h = harness();
    const md = make(h);
    expect(md.applyData.call({}, h.mk(`({ vertexBuffer: new Float32Array(27) })`))).toBeUndefined();
    expect(md.applyData.call(null)).toBeUndefined();
  });

  it("D2 在更新里同样查顺序", () => {
    const h = harness();
    const md = make(h);
    fail(h, md, "({ vertexFormat: ['uv', 'position'] })", "Vertex format in incorrect order.");
  });

  it("token 被释放后 applyData 报码 4", () => {
    const h = harness();
    const md = make(h);
    h.scene.destroyModelData(md);
    fail(h, md, "({})", "Invalid model data token");
  });
});

describe("S13 replaceData 在 update 回调里抛错", () => {
  it("当前回调是 update 时抛 IModelData.replace cannot be called in update.；applyData 与别的回调不限", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const arg = h.mk(`({ vertexBuffer: new Float32Array(27) })`);
    h.current.value = "update";
    expectSyntaxError(
      h,
      thrown(() => md.replaceData(arg)),
      "IModelData.replace cannot be called in update.",
    );
    expect(thrown(() => md.applyData(arg))).toBeUndefined();
    for (const callback of ["init", "timer", "cursorClick", "applyUserProperties", null]) {
      h.current.value = callback;
      expect(
        thrown(() => md.replaceData(arg)),
        String(callback),
      ).toBeUndefined();
    }
  });

  it("runtime 驱动：update 回调与字段脚本的 update 抛错，init 与 setTimeout 里放行", async () => {
    const h = harness();
    const source = `
const make = () => thisScene.createModelData({ vertexBuffer: new Float32Array(9), vertexFormat: ['position', 'uv', 'color'], material: 'm', isVertexBufferDynamic: true });
let md;
const replace = (name) => {
  try { md.replaceData({ vertexBuffer: new Float32Array(9) }); console.log(name + ' ok'); }
  catch (e) { console.log(name + ' ' + e.constructor.name + ' ' + e.message); }
};
export function init(v) { md = make(); replace('init'); engine.setTimeout(() => replace('timer'), 1); return v; }
export function update(v) { replace('update'); return v; }
`;
    await h.runtime.load({ list: [scriptOf(source)] } as never);
    h.runtime.frame(0.5);
    expect(h.logs).toEqual([
      "init ok",
      "timer ok",
      "update SyntaxError IModelData.replace cannot be called in update.",
    ]);
  });
});

describe("S15、D1、D9 destroyModelData", () => {
  it("D1 IModelData 句柄与数字 token 都收；别的类型 / 负数 / 小数 / 超范围静默，返回 undefined", () => {
    const h = harness();
    const a = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const b = h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect(h.scene.destroyModelData(a)).toBeUndefined();
    expect(h.store.desc(1)).toBeNull();
    for (const bad of ["{}", "'2'", "-1", "1.5", "4294967296", "null", "undefined", "true", "[2]"])
      h.scene.destroyModelData(h.mk(`(${bad})`));
    h.scene.destroyModelData();
    expect(h.store.desc(2)).not.toBeNull();
    // 数字 token 也行；不存在的 token 静默
    expect(h.scene.destroyModelData(b.__modelDataToken)).toBeUndefined();
    expect(h.store.desc(2)).toBeNull();
    expect(h.scene.destroyModelData(0xffffffff)).toBeUndefined();
    // 别的 realm 里长得像句柄的对象不是句柄
    const fake = h.mk(`({ __modelDataToken: 3 })`);
    const c = h.scene.createModelData(h.mk(`(${SHAPE})`));
    h.scene.destroyModelData(fake);
    expect(h.store.desc(c.__modelDataToken)).not.toBeNull();
  });

  it("D9 同一个 token 释放多次只生效一次，图层还在用时资源不会被释放", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`(${SHAPE})`));
    expect(h.store.retainLayer(1, 7)).toBe(true);
    h.scene.destroyModelData(md);
    h.scene.destroyModelData(md);
    h.scene.destroyModelData(1);
    expect(h.store.desc(1)).not.toBeNull();
    // 脚本释放后资源还在，applyData 照常
    expect(thrown(() => md.applyData(h.mk(`({ vertexBuffer: new Float32Array(27) })`)))).toBeUndefined();
    h.store.releaseLayer(1, 7);
    expect(h.store.desc(1)).toBeNull();
  });
});

describe("S16 createLayer 与句柄", () => {
  it("createLayer(md) 与 { model: md, … } 配置里 model 是整数 token；查不到的 token 也建出层", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`(${SHAPE})`));
    const bare = h.scene.createLayer(md);
    expect(bare).not.toBeNull();
    expect(JSON.parse(h.structure.created[0].config)).toMatchObject({ model: 1 });
    expect(h.scene.getInitialLayerConfig(bare)).toEqual({ model: 1 });
    const named = h.scene.createLayer(h.mk(`(md) => ({ model: md, name: 'ML', origin: '0 0 0' })`)(md));
    expect(named).not.toBeNull();
    expect(h.scene.getInitialLayerConfig(named)).toEqual({ model: 1, name: "ML", origin: "0 0 0" });
    // 直接写数字 token、查不到的 token
    expect(h.scene.createLayer({ model: 1 })).not.toBeNull();
    expect(h.scene.createLayer({ model: 99999 })).not.toBeNull();
    // 句柄已释放也照样建（宿主查不到 token 时图层不画）
    h.scene.destroyModelData(md);
    expect(h.scene.createLayer(md)).not.toBeNull();
    expect(JSON.parse(h.structure.created[4].config)).toMatchObject({ model: 1 });
  });
});

describe("存储与描述的一致性", () => {
  it("createModelData 创建时字节被拷贝，之后改脚本里的数组不影响数据仓（E3b）", () => {
    const h = harness();
    h.mk(`globalThis.buffer = new Float32Array(27).fill(1)`);
    h.scene.createModelData(h.mk(`({ ...${SHAPE}, vertexBuffer: buffer })`));
    h.mk(`buffer.fill(9)`);
    expect(new Float32Array(h.store.shape(1, 0)!.vertices.buffer)[0]).toBe(1);
  });

  it("applyData 参数里的视图带偏移时只取视图那段", () => {
    const h = harness();
    const md = h.scene.createModelData(h.mk(`(${SHAPE})`));
    md.applyData(
      h.mk(`({ vertexBuffer: new Float32Array(new Float32Array([0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 7]).buffer, 8, 9) })`),
    );
    expect(new Float32Array(h.store.shape(1, 0)!.vertices.buffer)[0]).toBe(7);
    expect(new Float32Array(h.store.shape(1, 0)!.vertices.buffer)[8]).toBe(7);
  });
});
