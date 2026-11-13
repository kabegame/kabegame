/**
 * P4f 步骤 1 的编译侧单测：粒子 `instanceoverride` 上的字段脚本写回到就地目标 `particle-instance`（`collectScripts`），能力表对 7 个
 * 系数挂脚本不再报 `particle:binding:instance:<键>`（`checkParticleInstance`）。依据 `.claude/plans/wpe-import/3-scene/phase4/
 * phase-4f-script.md`「步骤 1」与 `rea-p4f-script.md` 第 6 节。
 */
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import { checkParticleInstance } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject, SceneJson, SceneScalar } from "./model";
import { SCRIPT_INSTANCE_KEYS } from "./particles";
import { collectScripts } from "./scripts";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const SCRIPT = "export function update(value) { return value; }";
const script = (value: SceneScalar) => ({ script: SCRIPT, value });

/** 挂在 `instanceoverride` 上的字段脚本：6 个系数、`colorn`、`brightness`（P4f 步骤 2 起也有目标）、两种控制点与 `color`。 */
const OVERRIDE: JsonObject = {
  alpha: script(0.5),
  size: script(2),
  count: script(3),
  speed: script(4),
  lifetime: script(5),
  rate: script(0.25),
  colorn: script("0 1 0"),
  brightness: script(2),
  controlpoint0: script("1 2 0"),
  controlpointangle2: script("0 0 1"),
  color: script("255 0 0"),
};

describe("字段脚本的写回目标（collectScripts，targetOf）", () => {
  async function targets(scene: SceneJson) {
    const { list } = await collectScripts(scene, {}, []);
    return Object.fromEntries(list.map((item) => [item.id, { target: item.target, valueType: item.valueType }]));
  }

  it("粒子对象的 24 个键（6 个系数、colorn、P4f 步骤 2 起的 brightness、步骤 3 起的 16 个控制点键）写回 particle-instance（colorn 与控制点为 vec3，其余 float）；color 没有目标", async () => {
    const found = await targets({
      objects: [
        { id: 1, image: "models/a.json" },
        { id: 2, particle: "p.json", instanceoverride: OVERRIDE },
      ],
    });
    for (const key of SCRIPT_INSTANCE_KEYS.filter((item) => item in OVERRIDE))
      expect(found[`objects/1/instanceoverride/${key}`], key).toEqual({
        target: { kind: "particle-instance", object: 1, field: key },
        valueType: key === "colorn" || key.startsWith("controlpoint") ? "vec3" : "float",
      });
    expect(found["objects/1/instanceoverride/color"].target).toEqual({
      kind: "unsupported",
      path: "objects/1/instanceoverride/color",
    });
    expect(SCRIPT_INSTANCE_KEYS).toEqual([
      "alpha",
      "size",
      "count",
      "speed",
      "lifetime",
      "rate",
      "brightness",
      "colorn",
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `controlpoint${i}`),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `controlpointangle${i}`),
    ]);
  });

  it("instanceoverride 的 alpha / brightness 不落到图层的同名字段上；对象顶层的 alpha 仍是图层目标", async () => {
    const found = await targets({
      objects: [{ id: 1, particle: "p.json", alpha: script(0.5), instanceoverride: { alpha: script(0.5) } }],
    });
    expect(found["objects/0/alpha"].target).toEqual({ kind: "layer", object: 0, field: "alpha" });
    expect(found["objects/0/instanceoverride/alpha"].target).toEqual({
      kind: "particle-instance",
      object: 0,
      field: "alpha",
    });
  });

  it("非粒子对象上的 instanceoverride 没有目标（能力表报 object:instanceoverride）", async () => {
    const found = await targets({
      objects: [{ id: 1, image: "models/a.json", instanceoverride: { alpha: script(1) } }],
    });
    expect(found["objects/0/instanceoverride/alpha"].target).toEqual({
      kind: "unsupported",
      path: "objects/0/instanceoverride/alpha",
    });
  });
});

describe("能力表（checkParticleInstance）", () => {
  const check = (raw: unknown, context = { flags: 0 }) => {
    const keys = new Set<string>();
    checkParticleInstance(raw, context, keys);
    return [...keys].sort();
  };

  it("24 个键（含 brightness，P4f 步骤 2；含控制点，P4f 步骤 3）挂脚本不报；color 挂脚本照报", () => {
    for (const key of SCRIPT_INSTANCE_KEYS) expect(check({ [key]: OVERRIDE[key] ?? script("1 0 0") }), key).toEqual([]);
    expect(check(OVERRIDE)).toEqual(["particle:binding:instance:color"]);
    // bit3 不影响脚本这一条
    expect(check({ brightness: script(1) }, { flags: 8 })).toEqual([]);
    expect(check({ controlpoint1: script("1 0 0") }, { flags: 8 })).toEqual([]);
  });
});

/** 内存文件：字符串原样，其它按 JSON（同 `p4a5.test.ts`）。 */
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

describe("compileScene：字段脚本挂在 instanceoverride 上", () => {
  const compile = (override: JsonObject) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: memoryReader({
        "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
        "P:/p/scene.json": {
          general: { orthogonalprojection: { width: 1920, height: 1080 } },
          objects: [{ id: 1, particle: "particles/p.json", instanceoverride: override }],
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

  it("OVERRIDE 里有目标的 10 个键（6 个系数、brightness、colorn 与两个控制点键）：不报 particle:binding:instance:*，初值取 value，脚本写回 particle-instance", async () => {
    const keys = SCRIPT_INSTANCE_KEYS.filter((key) => key in OVERRIDE);
    const override = Object.fromEntries(keys.map((key) => [key, OVERRIDE[key]]));
    const bundle = await compile(override);
    expect(bundle.unsupported.filter((key) => key.startsWith("particle:"))).toEqual([]);
    expect(bundle.layers[0].particle!.instance).toMatchObject({
      alpha: 0.5,
      size: 2,
      count: 3,
      speed: 4,
      lifetime: 5,
      rate: 0.25,
      brightness: 2,
      colorn: [0, 1, 0],
    });
    // 控制点（P4f 步骤 3）：初值同样取 value
    expect(bundle.layers[0].particle!.instance.controlpoints[0]).toEqual([1, 2, 0]);
    expect(bundle.layers[0].particle!.instance.controlpointAngles[2]).toEqual([0, 0, 1]);
    expect(bundle.scripts.list.map((item) => item.target)).toEqual(
      keys.map((field) => ({ kind: "particle-instance", object: 0, field })),
    );
    // 字段脚本不是用户绑定：绑定表里没有它们
    expect(bundle.bindings.filter((binding) => binding.target.kind === "particle-instance")).toEqual([]);
  });

  it("控制点挂脚本不报（P4f 步骤 3；brightness 从 P4f 步骤 2 起不报）", async () => {
    const bundle = await compile({ brightness: script(2), controlpoint1: script("1 0 0") });
    expect(bundle.unsupported.filter((key) => key.startsWith("particle:binding"))).toEqual([]);
  });
});
