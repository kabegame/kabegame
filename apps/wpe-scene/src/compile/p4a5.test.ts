/**
 * P4a 步骤 5 的编译侧单测：能力表的两处修正（属性关键帧报 `value:animation`、`alphawriting: "default"` 中性），
 * `instanceoverride` 的绑定登记与能力表（`.claude/plans/wpe-import/3-scene/phase4/phase-4a-base.md`「步骤 5」）。
 */
import { describe, expect, it, vi } from "vitest";
import { collectAnimations } from "./animations";
import { BindingCollector, isKeyframedValue, planApply, type SceneBinding } from "./bindings";
import { compileScene } from "./bundle";
import {
  checkEffectFeatures,
  checkModelFeatures,
  checkParticleFeatures,
  checkParticleInstance,
  checkPassFeatures,
  checkSceneFeatures,
} from "./features";
import type { SceneReader } from "./fs";
import { observePropertyReads, type JsonObject, type SceneJson, type SceneValue } from "./model";
import { INSTANCE_FIELDS, instanceScalar, parseParticleInstance, type InstanceKey } from "./particles";
import { readParticleModule } from "../particles/modules";
import { SceneState } from "../render/state";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
/** 一条关键帧动画（形状照语料：`c0` 关键帧 + `options`）。 */
const ANIMATION = {
  c0: [{ frame: 0, value: 0 }],
  options: { fps: 30, length: 60, mode: "loop", wraploop: false },
};
const keyframed = (value: unknown, extra: Record<string, unknown> = {}) => ({ animation: ANIMATION, value, ...extra });
const SCRIPT = "export function update(value) { return value; }";

function sceneKeys(scene: SceneJson): string[] {
  const keys = new Set<string>();
  checkSceneFeatures(scene, keys);
  return [...keys].sort();
}

describe("A：属性关键帧报 value:animation", () => {
  it("isKeyframedValue：animation 是对象才算；puppet 的整数 id、数组、null 不算", () => {
    expect(isKeyframedValue(keyframed(1))).toBe(true);
    expect(isKeyframedValue(keyframed(1, { user: "a" }))).toBe(true);
    expect(isKeyframedValue(keyframed(1, { script: SCRIPT }))).toBe(true);
    expect(isKeyframedValue({ animation: 3, blend: 1 })).toBe(false);
    expect(isKeyframedValue({ animation: [1, 2], value: 1 })).toBe(false);
    expect(isKeyframedValue({ animation: null, value: 1 })).toBe(false);
    expect(isKeyframedValue({ user: "a", value: 1 })).toBe(false);
    expect(isKeyframedValue([ANIMATION])).toBe(false);
    expect(isKeyframedValue(null)).toBe(false);
    expect(isKeyframedValue("1 2 3")).toBe(false);
  });

  const image = (extra: JsonObject = {}): JsonObject => ({ id: 1, image: "models/a.json", ...extra });

  // P10a 步骤 2：scene.json 里的关键帧不再由能力表报，改由 `collectAnimations` 编成动画（细分键见 `animations.test.ts`）
  it("scene：general、图层字段、effect 实例常量、effect 可见性、instanceoverride 都由 collectAnimations 收集", () => {
    expect(sceneKeys({ general: ORTHO, objects: [image()] })).toEqual([]);
    const effect = (instance: JsonObject) => ({
      general: ORTHO,
      objects: [image({ effects: [{ file: "effects/tint/effect.json", ...instance }] })],
    });
    const cases: [SceneJson, string][] = [
      [{ general: { ...ORTHO, bloomstrength: keyframed(2) }, objects: [] }, "general/bloomstrength"],
      [{ general: ORTHO, objects: [image({ alpha: keyframed(1) })] }, "objects/0/alpha"],
      [{ general: ORTHO, objects: [image({ origin: keyframed("1 2 3") })] }, "objects/0/origin"],
      [
        effect({ passes: [{ constantshadervalues: { multiply: keyframed(1) } }] }),
        "objects/0/effects/0/passes/0/constantshadervalues/multiply",
      ],
      [effect({ visible: keyframed(true) }), "objects/0/effects/0/visible"],
      [
        {
          general: ORTHO,
          objects: [{ id: 2, particle: "particles/p.json", instanceoverride: { count: keyframed(2) } }],
        },
        "objects/0/instanceoverride/count",
      ],
    ];
    for (const [scene, id] of cases) {
      expect(sceneKeys(scene), id).toEqual([]);
      const { list, unsupported } = collectAnimations(scene);
      expect(
        list.map((item) => item.id),
        id,
      ).toEqual([id]);
      expect(unsupported, id).toEqual([]);
    }
  });

  it("挂了 user / script 的关键帧同样收集；puppet 的 animationlayers（整数 id）不算", () => {
    for (const extra of [{ user: "a" }, { script: SCRIPT }]) {
      const scene = { general: ORTHO, objects: [image({ alpha: keyframed(1, extra) })] };
      expect(sceneKeys(scene)).toEqual([]);
      expect(collectAnimations(scene).list.map((item) => item.id)).toEqual(["objects/0/alpha"]);
    }
    const puppet = {
      general: ORTHO,
      objects: [image({ animationlayers: [{ animation: 1, blend: 1, rate: 1, visible: true }] })],
    };
    expect(sceneKeys(puppet)).not.toContain("value:animation");
    expect(collectAnimations(puppet)).toEqual({ list: [], unsupported: [] });
  });

  it("材质常量报；alphawriting 的 default 中性，enabled / disabled 自 P8 步骤 5 起实现、不报，其它取值照报", () => {
    const pass = (extra: JsonObject) => {
      const keys = new Set<string>();
      checkPassFeatures({ shader: "genericimage2", ...extra }, keys);
      return [...keys].sort();
    };
    expect(pass({ constantshadervalues: { alpha: keyframed(0.5) } })).toEqual(["value:animation"]);
    expect(pass({ constantshadervalues: { alpha: 0.5 } })).toEqual([]);
    expect(pass({ alphawriting: "default" })).toEqual([]);
    expect(pass({})).toEqual([]);
    expect(pass({ alphawriting: "enabled" })).toEqual([]);
    expect(pass({ alphawriting: "disabled" })).toEqual([]);
    expect(pass({ alphawriting: true })).toEqual(["material:alphawriting"]);
  });

  it("模型 JSON 与 effect.json 各扫一次", () => {
    const model = new Set<string>();
    checkModelFeatures({ material: "materials/a.json", width: keyframed(10) as never }, model);
    expect([...model]).toEqual(["value:animation"]);
    const plainModel = new Set<string>();
    checkModelFeatures({ material: "materials/a.json", width: 10 }, plainModel);
    expect([...plainModel]).toEqual([]);

    const effect = new Set<string>();
    checkEffectFeatures(
      { file: "effects/x/effect.json" },
      { passes: [{ material: "materials/x.json" }], fbos: [{ name: "a", scale: keyframed(2) as never }] },
      "x",
      effect,
    );
    expect([...effect]).toEqual(["value:animation"]);
  });

  it("粒子 JSON：系统级键、模块字段、控制点、子系统条目都报；关键帧与绑定分开报", () => {
    const keys = (system: JsonObject) => {
      const set = new Set<string>();
      checkParticleFeatures(system, true, set);
      return [...set].sort();
    };
    expect(keys({ maxcount: 10, starttime: keyframed(2) })).toEqual(["value:animation"]);
    expect(keys({ maxcount: 10, starttime: keyframed(2, { user: "t" }) })).toEqual([
      "particle:binding:system:starttime",
      "value:animation",
    ]);
    // 模块字段：报 value:animation，不再报形状问题 particle:emitter:sphererandom:rate
    expect(keys({ emitter: [{ name: "sphererandom", rate: keyframed(5) }] })).toEqual(["value:animation"]);
    expect(keys({ emitter: [{ name: "sphererandom", rate: keyframed(5, { user: "r" }) }] })).toEqual([
      "particle:binding:emitter:sphererandom:rate",
      "value:animation",
    ]);
    expect(keys({ operator: [{ name: "alphafade", fadeintime: keyframed(0.2, { script: SCRIPT }) }] })).toEqual([
      "particle:binding:operator:alphafade:fadeintime",
      "value:animation",
    ]);
    // 表内模块的未知字段同样报
    expect(keys({ operator: [{ name: "movement", foo: keyframed(1) }] })).toEqual([
      "particle:operator:movement:foo",
      "value:animation",
    ]);
    expect(keys({ controlpoint: [{ id: 0, offset: keyframed("0 0 0") }] })).toContain("value:animation");
    expect(keys({ children: [{ name: "c.json", origin: keyframed("0 0 0") }] })).toContain("value:animation");
    expect(keys({ emitter: [{ name: "sphererandom", rate: 5 }], controlpoint: [{ id: 0 }] })).toEqual([]);
  });

  it("readParticleModule：关键帧字段报 animation，按 value 解析", () => {
    const reading = readParticleModule("emitter", { name: "sphererandom", rate: keyframed(7) }, true);
    expect(reading.issues).toEqual([{ field: "rate", kind: "animation" }]);
    expect(reading.fields.rate).toBe(7);
    const both = readParticleModule("emitter", { name: "sphererandom", rate: keyframed(7, { user: "r" }) }, true);
    expect(both.issues).toEqual([
      { field: "rate", kind: "animation" },
      { field: "rate", kind: "binding" },
    ]);
  });
});

describe("B：instanceoverride 的取值、绑定与能力表", () => {
  it("instanceScalar：数字原样、字符串整串解析、布尔 1 / 0，其余取 1", () => {
    expect(instanceScalar(2.5)).toBe(2.5);
    expect(instanceScalar(0)).toBe(0);
    expect(instanceScalar("0.75")).toBe(0.75);
    expect(instanceScalar(true)).toBe(1);
    expect(instanceScalar(false)).toBe(0);
    for (const value of [undefined, null, "", "  ", "1 2 3", "abc", Number.NaN, Infinity, {}])
      expect(instanceScalar(value)).toBe(1);
  });

  it("BindingCollector 解析：读用户属性、带 condition；静态值与 {script} 只取 value、不登记", () => {
    const bindings = new BindingCollector();
    const target = (field: InstanceKey): SceneBinding["target"] => ({ kind: "particle-instance", object: 3, field });
    const instance = parseParticleInstance(
      {
        alpha: 10,
        count: { user: "count", value: 1 },
        size: { user: { name: "style", condition: "1" }, value: 1 },
        rate: { script: SCRIPT, value: 0.5 },
        speed: "2",
        id: 33,
      },
      (field, raw) => bindings.bind(raw as SceneValue | undefined, { count: 1.5, style: "0" }, target(field)),
    );
    expect(instance).toMatchObject({ alpha: 10, count: 1.5, size: 0, rate: 0.5, speed: 2, lifetime: 1, brightness: 1 });
    // 按 INSTANCE_FIELDS 的顺序登记
    expect(bindings.list).toEqual([
      { property: "style", condition: "1", target: target("size") },
      { property: "count", target: target("count") },
    ]);
  });

  it("planApply：particle-instance 分到就地一侧", () => {
    const bindings: SceneBinding[] = INSTANCE_FIELDS.map((field) => ({
      property: field,
      target: { kind: "particle-instance", object: 0, field },
    }));
    const plan = planApply(bindings, new Map(INSTANCE_FIELDS.map((field) => [field, 2])));
    expect(plan.recompile).toEqual([]);
    expect(plan.writes.map((write) => write.binding.property)).toEqual([...INSTANCE_FIELDS]);
  });

  describe("checkParticleInstance", () => {
    const check = (raw: unknown, context = { flags: 0 }) => {
      const keys = new Set<string>();
      checkParticleInstance(raw, context, keys);
      return [...keys].sort();
    };

    it("已实现的六个标量键（静态与 {user}）、id、null 都不报", () => {
      expect(
        check({
          id: 12,
          alpha: 10,
          size: { user: "s", value: 2 },
          count: 0.5,
          speed: 2,
          lifetime: 3,
          rate: 0.27,
          colorn: null,
          controlpoint1: null,
        }),
      ).toEqual([]);
      expect(check(undefined)).toEqual([]);
      expect(check(null)).toEqual([]);
      expect(check({ id: null })).toEqual([]);
    });

    it("colorn / color（P4b 步骤 6 已实现）：静态值与 colorn 的 {user} 不再报 particle:instance:colorn", () => {
      for (const raw of [
        { colorn: "1.00000 1.00000 1.00000" },
        { colorn: "0 0 0" },
        { color: "255 128 0" },
        { colorn: { user: "c", value: "1 0 0" } },
        { colorn: "-1 -1 -1" },
        { colorn: "abc" },
      ])
        expect(check(raw), JSON.stringify(raw)).toEqual([]);
      expect(check({ colorn: "1 0 0" }, { flags: 8 })).toEqual([]);
    });

    it("WPE 没读到的两种写法照报：color 绑了属性报 color:user，colorn 带 condition 报 colorn:condition；bit3 时都不报", () => {
      expect(check({ color: { user: "c", value: "255 0 0" } })).toEqual(["particle:instance:color:user"]);
      expect(check({ color: { user: { name: "c", condition: "1" }, value: "255 0 0" } })).toEqual([
        "particle:instance:color:user",
      ]);
      expect(check({ colorn: { user: { name: "c", condition: "1" }, value: "1 0 0" } })).toEqual([
        "particle:instance:colorn:condition",
      ]);
      // 条件写数字也算（WPE 按字符串比）
      expect(check({ colorn: { user: { name: "c", condition: 2 }, value: "1 0 0" } })).toEqual([
        "particle:instance:colorn:condition",
      ]);
      expect(check({ colorn: { user: { name: "c" }, value: "1 0 0" } })).toEqual([]);
      expect(check({ color: { user: "c", value: "255 0 0" } }, { flags: 8 })).toEqual([]);
      expect(check({ colorn: { user: { name: "c", condition: "1" }, value: "1 0 0" } }, { flags: 8 | 4 })).toEqual([]);
    });

    it("brightness（P4f 步骤 2 已实现，HDR 下乘实例颜色）：非默认的静态值、{user}、bit3 都不报", () => {
      expect(check({ brightness: 5 })).toEqual([]);
      expect(check({ brightness: 1 })).toEqual([]);
      expect(check({ brightness: 5 }, { flags: 8 })).toEqual([]);
      expect(check({ brightness: { user: "b", value: 10 } })).toEqual([]);
      expect(check({ brightness: { user: { name: "b", condition: "1" }, value: 10 } })).toEqual([]);
    });

    it("控制点静态值、{user}、挂 {script} 都不报（P4c 步骤 1、P4f 步骤 3）；6 个系数、brightness 与 colorn 挂脚本不报（P4f 步骤 1、2）；其它键报 particle:instance:<键>", () => {
      expect(check({ controlpoint1: "10 20 0" })).toEqual([]);
      expect(check({ controlpointangle3: "0 0 0" })).toEqual([]);
      expect(check({ controlpoint7: "abc", controlpointangle0: "1 2 3" })).toEqual([]);
      // P4f 步骤 3：控制点的运行时写入实现了，绑用户属性与挂脚本不再报
      expect(check({ controlpoint2: { user: "p", value: "1 2 0" } })).toEqual([]);
      expect(check({ controlpointangle5: { user: { name: "a", condition: "1" }, value: "0 0 1" } })).toEqual([]);
      expect(check({ controlpoint1: { script: SCRIPT, value: "1 2 0" } })).toEqual([]);
      // P4f 步骤 1、2：6 个系数、brightness 与 colorn 挂脚本已实现（写回目标 particle-instance），不报
      expect(check({ count: { script: SCRIPT, value: 1 } })).toEqual([]);
      expect(check({ colorn: { script: SCRIPT, value: "1 1 1" } })).toEqual([]);
      expect(check({ brightness: { script: SCRIPT, value: 1 } })).toEqual([]);
      expect(check({ foo: 1 })).toEqual(["particle:instance:foo"]);
      expect(check({ controlpoint8: "1 0 0" })).toEqual(["particle:instance:controlpoint8"]);
      expect(check("1 2 3")).toEqual(["particle:instance"]);
    });
  });
});

/** 内存文件：字符串原样，其它按 JSON。 */
function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

const translator = {
  async translate() {
    return { ok: true };
  },
} as unknown as Wpesl2wgsl;

describe("B：compileScene 登记 instanceoverride 绑定", () => {
  const PROPERTIES = {
    a: { type: "slider", value: 0.5 },
    s: { type: "slider", value: 2 },
    n: { type: "slider", value: 1.5 },
    v: { type: "slider", value: 3 },
    l: { type: "slider", value: 4 },
    r: { type: "slider", value: 0.25 },
    b: { type: "slider", value: 1 },
    c: { type: "color", value: "0 1 0" },
  };
  const OVERRIDE = {
    id: 7,
    alpha: { user: "a", value: 1 },
    size: { user: "s", value: 1 },
    count: { user: "n", value: 1 },
    speed: { user: "v", value: 1 },
    lifetime: { user: "l", value: 1 },
    rate: { user: "r", value: 1 },
    brightness: { user: "b", value: 1 },
    colorn: { user: "c", value: "1 0 0" },
  };
  const files = (general: JsonObject, flags = 0) => ({
    "P:/p/project.json": { file: "scene.json", general: { properties: PROPERTIES } },
    "P:/p/scene.json": {
      general,
      objects: [
        { id: 1, image: "models/none.json" },
        { id: 2, particle: "particles/p.json", instanceoverride: OVERRIDE },
      ],
    },
    "P:/p/particles/p.json": {
      material: "materials/pm.json",
      maxcount: 20,
      flags,
      emitter: [{ name: "sphererandom", rate: 5 }],
    },
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["_rt_FullFrameBuffer"] }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
  });
  const compile = (general: JsonObject, flags = 0, postprocess: "disabled" | "ultra" = "disabled") =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader(files(general, flags)),
      translator,
      postprocess,
      exhaustive: true,
    });
  const instanceBindings = (bindings: readonly SceneBinding[]) =>
    bindings.filter((binding) => binding.target.kind === "particle-instance" || binding.target.kind === "recompile");

  it("七个标量键与 colorn 都登记成就地目标（objects 下标），值取用户属性", async () => {
    const bundle = await compile(ORTHO);
    expect(instanceBindings(bundle.bindings)).toEqual(
      [
        ["a", "alpha"],
        ["s", "size"],
        ["n", "count"],
        ["v", "speed"],
        ["l", "lifetime"],
        ["r", "rate"],
        ["b", "brightness"],
        ["c", "colorn"],
      ].map(([property, field]) => ({ property, target: { kind: "particle-instance", object: 1, field } })),
    );
    expect(bundle.layers[1].particle!.instance).toMatchObject({
      alpha: 0.5,
      size: 2,
      count: 1.5,
      speed: 3,
      lifetime: 4,
      rate: 0.25,
      brightness: 1,
      colorn: [0, 1, 0],
    });
    expect(bundle.unsupported.filter((key) => key.startsWith("particle:instance"))).toEqual([]);
    expect(bundle.unsupported).not.toContain("particle:instance:brightness");
    // SceneState 的起始值就是编译期的值（P4f 步骤 3 起带控制点覆盖，这里都没设）
    expect(SceneState.fromBundle(bundle).particleInstances.get(1)).toEqual({
      alpha: 0.5,
      size: 2,
      count: 1.5,
      speed: 3,
      lifetime: 4,
      rate: 0.25,
      brightness: 1,
      colorn: [0, 1, 0],
      controlpoints: Array(8).fill(null),
      controlpointAngles: Array(8).fill(null),
    });
  });

  it("HDR 下 brightness 同样是就地目标（P4f 步骤 2，有无 bit3 都是）", async () => {
    const hdr = { ...ORTHO, bloom: true, hdr: true };
    const lit = await compile(hdr, 0, "ultra");
    expect(lit.general.postprocess.hdr).toBe(true);
    expect(lit.bindings.find((binding) => binding.property === "b")?.target).toEqual({
      kind: "particle-instance",
      object: 1,
      field: "brightness",
    });
    const masked = await compile(hdr, 8, "ultra");
    expect(masked.bindings.find((binding) => binding.property === "b")?.target).toEqual({
      kind: "particle-instance",
      object: 1,
      field: "brightness",
    });
  });

  it("编译期读过的属性都在绑定表里（漏登记 = 改了没反应）", async () => {
    const read = new Set<string>();
    observePropertyReads((name) => read.add(name));
    let bundle;
    try {
      bundle = await compile(ORTHO);
    } finally {
      observePropertyReads(null);
    }
    const bound = new Set(bundle.bindings.map((binding) => binding.property));
    for (const name of ["a", "s", "n", "v", "l", "r", "b", "c"]) expect(read.has(name), name).toBe(true);
    expect([...read].filter((name) => !bound.has(name))).toEqual([]);
  });

  it("就地写 = 用新值重编译：SceneState 写入的值与编译期解析逐项相同（数字、字符串、布尔、condition）", async () => {
    const bundle = await compile(ORTHO);
    for (const raw of [0.3, 2, "0.75", "abc", true, false, 0]) {
      for (const condition of [undefined, "0.3", "true"]) {
        const state = SceneState.fromBundle(bundle);
        const user = condition === undefined ? "n" : { name: "n", condition };
        // 编译期：同一条 `{user}` 按新的属性值解析
        const compiled = parseParticleInstance({ count: { user, value: 1 } }, (_, value) =>
          new BindingCollector().bind(
            value as SceneValue,
            { n: raw },
            { kind: "particle-instance", object: 1, field: "count" },
          ),
        ).count;
        state.write(
          {
            property: "n",
            ...(condition === undefined ? {} : { condition }),
            target: { kind: "particle-instance", object: 1, field: "count" },
          },
          raw,
        );
        expect(state.particleInstances.get(1)!.count, `${String(raw)} / ${condition}`).toBe(compiled);
        expect(state.takeDirty().particles).toEqual(new Set([1]));
        expect(state.takeDirty().particles.size).toBe(0);
      }
    }
    // 目标不在 bundle 里：不做事
    const state = SceneState.fromBundle(bundle);
    expect(state.write({ property: "n", target: { kind: "particle-instance", object: 9, field: "count" } }, 2)).toBe(
      "applied",
    );
    expect(state.takeDirty().particles.size).toBe(0);
  });

  it("colorn 就地写 = 用新值重编译（P4b 步骤 6）：字符串、少于三个分量、数字、布尔、condition 与编译期解析相同，只标脏粒子", async () => {
    const bundle = await compile(ORTHO);
    for (const raw of ["0 0 1", "0.25 0.5 0.75 1", "1 0", "abc", 0.5, true, "-1 -1 -1"]) {
      for (const condition of [undefined, "0 0 1"]) {
        const state = SceneState.fromBundle(bundle);
        const user = condition === undefined ? "c" : { name: "c", condition };
        const compiled = parseParticleInstance({ colorn: { user, value: "1 0 0" } }, (field, value) =>
          new BindingCollector().bind(value as SceneValue, { c: raw }, { kind: "particle-instance", object: 1, field }),
        ).colorn;
        expect(
          state.write(
            {
              property: "c",
              ...(condition === undefined ? {} : { condition }),
              target: { kind: "particle-instance", object: 1, field: "colorn" },
            },
            raw,
          ),
        ).toBe("applied");
        expect(state.particleInstances.get(1)!.colorn, `${String(raw)} / ${condition}`).toEqual(compiled);
        // 标量不受影响
        expect(state.particleInstances.get(1)!.count).toBe(1.5);
        const dirty = state.takeDirty();
        expect(dirty.particles).toEqual(new Set([1]));
        expect([dirty.layers.size, dirty.passes.size]).toEqual([0, 0]);
      }
    }
    // 编译期绑定的属性改成新值：用 planApply 分到就地一侧
    const plan = planApply(bundle.bindings, new Map([["c", "0 0 1"]]));
    expect(plan.recompile).toEqual([]);
    expect(plan.writes.map((write) => write.binding.target)).toEqual([
      { kind: "particle-instance", object: 1, field: "colorn" },
    ]);
  });
});
