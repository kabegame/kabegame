/**
 * P13f1 雾与 `ADDITIVE`（`.claude/plans/wpe-import/3-scene/phase13/phase-13f-fog-lights.md`，rea-p13-lights 第 2 节，p13-REPORT F1–F6）：
 * - `fogDefines` / `fogUniforms` / `isFogUniformField`：打包与 `p13f-fog` 抓帧逐位相同（float32 减法）；
 * - `materialCombos`：additive 加 `ADDITIVE = 1`；
 * - 能力表：雾的 general 字段不报；四个雾 uniform 是引擎 uniform；
 * - `SceneState`：雾的数值字段写入置灯光脏位，开关不置；
 * - 真翻译器编 `p13f-fog`：不写 `FOG` / `FOG: 1` / additive 的程序读雾 uniform，`FOG: 0` 与 `generic2` 不读；两开关都关的工程没人读；
 *   开雾又有体积光照报 `volumetrics:fog`。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generalDefaults } from "./bindings";
import { compileScene, type SceneBundle } from "./bundle";
import { checkParticleProgram, checkSceneFeatures, isEngineUniform } from "./features";
import { FOG_UNIFORMS, fogDefines, fogUniforms, isFogUniformField } from "./fog";
import type { SceneReader } from "./fs";
import type { SceneJson } from "./model";
import { BLOOM_DEFAULTS } from "./postprocess";
import { ADDITIVE_COMBO, materialCombos } from "./writeState";
import { SceneState } from "../render/state";
import { Wpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f = Math.fround;

describe("雾的宏与 uniform", () => {
  it("开关 → fogDefines：都关为空", () => {
    expect(fogDefines({ fogdistance: false, fogheight: false })).toEqual({});
    expect(fogDefines({ fogdistance: true, fogheight: false })).toEqual({ FOG_DIST: "1" });
    expect(fogDefines({ fogdistance: true, fogheight: true })).toEqual({ FOG_DIST: "1", FOG_HEIGHT: "1" });
  });

  it("打包和 p13f-fog 抓帧逐位相同（F1：差值按 float32 减法，end < start 时 .y 为负）", () => {
    const values = fogUniforms({
      ...generalDefaults(),
      fogdistancecolor: [0.9, 0.2, 0.1],
      fogheightcolor: [0.1, 0.3, 0.9],
      fogdistancestart: 4,
      fogdistanceend: 18,
      fogdistancestartdensity: 0.1,
      fogdistanceenddensity: 0.8,
      fogheightstart: 2.5,
      fogheightend: -0.5,
      fogheightstartdensity: 0.05,
      fogheightenddensity: 0.7,
    });
    // ignore/p13/f/out/wpe-p13f-fog-consts.json（颜色由 uniform 缓冲按 float32 存，原值写进去即同位）
    expect(values.g_FogDistanceParams).toEqual([4, 14, 0.10000000149011612, 0.699999988079071]);
    expect(values.g_FogHeightParams).toEqual([2.5, -3, 0.05000000074505806, 0.6499999761581421]);
    expect(values.g_FogDistanceColor.map(f)).toEqual([0.8999999761581421, 0.20000000298023224, 0.10000000149011612]);
    expect(Object.keys(values)).toEqual([...FOG_UNIFORMS]);
  });

  it("缺省值（rea-p13-lights 2.1）：高度雾缺省 end −3 < start 1", () => {
    expect(fogUniforms(generalDefaults())).toEqual({
      g_FogDistanceColor: [0, 0, 0],
      g_FogDistanceParams: [1, 4, 0, 1],
      g_FogHeightColor: [0, 0, 0],
      g_FogHeightParams: [1, -4, 0, 1],
    });
  });

  it("isFogUniformField：开关不算", () => {
    expect(isFogUniformField("fogdistanceend")).toBe(true);
    expect(isFogUniformField("fogheightcolor")).toBe(true);
    expect(isFogUniformField("fogdistance")).toBe(false);
    expect(isFogUniformField("fogheight")).toBe(false);
    expect(isFogUniformField("ambientcolor")).toBe(false);
  });

  it("四个雾 uniform 是引擎 uniform", () => {
    for (const name of FOG_UNIFORMS) expect(isEngineUniform(name), name).toBe(true);
  });
});

describe("ADDITIVE 组合键（rea-p6d1-matstate 第 4 节）", () => {
  it("additive 加 ADDITIVE = 1，大小写不同的同名键被换掉；别的混合原样", () => {
    expect(materialCombos({ blending: "additive", combos: { FOG: 1, additive: 0 } })).toEqual({
      FOG: 1,
      [ADDITIVE_COMBO]: 1,
    });
    expect(materialCombos({ blending: "additive" })).toEqual({ ADDITIVE: 1 });
    const combos = { FOG: 1 };
    expect(materialCombos({ blending: "normal", combos })).toBe(combos);
    expect(materialCombos({ blending: "translucent", combos })).toBe(combos);
  });

  it("additive 粒子编译期加的 ADDITIVE 不报 particle:combo（`3347978935`、`3354830590` 曾误报）", () => {
    const keys = new Set<string>();
    checkParticleProgram(
      { shader: "genericparticle", blending: "additive" },
      {
        ok: true,
        combos: [
          { name: "ADDITIVE", value: 1, source: "request" },
          { name: "FOG", value: 1, source: "default" },
        ],
      } as TranslateResult,
      keys,
    );
    expect([...keys]).toEqual([]);
  });
});

describe("能力表与状态", () => {
  it("雾的 14 个 general 字段不报（常量、绑属性都一样）", () => {
    const keys = new Set<string>();
    checkSceneFeatures(
      {
        general: {
          orthogonalprojection: { width: 1920, height: 1080 },
          fogdistance: true,
          fogheight: { user: "p", value: true },
          fogdistancecolor: "0.9 0.2 0.1",
          fogheightcolor: { user: "c", value: "0.1 0.3 0.9" },
          fogdistancestart: 4,
          fogdistanceend: { user: "e", value: 18 },
          fogdistancestartdensity: 0.1,
          fogdistanceenddensity: 0.8,
          fogheightstart: 2.5,
          fogheightend: -0.5,
          fogheightstartdensity: 0.05,
          fogheightenddensity: 0.7,
        },
        objects: [],
      } as SceneJson,
      keys,
    );
    expect([...keys]).toEqual([]);
  });

  it("SceneState：雾的数值字段写入置灯光脏位，开关只改字段", () => {
    const state = SceneState.fromBundle({
      general: {
        width: 640,
        height: 360,
        fields: generalDefaults(),
        clearVariable: false,
        perspectiveOverrideFov: (95 * Math.PI) / 180,
        postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
        bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
      },
      layers: [],
      programs: [],
      textures: [],
      bloom: null,
      unsupported: [],
      bindings: [],
      scripts: { list: [] },
    } as unknown as SceneBundle);
    state.takeDirty();
    expect(state.write({ property: "p", target: { kind: "general", key: "fogdistanceend" } }, 9)).toBe("applied");
    expect(state.general.fogdistanceend).toBe(9);
    expect(state.takeDirty().lights).toBe(true);
    expect(state.write({ property: "p", target: { kind: "general", key: "fogdistance" } }, true)).toBe("applied");
    expect(state.general.fogdistance).toBe(true);
    expect(state.takeDirty().lights).toBe(false);
  });
});

// ———— 真翻译器：确定性工程 ————

function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, "ignore", "p13", "proj")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
const PROJECTS = join(repoRoot(), "ignore", "p13", "proj");
const project = (name: string) => join(PROJECTS, name);
const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    try {
      return new Uint8Array(readFileSync(path).subarray(start, end));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
};

describe.skipIf(!root || !existsSync(wasm) || !existsSync(project("p13f-fog")))("真翻译器：p13f-fog（F2）", () => {
  const compile = async (name: string, volumetrics: "disabled" | "low" = "disabled") =>
    compileScene({
      projectDir: project(name),
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "disabled",
      volumetrics,
      exhaustive: true,
    });
  /** 每个模型对象的程序读不读雾 uniform（按对象名）。 */
  const readsFog = (bundle: Awaited<ReturnType<typeof compile>>) =>
    Object.fromEntries(
      bundle.layers
        .filter((layer) => layer.model)
        .map((layer) => {
          const programs = layer.model!.meshes.flatMap((mesh) => mesh.passes.map((pass) => pass.program));
          const names = programs.flatMap((index) =>
            index === null ? [] : (bundle.programs[index].uniforms ?? []).map((uniform) => uniform.name),
          );
          return [layer.name, FOG_UNIFORMS.filter((name) => names.includes(name))];
        }),
    );

  it("开雾：缺省 FOG、FOG 1、additive 读四个雾 uniform，FOG 0 与 generic2 不读；不报任何键", async () => {
    const bundle = await compile("p13f-fog");
    expect(bundle.unsupported).toEqual([]);
    const all = [...FOG_UNIFORMS];
    expect(readsFog(bundle)).toEqual({ GROUND: all, CA: all, CB: [], CC: [], CD: all, CE: all });
  });

  it("两个开关都关：没有程序读雾 uniform", async () => {
    const bundle = await compile("p13f-fog-off");
    expect(bundle.unsupported).toEqual([]);
    expect(Object.values(readsFog(bundle)).flat()).toEqual([]);
  });

  /** 每个图层：是否开雾强制 passthrough、上屏程序的 `FOG_COMPUTED`（没有上屏为 null）。 */
  const uploads = (bundle: Awaited<ReturnType<typeof compile>>) =>
    Object.fromEntries(
      bundle.layers
        .filter((layer) => !layer.model && !layer.particle)
        .map((layer) => {
          const program = layer.passthrough?.program;
          const combo =
            program == null
              ? null
              : (bundle.programs[program].combos ?? []).find((c) => c.name === "FOG_COMPUTED")?.value;
          return [layer.name, [!!layer.fogPassthrough, combo ?? null]];
        }),
    );

  it("开雾强制 passthrough（F7）：图像层与文本层都走合成，FOG_COMPUTED 取基础材质的 FOG，文本是 1", async () => {
    const bundle = await compile("p13f-fog-img");
    expect(bundle.unsupported).toEqual([]);
    expect(uploads(bundle)).toEqual({
      FR: [true, 0],
      CLK: [true, 0],
      I1: [true, 1],
      I2: [true, 0],
      I3: [true, 1],
      I4: [true, 1],
      I5: [true, 0],
      T1: [true, 1],
      I6: [true, 1],
    });
  });

  it("开雾强制 passthrough：组合层与全屏层（带不带 effect）也走；关雾时不走", async () => {
    const on = await compile("p13f-fog-fs");
    expect(on.unsupported).toEqual([]);
    expect(uploads(on)).toMatchObject({ CL: [true, 0], FS0: [true, 0], FS1: [true, 0] });
    const off = await compile("p13f-fog-fs-off");
    expect(Object.values(uploads(off)).filter(([forced]) => forced)).toEqual([]);
  });
});
