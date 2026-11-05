import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bindingValue,
  mergeProperties,
  planApply,
  type LayerField,
  type RecompileReason,
  type SceneBinding,
  type UserProperty,
  type ValueType,
} from "./bindings";
import { compileScene } from "./bundle";
import { checkEffectFeatures, checkPassFeatures } from "./features";
import type { SceneReader } from "./fs";
import { numbers, observePropertyReads, resolveValue, type SceneValue } from "./model";
import { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const corpus = !!root && existsSync(wasm);

const reader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

const sample = (name: string) => join(root!, "projects", "defaultprojects", name);

async function compile(dir: string, options: Partial<Parameters<typeof compileScene>[0]> = {}) {
  return compileScene({
    projectDir: dir,
    sceneAssets: [join(root!, "assets")],
    reader,
    translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
    // 后处理固定开启：泛光参数与开关的绑定不受本机 WPE 设置影响
    postprocess: "enabled",
    ...options,
  });
}

/** 绑定目标的常量形状（测试里取值用）。 */
function constant(binding: SceneBinding) {
  expect(binding.target.kind).toBe("constant");
  return binding.target as Extract<SceneBinding["target"], { kind: "constant" }>;
}
function layerTarget(binding: SceneBinding) {
  expect(binding.target.kind).toBe("layer");
  return binding.target as Extract<SceneBinding["target"], { kind: "layer" }>;
}

describe("取值换算与分类（无 GPU、无语料）", () => {
  const properties: Record<string, string | number | boolean> = {
    color: "1 0.5 0",
    n: 3,
    flag: true,
    mode: "b",
    zero: 0,
  };

  it("bindingValue 与编译期 numbers(resolveValue(…)) 对数字、颜色字符串、布尔、condition 逐项相同", () => {
    const cases: {
      property: keyof typeof properties;
      condition?: string;
      type: ValueType | LayerField;
      value: SceneValue;
    }[] = [
      { property: "color", type: "color", value: { user: "color", value: "0 0 0" } },
      { property: "n", type: "alpha", value: { user: "n", value: 1 } },
      { property: "flag", type: "brightness", value: { user: "flag", value: false } },
      { property: "mode", type: "color", value: { user: "mode", value: "a" } },
      {
        property: "mode",
        condition: "b",
        type: "visible",
        value: { user: { name: "mode", condition: "b" }, value: false },
      },
      {
        property: "n",
        condition: "3",
        type: "origin",
        value: { user: { name: "n", condition: "3" }, value: "0 0 0" },
      },
    ];
    for (const { property, condition, type, value } of cases) {
      const resolved = resolveValue(value, properties);
      const actual = bindingValue(properties[property], condition, type);
      // visible 是布尔，其余按 numbers() 的分量
      if (type === "visible") expect(actual, property).toBe(resolved !== false);
      else expect(actual, property).toEqual(numbers(resolved));
    }
  });

  it("condition 写成数字时按字符串比（WPE 把值换成字符串再比）", () => {
    const value = { user: { name: "zero", condition: 0 }, value: true } as unknown as SceneValue;
    expect(resolveValue(value, properties)).toBe(true);
    expect(bindingValue(0, "0", "visible")).toBe(true);
    expect(bindingValue(1, "0", "visible")).toBe(false);
    // 数值字段的 condition：布尔再按 numbers() 变 0 / 1
    expect(bindingValue(1, "0", "alpha")).toEqual([0]);
  });

  it("COMBO 写成对象报 combo:user-binding（WPE 会断言中止，不交给翻译器）", () => {
    const passKeys = new Set<string>();
    checkPassFeatures({ combos: { TINT: { user: "x", value: 1 } } as never }, passKeys);
    expect([...passKeys]).toEqual(["combo:user-binding"]);
    const effectKeys = new Set<string>();
    checkEffectFeatures({ passes: [{ combos: { TINT: { user: "x" } } } as never] }, { passes: [] }, "tint", effectKeys);
    expect([...effectKeys]).toEqual(["combo:user-binding"]);
    // 数值 / 布尔的 COMBO 照常放行
    const ok = new Set<string>();
    checkPassFeatures({ combos: { TINT: 1, BLENDMODE: true } }, ok);
    expect([...ok]).toEqual([]);
  });

  it("mergeProperties：跳过 group / text / 空值，按值去重，保留 type", () => {
    const properties = new Map<string, UserProperty>();
    const first = mergeProperties(properties, {
      a: { type: "slider", value: 1 },
      group: { type: "group", value: 1 },
      text: { type: "text", value: "x" },
      empty: { type: "slider", value: null },
    });
    expect([...first.keys()]).toEqual(["a"]);
    expect(properties.get("a")).toEqual({ type: "slider", value: 1 });
    expect(mergeProperties(properties, { a: { type: "slider", value: 1 } }).size).toBe(0);
    // 类型变了、值没变：对绑定没有影响，不去重触发
    expect(mergeProperties(properties, { a: { type: "color", value: 1 } }).size).toBe(0);
    expect(mergeProperties(properties, { a: { type: "color", value: 2 } }).size).toBe(1);
    // 增量没给的键不丢（不学 WPE 的整项覆盖，I4）
    expect(properties.get("a")).toEqual({ type: "color", value: 2 });
  });

  it("planApply：每类目标给出就地 / 重编译，没被引用的属性两边都不进", () => {
    const at = (object: number, field: LayerField): SceneBinding["target"] => ({ kind: "layer", object, field });
    const constantTarget = (pass: string): SceneBinding["target"] => ({
      kind: "constant",
      pass,
      material: "m",
      uniforms: ["g_X"],
      type: "float",
    });
    const recompile = (reason: RecompileReason, path: string): SceneBinding["target"] => ({
      kind: "recompile",
      reason,
      path,
    });
    const inPlace: SceneBinding[] = [
      { property: "constant", target: constantTarget("objects/0/passes/0") },
      ...(["origin", "scale", "angles", "alpha", "color", "brightness", "visible"] as LayerField[]).map(
        (field): SceneBinding => ({ property: `layer-${field}`, target: at(0, field) }),
      ),
      { property: "bloom", target: { kind: "bloom", field: "hdrStrength" } },
      { property: "effect-visible", target: { kind: "effect", object: 0, effect: 0 } },
    ];
    const recompiled: SceneBinding[] = [
      { property: "bloom-switch", target: recompile("postprocess", "general.bloom") },
      { property: "hdr", target: recompile("postprocess", "general.hdr") },
      { property: "cbm", target: recompile("layer-structure", "objects/0/colorBlendMode") },
      { property: "size", target: recompile("layer-structure", "objects/0/size") },
      { property: "clear", target: recompile("general", "general.clearcolor") },
      { property: "ambient", target: recompile("general", "general.ambientcolor") },
      { property: "skylight", target: recompile("general", "general.skylightcolor") },
      { property: "eye", target: recompile("general", "camera.eye") },
    ];
    const bindings = [...inPlace, ...recompiled];
    const changes = new Map<string, string>([...bindings.map((b) => [b.property, "1"] as [string, string])]);
    changes.set("script-only", "1");
    const plan = planApply(bindings, changes);
    expect(plan.writes.map((write) => write.binding.property)).toEqual(inPlace.map((b) => b.property));
    expect(plan.recompile.map((item) => `${item.reason}:${item.path}`).sort()).toEqual(
      recompiled
        .map(
          (binding) =>
            `${(binding.target as Extract<SceneBinding["target"], { kind: "recompile" }>).reason}:${(binding.target as Extract<SceneBinding["target"], { kind: "recompile" }>).path}`,
        )
        .sort(),
    );
    // 只给脚本用的属性：既不就地写、也不重编译
    expect(plan.writes.some((write) => write.binding.property === "script-only")).toBe(false);
    expect(plan.recompile.some((item) => item.key === "script-only")).toBe(false);
  });
});

describe.skipIf(!corpus)("本机语料：绑定表", () => {
  it("脚本重编译目标按 scene.json 路径覆盖编译输入", async () => {
    const bundle = await compile(sample("eagleflag"), {
      scriptOverrides: { "general/clearcolor": [1, 0, 0] },
    });
    expect(bundle.general.clearColor).toEqual([1, 0, 0]);
  }, 120000);
  it("razer_vortex：brightness / length / speed 都是 tint pass 的材质常量", async () => {
    const bundle = await compile(sample("razer_vortex"));
    const of = (property: string) => bundle.bindings.filter((binding) => binding.property === property);
    expect(of("ui_editor_properties_brightness")).toHaveLength(2);
    expect(of("ui_editor_properties_length")).toHaveLength(2);
    expect(of("ui_editor_properties_speed")).toHaveLength(3);
    for (const binding of bundle.bindings) {
      const target = constant(binding);
      expect(target.pass).toMatch(/^objects\/\d+\/effects\/0\/passes\/0$/);
      expect(target.uniforms).toHaveLength(1);
      expect(target.type).toBe("float");
    }
    const uniforms = (property: string) => of(property).map((binding) => constant(binding).uniforms[0]);
    expect(uniforms("ui_editor_properties_brightness")).toEqual(["g_Brightness", "g_Brightness"]);
    expect(uniforms("ui_editor_properties_length")).toEqual(["g_Length", "g_Length"]);
    expect(uniforms("ui_editor_properties_speed")).toEqual(["g_ScrollX", "g_ScrollX", "g_ScrollX"]);
  }, 120000);

  it("razer_bedroom：light_speed 登记 17 条 scroll 常量（9 个 speedx + 8 个 speedy）", async () => {
    // 列全所有绑定，避免快速路径在其它不支持项处提前结束。
    const bundle = await compile(sample("razer_bedroom"), { exhaustive: true });
    const bindings = bundle.bindings.filter((binding) => binding.property === "light_speed");
    expect(bindings).toHaveLength(17);
    for (const binding of bindings) expect(constant(binding).pass).toMatch(/^objects\/\d+\/effects\/0\/passes\/0$/);
    const names = bindings.map((binding) => constant(binding).uniforms[0]);
    expect(names.filter((name) => name === "g_ScrollX")).toHaveLength(9);
    expect(names.filter((name) => name === "g_ScrollY")).toHaveLength(8);
  }, 120000);

  it("eagleflag：材质 usershadervalues 的三条登记到 flag pass", async () => {
    const bundle = await compile(sample("eagleflag"));
    expect(
      bundle.bindings.map((binding) => ({
        property: binding.property,
        pass: constant(binding).pass,
        material: constant(binding).material,
        uniforms: constant(binding).uniforms,
        type: constant(binding).type,
      })),
    ).toEqual([
      { property: "schemecolor", pass: "objects/0/passes/0", material: "color1", uniforms: ["g_Color1"], type: "vec3" },
      { property: "flagcolor1", pass: "objects/0/passes/0", material: "color2", uniforms: ["g_Color2"], type: "vec3" },
      { property: "flagcolor2", pass: "objects/0/passes/0", material: "color3", uniforms: ["g_Color3"], type: "vec3" },
    ]);
  }, 120000);

  it("shimmering_particles：style 五条条件可见、backgroundcolor 一条图层颜色、glow 一条泛光强度", async () => {
    const bundle = await compile(sample("shimmering_particles"), { exhaustive: true });
    const targets = (property: string) =>
      bundle.bindings.filter((binding) => binding.property === property).map((binding) => binding.target);
    expect(targets("style")).toEqual([
      { kind: "layer", object: 0, field: "visible" },
      { kind: "layer", object: 1, field: "visible" },
      { kind: "layer", object: 2, field: "visible" },
      { kind: "layer", object: 3, field: "visible" },
      { kind: "layer", object: 4, field: "visible" },
    ]);
    const style = bundle.bindings.filter((binding) => binding.property === "style");
    expect(style.map((binding) => binding.condition)).toEqual(["0", "1", "1", "1", "1"]);
    expect(targets("backgroundcolor")).toEqual([{ kind: "layer", object: 1, field: "color" }]);
    expect(targets("glow")).toEqual([{ kind: "bloom", field: "hdrStrength" }]);
    // 条件可见不再整张退回（P3a 删掉了 visible:condition）
    expect(bundle.unsupported).not.toContain("visible:condition");
  }, 120000);
});

describe.skipIf(!corpus)("本机语料：绑定表完整性", () => {
  const defaults = root ? join(root, "projects", "defaultprojects") : "";
  const workshop = root ? join(root, "..", "..", "workshop", "content", "431960") : "";
  const projects =
    root && existsSync(defaults)
      ? readdirSync(defaults)
          .map((name) => join(defaults, name))
          .filter(
            (dir) =>
              (existsSync(join(dir, "project.json")) && existsSync(join(dir, "scene.pkg"))) ||
              existsSync(join(dir, "scene.json")) ||
              (() => {
                try {
                  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
                  return (
                    typeof project.file === "string" &&
                    project.file.endsWith(".json") &&
                    existsSync(join(dir, project.file))
                  );
                } catch {
                  return false;
                }
              })(),
          )
      : [];
  if (root && existsSync(workshop))
    projects.push(
      ...readdirSync(workshop)
        .map((id) => join(workshop, id))
        .filter((dir) => existsSync(join(dir, "scene.pkg"))),
    );

  it("每张场景编译期读过的属性都登记进了绑定表（就地或重编译）", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const failures: string[] = [];
    try {
      for (const dir of projects) {
        const read = new Set<string>();
        observePropertyReads((name) => read.add(name));
        let bundle;
        try {
          bundle = await compileScene({
            projectDir: dir,
            sceneAssets: [join(root!, "assets")],
            reader,
            translator,
            postprocess: "disabled",
            exhaustive: true,
          });
        } finally {
          observePropertyReads(null);
        }
        const bound = new Set(bundle.bindings.map((binding) => binding.property));
        const missing = [...read].filter((name) => !bound.has(name));
        if (missing.length) failures.push(`${dir.split(/[\\/]/).at(-1)}: ${missing.join(", ")}`);
      }
    } finally {
      observePropertyReads(null);
    }
    expect(failures).toEqual([]);
  }, 600000);
});
