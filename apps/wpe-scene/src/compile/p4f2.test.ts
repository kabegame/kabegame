/**
 * P4f 步骤 2 的编译侧单测：HDR 下的 `instanceoverride.brightness` 从「重编译目标、非默认值报不支持」改成普通的就地目标
 * （`compileParticleSystem` 的 `instanceTarget`），能力表不再报 `particle:instance:brightness`、挂脚本不再报
 * `particle:binding:instance:brightness`（`SCRIPT_INSTANCE_KEYS`），场景加载时判定的 HDR 写进每个系统（`SceneParticle.hdr`）。
 * 依据 `.claude/plans/wpe-import/3-scene/phase4/phase-4f-script.md`「步骤 2」与 `rea-p4f-script.md` 第 7 节。
 */
import { describe, expect, it, vi } from "vitest";
import { planApply, type SceneBinding } from "./bindings";
import { compileScene, type SceneBundle } from "./bundle";
import { checkParticleInstance } from "./features";
import type { SceneReader } from "./fs";
import type { JsonObject, SceneJson, SceneScalar } from "./model";
import { SCRIPT_INSTANCE_KEYS } from "./particles";
import { collectScripts } from "./scripts";
import { SceneState } from "../render/state";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const SCRIPT = "export function update(value) { return value; }";
const script = (value: SceneScalar) => ({ script: SCRIPT, value });

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

const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
/** 场景 `bloom`、`hdr` 都开：「超高」档下 HDR 实际开启（`postprocess.ts`）。 */
const HDR_GENERAL = { ...ORTHO, bloom: true, hdr: true };

interface Options {
  general?: JsonObject;
  postprocess?: "disabled" | "ultra";
  /** 粒子 JSON 的系统 `flags`（顶层）。 */
  flags?: number;
  /** 子系统的 `flags`。 */
  childFlags?: number;
}

/**
 * 对象 1 是粒子（对象 0 是图像层，下标不等于 id），挂一个 static 与一个 eventspawn 子系统；属性 `b` 是 5（非默认）。
 */
function compile(override: JsonObject, options: Options = {}): Promise<SceneBundle> {
  const { general = ORTHO, postprocess = "disabled", flags = 0, childFlags = 0 } = options;
  const system = (extra: JsonObject) => ({
    material: "materials/pm.json",
    maxcount: 20,
    emitter: [{ name: "sphererandom", rate: 5 }],
    ...extra,
  });
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": { file: "scene.json", general: { properties: { b: { type: "slider", value: 5 } } } },
      "P:/p/scene.json": {
        general,
        objects: [
          { id: 1, image: "models/none.json" },
          { id: 2, particle: "particles/p.json", instanceoverride: override },
        ],
      },
      "P:/p/particles/p.json": system({
        flags,
        children: [{ name: "particles/c.json" }, { name: "particles/c.json", type: "eventspawn" }],
      }),
      "P:/p/particles/c.json": system({ flags: childFlags }),
      "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] },
      "P:/p/shaders/genericparticle.vert": "void main(){}",
      "P:/p/shaders/genericparticle.frag": "void main(){}",
    }),
    translator,
    postprocess,
    exhaustive: true,
  });
}

const particleKeys = (bundle: SceneBundle) => bundle.unsupported.filter((key) => key.startsWith("particle:"));
const bindingOf = (bundle: SceneBundle, property: string): SceneBinding | undefined =>
  bundle.bindings.find((binding) => binding.property === property);

describe("SceneParticle.hdr：场景加载时判定的 HDR，顶层与子系统都写", () => {
  it("超高档且场景 bloom、hdr 都开：顶层、static 与事件子系统都是 true", async () => {
    const bundle = await compile({}, { general: HDR_GENERAL, postprocess: "ultra" });
    expect(bundle.general.postprocess.hdr).toBe(true);
    const particle = bundle.layers[1].particle!;
    expect(particle.hdr).toBe(true);
    expect(particle.children.map((child) => [child.type, child.system.hdr])).toEqual([
      ["static", true],
      ["eventspawn", true],
    ]);
  });

  it("关闭档、或场景没开 hdr：都是 false", async () => {
    for (const [general, postprocess] of [
      [HDR_GENERAL, "disabled"],
      [{ ...ORTHO, bloom: true }, "ultra"],
    ] as const) {
      const bundle = await compile({}, { general, postprocess });
      expect(bundle.general.postprocess.hdr).toBe(false);
      const particle = bundle.layers[1].particle!;
      expect([particle.hdr, ...particle.children.map((child) => child.system.hdr)]).toEqual([false, false, false]);
    }
  });
});

describe("brightness 是就地目标、能力表不报", () => {
  it("HDR 下 {user} 登记成 particle-instance（顶层有无 bit3 都是），初值取属性；不报 particle:instance:brightness", async () => {
    for (const flags of [0, 8]) {
      const bundle = await compile(
        { brightness: { user: "b", value: 1 } },
        { general: HDR_GENERAL, postprocess: "ultra", flags },
      );
      expect(bindingOf(bundle, "b")?.target, String(flags)).toEqual({
        kind: "particle-instance",
        object: 1,
        field: "brightness",
      });
      expect(bundle.layers[1].particle!.instance.brightness).toBe(5);
      expect(particleKeys(bundle), String(flags)).toEqual([]);
    }
    // 没有任何 recompile 目标落在 instanceoverride 上
    const bundle = await compile(
      { brightness: { user: "b", value: 1 } },
      { general: HDR_GENERAL, postprocess: "ultra" },
    );
    expect(bundle.bindings.filter((binding) => binding.target.kind === "recompile")).toEqual([]);
  });

  it("HDR 下非默认的静态值不报（顶层与子系统各按自己的 flags 查一遍，都不报）", async () => {
    for (const [flags, childFlags] of [
      [0, 0],
      [0, 8],
      [8, 0],
    ]) {
      const bundle = await compile(
        { brightness: 3 },
        { general: HDR_GENERAL, postprocess: "ultra", flags, childFlags },
      );
      expect(particleKeys(bundle), `${flags} ${childFlags}`).toEqual([]);
      expect(bundle.layers[1].particle!.instance.brightness).toBe(3);
    }
  });

  it("planApply：HDR 下改 brightness 分到就地一侧，不重编译", async () => {
    const bundle = await compile(
      { brightness: { user: "b", value: 1 } },
      { general: HDR_GENERAL, postprocess: "ultra" },
    );
    const plan = planApply(bundle.bindings, new Map([["b", 2]]));
    expect(plan.recompile).toEqual([]);
    expect(plan.writes.map((write) => write.binding.target)).toEqual([
      { kind: "particle-instance", object: 1, field: "brightness" },
    ]);
  });

  it("SceneState：写 brightness 标脏（进 particles、不进 rates），值按编译期同一条规则", async () => {
    const bundle = await compile(
      { brightness: { user: "b", value: 1 } },
      { general: HDR_GENERAL, postprocess: "ultra" },
    );
    const state = SceneState.fromBundle(bundle);
    expect(state.particleInstances.get(1)?.brightness).toBe(5);
    state.takeDirty();
    expect(state.write(bindingOf(bundle, "b")!, "0.5")).toBe("applied");
    expect(state.particleInstances.get(1)?.brightness).toBe(0.5);
    const dirty = state.takeDirty();
    expect([...dirty.particles]).toEqual([1]);
    expect([...dirty.rates]).toEqual([]);
  });

  it("checkParticleInstance：静态值、{user}、{script} 都不报，bit3 也一样", () => {
    for (const flags of [0, 8])
      for (const brightness of [5, { user: "b", value: 2 }, script(2)]) {
        const keys = new Set<string>();
        checkParticleInstance({ brightness }, { flags }, keys);
        expect([...keys], JSON.stringify({ flags, brightness })).toEqual([]);
      }
  });
});

describe("brightness 挂字段脚本（P4f 步骤 1 的同一条路）", () => {
  it("SCRIPT_INSTANCE_KEYS 含 brightness；写回目标 particle-instance、值类型 float", async () => {
    expect(SCRIPT_INSTANCE_KEYS).toContain("brightness");
    const scene: SceneJson = {
      objects: [
        { id: 1, image: "models/a.json" },
        { id: 2, particle: "p.json", instanceoverride: { brightness: script(2) } },
      ],
    };
    const { list } = await collectScripts(scene, {}, []);
    expect(list.map((item) => [item.id, item.target, item.valueType])).toEqual([
      ["objects/1/instanceoverride/brightness", { kind: "particle-instance", object: 1, field: "brightness" }, "float"],
    ]);
  });

  it("compileScene：HDR 与 LDR 下都不报 particle:binding:instance:brightness，初值取 value，脚本写回 particle-instance", async () => {
    for (const options of [{}, { general: HDR_GENERAL, postprocess: "ultra" as const }]) {
      const bundle = await compile({ brightness: script(2) }, options);
      expect(particleKeys(bundle), JSON.stringify(options)).toEqual([]);
      expect(bundle.layers[1].particle!.instance.brightness).toBe(2);
      expect(bundle.scripts.list.map((item) => item.target)).toEqual([
        { kind: "particle-instance", object: 1, field: "brightness" },
      ]);
      // 字段脚本不是用户绑定：绑定表里没有它
      expect(bundle.bindings.filter((binding) => binding.target.kind === "particle-instance")).toEqual([]);
    }
  });
});
