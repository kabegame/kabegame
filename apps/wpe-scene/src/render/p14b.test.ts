/**
 * P14b（`.claude/plans/wpe-import/3-scene/phase14/phase-14b-group-models.md`）：组里的模型对象。
 * - 矩阵：`g_ModelMatrix` = `inverse(W_组) · W`（glm 的完整乘法 `multiply`，即 `FUN_14005ecb0`）、MVP = `P ⊗ M`（仿射），和 WPE 抓帧逐位
 *   相同，带 x / y 旋转时仿射乘法差 1 ulp（`p14b-gm-rot3d`）；GpuScene 那一层在 `p5b-group.test.ts`；
 * - 层首快照（P14 E16）：直接父是组时不拷，隔着分组节点的孙子照拷（同图像层的层首拷贝，P5f）。
 */
import { describe, expect, it } from "vitest";
import type { SceneLayer, ScenePass } from "../compile/bundle";
import { planModelLayer } from "./graph";
import { drawMatrixOf, groupMvpParts, type LayerTransform } from "./layout";
import { mulAffine, multiply, type Mat4 } from "./math";
import { drawMatrices } from "./uniforms";

type T = Pick<LayerTransform, "origin" | "angles" | "scale" | "offset" | "parent">;

describe("组里网格的矩阵照 WPE（p14b-gm-basic 抓帧 A:\\p14b\\gm-basic\\gm-basic-frame222.rdc）", () => {
  // 组 G：中心 (900, 560)、缩放 1.25×0.8、转 0.35 rad，800×600；T1 是脚本建的模型层 setParent(G, false)，局部 (−120, 20) 转 0.2 rad；
  // S1 是 scene.json 里 parent 指向 G 的静态 mdl，局部 (−200, −150)、缩放 1.5×1、转 −0.3 rad
  const layers = new Map<number, T>([
    [10, { origin: [900, 560, 0], angles: [0, 0, 0.35], scale: [1.25, 0.8, 1], parent: null }],
    [11, { origin: [-200, -150, 0], angles: [0, 0, -0.3], scale: [1.5, 1, 1], parent: 10 }],
    [20, { origin: [-120, 20, 0], angles: [0, 0, 0.2], scale: [1, 1, 1], parent: 10 }],
  ]);
  // 事件 97（T1）、71（S1）的 g_ModelMatrix 与 g_ModelViewProjectionMatrix。T1 的平移 y 是 19.999969…，不是局部的 20：WPE 真的乘了
  // inverse(W_组) · W，不是直接取局部矩阵
  const T1_MODEL = [
    0.9800665378570557, 0.19866934418678284, 0, 0, -0.19866934418678284, 0.9800665974617004, 0, 0, 0, 0, 1, 0, -120,
    19.999969482421875, 0, 1,
  ];
  const T1_MVP = [
    0.002450166270136833, 0.0006622311775572598, 0, 0, -0.0004966733395121992, 0.0032668886706233025, 0, 0, 0, 0,
    0.0005000000237487257, 0, -0.29999998211860657, 0.06666656583547592, 0.5, 1,
  ];
  const S1_MODEL = [
    1.4330047369003296, -0.4432803690433502, 0, 0, 0.29552021622657776, 0.9553365111351013, 0, 0, 0, 0, 1, 0, -200,
    -150, 0, 1,
  ];
  const S1_MVP = [
    0.0035825117956846952, -0.0014776012394577265, 0, 0, 0.0007388005033135414, 0.0031844552140682936, 0, 0, 0, 0,
    0.0005000000237487257, 0, -0.5, -0.5, 0.5, 1,
  ];

  it.each([
    ["T1（脚本模型数据层）", 20, T1_MODEL, T1_MVP],
    ["S1（静态 mdl）", 11, S1_MODEL, S1_MVP],
  ])("%s：g_ModelMatrix 与 MVP 逐位相同", (_name, object, model, mvp) => {
    const cache = new Map<number, Mat4>();
    const group = drawMatrixOf(10, layers, cache);
    const world = drawMatrixOf(object, layers, cache);
    const parts = groupMvpParts([800, 600], group)!;
    const local = multiply(parts.inverse, world);
    expect(Array.from(local)).toEqual(model);
    expect(Array.from(drawMatrices({ role: "direct" }, local, [0, 0], parts.projection).modelViewProjection)).toEqual(
      mvp,
    );
    // 同一个 MVP 也等于图像层组里的写法（`drawMatrices` 的 group）
    expect(
      Array.from(drawMatrices({ role: "direct" }, world, [0, 0], parts.projection, parts).modelViewProjection),
    ).toEqual(mvp);
  });
});

describe("带 x / y 旋转的组里网格（p14b-gm-rot3d 抓帧 A:\p14b\gm-rot3d\gm-rot3d-frame162.rdc）", () => {
  // 组 G：(900, 560, 30)、缩放 1.25×0.8×1.1、转 (0.3, 0.2, 0.35)；静态 S1 局部 (−200, −150, −20)、缩放 1.5×1×0.7、转 (−0.2, 0.35, −0.3)；
  // 脚本 R1 局部 (−120, 20, 15)、缩放 1.1×0.9×1.3、转 (0.4, −0.25, 0.2)。期望值是事件 71（S1）、83（R1）
  const layers = new Map<number, T>([
    [10, { origin: [900, 560, 30], angles: [0.3, 0.2, 0.35], scale: [1.25, 0.8, 1.1], parent: null }],
    [11, { origin: [-200, -150, -20], angles: [-0.2, 0.35, -0.3], scale: [1.5, 1, 0.7], parent: 10 }],
    [20, { origin: [-120, 20, 15], angles: [0.4, -0.25, 0.2], scale: [1.1, 0.9, 1.3], parent: 10 }],
  ]);
  const S1_MODEL = [
    1.3461253643035889, -0.41640543937683105, -0.514346718788147, 0, 0.2245488464832306, 0.9564251899719238,
    -0.18662454187870026, 0, 0.26583462953567505, 0.06333790719509125, 0.6444534659385681, 0, -200, -149.99998474121094,
    -20, 1,
  ];
  const S1_MVP = [
    0.0033653134014457464, -0.0013880181359127164, -0.00025717337848618627, 0, 0.0005613720859400928,
    0.003188084112480283, -0.00009331227192888036, 0, 0.0006645865505561233, 0.00021112636022735387,
    0.0003222267550881952, 0, -0.5, -0.4999999701976776, 0.49000000953674316, 1,
  ];
  const R1_MODEL = [
    1.0445585250854492, 0.2117425501346588, 0.2721443772315979, 0, -0.24966877698898315, 0.7952044606208801,
    0.3395810127258301, 0, -0.18975624442100525, -0.555005669593811, 1.1601557731628418, 0, -119.99993896484375,
    20.000030517578125, 15.000015258789062, 1,
  ];
  const R1_MVP = [
    0.0026113963685929775, 0.0007058085175231099, 0.00013607219443656504, 0, -0.0006241719238460064,
    0.0026506816502660513, 0.00016979050997179002, 0, -0.0004743906029034406, -0.0018500189762562513,
    0.0005800779326818883, 0, -0.29999983310699463, 0.06666676700115204, 0.5074999928474426, 1,
  ];

  it.each([
    ["S1（静态 mdl）", 11, S1_MODEL, S1_MVP],
    ["R1（脚本模型数据层）", 20, R1_MODEL, R1_MVP],
  ])("%s：glm 乘法逐位相同，仿射乘法不同", (_name, object, model, mvp) => {
    const cache = new Map<number, Mat4>();
    const parts = groupMvpParts([800, 600], drawMatrixOf(10, layers, cache))!;
    const world = drawMatrixOf(object, layers, cache);
    const local = multiply(parts.inverse, world);
    expect(Array.from(local)).toEqual(model);
    expect(Array.from(drawMatrices({ role: "direct" }, local, [0, 0], parts.projection).modelViewProjection)).toEqual(
      mvp,
    );
    expect(Array.from(mulAffine(parts.inverse, world))).not.toEqual(model);
  });
});

describe("planModelLayer：组里读帧缓冲的模型（P14 E16 + P14b）", () => {
  const pass = {
    key: "objects/2/meshes/0/passes/0",
    framebuffer: true,
    textures: {},
    runtime: { 0: "_rt_FullFrameBuffer" },
  } as unknown as ScenePass;
  const model = { meshes: [{ passes: [pass] }], order: [0] } as unknown as NonNullable<SceneLayer["model"]>;
  const first = (group: number | null, parent: number | null) =>
    planModelLayer({ model, sprite: null, group, parent }).steps[0]?.kind;

  it("顶层照拷；直接父是组时不拷（读到上一次拷下的，同图像层与 WPE）；隔着分组节点的孙子照拷", () => {
    expect(first(null, null)).toBe("snapshot");
    expect(first(1, 1)).toBe("mesh");
    expect(first(1, 5)).toBe("snapshot");
    // 不给组归属（旧调用方）时同顶层
    expect(planModelLayer({ model, sprite: null }).steps[0]?.kind).toBe("snapshot");
  });
});
