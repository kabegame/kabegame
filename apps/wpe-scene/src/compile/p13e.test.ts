/**
 * P13e 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase13/phase-13e-volumetrics.md`，rea-p13-volumetrics V1–V6）：
 * - 灯体网格（点光球、聚光圆柱）与 GLM 求逆：对 WPE 抓帧逐位相同（`ignore/p13/e/` 的导出、`ignore/p13/out/wpe-p13e-*-consts.json`）；
 * - 聚光的灯体矩阵与常量：`p13e-spot` 抓帧；
 * - 真翻译器编确定性工程：`p13e-po`（正交点光）、`p13e-spot`（透视聚光）不报任何键，常量与抓帧一致；
 * - 照报：cookie、聚光阴影、聚光分不到槽、点光分不到阴影条目、管光 / 平行光不收、档位 0 不建。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "./bundle";
import type { SceneReader } from "./fs";
import type { LightCounts } from "./lights";
import type { SceneObject, SceneScalar, SceneValue } from "./model";
import {
  compileVolumetrics,
  glmInverse,
  pointLightSphere,
  spotLightCylinder,
  spotViewProjection,
  volumetricsTargetSize,
  type VolumetricsCompileContext,
} from "./volumetrics";
import { layerLocalMatrix } from "../render/layout";
import { Wpesl2wgsl, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f = Math.fround;
/** 仓库根：往上找到有 `ignore/p13/proj` 的目录（kbp 快照里层数不同，变异检查也要读到抓帧与工程）。 */
function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, "ignore", "p13", "proj")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
const REPO = repoRoot();
const MESHES = join(REPO, "ignore", "p13", "e");
const PROJECTS = join(REPO, "ignore", "p13", "proj");

/** 逐个 float32 位比（正负零当作相同：uniform 与顶点里零的符号不影响画面，抓帧与我们的矩阵构造在这一点上不保证一致）。 */
function sameF32(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect([i, f(actual[i]) === f(expected[i])]).toEqual([i, true]);
}

/** 正负零也比：`g_EffectModelMatrix` 照 GLM 的求逆，连零的符号都和抓帧相同。 */
function sameBits(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect([i, Object.is(f(actual[i]), f(expected[i]))]).toEqual([i, true]);
}

describe("灯体网格（V1）", () => {
  it("点光球：577 个顶点、1104 个三角形，读码给的几个值逐位相同", () => {
    const { positions, indices } = pointLightSphere();
    expect(positions.length / 3).toBe(577);
    expect(indices.length / 3).toBe(1104);
    expect(Array.from(positions.subarray(0, 6))).toEqual([0, 1, 0, 0, -1, 0]);
    // 第 1 圈：y = cosf(7.5°)，经度 105° 与 75° 的 x 不对称（各自舍入），接缝 j = 24 的 z 不是 0
    const ring1 = (j: number) => Array.from(positions.subarray((2 + j) * 3, (3 + j) * 3));
    expect(ring1(0)[1]).toBe(0.9914448857307434);
    expect(ring1(7)[0]).toBe(-0.033782683312892914);
    expect(ring1(5)[0]).toBe(0.03378266841173172);
    expect(ring1(24)[2]).toBe(2.2821925682592337e-8);
    expect(Array.from(indices.subarray(0, 6))).toEqual([2, 3, 27, 3, 28, 27]);
    expect(Math.max(...indices)).toBe(576);
  });

  it.skipIf(!existsSync(join(MESHES, "sphere-3287715210.json")))(
    "点光球：和 3287715210 抓帧的 577 个点逐位相同",
    () => {
      const ref = JSON.parse(readFileSync(join(MESHES, "sphere-3287715210.json"), "utf8")) as { vertices: number[][] };
      sameF32(pointLightSphere().positions, ref.vertices.flat());
    },
  );

  it("聚光圆柱：130 个顶点、128 个三角形，盖心在 (0.5, 0.5)", () => {
    const { positions, indices } = spotLightCylinder();
    expect(positions.length / 3).toBe(130);
    expect(indices.length / 3).toBe(128);
    expect(Array.from(positions.subarray(0, 6))).toEqual([0.5, 0.5, 1, 0.5, 0.5, 0]);
    expect(Array.from(indices.subarray(0, 12))).toEqual([4, 2, 3, 4, 3, 5, 1, 3, 2, 0, 4, 5]);
  });

  it.skipIf(!existsSync(join(MESHES, "cone-p13e-spot.json")))("聚光圆柱：和 p13e-spot 抓帧的 130 个点逐位相同", () => {
    const ref = JSON.parse(readFileSync(join(MESHES, "cone-p13e-spot.json"), "utf8")) as { vertices: number[][] };
    sameF32(spotLightCylinder().positions, ref.vertices.flat());
  });
});

describe("g_EffectModelMatrix = GLM 求逆（V3）", () => {
  it("透视（p13e-spot event 100）：连正负零逐位相同", () => {
    const vp = [
      1.206284999847412, 0, 0, 0, 0, 2.0344576835632324, 3.162309212711989e-6, -0.3162277638912201, 0,
      -0.6781525611877441, 9.486928320256993e-6, -0.9486833214759827, 0, -2.0344581604003906, 0.09990296512842178,
      9.803060531616211,
    ];
    sameBits(
      glmInverse(vp),
      [
        0.8289915323257446, -0, 0, -0, -0, 0.4423784017562866, -0.1474594622850418, 0, -0, 39.999610900878906,
        89.99911499023438, 9.999900817871094, -0, -0.31582775712013245, -0.947783350944519, 0.00010000001930166036,
      ],
    );
  });

  it("正交（p13e-po event 104）：1080.0001 这类舍入照 float32", () => {
    const vp = [
      0.0010416667209938169, 0, 0, 0, 0, 0.0018518518190830946, 0, 0, 0, 0, 0.0002500000118743628, 0, -1, -1, 0.5, 1,
    ];
    sameBits(
      glmInverse(vp),
      [
        960, -0, 0, -0, -0, 540.0000610351562, -0, 0, 0, -0, 3999.999755859375, -0, 960, 540.0000610351562,
        -1999.9998779296875, 1,
      ],
    );
  });
});

describe("聚光的灯体矩阵（V1.2、V2）", () => {
  it("p13e-spot：g_AltViewProjectionMatrix = inverse(聚光 VP) 与抓帧逐位相同", () => {
    const matrix = layerLocalMatrix({ origin: [-2, 4, 1], angles: [0, 0, -1.2], scale: [1, 1, 1] });
    const inverse = glmInverse(spotViewProjection(matrix, 25, 8, false));
    sameF32(
      inverse,
      [
        0, -0, 0.4670979082584381, -0, 0.4353535771369934, 0.1692565381526947, 2.0226866848105374e-9,
        2.0226866848105374e-9, -39.749996185302734, 79.49999237060547, 19.874998092651367, 19.874998092651367,
        0.11297181993722916, -0.4336186647415161, 0.1249999925494194, 0.1249999925494194,
      ],
    );
  });

  it("RT 尺寸：low / medium 1/8、high / ultra 1/4，至少 2", () => {
    expect(volumetricsTargetSize(1920, 1080, 1)).toEqual([240, 135]);
    expect(volumetricsTargetSize(1920, 1080, 2)).toEqual([240, 135]);
    expect(volumetricsTargetSize(1920, 1080, 3)).toEqual([480, 270]);
    expect(volumetricsTargetSize(1920, 1080, 4)).toEqual([480, 270]);
    expect(volumetricsTargetSize(9, 9, 1)).toEqual([2, 2]);
  });
});

// ———— 照报规则（假着色器：只看 compileVolumetrics 的取舍） ————

const COUNTS: LightCounts = {
  point: 4,
  spot: 1,
  tube: 0,
  directional: 0,
  pointShadow: 1,
  spotShadow: 0,
  spotCookie: 0,
  spotShadowCookie: 0,
  directionalShadow: 0,
};
const read = (value: SceneValue | undefined): SceneScalar | undefined =>
  value && typeof value === "object" && "value" in value ? (value.value as SceneScalar) : (value as SceneScalar);

async function compileRules(objects: SceneObject[], options: { quality?: number; shadowQuality?: number } = {}) {
  const unsupported = new Set<string>();
  let programs = 0;
  const context: VolumetricsCompileContext = {
    fs: {
      text: async () => JSON.stringify({ passes: [{ shader: "s" }] }),
    } as unknown as VolumetricsCompileContext["fs"],
    shader: {
      compile: async () => ({ ok: true, uniforms: [], textures: [], combos: [] }) as unknown as TranslateResult,
    } as unknown as VolumetricsCompileContext["shader"],
    unsupported,
    addProgram: () => programs++,
  };
  const result = await compileVolumetrics(context, {
    objects,
    read: (value) => read(value),
    quality: options.quality ?? 1,
    shadowQuality: options.shadowQuality ?? 1,
    counts: COUNTS,
    orthographic: true,
    inGroup: () => false,
  });
  return { result, unsupported: [...unsupported].sort() };
}

const point = (extra: SceneObject = {}): SceneObject => ({ light: "lpoint", castvolumetrics: true, ...extra });

describe("compileVolumetrics 的取舍（V5、V6，待定 2、3）", () => {
  it("可见、castvolumetrics 的点光 / 聚光才收；管光、平行光、隐藏的、没开的不收", async () => {
    const { result, unsupported } = await compileRules([
      point(),
      { light: "ltube", castvolumetrics: true },
      { light: "ldirectional", castvolumetrics: true },
      point({ visible: false }),
      { light: "lpoint" },
      { light: "lspot", castvolumetrics: true },
    ]);
    expect(unsupported).toEqual([]);
    expect(result!.lights.map((light) => [light.object, light.kind])).toEqual([
      [0, "point"],
      [5, "spot"],
    ]);
    expect(result!.blurH).not.toBeNull();
  });

  it("没有会画的灯或档位 0 时不建", async () => {
    expect((await compileRules([{ light: "ltube", castvolumetrics: true }])).result).toBeNull();
    expect((await compileRules([point()], { quality: 0 })).result).toBeNull();
  });

  it("high / ultra 不模糊", async () => {
    const { result } = await compileRules([point()], { quality: 3 });
    expect([result!.blurH, result!.blurV]).toEqual([null, null]);
  });

  it("点光常量：r·0.99、cos 内外锥（缺省 20 / 30）、intensity、位置、density、color、volumetricsexponent；灯体矩阵是 diag(r) + 位置", async () => {
    const { result } = await compileRules([
      point({
        origin: "1300 700 200",
        radius: 600,
        intensity: 3,
        color: "1 0.8 0.6",
        density: 0.8,
        volumetricsexponent: 1.5,
      }),
    ]);
    const { constants } = result!.lights[0];
    sameF32(constants.g_RenderVar1, [594, 0.9396926164627075, 0.8660253882408142, 3]);
    sameF32(constants.g_RenderVar2, [1300, 700, 200, 0.800000011920929]);
    sameF32(constants.g_RenderVar4, [1, 0.800000011920929, 0.6000000238418579, 1.5]);
    sameF32(constants.g_AltViewProjectionMatrix, [600, 0, 0, 0, 0, 600, 0, 0, 0, 0, 600, 0, 1300, 700, 200, 1]);
  });

  it("缺键取构造缺省：radius 1、density 2、volumetricsexponent 1、intensity 0、color 0", async () => {
    const { result } = await compileRules([point()]);
    const { constants } = result!.lights[0];
    sameF32(constants.g_RenderVar1, [f(0.99), 0.9396926164627075, 0.8660253882408142, 0]);
    sameF32(constants.g_RenderVar2, [0, 0, 0, 2]);
    sameF32(constants.g_RenderVar4, [0, 0, 0, 1]);
  });

  it("SHADOW：castshadow 且阴影档不为 0；阴影档 0 时不开", async () => {
    expect((await compileRules([point({ castshadow: true })])).result!.lights[0].shadow).toBe(true);
    expect((await compileRules([point({ castshadow: true })], { shadowQuality: 0 })).result!.lights[0].shadow).toBe(
      false,
    );
  });

  it("带阴影的点光多于 min(pointShadow, point) 时报 volumetrics:shadow-unassigned；隐藏的不算", async () => {
    expect((await compileRules([point({ castshadow: true })])).unsupported).toEqual([]);
    expect(
      (await compileRules([point({ castshadow: true }), { light: "lpoint", castshadow: true, visible: false }]))
        .unsupported,
    ).toEqual([]);
    expect(
      (await compileRules([point({ castshadow: true }), { light: "lpoint", castshadow: true }])).unsupported,
    ).toEqual(["volumetrics:shadow-unassigned"]);
    // 阴影档 0 时没有 SHADOW，不报
    expect(
      (await compileRules([point({ castshadow: true }), { light: "lpoint", castshadow: true }], { shadowQuality: 0 }))
        .unsupported,
    ).toEqual([]);
  });

  it("聚光：可见的聚光多于聚光槽报 spot-unassigned，带阴影报 spot-shadow；任何灯 usecookie 报 cookie", async () => {
    const spot = { light: "lspot", castvolumetrics: true };
    expect((await compileRules([spot, { light: "lspot" }])).unsupported).toEqual(["volumetrics:spot-unassigned"]);
    expect((await compileRules([spot, { light: "lspot", visible: false }])).unsupported).toEqual([]);
    expect((await compileRules([{ ...spot, castshadow: true }])).unsupported).toEqual(["volumetrics:spot-shadow"]);
    expect((await compileRules([point({ usecookie: true })])).unsupported).toEqual(["volumetrics:cookie"]);
  });

  it("COMBO：点光带 LIGHTS_SHADOW_MAPPING_QUALITY，聚光不带", async () => {
    const combos: Record<string, number>[] = [];
    const context: VolumetricsCompileContext = {
      fs: {
        text: async () => JSON.stringify({ passes: [{ shader: "s" }] }),
      } as unknown as VolumetricsCompileContext["fs"],
      shader: {
        compile: async (_: string, c: Record<string, number>) => {
          combos.push(c);
          return { ok: true, uniforms: [], textures: [], combos: [] } as unknown as TranslateResult;
        },
      } as unknown as VolumetricsCompileContext["shader"],
      unsupported: new Set(),
      addProgram: () => 0,
    };
    await compileVolumetrics(context, {
      objects: [point({ castshadow: true }), { light: "lspot", castvolumetrics: true }],
      read: (value) => read(value),
      quality: 2,
      shadowQuality: 3,
      counts: COUNTS,
      orthographic: true,
      inGroup: () => false,
    });
    // 每盏灯：背面、正面、全屏
    expect(combos[1]).toEqual({ POINTLIGHT: 1, SHADOW: 1, QUALITY: 2, LIGHTS_SHADOW_MAPPING_QUALITY: 3 });
    expect(combos[4]).toEqual({ POINTLIGHT: 0, SHADOW: 0, QUALITY: 2 });
  });
});

// ———— 真翻译器：确定性工程 ————

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
const project = (name: string) => join(PROJECTS, name);

describe.skipIf(!root || !existsSync(wasm) || !existsSync(project("p13e-po")))("真翻译器：确定性工程（步骤 0）", () => {
  const compile = async (name: string, volumetrics: "low" | "high" = "low") =>
    compileScene({
      projectDir: project(name),
      sceneAssets: [join(root!, "assets")],
      reader: diskReader,
      translator: await Wpesl2wgsl.fromBytes(readFileSync(wasm)),
      postprocess: "disabled",
      shadows: "low",
      volumetrics,
      exhaustive: true,
    });

  it("p13e-po：不报任何键，一盏点光，四个材质都编出来", async () => {
    const bundle = await compile("p13e-po");
    expect(bundle.unsupported).toEqual([]);
    const volumetrics = bundle.volumetrics!;
    expect(volumetrics.quality).toBe(1);
    expect(volumetrics.lights.map((light) => [light.kind, light.shadow])).toEqual([["point", false]]);
    const [light] = volumetrics.lights;
    for (const pass of [
      light.back,
      light.front,
      light.fullscreen,
      volumetrics.blurH!,
      volumetrics.blurV!,
      volumetrics.combine,
    ])
      expect(pass.program).not.toBeNull();
    // 正面的程序读 Back（槽 1）与 Single（槽 3）
    const front = bundle.programs[light.front.program!];
    expect(front.textures?.map((texture) => [texture.slot, texture.kind])).toEqual([
      [1, "2d"],
      [3, "2d"],
    ]);
    expect(light.back.cullmode).toBe("normal");
    expect([light.front.blending, light.front.depthtest, light.fullscreen.cullmode]).toEqual([
      "additive",
      "disabled",
      "nocull",
    ]);
  }, 120000);

  it("p13e-spot：聚光不报任何键", async () => {
    const bundle = await compile("p13e-spot");
    expect(bundle.unsupported).toEqual([]);
    const [light] = bundle.volumetrics!.lights;
    expect(light.kind).toBe("spot");
    sameF32(light.constants.g_RenderVar1, [7.920000076293945, 0.9659258127212524, 0.9063077569007874, 4]);
    sameF32(light.constants.g_RenderVar3, [0.3623577058315277, -0.9320390820503235, -0, 0]);
  }, 120000);

  it("p13e-ps：带阴影的点光开 SHADOW，灯光记录建了（每帧取阴影条目）", async () => {
    const bundle = await compile("p13e-ps");
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.volumetrics!.lights[0].shadow).toBe(true);
    expect(bundle.lights?.counts.pointShadow).toBe(1);
  }, 120000);

  it("p13e-pns：castshadow 但 lightconfig 没有 pointshadow，照报 shadow-unassigned", async () => {
    const bundle = await compile("p13e-pns");
    expect(bundle.unsupported).toEqual(["volumetrics:shadow-unassigned"]);
  }, 120000);

  it("high：不编模糊", async () => {
    const bundle = await compile("p13e-po", "high");
    expect([bundle.volumetrics!.quality, bundle.volumetrics!.blurH]).toEqual([3, null]);
  }, 120000);
});
