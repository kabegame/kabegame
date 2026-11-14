/**
 * P3a 修复（2026-11-14）：
 * 1. 绑定的属性不存在时一律保持 `value`、不比 condition（`resolveValue`）；
 * 2. 图层标量 `alpha` / `brightness` 照 WPE 的 float setter 不收布尔，编译期与就地写同一规则；
 * 3. WPE 注入的 14 个内置属性算「存在」，工程声明了同名属性时以工程的为准。
 * 期望值照 WPE 实测：`ignore/p3a-missing/out/wpe-judge*.txt`（可见性 / alpha / 颜色）、`wpe-p3am-log.txt`（脚本属性）、
 * `wpe-judge-bright.txt`（brightness）、`wpe-judge-builtin.txt` 与 `wpe-p3amb-log.txt`（内置名）。
 */
import { describe, expect, it, vi } from "vitest";
import { BindingCollector, type SceneBinding } from "./bindings";
import { builtinProperties, WPE_BUILTIN_PROPERTIES, wpeAlignmentOf } from "./builtinProperties";
import { compileScene, type SceneBundle } from "./bundle";
import type { SceneReader } from "./fs";
import { currentProperties, observePropertyReads, resolveValue, type SceneScalar, type SceneValue } from "./model";
import { SceneState } from "../render/state";
import { probeUserProperties } from "../dev/probeScripts";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 测试工程 `ignore/p3a-missing/defs/p3am.py` 的三个存在的属性。 */
const PROPERTIES = {
  kbp3a_combo: { type: "combo", value: "0" },
  kbp3a_bool: { type: "bool", value: true },
  kbp3a_slider: { type: "slider", value: 0.25 },
};

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** 一个图像层（不翻译着色器，只看图层字段与绑定）。 */
const square = (name: string, fields: Record<string, unknown>) => ({
  name,
  image: "models/a.json",
  size: "10 10",
  ...fields,
});

async function compileObjects(
  objects: Record<string, unknown>[],
  {
    properties = PROPERTIES as Record<string, unknown>,
    userProperties = {},
  }: { properties?: Record<string, unknown>; userProperties?: Record<string, unknown> } = {},
): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties } },
      "P:/p/scene.json": {
        general: { orthogonalprojection: { width: 64, height: 32 } },
        objects: objects.map((object, index) => ({ id: index + 1, ...object })),
      },
      "P:/p/models/a.json": { material: "materials/a.json", width: 10, height: 10 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    // 不翻译着色器，每个图层都报不支持：照常编完全部对象
    exhaustive: true,
    userProperties,
  });
}

const miss = (name: string, value: SceneScalar, condition?: string) => ({
  user: condition === undefined ? { name } : { name, condition },
  value,
});
const cond = (name: string, condition: string, value: SceneScalar) => ({ user: { name, condition }, value });

/** 按名字取编译出的图层字段。 */
function layerOf(bundle: SceneBundle, objects: Record<string, unknown>[], name: string) {
  const index = objects.findIndex((object) => object.name === name);
  const layer = bundle.layers.find((item) => item.object === index);
  if (!layer) throw new Error(`没有图层 ${name}`);
  return layer;
}

describe("1. 属性不存在时保持 value、不比 condition", () => {
  it("可见性（p3am-missing V1–V8、p3am-extra E4；对照 C1–C3、E1–E3）", async () => {
    const objects = [
      square("V1", { visible: miss("kbmiss_v1", true, "0") }),
      square("V2", { visible: miss("kbmiss_v2", false, "0") }),
      square("V3", { visible: miss("kbmiss_v3", true, "true") }),
      square("V4", { visible: miss("kbmiss_v4", false, "false") }),
      square("V5", { visible: miss("kbmiss_v5", false, "") }),
      square("V6", { visible: miss("kbmiss_v6", true, "") }),
      square("V7", { visible: { user: "kbmiss_v7", value: false } }),
      square("V8", { visible: miss("kbmiss_v8", false) }),
      square("E4", { visible: miss("kbmiss_e4", true) }),
      square("C1", { visible: cond("kbp3a_combo", "0", false) }),
      square("C2", { visible: cond("kbp3a_combo", "1", true) }),
      square("C3", { visible: cond("kbp3a_bool", "true", false) }),
      square("E1", { visible: cond("kbp3a_slider", "0.25", false) }),
      square("E2", { visible: cond("kbp3a_slider", "0.250000", false) }),
      square("E3", { visible: cond("kbp3a_bool", "1", false) }),
    ];
    const bundle = await compileObjects(objects);
    const wpe: Record<string, boolean> = {
      V1: true,
      V2: false,
      V3: true,
      V4: false,
      V5: false,
      V6: true,
      V7: false,
      V8: false,
      E4: true,
      C1: true,
      C2: false,
      C3: true,
      E1: true,
      E2: false,
      E3: false,
    };
    for (const [name, visible] of Object.entries(wpe))
      expect(layerOf(bundle, objects, name).visible, name).toBe(visible);
    // 绑定照样登记（运行时属性来了还要能生效），条件也带上
    const binding = bundle.bindings.find((item) => item.property === "kbmiss_v1");
    expect(binding).toEqual({
      property: "kbmiss_v1",
      condition: "0",
      target: { kind: "layer", object: 0, field: "visible" },
    });
    // 条件可见的图层不论当前显不显示都预建
    expect(layerOf(bundle, objects, "V2").visibleBound).toBe(true);
  });

  it("数值字段：图层 alpha（N1–N4）、颜色（K1、K3）保持 value", async () => {
    const objects = [
      square("N1", { alpha: miss("kbmiss_n1", 0.5, "0") }),
      square("N2", { alpha: miss("kbmiss_n2", 0.5, "1") }),
      square("N3", { alpha: miss("kbmiss_n3", 0.5, "0.5") }),
      square("N4", { alpha: miss("kbmiss_n4", 0.5) }),
      square("K1", { color: miss("kbmiss_k1", "0.2 0.6 1", "0") }),
      square("K3", { color: miss("kbmiss_k3", "1 0.6 0.2", "1") }),
    ];
    const bundle = await compileObjects(objects);
    for (const name of ["N1", "N2", "N3", "N4"]) expect(layerOf(bundle, objects, name).alpha, name).toBe(0.5);
    expect(layerOf(bundle, objects, "K1").color).toEqual([0.2, 0.6, 1]);
    expect(layerOf(bundle, objects, "K3").color).toEqual([1, 0.6, 0.2]);
  });

  it("脚本属性（p3am-missing 的 S：缺失的四个取 value、类型也是 value 的；存在的取当前值或条件布尔）", async () => {
    const objects = [
      square("S", {
        alpha: {
          script: "export function update(value) { return value; }",
          value: 1,
          scriptproperties: {
            sa: miss("kbmiss_sa", true, "1"),
            sb: miss("kbmiss_sb", 0.5, "1"),
            sc: { user: "kbmiss_sc", value: 0.25 },
            sd: cond("kbp3a_combo", "0", false),
            se: miss("kbmiss_se", true, "0"),
            sf: miss("kbmiss_sf", 0.5, "0.5"),
            sg: { user: { name: "kbp3a_slider" }, value: 0.5 },
            sh: 0.75,
          },
        },
      }),
    ];
    const bundle = await compileObjects(objects);
    // WPE「首次 apply 之后」的值（`wpe-p3am-log.txt`）；缺失的四个在 init 里也是这个值
    expect(bundle.scripts.list[0].scriptProperties).toEqual({
      sa: true,
      sb: 0.5,
      sc: 0.25,
      sd: true,
      se: true,
      sf: 0.5,
      sg: 0.25,
      sh: 0.75,
    });
    // 缺失属性的脚本绑定照样登记
    expect(
      bundle.bindings.filter((item) => item.target.kind === "script-property").map((item) => item.property),
    ).toEqual(["kbmiss_sa", "kbmiss_sb", "kbmiss_sc", "kbp3a_combo", "kbmiss_se", "kbmiss_sf", "kbp3a_slider"]);
  });

  it("resolveValue 经 properties[name] 读：缺失的名字也被读取观察记到；null 当缺失", () => {
    const seen: string[] = [];
    observePropertyReads((name) => seen.push(name));
    try {
      const properties = currentProperties({ file: "scene.json", general: { properties: {} } }, {});
      expect(resolveValue({ user: { name: "nope", condition: "0" }, value: true }, properties)).toBe(true);
      expect(seen).toContain("nope");
    } finally {
      observePropertyReads(null);
    }
    expect(resolveValue({ user: { name: "n", condition: "0" }, value: true }, { n: null })).toBe(true);
    // 属性存在：条件照常覆盖 value
    expect(resolveValue({ user: { name: "n", condition: "0" }, value: true }, { n: 1 })).toBe(false);
    // BindingCollector.bind 与 resolveValue 同值，并且登记
    const bindings = new BindingCollector();
    const target = { kind: "layer", object: 3, field: "visible" } as const;
    expect(bindings.bind({ user: { name: "nope", condition: "1" }, value: false } as SceneValue, {}, target)).toBe(
      false,
    );
    expect(bindings.list).toEqual([{ property: "nope", condition: "1", target }]);
  });
});

describe("2. 图层标量 alpha / brightness 不收布尔", () => {
  const objects = [
    // p3am-missing / p3am-extra 的 NC*（alpha）
    square("NC1", { alpha: cond("kbp3a_slider", "0.25", 0.5) }),
    square("NC2", { alpha: cond("kbp3a_slider", "0.75", 0.5) }),
    square("NC3", { alpha: { user: { name: "kbp3a_slider" }, value: 0.5 } }),
    square("NC4", { alpha: cond("kbp3a_combo", "0", 0.5) }),
    square("NC5", { alpha: { user: "kbp3a_bool", value: 0.5 } }),
    // p3am-bright 的 R* / A1（brightness，WPE 在 HDR 下读 g_Color）
    square("R1", { brightness: cond("kbp3a_slider", "0.25", 0.5) }),
    square("R2", { brightness: cond("kbp3a_slider", "0.75", 0.5) }),
    square("R3", { brightness: { user: "kbp3a_bool", value: 0.5 } }),
    square("R4", { brightness: { user: "kbp3a_slider", value: 0.5 } }),
    square("R5", { brightness: miss("kbmiss_r5", 0.5, "0") }),
    square("R6", { brightness: 0.5 }),
    square("R7", { brightness: cond("kbp3a_combo", "0", 0.5) }),
    square("R8", { brightness: false }),
    square("A1", { alpha: false }),
  ];
  const wpe: Record<string, ["alpha" | "brightness", number]> = {
    NC1: ["alpha", 0.5],
    NC2: ["alpha", 0.5],
    NC3: ["alpha", 0.25],
    NC4: ["alpha", 0.5],
    NC5: ["alpha", 0.5],
    R1: ["brightness", 0.5],
    R2: ["brightness", 0.5],
    R3: ["brightness", 0.5],
    R4: ["brightness", 0.25],
    R5: ["brightness", 0.5],
    R6: ["brightness", 0.5],
    R7: ["brightness", 0.5],
    // JSON 里直接写布尔：构造时的缺省 1
    R8: ["brightness", 1],
    A1: ["alpha", 1],
  };

  it("编译期：条件换成的布尔、布尔属性、JSON 布尔都不写，留 value 或缺省 1", async () => {
    const bundle = await compileObjects(objects);
    for (const [name, [field, value]] of Object.entries(wpe))
      expect(layerOf(bundle, objects, name)[field], name).toBe(value);
  });

  it("就地写：收到布尔不写、不标脏；数字照写；结果与用新值整场编译相同", async () => {
    const before = await compileObjects(objects);
    const state = SceneState.fromBundle(before);
    state.takeDirty();
    const bindingOf = (name: string): SceneBinding => {
      const index = objects.findIndex((object) => object.name === name);
      const found = before.bindings.find((item) => item.target.kind === "layer" && item.target.object === index);
      if (!found) throw new Error(`没有绑定 ${name}`);
      return found;
    };
    // 条件绑定：滑块改成 0.75 / 0.25，条件换成的布尔都不写
    for (const name of ["NC1", "NC2", "R1", "R2"]) {
      expect(state.write(bindingOf(name), 0.75), name).toBe("applied");
      expect(state.write(bindingOf(name), 0.25), name).toBe("applied");
    }
    // 布尔属性不带条件：false 也不写
    expect(state.write(bindingOf("NC5"), false)).toBe("applied");
    expect(state.write(bindingOf("R3"), false)).toBe("applied");
    expect([...state.takeDirty().layers]).toEqual([]);
    const after = await compileObjects(objects, {
      userProperties: { kbp3a_slider: 0.25, kbp3a_bool: false },
    });
    const fresh = SceneState.fromBundle(after);
    for (const name of ["NC1", "NC2", "NC5", "R1", "R2", "R3"]) {
      const index = objects.findIndex((object) => object.name === name);
      expect(state.layers.get(index), name).toEqual(fresh.layers.get(index));
    }
    // 数字照写、标脏
    const nc3 = objects.findIndex((object) => object.name === "NC3");
    expect(state.write(bindingOf("NC3"), 0.75)).toBe("applied");
    expect(state.layers.get(nc3)?.alpha).toBe(0.75);
    expect([...state.takeDirty().layers]).toEqual([nc3]);
    const r4 = objects.findIndex((object) => object.name === "R4");
    state.write(bindingOf("R4"), 0.75);
    expect(state.layers.get(r4)?.brightness).toBe(0.75);
  });
});

describe("3. WPE 注入的内置属性", () => {
  it("14 个键、默认值与 JS 类型照首次 apply 的实测", () => {
    const values = Object.fromEntries(Object.entries(WPE_BUILTIN_PROPERTIES).map(([key, item]) => [key, item.value]));
    expect(values).toEqual({
      alignment: 0,
      alignmentfliph: false,
      alignmentposition: 50,
      alignmentx: 50,
      alignmenty: 50,
      alignmentz: 100,
      rate: 100,
      wcc_amt: 100,
      wcc_v: "",
      wec_brs: 50,
      wec_con: 50,
      wec_e: false,
      wec_hue: 50,
      wec_sa: 50,
    });
  });

  it("alignment 照用视频壁纸的样式对应（WallpaperStage.vue 的 effectiveAlignment）", () => {
    expect(["fill", "fit", "stretch", "center", "tile"].map((style) => wpeAlignmentOf(style as never))).toEqual([
      0, 1, 2, 3, 0,
    ]);
    expect(builtinProperties("center").alignment).toEqual({ type: "combo", value: 3 });
    expect(builtinProperties().alignment.value).toBe(0);
    // 每次一份新的
    expect(builtinProperties()).not.toBe(builtinProperties());
  });

  it("编译期全集带内置项；工程声明的同名属性赢；用户值（宿主全集）再覆盖", () => {
    const project = {
      file: "scene.json",
      general: { properties: { wec_hue: { value: 7 }, mine: { value: 1 } } },
    };
    const properties = currentProperties(project, { alignment: 1 });
    expect(properties.rate).toBe(100);
    expect(properties.wcc_v).toBe("");
    expect(properties.wec_hue).toBe(7);
    expect(properties.alignment).toBe(1);
    expect(properties.mine).toBe(1);
  });

  it("绑定按内置值比较（p3am-builtin B1–B4、B6–B16，p3am-empty W7）；工程声明的 wec_hue 赢（B7 / B8）", async () => {
    const objects = [
      square("B1", { visible: cond("rate", "100", false) }),
      square("B2", { visible: cond("rate", "0", true) }),
      square("B3", { visible: cond("wec_e", "false", false) }),
      square("B4", { visible: cond("alignment", "0", false) }),
      square("B6", { visible: cond("alignmentz", "100", false) }),
      square("B7", { visible: cond("wec_hue", "7", false) }),
      square("B8", { visible: cond("wec_hue", "50", false) }),
      square("B9", { visible: cond("alignmentfliph", "false", false) }),
      square("B10", { visible: cond("alignmentposition", "50", false) }),
      square("B11", { visible: cond("wec_brs", "50", false) }),
      square("B12", { visible: cond("wcc_amt", "100", false) }),
      square("B13", { visible: cond("alignmentx", "50", false) }),
      square("B14", { visible: cond("alignmenty", "50", false) }),
      square("B15", { visible: cond("wec_con", "50", false) }),
      square("B16", { visible: cond("wec_sa", "50", false) }),
      square("W7", { visible: cond("wcc_v", "x", true) }),
    ];
    const properties = { ...PROPERTIES, wec_hue: { type: "slider", value: 7 } };
    const bundle = await compileObjects(objects, { properties });
    const wpe: Record<string, boolean> = {
      B1: true,
      B2: false,
      B3: true,
      B4: true,
      B6: true,
      B7: true,
      B8: false,
      B9: true,
      B10: true,
      B11: true,
      B12: true,
      B13: true,
      B14: true,
      B15: true,
      B16: true,
      W7: false,
    };
    for (const [name, visible] of Object.entries(wpe))
      expect(layerOf(bundle, objects, name).visible, name).toBe(visible);
    // 绑内置名的照常登记，运行时（宿主按样式改 alignment）就地生效
    expect(bundle.bindings.some((item) => item.property === "alignment" && item.condition === "0")).toBe(true);
    // 宿主全集里 alignment 已按样式换成 1：条件 "0" 不再成立
    const fit = await compileObjects(objects, { properties, userProperties: { alignment: 1 } });
    expect(layerOf(fit, objects, "B4").visible).toBe(false);
  });

  it('脚本属性绑内置名取内置值（p3am-builtin 的 S：apply 之后 ra=100、rb=true、rc=""、rd=7、re=false）', async () => {
    const objects = [
      square("S", {
        alpha: {
          script: "export function update(value) { return value; }",
          value: 1,
          scriptproperties: {
            ra: { user: "rate", value: 7 },
            rb: cond("wec_e", "false", 0.5),
            rc: { user: "wcc_v", value: 0.75 },
            rd: { user: "wec_hue", value: 3 },
            re: { user: "alignmentfliph", value: true },
          },
        },
      }),
    ];
    const bundle = await compileObjects(objects, {
      properties: { ...PROPERTIES, wec_hue: { type: "slider", value: 7 } },
    });
    expect(bundle.scripts.list[0].scriptProperties).toEqual({ ra: 100, rb: true, rc: "", rd: 7, re: false });
  });

  it("dev 探针的属性全集带内置项：工程声明的赢，请求给的值再覆盖", () => {
    const properties = probeUserProperties(
      { general: { properties: { wec_hue: { type: "slider", value: 7 } as never } } },
      { rate: 50 },
    );
    expect(properties.get("wec_hue")).toEqual({ type: "slider", value: 7 });
    expect(properties.get("rate")).toEqual({ type: "slider", value: 50 });
    expect(properties.get("alignment")).toEqual({ type: "combo", value: 0 });
    expect(properties.get("wcc_v")).toEqual({ type: "combo", value: "" });
    expect([...properties.keys()].filter((key) => key in WPE_BUILTIN_PROPERTIES)).toHaveLength(14);
  });
});
