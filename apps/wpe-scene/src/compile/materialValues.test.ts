/**
 * 材质常量的取值规则（`materialValues.ts`），对齐 WPE：vector-constant-REPORT.md 2.3–2.6，第 6 节 `p4b-vec` 实测。
 * 每条规则一个用例；编译期（`shaderUniforms`）、就地写（`SceneState.write`）、脚本写回（`scriptWriteValue`）三条路共用同一个 setter。
 */
import { describe, expect, it } from "vitest";
import { BindingCollector, generalDefaults, type SceneBinding } from "./bindings";
import type { SceneBundle } from "./bundle";
import { atof, constantTargetFields, materialDefault, materialSetter, materialSlots } from "./materialValues";
import type { MaterialPass, SceneScalar } from "./model";
import { shaderUniforms } from "./shader";
import { SceneState, scriptWriteValue } from "../render/state";
import type { TranslateResult, UniformLayout } from "../wpesl2wgsl";

function uniform(name: string, declared: string, meta: Record<string, unknown>, extra: Partial<UniformLayout> = {}) {
  const type = declared === "float" ? "f32" : `${declared}<f32>`;
  return { name, type, declared, offset: 0, size: 16, meta, ...extra } satisfies UniformLayout;
}

function program(...uniforms: UniformLayout[]): TranslateResult {
  return { ok: true, uniforms };
}

/** 单个 uniform `g_X`（材质键 `x`）的编译期取值。 */
function compileX(
  declared: string,
  pass: MaterialPass,
  properties: Record<string, SceneScalar> = {},
  meta: Record<string, unknown> = {},
) {
  return shaderUniforms(program(uniform("g_X", declared, { material: "x", ...meta })), pass, properties).g_X;
}

function emptyState(constants: Record<string, number[]>): SceneState {
  const bloom = { strength: 1, threshold: 0.5, tint: [1, 1, 1], hdrStrength: 1, hdrThreshold: 0.5 };
  const state = SceneState.fromBundle({
    general: {
      fields: generalDefaults(),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...bloom, hdrFeather: 1, hdrScatter: 1, hdrIterations: 4 },
    },
    layers: [],
    bloom: null,
  } as unknown as SceneBundle);
  state.constants.set("p", { ...constants });
  return state;
}

/** 编译一个 pass、登记绑定，再把绑定就地写成 `next`：返回就地写后的常量与用 `next` 整场编译的常量。 */
function writeThenRecompile(
  result: TranslateResult,
  pass: MaterialPass,
  property: string,
  before: SceneScalar,
  next: SceneScalar,
) {
  const bindings = new BindingCollector();
  const compiled = shaderUniforms(result, pass, { [property]: before }, "p", bindings);
  const binding = bindings.list.find((item: SceneBinding) => item.property === property);
  if (!binding) throw new Error(`${property} 没有登记`);
  const state = emptyState(compiled);
  expect(state.write(binding, next)).toBe("applied");
  return { inPlace: state.constants.get("p"), recompiled: shaderUniforms(result, pass, { [property]: next }) };
}

describe("setter（报告 2.4）", () => {
  it("数字：float 写一个分量，向量铺满（num-*）", () => {
    expect(materialSetter(1, 0.4)).toEqual([0.4]);
    expect(materialSetter(2, 0.4)).toEqual([0.4, 0.4]);
    expect(materialSetter(3, 0.4)).toEqual([0.4, 0.4, 0.4]);
    expect(materialSetter(4, 0.4)).toEqual([0.4, 0.4, 0.4, 0.4]);
  });

  it("字符串进向量：先清零、按 0x20 切、逐段 atof，最多 N 段（s*、comma*、lead-sp、tab）", () => {
    expect(materialSetter(3, "0.4")).toEqual([0.4, 0, 0]);
    expect(materialSetter(4, "0.4 0.5")).toEqual([0.4, 0.5, 0, 0]);
    expect(materialSetter(2, "0.4 0.5 0.6 0.7")).toEqual([0.4, 0.5]);
    expect(materialSetter(3, "1   2  3")).toEqual([1, 2, 3]);
    expect(materialSetter(2, "0.4, 0.5")).toEqual([0.4, 0.5]);
    expect(materialSetter(2, "0.4,0.5")).toEqual([0.4, 0]);
    expect(materialSetter(3, " 0.4 0.5 0.6")).toEqual([0.4, 0.4, 0.5]);
    expect(materialSetter(2, "0.4\t0.5")).toEqual([0.4, 0]);
    expect(materialSetter(3, "")).toEqual([0, 0, 0]);
    expect(materialSetter(2, "abc 2")).toEqual([0, 2]);
  });

  it("float 只收数字：字符串、布尔、数组、null 都不写（s1-f、s2-f、bool-*、array-v3）", () => {
    for (const value of ["0.4", "0.4 0.5", true, false, [0.4], null]) expect(materialSetter(1, value)).toBeNull();
    for (const value of [true, [0.4, 0.5, 0.6], null]) expect(materialSetter(3, value)).toBeNull();
  });

  it("对象取 value 按同一规则写，不往下取；没有 value 不写", () => {
    expect(materialSetter(3, { user: "p", value: 0.5 })).toEqual([0.5, 0.5, 0.5]);
    expect(materialSetter(1, { script: "…", value: "0.5" })).toBeNull();
    expect(materialSetter(2, { value: { value: 1 } })).toBeNull();
    expect(materialSetter(2, { user: "p" })).toBeNull();
  });

  it("atof：读最长的十进制前缀", () => {
    expect([atof("  -1.5e2x"), atof(".5"), atof("1e"), atof("x1"), atof("")]).toEqual([-150, 0.5, 1, 0, 0]);
    // UCRT 的 inf / infinity / nan，不分大小写、可带符号（P10b）；不完整的（`in`）照旧读不出
    expect([atof("NaN"), atof(" nan(ind)"), atof("Infinity"), atof("-inf"), atof("+INF x"), atof("in")]).toEqual([
      NaN,
      NaN,
      Infinity,
      -Infinity,
      Infinity,
      0,
    ]);
    // 经字符串写回的向量（`scriptWriteValue` 拼成的）读回原值
    expect(materialSetter(3, [NaN, 1040, -Infinity].join(" "))).toEqual([NaN, 1040, -Infinity]);
  });
});

describe("缺省值（报告 2.1 / 2.3）", () => {
  it("先转字符串：float 存 atof 的数，向量存字符串；数字缺省进向量不铺满（defn-*）", () => {
    expect(materialDefault(1, 0.9)).toBe(0.9);
    expect(materialDefault(1, "1 2")).toBe(1);
    expect(materialDefault(3, 0.3)).toBe("0.3");
    expect(materialDefault(1, true)).toBe(0);
    expect(compileX("vec3", {}, {}, { default: 0.3 })).toEqual([0.3, 0, 0]);
    expect(compileX("vec4", {}, {}, { default: "0.9 0.8 0.7 0.6" })).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(compileX("float", {}, {}, { default: 0.9 })).toEqual([0.9]);
  });

  it("键在就不补缺省：值写不进去时是 0，不是缺省（s1-f）", () => {
    expect(compileX("float", { constantshadervalues: { x: "0.4" } }, {}, { default: 0.9 })).toEqual([0]);
    expect(compileX("vec3", { constantshadervalues: { x: true } }, {}, { default: "0.9 0.8 0.7" })).toEqual([0, 0, 0]);
    // JSON 数组不在 SceneValue 的类型里，但场景文件里可能出现（第 6 节 array-v3）
    const array = [0.4, 0.5, 0.6] as unknown as string;
    expect(compileX("vec3", { constantshadervalues: { x: array } }, {}, { default: "1 1 1" })).toEqual([0, 0, 0]);
  });
});

describe("编译期的来源（报告 2.3 / 2.5）", () => {
  it("材质常量：数字进向量铺满，多段截断", () => {
    expect(compileX("vec3", { constantshadervalues: { x: 0.4 } })).toEqual([0.4, 0.4, 0.4]);
    expect(compileX("vec2", { constantshadervalues: { x: "0.4 0.5 0.6 0.7" } })).toEqual([0.4, 0.5]);
  });

  it("用户属性：滑块进向量铺满；布尔、下拉字符串、颜色绑 float 都不写，留 JSON 的 value（u-*）", () => {
    const user = (property: string) => ({ constantshadervalues: { x: { user: property, value: "0.1 0.2 0.3" } } });
    expect(compileX("vec3", user("p"), { p: 0.6 })).toEqual([0.6, 0.6, 0.6]);
    const kept = (property: SceneScalar) =>
      compileX("float", { constantshadervalues: { x: { user: "p", value: 0.3 } } }, { p: property });
    expect([kept(true), kept("0.8"), kept("0.9 0.1 0.1")]).toEqual([[0.3], [0.3], [0.3]]);
    expect(
      compileX("vec4", { constantshadervalues: { x: { user: "c", value: "1 1 1 1" } } }, { c: "0.9 0.5 0.1" }),
    ).toEqual([0.9, 0.5, 0.1, 0]);
    // 属性不在全集里：只写 JSON 的 value
    expect(compileX("vec3", user("missing"))).toEqual([0.1, 0.2, 0.3]);
  });

  it("带 condition：值换成布尔，材质 setter 不收，留 value；绑定照样登记（u-cond-f）", () => {
    const bindings = new BindingCollector();
    const pass = { constantshadervalues: { x: { user: { name: "p", condition: "0.8" }, value: 0.3 } } };
    const values = shaderUniforms(
      program(uniform("g_X", "float", { material: "x" })),
      pass,
      { p: "0.8" },
      "k",
      bindings,
    );
    expect(values.g_X).toEqual([0.3]);
    expect(bindings.list).toMatchObject([{ property: "p", condition: "0.8", target: { kind: "constant" } }]);
  });

  it("usershadervalues：改写成 {value: 原值或缺省, user}，属性有值时再按属性写", () => {
    const result = program(
      uniform("g_A", "vec3", { material: "a", default: "0 0 0" }),
      uniform("g_B", "vec3", { material: "b", default: "0 1 0" }),
      uniform("g_C", "float", { material: "c", default: 0.5 }),
    );
    const pass = {
      usershadervalues: { pa: "a", pb: "b", pc: "c" },
      constantshadervalues: { a: { user: "other", value: "1 0 0" } },
    };
    expect(shaderUniforms(result, pass, {})).toEqual({ g_A: [1, 0, 0], g_B: [0, 1, 0], g_C: [0.5] });
    expect(shaderUniforms(result, pass, { pa: 0.2, pb: "0.3", pc: true })).toEqual({
      g_A: [0.2, 0.2, 0.2],
      g_B: [0.3, 0, 0],
      g_C: [0.5],
    });
  });

  it("数组不收材质值；单个 pass 超过 48 个 float 报 constant:slots", () => {
    const arrayed = program(uniform("g_X", "float", { material: "x" }, { array: 4, type: "array<vec4<f32>, 4>" }));
    expect(shaderUniforms(arrayed, { constantshadervalues: { x: 1 } }, {}).g_X).toEqual([0, 0, 0, 0]);
    const many = program(...Array.from({ length: 13 }, (_, i) => uniform(`g_V${i}`, "vec4", { material: `v${i}` })));
    const issues = new Set<string>();
    shaderUniforms(many, {}, {}, undefined, undefined, issues);
    expect([...issues]).toEqual(["constant:slots"]);
  });

  it("拆开的两半共用片元那一半的 setter 类型与缺省值；顶点更宽报 constant:mixed-type", () => {
    const result = program(
      uniform("g_S", "float", { material: "s", default: 0.25 }, { stage: "vertex" }),
      uniform("kb_fs_g_S", "vec3", { material: "s", default: "0.5 0.6 0.7" }, { stage: "fragment", original: "g_S" }),
    );
    const issues = new Set<string>();
    expect(shaderUniforms(result, {}, {}, undefined, undefined, issues)).toEqual({
      g_S: [0.5],
      kb_fs_g_S: [0.5, 0.6, 0.7],
    });
    expect([...issues]).toEqual([]);
    expect(materialSlots(result.uniforms ?? [])[0].members.map((m) => m.name)).toEqual(["kb_fs_g_S", "g_S"]);
    const wide = program(
      uniform("g_S", "vec2", { material: "s" }, { stage: "vertex" }),
      uniform("kb_fs_g_S", "float", { material: "s", default: 3 }, { stage: "fragment" }),
    );
    shaderUniforms(wide, {}, {}, undefined, undefined, issues);
    expect([...issues]).toEqual(["constant:mixed-type:s"]);
  });
});

describe("就地写（报告 2.5）：同一个 setter、整体重写，与整场重编译一致", () => {
  const color = program(uniform("g_X", "vec3", { material: "x" }));
  const scalar = program(uniform("g_X", "float", { material: "x" }));
  const userPass = (value: SceneScalar) => ({ constantshadervalues: { x: { user: "p", value } } });

  it("滑块进向量每次铺满", () => {
    const { inPlace, recompiled } = writeThenRecompile(color, userPass("0.1 0.2 0.3"), "p", 0.6, 0.3);
    expect(inPlace?.g_X).toEqual([0.3, 0.3, 0.3]);
    expect(inPlace).toEqual(recompiled);
  });

  it("颜色改成一段字符串：没给到的分量清零，不留旧值", () => {
    const { inPlace, recompiled } = writeThenRecompile(color, userPass("1 1 1"), "p", "0.9 0.5 0.1", "0.2");
    expect(inPlace?.g_X).toEqual([0.2, 0, 0]);
    expect(inPlace).toEqual(recompiled);
  });

  it("布尔、字符串绑 float：不写，保持加载时的 value", () => {
    for (const [before, next] of [
      [true, false],
      ["0.2", "0.8"],
    ] as const) {
      const { inPlace, recompiled } = writeThenRecompile(scalar, userPass(0.3), "p", before, next);
      expect(inPlace?.g_X).toEqual([0.3]);
      expect(inPlace).toEqual(recompiled);
    }
  });

  it("带 condition 的绑定：运行中永远不变", () => {
    const bindings = new BindingCollector();
    const pass = { constantshadervalues: { x: { user: { name: "p", condition: "a" }, value: 0.3 } } };
    const state = emptyState(shaderUniforms(scalar, pass, { p: "b" }, "p", bindings));
    expect(state.write(bindings.list[0], "a")).toBe("applied");
    expect(state.constants.get("p")?.g_X).toEqual([0.3]);
    expect(state.takeDirty().passes.size).toBe(0);
  });

  it("拆开的两半：一次写入按片元的类型写，顶点那一半取前几个分量", () => {
    const result = program(
      uniform("g_S", "vec2", { material: "s" }, { stage: "vertex" }),
      uniform("kb_fs_g_S", "vec4", { material: "s" }, { stage: "fragment" }),
    );
    const { inPlace, recompiled } = writeThenRecompile(
      result,
      { constantshadervalues: { s: { user: "p", value: 0 } } },
      "p",
      0,
      0.7,
    );
    expect(inPlace).toEqual({ g_S: [0.7, 0.7], kb_fs_g_S: [0.7, 0.7, 0.7, 0.7] });
    expect(inPlace).toEqual(recompiled);
  });
});

describe("脚本写回（报告 2.6）", () => {
  it("单分量传数字给 float setter，多分量拼成字符串、切回同样的分量", () => {
    const bindings = new BindingCollector();
    const result = program(uniform("g_F", "float", { material: "f" }), uniform("g_V", "vec3", { material: "v" }));
    const pass = { constantshadervalues: { f: { user: "pf", value: 1 }, v: { user: "pv", value: "1 1 1" } } };
    const state = emptyState(shaderUniforms(result, pass, {}, "p", bindings));
    const [f, v] = bindings.list;
    expect(scriptWriteValue([0.6])).toBe(0.6);
    state.write({ property: "", target: f.target }, scriptWriteValue([0.6]));
    state.write({ property: "", target: v.target }, scriptWriteValue([0.1, -0.25, 1e-7]));
    expect(state.constants.get("p")).toEqual({ g_F: [0.6], g_V: [0.1, -0.25, 1e-7] });
    expect(scriptWriteValue(true)).toBe(true);
  });
});

describe("没被读的材质常量（P7d 步骤 1，p7-REPORT「P7d 的实测」）：WPE 只给反射里被使用的键分配槽位", () => {
  /** 翻译器反射里没被读的一格。 */
  const unread = { unused: true } as const;

  function issuesOf(result: TranslateResult): string[] {
    const issues = new Set<string>();
    shaderUniforms(result, {}, {}, undefined, undefined, issues);
    return [...issues];
  }

  it("槽位只数被读的键：13 个 vec4 键是 52 个 float，其中一个没被读就是 48，不报 constant:slots", () => {
    const keys = (unusedCount: number) =>
      program(
        ...Array.from({ length: 13 }, (_, i) =>
          uniform(`g_V${i}`, "vec4", { material: `v${i}` }, i < unusedCount ? unread : {}),
        ),
      );
    expect(issuesOf(keys(0))).toEqual(["constant:slots"]);
    expect(issuesOf(keys(1))).toEqual([]);
    expect(materialSlots(keys(1).uniforms ?? []).map((slot) => slot.used)).toEqual([false, ...Array(12).fill(true)]);
    // 没被读的键取值照常填（没人读，填什么都一样）
    expect(shaderUniforms(keys(1), { constantshadervalues: { v0: "1 2 3 4" } }, {}).g_V0).toEqual([1, 2, 3, 4]);
  });

  it("拆开的两半：有一半被读就占主格的分量数，两半都没读不占", () => {
    const halves = (vertexRead: boolean, fragmentRead: boolean) =>
      program(
        ...Array.from({ length: 12 }, (_, i) => uniform(`g_V${i}`, "vec4", { material: `v${i}` })),
        uniform("g_S", "vec2", { material: "s" }, { stage: "vertex", ...(vertexRead ? {} : unread) }),
        uniform("kb_fs_g_S", "float", { material: "s" }, { stage: "fragment", ...(fragmentRead ? {} : unread) }),
      );
    expect(issuesOf(halves(false, false))).toEqual([]);
    expect(issuesOf(halves(true, false))).toEqual(["constant:slots"]);
    expect(issuesOf(halves(false, true))).toEqual(["constant:slots"]);
    expect(materialSlots(halves(false, false).uniforms ?? []).at(-1)?.used).toBe(false);
  });

  it("合并类型取读到它的阶段：只有顶点读时按顶点的类型与缺省写（frame_builder_by_gariam）；两半都读时照旧取片元", () => {
    const vertexOnly = program(
      uniform("u_R", "vec2", { material: "r", default: "640 360" }, { stage: "vertex" }),
      uniform("kb_fs_u_R", "float", { material: "r", default: 1 }, { stage: "fragment", original: "u_R", ...unread }),
    );
    expect(shaderUniforms(vertexOnly, {}, {})).toEqual({ u_R: [640, 360], kb_fs_u_R: [640] });
    expect(issuesOf(vertexOnly)).toEqual([]);
    const [slot] = materialSlots(vertexOnly.uniforms ?? []);
    expect(slot.members.map((m) => [m.name, m.components])).toEqual([
      ["u_R", 2],
      ["kb_fs_u_R", 2],
    ]);
    expect(constantTargetFields(slot).type).toBe("vec2");
    // 字符串进 vec2 setter 按空格切（float setter 不收字符串，会是 0）
    expect(shaderUniforms(vertexOnly, { constantshadervalues: { r: "1920 1080" } }, {})).toEqual({
      u_R: [1920, 1080],
      kb_fs_u_R: [1920],
    });

    const both = program(
      uniform("u_R", "vec2", { material: "r", default: "640 360" }, { stage: "vertex" }),
      uniform("kb_fs_u_R", "float", { material: "r", default: 1 }, { stage: "fragment", original: "u_R" }),
    );
    expect(shaderUniforms(both, {}, {})).toEqual({ u_R: [1, 0], kb_fs_u_R: [1] });
    expect(issuesOf(both)).toEqual(["constant:mixed-type:r"]);
    expect(constantTargetFields(materialSlots(both.uniforms ?? [])[0]).type).toBe("float");
  });

  it("片元读、顶点没读：取片元；更宽的顶点一半没被读，WPE 不上传，不报 constant:mixed-type", () => {
    const result = program(
      uniform("u_R", "vec2", { material: "r" }, { stage: "vertex", ...unread }),
      uniform("kb_fs_u_R", "float", { material: "r", default: 3 }, { stage: "fragment", original: "u_R" }),
    );
    expect(shaderUniforms(result, {}, {})).toEqual({ u_R: [3, 0], kb_fs_u_R: [3] });
    expect(issuesOf(result)).toEqual([]);
    expect(materialSlots(result.uniforms ?? [])[0].members[0].name).toBe("kb_fs_u_R");
  });

  it("两半都没读（frame_builder 的 REF_RES 0）：不报 constant:mixed-type，取法照旧（片元那一半）", () => {
    const result = program(
      uniform("u_R", "vec2", { material: "r" }, { stage: "vertex", ...unread }),
      uniform("kb_fs_u_R", "float", { material: "r", default: 3 }, { stage: "fragment", original: "u_R", ...unread }),
    );
    expect(shaderUniforms(result, {}, {})).toEqual({ u_R: [3, 0], kb_fs_u_R: [3] });
    expect(issuesOf(result)).toEqual([]);
    expect(materialSlots(result.uniforms ?? [])[0].used).toBe(false);
  });

  it("就地写与整场重编译一致：只有顶点读时一次写入按顶点的 vec2 写", () => {
    const result = program(
      uniform("u_R", "vec2", { material: "r" }, { stage: "vertex" }),
      uniform("kb_fs_u_R", "float", { material: "r" }, { stage: "fragment", original: "u_R", ...unread }),
    );
    const { inPlace, recompiled } = writeThenRecompile(
      result,
      { constantshadervalues: { r: { user: "p", value: "1 2" } } },
      "p",
      "1 2",
      "0.3 0.4",
    );
    expect(inPlace).toEqual({ u_R: [0.3, 0.4], kb_fs_u_R: [0.3] });
    expect(inPlace).toEqual(recompiled);
  });
});
