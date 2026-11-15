/**
 * 体积光（P13e，`.claude/plans/wpe-import/3-scene/phase13/phase-13e-volumetrics.md`；读码 rea-p13-passes 第 3 节、rea-p13-volumetrics V1–V11，
 * 实测 p13-REPORT 第 11–13 行与子计划「步骤 0 的结果」）。
 *
 * WPE 的体积光是灯对象自己的绘制（`FUN_140196ce0`），插在主 pass 的对象序列里：画到一盏可见、`castvolumetrics` 的灯时，拷场景深度进
 * `_rt_volumetricsBack`（全分辨率），在 1/d 的 `_rt_volumetricsSingle` 里画灯体背面的深度，再用 `volumetricsfront` 画灯体正面，沿视线
 * 步进累加进 `_rt_volumetricsLightBuffer`。连续的几盏灯共用一次清屏，到下一个可见的非灯对象之前（或列表末尾）合成：低 / 中档先横竖各模糊
 * 一次，再加法画回主目标。这里编材质、算灯的常量；渲染与合成时机在 `render/volumetrics.ts` 与 `render/scene.ts`。
 *
 * - 可画（V5）：自己可见 ∧ `castvolumetrics`，不看 `lightconfig`。父对象的灯已由能力表报 `object:parent`（P13f），这里按根对象处理。
 * - 管光、平行光（V1.2、`p13e-kinds`）：WPE 也建组、清屏、合成，但灯体矩阵是没初始化的残留值、实测是 NaN，什么都画不出；合成一片 0
 *   对画面没有影响，所以这里直接不收它们（组照样不被它们打断：灯对象从不触发合成）。
 * - 点光（V1.1、V2）：灯体是单位球（{@link pointLightSphere}），`g_AltViewProjectionMatrix` = diag(r) + 位置，r 是原始 `radius`。
 * - 聚光（V1.2、V2，待定 2）：灯体是 NDC 圆柱（{@link spotLightCylinder}），`g_AltViewProjectionMatrix` = 聚光 VP 的逆、`g_AltModelMatrix` =
 *   聚光 VP（{@link spotViewProjection}），`g_RenderVar3` = 世界矩阵第 0 行原值。阴影 / cookie 照报。
 * - 照报（待定 3，WPE 读的是残留或未初始化的值）：点光 `SHADOW` 却分不到阴影条目（`volumetrics:shadow-unassigned`）、聚光分不到聚光槽
 *   （`volumetrics:spot-unassigned`）、灯在组里（`volumetrics:group`）；另有 cookie（`volumetrics:cookie`）、聚光阴影（`volumetrics:spot-shadow`）。
 */
import type { ScenePass } from "./bundle";
import { checkPassFeatures, checkProgramFeatures, normalizeDepthKeys } from "./features";
import type { SceneFs } from "./fs";
import type { LightCounts } from "./lights";
import { numbers, parseMaterial, type SceneObject, type SceneScalar, type SceneValue } from "./model";
import { shaderUniforms, type ShaderCompiler, type ShaderTextureSlot } from "./shader";
import { FBO_FORMATS } from "./tex";
import type { TranslateResult } from "../wpesl2wgsl";
import { perspectiveRH } from "../render/camera";
import { layerLocalMatrix } from "../render/layout";
import { fastInverseSqrt, multiply, type Mat4 } from "../render/math";

const f = Math.fround;

/** WPE 写死的材质路径（`assets/materials/util/`）。 */
export const VOLUMETRICS_MATERIALS = {
  back: "materials/util/volumetrics_back.json",
  front: "materials/util/volumetrics_front.json",
  fullscreen: "materials/util/volumetrics_fullscreen.json",
  blurH: "materials/util/volumetrics_blur_h.json",
  blurV: "materials/util/volumetrics_blur_v.json",
  combine: "materials/util/volumetrics_combine.json",
} as const;

/**
 * 体积光 pass 由渲染器写的 uniform（V2）：灯体矩阵、聚光 VP、`g_EffectModelMatrix`（VP 的逆）、五个 `g_RenderVar`。`g_EffectModelMatrix`
 * 在图层 effect 里另有含义（`ENGINE_UNIFORMS`），这里由体积光每帧写。
 */
export const VOLUMETRICS_UNIFORMS: ReadonlySet<string> = new Set([
  "g_AltViewProjectionMatrix",
  "g_AltModelMatrix",
  "g_EffectModelMatrix",
  "g_RenderVar0",
  "g_RenderVar1",
  "g_RenderVar2",
  "g_RenderVar3",
  "g_RenderVar4",
]);

/** 档位 → 1/d 的 d（`0x140196d79`）：high、ultra 4，low、medium 8。 */
export function volumetricsDivisor(quality: number): number {
  return quality >= 3 ? 4 : 8;
}

/** 1/d 的 RT 尺寸（RT 构造 `FUN_1400d2c60`：整数除法、至少 2，同泛光）。 */
export function volumetricsTargetSize(width: number, height: number, quality: number): [number, number] {
  const d = volumetricsDivisor(quality);
  return [Math.max(2, Math.floor(width / d)), Math.max(2, Math.floor(height / d))];
}

/** 低、中档合成前横竖各模糊一次（`ctx+0x1ad < 3`，V9）。 */
export function volumetricsBlurs(quality: number): boolean {
  return quality < 3;
}

/** MSVC `sinf` / `cosf`：参数是 float，内部转 double 求值再舍回 float（V1.1）。 */
function sinf(x: number): number {
  return f(Math.sin(f(x)));
}
function cosf(x: number): number {
  return f(Math.cos(f(x)));
}

/** 灯体网格：`vec3` 位置与 u16 三角形列表索引。 */
export interface VolumetricMesh {
  positions: Float32Array;
  indices: Uint16Array;
}

/**
 * 点光灯体（`FUN_14025c660(_, _, 1.0f, …)`，V1.1）：两极 `(0, ±1, 0)` 在前，然后 23 圈 × 25 个点，纬度 `a = f32(i)·0.130899698f`
 * （i = 1…23）、经度 `b = f32(j)·0.261799395f`（j = 0…24，接缝重复），顶点 `(cosf(b)·sinf(a), cosf(a), sinf(b)·sinf(a))`，逐个 float32
 * 乘、不累加。577 个顶点、1104 个三角形；和抓帧逐位相同（`ignore/p13/e/chk_mesh_inv.py`）。
 */
export function pointLightSphere(): VolumetricMesh {
  const positions: number[] = [0, 1, 0, 0, -1, 0];
  const base = 2;
  const latStep = f(0.130899698);
  const lonStep = f(0.261799395);
  for (let i = 1; i <= 23; i++) {
    const a = f(i * latStep);
    const sa = sinf(a);
    const ca = cosf(a);
    for (let j = 0; j <= 24; j++) {
      const b = f(j * lonStep);
      positions.push(f(cosf(b) * sa), ca, f(sinf(b) * sa));
    }
  }
  const indices: number[] = [];
  for (let ring = 0; ring < 22; ring++) {
    const a0 = base + 25 * ring;
    const a1 = a0 + 25;
    for (let j = 0; j < 24; j++) indices.push(a0 + j, a0 + j + 1, a1 + j, a0 + j + 1, a1 + j + 1, a1 + j);
  }
  const last = base + 22 * 25;
  for (let j = 0; j < 24; j++) indices.push(0, base + j + 1, base + j, 1, last + j, last + j + 1);
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

/**
 * 聚光灯体（没有 cookie，`0x140197258`，V1.2）：NDC 里 32 段的单位圆柱，z10 = 0（远）、z11 = 1（近，反向深度）。两个盖心 `(0.5, 0.5, z11)`、
 * `(0.5, 0.5, z10)` 不在圆心（WPE 的写法，点在圆内，扇形照样铺满）；每段 `a = (f32(k)·0.03125)·6.2831855f`、`a2 = a + 0.19634955f`，
 * 4 个独立顶点。130 个顶点、128 个三角形；和抓帧逐位相同。经 `inverse(聚光 VP)` 变回世界后是从近平面到远平面的截头圆锥。
 */
export function spotLightCylinder(): VolumetricMesh {
  const z10 = 0;
  const z11 = 1;
  const positions: number[] = [0.5, 0.5, z11, 0.5, 0.5, z10];
  const indices: number[] = [];
  for (let k = 0; k < 32; k++) {
    const a = f(f(k * 0.03125) * f(6.2831855));
    const a2 = f(a + f(0.19634955));
    const c = positions.length / 3;
    positions.push(sinf(a), -cosf(a), z10, sinf(a2), -cosf(a2), z10, sinf(a), -cosf(a), z11, sinf(a2), -cosf(a2), z11);
    indices.push(c + 2, c, c + 1, c + 2, c + 1, c + 3, 1, c + 1, c, 0, c + 2, c + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
}

/**
 * GLM `detail::compute_inverse<4, 4, float>` 的标量展开（`FUN_14005f730`，V3）：18 个 2×2 子式 → 6 组余子式 → 乘符号 → 行列式
 * `(D0 + D1) + (D2 + D3)` → 乘 `1/det`，全程 float32。`m` 的内存布局同 `Mat4`（GLM 的 `m[c][r]` = `m[c·4 + r]`）。对抓帧的
 * `g_EffectModelMatrix` 连正负零逐位相同（`p13e-spot`、`p13e-po`、`3287715210`）。
 */
export function glmInverse(m: ArrayLike<number>): Mat4 {
  const M = (c: number, r: number) => f(m[c * 4 + r]);
  const mul = (a: number, b: number) => f(a * b);
  const d = (a: number, b: number, c: number, e: number) => f(mul(a, b) - mul(c, e));
  const c00 = d(M(2, 2), M(3, 3), M(3, 2), M(2, 3));
  const c02 = d(M(1, 2), M(3, 3), M(3, 2), M(1, 3));
  const c03 = d(M(1, 2), M(2, 3), M(2, 2), M(1, 3));
  const c04 = d(M(2, 1), M(3, 3), M(3, 1), M(2, 3));
  const c06 = d(M(1, 1), M(3, 3), M(3, 1), M(1, 3));
  const c07 = d(M(1, 1), M(2, 3), M(2, 1), M(1, 3));
  const c08 = d(M(2, 1), M(3, 2), M(3, 1), M(2, 2));
  const c10 = d(M(1, 1), M(3, 2), M(3, 1), M(1, 2));
  const c11 = d(M(1, 1), M(2, 2), M(2, 1), M(1, 2));
  const c12 = d(M(2, 0), M(3, 3), M(3, 0), M(2, 3));
  const c14 = d(M(1, 0), M(3, 3), M(3, 0), M(1, 3));
  const c15 = d(M(1, 0), M(2, 3), M(2, 0), M(1, 3));
  const c16 = d(M(2, 0), M(3, 2), M(3, 0), M(2, 2));
  const c18 = d(M(1, 0), M(3, 2), M(3, 0), M(1, 2));
  const c19 = d(M(1, 0), M(2, 2), M(2, 0), M(1, 2));
  const c20 = d(M(2, 0), M(3, 1), M(3, 0), M(2, 1));
  const c22 = d(M(1, 0), M(3, 1), M(3, 0), M(1, 1));
  const c23 = d(M(1, 0), M(2, 1), M(2, 0), M(1, 1));
  const fac = [
    [c00, c00, c02, c03],
    [c04, c04, c06, c07],
    [c08, c08, c10, c11],
    [c12, c12, c14, c15],
    [c16, c16, c18, c19],
    [c20, c20, c22, c23],
  ];
  const v = (r: number) => [M(1, r), M(0, r), M(0, r), M(0, r)];
  const [v0, v1, v2, v3] = [v(0), v(1), v(2), v(3)];
  const inv = (a: number[], fa: number[], b: number[], fb: number[], c: number[], fc: number[]) =>
    [0, 1, 2, 3].map((k) => f(f(mul(a[k], fa[k]) - mul(b[k], fb[k])) + mul(c[k], fc[k])));
  const inv0 = inv(v1, fac[0], v2, fac[1], v3, fac[2]);
  const inv1 = inv(v0, fac[0], v2, fac[3], v3, fac[4]);
  const inv2 = inv(v0, fac[1], v1, fac[3], v3, fac[5]);
  const inv3 = inv(v0, fac[2], v1, fac[4], v2, fac[5]);
  const signA = [1, -1, 1, -1];
  const signB = [-1, 1, -1, 1];
  const columns = [
    inv0.map((x, k) => mul(x, signA[k])),
    inv1.map((x, k) => mul(x, signB[k])),
    inv2.map((x, k) => mul(x, signA[k])),
    inv3.map((x, k) => mul(x, signB[k])),
  ];
  const row0 = [columns[0][0], columns[1][0], columns[2][0], columns[3][0]];
  const dot = [0, 1, 2, 3].map((k) => mul(M(0, k), row0[k]));
  const det = f(f(dot[0] + dot[1]) + f(dot[2] + dot[3]));
  const one = f(1 / det);
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = mul(columns[c][r], one);
  return out;
}

/** `FUN_1400dc250`：三分量按快速倒数平方根归一化（同 `shadowMath.ts` 的级联视图）。 */
function qnorm(v: readonly number[]): number[] {
  const l2 = f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]));
  const r = fastInverseSqrt(l2);
  return [f(v[0] * r), f(v[1] * r), f(v[2] * r)];
}

/**
 * 聚光的 VP（`FUN_14025d420` 类型 1，V1.2）：视图同平行光级联第 6 步（三列是快速倒数平方根归一化的 Z、Y、−X，看向局部 +X、up 局部 +Y，
 * 平移 `−((V_0j·px + V_1j·py) + V_2j·pz)`）；投影 `PerspectiveFovRH(fovY = (outer + outer)·0.017453292f, 1, near, far)`，near 正交 1、
 * 透视 0.05（**不读** `lightsourcesize`），far = `radius > near + 0.01 ? radius : near + 0.01`。返回 `V·P`（WPE 写法）= `P * V`。
 */
export function spotViewProjection(
  matrix: ArrayLike<number>,
  outercone: number,
  radius: number,
  orthographic: boolean,
): Mat4 {
  const X = [matrix[0], matrix[1], matrix[2]];
  const Y = [matrix[4], matrix[5], matrix[6]];
  const Z = [matrix[8], matrix[9], matrix[10]];
  const p = [f(matrix[12]), f(matrix[13]), f(matrix[14])];
  const n = [qnorm(Z), qnorm(Y), qnorm([-X[0], -X[1], -X[2]])];
  const view = new Float32Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) view[i * 4 + j] = n[j][i];
  for (let j = 0; j < 3; j++) view[12 + j] = f(-f(f(f(n[j][0] * p[0]) + f(n[j][1] * p[1])) + f(n[j][2] * p[2])));
  view[11] = -0;
  view[15] = 1;
  const outer = f(outercone);
  const fov = f(f(outer + outer) * f(0.017453292));
  const near = orthographic ? 1 : f(0.05);
  const limit = f(near + f(0.01));
  const r = f(radius);
  const far = r > limit ? r : limit;
  return multiply(perspectiveRH(fov, 1, near, far), view);
}

/** 一盏会画的体积光（编译期常量；每帧量由渲染器算）。 */
export interface VolumetricLight {
  /** `objects` 下标：渲染器按它把灯插进图层序列。 */
  object: number;
  kind: "point" | "spot";
  /** `SHADOW` 变体（castshadow ∧ 阴影档 ≠ 0，V6）：点光的 `g_RenderVar0` / `g_RenderVar3` 每帧取这盏灯的阴影条目。 */
  shadow: boolean;
  /** 原始 `radius`（float32）：点光灯体缩放与「在内」判定。 */
  radius: number;
  /** 世界位置（根对象的 `origin`）。 */
  position: [number, number, number];
  /**
   * 不随相机变的 uniform：`g_RenderVar1`（r·0.99、cos 内外锥、intensity）、`g_RenderVar2`（位置、density）、`g_RenderVar4`
   * （color、volumetricsexponent）、`g_AltViewProjectionMatrix`、`g_AltModelMatrix`，聚光另有 `g_RenderVar3`。
   */
  constants: Record<string, number[]>;
  /** 聚光的「在内」判定（V4）：归一化的灯轴（世界矩阵第 0 行 / 四分量长度）与远平面上圆的半径。 */
  spot?: { axis: [number, number, number]; farRadius: number };
  back: ScenePass;
  front: ScenePass;
  fullscreen: ScenePass;
}

/** 一份 bundle 的体积光：有会画的灯且档位不为 0 时才有。 */
export interface SceneVolumetrics {
  /** volumetrics 档 1–4（low…ultra）。 */
  quality: number;
  /** `objects` 顺序。 */
  lights: VolumetricLight[];
  /** 低、中档的两次模糊（`volumetricsBlurs`）。 */
  blurH: ScenePass | null;
  blurV: ScenePass | null;
  combine: ScenePass;
}

export interface VolumetricsCompileContext {
  fs: SceneFs;
  shader: ShaderCompiler;
  unsupported: Set<string>;
  addProgram(result: TranslateResult): number;
}

export interface VolumetricsInput {
  objects: readonly SceneObject[];
  /** 读灯字段（解析 `{user}` 并登记重编译，`lights.ts` 的 `bindingReader`）。 */
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined;
  /** volumetrics 档 0–4（0 = 关）。 */
  quality: number;
  /** 阴影档 0–4 与 `lightconfig` 的计数（P13d）。 */
  shadowQuality: number;
  counts: LightCounts;
  orthographic: boolean;
  /** 灯在组（带子层的组合层）里：`objects` 下标 → 真。 */
  inGroup: (object: number) => boolean;
}

/** 场景里有没有会画的体积光灯（可见点光 / 聚光且 `castvolumetrics`）；读档位前判一次，没有就不读 WPE 的设置。 */
export function wantsVolumetrics(objects: readonly SceneObject[], read: VolumetricsInput["read"]): boolean {
  return objects.some((object, index) => volumetricKind(object, index, read) !== null);
}

function volumetricKind(object: SceneObject, index: number, read: VolumetricsInput["read"]): "point" | "spot" | null {
  const kind = object.light === "lpoint" ? "point" : object.light === "lspot" ? "spot" : null;
  if (!kind) return null;
  const at = (key: string) => `objects/${index}/${key}`;
  if (read(object.castvolumetrics as SceneValue | undefined, at("castvolumetrics")) !== true) return null;
  if (read(object.visible as SceneValue | undefined, at("visible")) === false) return null;
  return kind;
}

/** 灯对象缺键时的值（`FUN_14018ff60`，rea-p13-lights 构造缺省）。 */
const DEFAULTS = { intensity: 0, radius: 1, innercone: 20, outercone: 30, density: 2, volumetricsexponent: 1 };

/**
 * 编译体积光：每盏会画的灯一份常量与三份 pass（背面、正面、全屏正面），整场一份模糊与合成。档位为 0 或没有会画的灯时返回 null。
 */
export async function compileVolumetrics(
  context: VolumetricsCompileContext,
  input: VolumetricsInput,
): Promise<SceneVolumetrics | null> {
  const { objects, read, quality, shadowQuality, counts, orthographic } = input;
  if (quality <= 0) return null;
  const issues = context.unsupported;
  const kinds = objects.map((object, index) => volumetricKind(object, index, read));
  if (!kinds.some(Boolean)) return null;
  // 可见的聚光数超过聚光槽时，排不上的那盏的聚光 VP 是残留值（V6），照报
  const visibleSpots = objects.filter(
    (object, index) =>
      object.light === "lspot" && read(object.visible as SceneValue | undefined, `objects/${index}/visible`) !== false,
  ).length;
  // 点光阴影条目：带阴影的可见点光排在前面（`sortLights` 按 flags 降序），全部排得上 ⇔ 个数 ≤ min(pointShadow, point)
  const castingPoints = objects.filter(
    (object, index) =>
      object.light === "lpoint" &&
      read(object.visible as SceneValue | undefined, `objects/${index}/visible`) !== false &&
      read(object.castshadow as SceneValue | undefined, `objects/${index}/castshadow`) === true,
  ).length;
  const lights: VolumetricLight[] = [];
  for (const [index, object] of objects.entries()) {
    const kind = kinds[index];
    if (!kind) continue;
    const at = (key: string) => `objects/${index}/${key}`;
    const field = (key: keyof typeof DEFAULTS) =>
      f(numbers(read(object[key] as SceneValue | undefined, at(key)), [DEFAULTS[key]])[0] ?? DEFAULTS[key]);
    const vector = (key: string, fallback: number[]) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), fallback).map((v) => f(v));
    const flag = (key: string) => read(object[key] as SceneValue | undefined, at(key)) === true;
    if (input.inGroup(index)) issues.add("volumetrics:group");
    if (flag("usecookie")) issues.add("volumetrics:cookie");
    const shadow = flag("castshadow") && shadowQuality !== 0;
    if (kind === "spot") {
      if (shadow) issues.add("volumetrics:spot-shadow");
      if (visibleSpots > counts.spot) issues.add("volumetrics:spot-unassigned");
    } else if (shadow && castingPoints > Math.min(counts.pointShadow, counts.point))
      issues.add("volumetrics:shadow-unassigned");
    const origin = vector("origin", [0, 0, 0]);
    const position: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    const radius = field("radius");
    const color = vector("color", [0, 0, 0]);
    const toRadians = (degrees: number) => f(degrees * f(0.017453292));
    const constants: Record<string, number[]> = {
      g_RenderVar1: [
        f(radius * f(0.99)),
        cosf(toRadians(field("innercone"))),
        cosf(toRadians(field("outercone"))),
        field("intensity"),
      ],
      g_RenderVar2: [...position, field("density")],
      g_RenderVar4: [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, field("volumetricsexponent")],
    };
    let spot: VolumetricLight["spot"];
    if (kind === "point") {
      constants.g_AltViewProjectionMatrix = [radius, 0, 0, 0, 0, radius, 0, 0, 0, 0, radius, 0, ...position, 1];
      // 点光的 `g_AltModelMatrix` 是点光阴影的 P（`POINTLIGHT` 不读），给单位阵
      constants.g_AltModelMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    } else {
      const matrix = layerLocalMatrix({
        origin: vector("origin", [0, 0, 0]),
        angles: vector("angles", [0, 0, 0]),
        scale: vector("scale", [1, 1, 1]),
      });
      const vp = spotViewProjection(matrix, field("outercone"), radius, orthographic);
      const inverse = glmInverse(vp);
      constants.g_AltModelMatrix = Array.from(vp);
      constants.g_AltViewProjectionMatrix = Array.from(inverse);
      const row0 = [matrix[0], matrix[1], matrix[2], matrix[3]].map((v) => f(v));
      constants.g_RenderVar3 = row0;
      const length = f(
        Math.sqrt(f(f(f(f(row0[0] * row0[0]) + f(row0[1] * row0[1])) + f(row0[2] * row0[2])) + f(row0[3] * row0[3]))),
      );
      // 远平面上的圆半径：NDC (0, 0, 0, 1) 与 (0, 1, 0, 1) 经逆矩阵变回世界、除 w 后的距离（V4，运算顺序没核，编译期常量）
      const unproject = (y: number) => {
        const w = f(f(inverse[7] * y) + inverse[15]);
        return [0, 1, 2].map((k) => f(f(f(inverse[4 + k] * y) + inverse[12 + k]) / w));
      };
      const [a, b] = [unproject(0), unproject(1)];
      const farRadius = f(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      spot = { axis: [f(row0[0] / length), f(row0[1] / length), f(row0[2] / length)], farRadius };
    }
    const combos: Record<string, number> = {
      POINTLIGHT: kind === "point" ? 1 : 0,
      SHADOW: shadow ? 1 : 0,
      QUALITY: quality,
      // 只给点光（`0x1401982fa`），值是阴影档
      ...(kind === "point" ? { LIGHTS_SHADOW_MAPPING_QUALITY: shadowQuality } : {}),
    };
    const key = `volumetrics/${index}`;
    const back = await compileVolumetricsPass(context, `${key}/back`, VOLUMETRICS_MATERIALS.back, {}, []);
    const front = await compileVolumetricsPass(
      context,
      `${key}/front`,
      VOLUMETRICS_MATERIALS.front,
      combos,
      FRONT_SLOTS,
    );
    const fullscreen = await compileVolumetricsPass(
      context,
      `${key}/fullscreen`,
      VOLUMETRICS_MATERIALS.fullscreen,
      combos,
      FRONT_SLOTS,
    );
    if (!back || !front || !fullscreen) continue;
    lights.push({
      object: index,
      kind,
      shadow,
      radius,
      position,
      constants,
      ...(spot ? { spot } : {}),
      back,
      front,
      fullscreen,
    });
  }
  const blurs = volumetricsBlurs(quality);
  const blurH = blurs
    ? await compileVolumetricsPass(context, "volumetrics/blur_h", VOLUMETRICS_MATERIALS.blurH, {}, BLUR_SLOTS)
    : null;
  const blurV = blurs
    ? await compileVolumetricsPass(context, "volumetrics/blur_v", VOLUMETRICS_MATERIALS.blurV, {}, BLUR_SLOTS)
    : null;
  const combine = await compileVolumetricsPass(
    context,
    "volumetrics/combine",
    VOLUMETRICS_MATERIALS.combine,
    {},
    BLUR_SLOTS,
  );
  if (!combine || (blurs && (!blurH || !blurV))) return null;
  return { quality, lights, blurH, blurV, combine };
}

/** 正面 pass 的槽：0 阴影图集（`SHADOW`）、1 `_rt_volumetricsBack`、3 `_rt_volumetricsSingle`；格式只影响 `TEX<n>FORMAT`，这里没有。 */
const FRONT_SLOTS: ShaderTextureSlot[] = [
  { slot: 1, format: FBO_FORMATS.rgba8888.tex },
  { slot: 3, format: FBO_FORMATS.rgba8888.tex },
];
/** 模糊与合成的槽 0（LightBuffer / LightBufferB）。 */
const BLUR_SLOTS: ShaderTextureSlot[] = [{ slot: 0, format: FBO_FORMATS.rgba8888.tex }];

/** 体积光材质的 COMBO 由代码给（V9），放行这几个名字。 */
const VOLUMETRICS_COMBOS: ReadonlySet<string> = new Set([
  "POINTLIGHT",
  "SHADOW",
  "QUALITY",
  "LIGHTS_SHADOW_MAPPING_QUALITY",
  "FULLSCREEN",
]);

async function compileVolumetricsPass(
  { fs, shader, unsupported, addProgram }: VolumetricsCompileContext,
  key: string,
  path: string,
  combos: Record<string, number>,
  slots: ShaderTextureSlot[],
): Promise<ScenePass | null> {
  const text = await fs.text(path);
  const pass = text ? parseMaterial(text).passes[0] : undefined;
  if (!pass?.shader) {
    unsupported.add(`material:missing:${path}`);
    return null;
  }
  checkPassFeatures(pass, unsupported);
  const result = await shader.compile(pass.shader, { ...(pass.combos ?? {}), ...combos }, slots);
  let program: number | null = null;
  if (result?.ok) {
    checkProgramFeatures(result, unsupported, VOLUMETRICS_UNIFORMS, VOLUMETRICS_COMBOS);
    program = addProgram(result);
  }
  return {
    key,
    program,
    blending: pass.blending ?? "normal",
    ...normalizeDepthKeys(pass),
    textures: {},
    runtime: {},
    uniforms: shaderUniforms(result, pass, {}),
    framebuffer: false,
  };
}
