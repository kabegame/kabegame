/**
 * P4f 步骤 3 的编译侧单测：粒子层的脚本方法与 `instance` 不再报（`scanScriptApi` 删掉了有粒子层时的多报，`MISSING_SCRIPT_API` 删了
 * `emitParticles` 与 `instance`）；实例覆盖的控制点挂脚本、绑用户属性不再报，登记成就地目标 `particle-instance`（vec3），状态的就地写与
 * 编译期同一条取值规则。
 */
import { describe, expect, it, vi } from "vitest";
import { planApply } from "./bindings";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import type { JsonObject } from "./model";
import {
  FLT_MAX,
  INSTANCE_CONTROL_POINT_KEYS,
  instanceControlPoint,
  instanceOverrideSet,
  SCRIPT_INSTANCE_KEYS,
} from "./particles";
import { MISSING_SCRIPT_API, scanScriptApi } from "./scriptApi";
import { SceneState } from "../render/state";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 内存文件：字符串原样，其它按 JSON（同 `p4f1.test.ts`）。 */
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

/** 一个粒子对象（`instanceoverride` 取 `override`），另可加对象；属性 `properties`。 */
const compile = (override: JsonObject, extra: JsonObject[] = [], properties: JsonObject = {}) =>
  compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json", general: { properties } },
      "P:/p/scene.json": {
        general: { orthogonalprojection: { width: 1920, height: 1080 } },
        objects: [{ id: 1, name: "fx", particle: "particles/p.json", instanceoverride: override }, ...extra],
      },
      "P:/p/particles/p.json": {
        material: "materials/pm.json",
        maxcount: 20,
        emitter: [{ name: "sphererandom", rate: 5 }],
      },
      "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
      "P:/p/shaders/genericparticle.vert": "void main(){}",
      "P:/p/shaders/genericparticle.frag": "void main(){}",
    }),
    translator,
    postprocess: "disabled",
    exhaustive: true,
  });

const SCRIPT = "export function update(value) { return value; }";

describe("脚本 API 检查不再报粒子层的方法与 instance", () => {
  const scan = (source: string) => scanScriptApi({ source, owner: { kind: "layer" }, layer: 0 });

  it("emitParticles、instance 不在 MISSING_SCRIPT_API 里；任意接收者上的 play / pause / stop / isPlaying / emitParticles 都不报", () => {
    const names = Object.values(MISSING_SCRIPT_API).flatMap((entries) => entries.map((entry) => entry.name));
    for (const name of ["emitParticles", "instance", "play", "pause", "stop", "isPlaying"])
      expect(names, name).not.toContain(name);
    expect(
      scan(
        [
          "thisLayer.emitParticles(3); thisLayer.emitParticles();",
          "let fx = thisScene.getLayer('fx'); fx.play(); fx.pause(); fx.stop(); fx.isPlaying(); fx.emitParticles(2);",
          "thisLayer.instance.count = 2; thisObject.instance.controlpoint0 = new Vec3(1, 2, 0);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("编译：有粒子层的场景里脚本用这些不报 script:api:*（以前报 particle.<名>、layer.emitParticles、layer.instance）", async () => {
    const source = [
      "export function update(value) {",
      "  thisLayer.play(); thisLayer.pause(); thisLayer.stop();",
      "  if (thisLayer.isPlaying()) thisLayer.emitParticles(1);",
      "  thisLayer.instance.alpha = 0.5;",
      "  return value;",
      "}",
    ].join("\n");
    const bundle = await compile({}, [{ id: 2, name: "ctrl", visible: { script: source, value: true } }]);
    expect(bundle.unsupported.filter((key) => key.startsWith("script:"))).toEqual([]);
  });
});

describe("实例覆盖的控制点（P4f 步骤 3）", () => {
  it("16 个控制点键在 SCRIPT_INSTANCE_KEYS 里；instanceControlPoint 认键；instanceOverrideSet 只看 x 是否 FLT_MAX", () => {
    expect(INSTANCE_CONTROL_POINT_KEYS).toHaveLength(16);
    for (const key of INSTANCE_CONTROL_POINT_KEYS) expect(SCRIPT_INSTANCE_KEYS).toContain(key);
    expect(
      ["controlpoint0", "controlpoint7", "controlpointangle3", "controlpoint8", "controlpoints", "alpha"].map(
        instanceControlPoint,
      ),
    ).toEqual([{ angle: false, index: 0 }, { angle: false, index: 7 }, { angle: true, index: 3 }, null, null, null]);
    expect(
      [null, undefined, [1, 2, 3], [FLT_MAX, 0, 0], [3.4028235e38, 1, 1], [Infinity, 0, 0]].map(instanceOverrideSet),
    ).toEqual([false, false, true, false, false, true]);
  });

  it("挂 {script}：不报，写回目标 particle-instance、值类型 vec3，初值取 value", async () => {
    const bundle = await compile({
      controlpoint2: { script: SCRIPT, value: "1 2 0" },
      controlpointangle5: { script: SCRIPT, value: "0 0 1" },
    });
    expect(bundle.unsupported.filter((key) => key.startsWith("particle:"))).toEqual([]);
    expect(bundle.scripts.list.map((item) => [item.target, item.valueType])).toEqual([
      [{ kind: "particle-instance", object: 0, field: "controlpoint2" }, "vec3"],
      [{ kind: "particle-instance", object: 0, field: "controlpointangle5" }, "vec3"],
    ]);
    const instance = bundle.layers[0].particle!.instance;
    expect([instance.controlpoints[2], instance.controlpointAngles[5]]).toEqual([
      [1, 2, 0],
      [0, 0, 1],
    ]);
  });

  it("绑用户属性：不报（以前报 particle:instance:controlpoint:user），登记成就地目标，值取属性；属性改值就地写进状态、置脏", async () => {
    const bundle = await compile({ controlpoint1: { user: "pos", value: "0 0 0" } }, [], {
      pos: { type: "textinput", value: "10 20 0" },
    });
    expect(bundle.unsupported.filter((key) => key.startsWith("particle:"))).toEqual([]);
    const binding = bundle.bindings.find((item) => item.property === "pos")!;
    expect(binding.target).toEqual({ kind: "particle-instance", object: 0, field: "controlpoint1" });
    expect(bundle.layers[0].particle!.instance.controlpoints[1]).toEqual([10, 20, 0]);
    const state = SceneState.fromBundle(bundle);
    expect(state.particleInstances.get(0)!.controlpoints[1]).toEqual([10, 20, 0]);
    state.takeDirty();
    const plan = planApply(bundle.bindings, new Map([["pos", "5 6 7"]]));
    expect(plan.recompile).toEqual([]);
    for (const write of plan.writes) state.write(write.binding, write.value);
    expect(state.particleInstances.get(0)!.controlpoints[1]).toEqual([5, 6, 7]);
    // 编译期那份不被改（状态拷了一份新数组）
    expect(bundle.layers[0].particle!.instance.controlpoints[1]).toEqual([10, 20, 0]);
    const dirty = state.takeDirty();
    expect([[...dirty.particles], [...dirty.rates]]).toEqual([[0], []]);
  });
});
