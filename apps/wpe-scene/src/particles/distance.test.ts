// P4d 步骤 5：距离类 operator 与 vortex_v2（distance.ts），以及不可见时照常更新控制点（system.ts 的 suspend）。依据
// rea-p4d-modules.md 第 3、4、5 节（各段执行与解析汇编逐条核对过），实测见报告「P4d 语义的实测核对」的「距离类与 vortex_v2」表，
// 定量由 ignore/p4/cases/d5 回放核对。期望值按 rea 的公式逐步 float32 手算，不调被测函数。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { identity, translation } from "../render/math";
import { ParticleColumns } from "./columns";
import {
  controlPointCount,
  eulerBasis,
  IDENTITY_BASIS,
  identityControlPoints,
  type ControlPointSet,
} from "./controlpoints";
import {
  inverseBasis,
  maintainDistanceBetweenControlPoints,
  maintainDistanceToControlPoint,
  reduceMovementNearControlPoint,
  vortexV2,
} from "./distance";
import {
  particleModuleDef,
  readParticleModule,
  resolveParticleFields,
  type InstanceMultipliers,
  type ParticleFields,
  type ParticleRunContext,
} from "./modules";
import { blendFactor, readBlend } from "./operators";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

const f32 = Math.fround;
const ONE: InstanceMultipliers = { size: 1, speed: 1, count: 1, lifetime: 1, rate: 1 };

type Name =
  | "maintaindistancetocontrolpoint"
  | "maintaindistancebetweencontrolpoints"
  | "reducemovementnearcontrolpoint"
  | "vortex_v2";

function fieldsOf(name: Name, module: JsonObject = {}, orthographic = true): ParticleFields {
  const reading = readParticleModule("operator", { name, ...module }, orthographic);
  expect(reading.issues).toEqual([]);
  return resolveParticleFields(particleModuleDef("operator", name)!, reading.fields, ONE);
}

const issuesOf = (name: Name, module: JsonObject) =>
  readParticleModule("operator", { name, ...module }, true).issues.map((issue) => `${issue.kind}:${issue.field}`);

/** 槽 0 的列：位置、速度、年龄、寿命。 */
function one(position: number[], velocity: number[] = [0, 0, 0], age = 0, life = 1): ParticleColumns {
  const columns = new ParticleColumns(4, 0);
  for (let i = 0; i < 3; i++) {
    columns.position[i][0] = position[i];
    columns.velocity[i][0] = velocity[i];
  }
  columns.age[0] = age;
  columns.life[0] = life;
  return columns;
}

/** 执行上下文：缺省 `h = 0.5`、`k = 0.1`（两者不同，用错一个就对不上），8 个单位阵控制点。 */
function context(columns: ParticleColumns, extra: Partial<ParticleRunContext> = {}): ParticleRunContext {
  return {
    columns,
    random: new SeededRandom(1),
    slot: 0,
    count: 1,
    h: 0.5,
    k: 0.1,
    time: 0,
    controlPoints: identityControlPoints(),
    world: false,
    basis: IDENTITY_BASIS,
    model: IDENTITY_BASIS,
    ...extra,
  };
}

/** 直接写控制点的 current / previous（3×3 与平移）。 */
function setPoint(
  set: ControlPointSet,
  index: number,
  { current, previous, basis }: { current?: number[]; previous?: number[]; basis?: ArrayLike<number> },
): void {
  if (current) set.current(index).translation.set(current);
  if (previous) set.previous(index).translation.set(previous);
  if (basis) set.current(index).basis.set(Array.from(basis));
}

const pos = (columns: ParticleColumns, slot = 0) => [0, 1, 2].map((i) => columns.position[i][slot]);
const vel = (columns: ParticleColumns, slot = 0) => [0, 1, 2].map((i) => columns.velocity[i][slot]);
const rsqrt = (x: number) => f32(1 / Math.sqrt(x));

describe("字段表（rea 3.1–3.3、第 4 节）", () => {
  it("缺省值：正交 / 透视两套", () => {
    const defaults = (name: Name, orthographic: boolean) =>
      readParticleModule("operator", { name }, orthographic).fields;
    expect(defaults("maintaindistancetocontrolpoint", true)).toMatchObject({
      distance: 200,
      variablestrength: 0,
      controlpoint: 0,
    });
    expect(defaults("maintaindistancetocontrolpoint", false)).toMatchObject({ distance: 1 });
    expect(defaults("maintaindistancebetweencontrolpoints", true)).toMatchObject({
      controlpointstart: 0,
      controlpointend: 1,
    });
    expect(defaults("reducemovementnearcontrolpoint", true)).toMatchObject({
      distanceinner: 100,
      distanceouter: 350,
      reductioninner: 100,
      reductionouter: 0,
      controlpoint: 0,
    });
    expect(defaults("reducemovementnearcontrolpoint", false)).toMatchObject({ distanceinner: 0.5, distanceouter: 1 });
    expect(defaults("vortex_v2", true)).toMatchObject({
      distanceinner: 500,
      distanceouter: 650,
      speedinner: 2500,
      speedouter: 0,
      centerforce: 1,
      ringradius: 300,
      ringwidth: 50,
      ringpulldistance: 50,
      ringpullforce: 10,
      axis: [0, 0, 1],
      flags: 0,
      controlpoint: 0,
    });
    expect(defaults("vortex_v2", false)).toMatchObject({
      distanceinner: 1,
      distanceouter: 2,
      speedinner: 1,
      ringradius: 1,
      ringwidth: 0.2,
      ringpulldistance: 0.25,
      ringpullforce: 0.05,
    });
  });

  it("控制点下标按无符号钳到 0–7；vortex_v2 的 flags 只存低 8 位；audioprocessingmode ≠ 0 照报（P4e）", () => {
    expect(fieldsOf("maintaindistancetocontrolpoint", { controlpoint: -1 }).controlpoint).toBe(7);
    expect(fieldsOf("reducemovementnearcontrolpoint", { controlpoint: 9 }).controlpoint).toBe(7);
    const between = fieldsOf("maintaindistancebetweencontrolpoints", { controlpointstart: 12, controlpointend: -3 });
    expect([between.controlpointstart, between.controlpointend]).toEqual([7, 7]);
    expect(fieldsOf("vortex_v2", { flags: 0x106, controlpoint: 3 })).toMatchObject({ flags: 6, controlpoint: 3 });
    expect(issuesOf("vortex_v2", { audioprocessingmode: 0, audioprocessingexponent: 3 })).toEqual([]);
    expect(issuesOf("vortex_v2", { audioprocessingmode: 1 })).toEqual(["value:audioprocessingmode"]);
    expect(issuesOf("vortex_v2", { boids: 1 })).toEqual(["unknown:boids"]);
  });

  it("vortex_v2 的两个速度乘 instanceoverride.speed，其余字段不乘", () => {
    const def = particleModuleDef("operator", "vortex_v2")!;
    const reading = readParticleModule("operator", { name: "vortex_v2", speedinner: 10, speedouter: 30 }, true);
    const fields = resolveParticleFields(def, reading.fields, { ...ONE, speed: 2 });
    expect([fields.speedinner, fields.speedouter, fields.centerforce, fields.ringpullforce]).toEqual([20, 60, 1, 10]);
  });

  it("控制点个数：四个模块按字段计入；between 不写字段时计 0、1 两个点", () => {
    const def = (operator: JsonObject[]) => ({ emitters: [], initializers: [], operators: parse(operator) });
    const parse = (operator: JsonObject[]) =>
      parseParticle({ operator }, { file: "p.json", orthographic: true }).operators;
    expect(controlPointCount(def([{ name: "maintaindistancebetweencontrolpoints" }]))).toBe(2);
    expect(controlPointCount(def([{ name: "maintaindistancebetweencontrolpoints", controlpointstart: 4 }]))).toBe(5);
    expect(controlPointCount(def([{ name: "maintaindistancetocontrolpoint", controlpoint: 2 }]))).toBe(3);
    expect(controlPointCount(def([{ name: "reducemovementnearcontrolpoint", controlpoint: 5 }]))).toBe(6);
    expect(controlPointCount(def([{ name: "vortex_v2", controlpoint: 1 }]))).toBe(2);
  });
});

describe("inverseBasis（FUN_140228b00，glm）", () => {
  it("对角与旋转缩放：乘回原矩阵约等于单位阵；对角阵逐位", () => {
    expect(Array.from(inverseBasis([2, 0, 0, 0, 4, 0, 0, 0, 0.5]))).toEqual([0.5, -0, 0, -0, 0.25, -0, 0, -0, 2]);
    const r = eulerBasis([0.3, -0.7, 1.1]);
    const m = r.map((value, i) => f32(value * [2, 2, 2, 1, 1, 1, 3, 3, 3][i]));
    const inv = inverseBasis(m);
    for (let c = 0; c < 3; c++)
      for (let row = 0; row < 3; row++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += inv[k * 3 + row] * m[c * 3 + k];
        expect(sum).toBeCloseTo(c === row ? 1 : 0, 5);
      }
  });
});

describe("maintaindistancetocontrolpoint（rea 3.1）", () => {
  /** 手算：Δ 平移、T 求逆、`(q·distance − 1)·s`、`p = f·d + p′`。 */
  function expected(p: number[], C: number[], P: number[], T: ArrayLike<number>, distance: number, s: number, b = 1) {
    const x = [0, 1, 2].map((i) => f32(f32(C[i] - P[i]) + p[i]));
    const d = x.map((v, i) => f32(v - C[i]));
    const u = [0, 1, 2].map((k) => f32(f32(f32(d[1] * T[3 + k]) + f32(d[0] * T[k])) + f32(d[2] * T[6 + k])));
    const q = rsqrt(f32(f32(f32(u[0] * u[0]) + f32(u[1] * u[1])) + f32(u[2] * u[2])));
    let f = f32(f32(f32(q * distance) - 1) * s);
    if (b !== 1) f = f32(f * b);
    return d.map((v, i) => f32(f32(f * v) + x[i]));
  }

  it("硬约束（variablestrength 0）：拉回半径 distance，先平移 current − previous", () => {
    const columns = one([130, 40, 5]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [30, 10, 0], previous: [20, 15, 0] });
    maintainDistanceToControlPoint(fieldsOf("maintaindistancetocontrolpoint"), ctx);
    const want = expected([130, 40, 5], [30, 10, 0], [20, 15, 0], IDENTITY_BASIS, 200, 1);
    expect(pos(columns)).toEqual(want);
    const [dx, dy, dz] = pos(columns).map((v, i) => v - [30, 10, 0][i]);
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(200, 3);
  });

  it("Δcp 的方向是 current − previous：粒子跟着控制点走（落在半径上时只剩平移）", () => {
    const columns = one([200, 0, 0]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [10, 0, 0], previous: [0, 0, 0] });
    maintainDistanceToControlPoint(fieldsOf("maintaindistancetocontrolpoint"), ctx);
    expect(pos(columns)[0]).toBeCloseTo(210, 3);
  });

  it("variablestrength：s = clamp01(vs·h)，用 h；大于 1 时钳到 1", () => {
    for (const vs of [0.3, 1000]) {
      const columns = one([150, 0, 0]);
      const ctx = context(columns);
      maintainDistanceToControlPoint(fieldsOf("maintaindistancetocontrolpoint", { variablestrength: vs }), ctx);
      const s = Math.min(1, f32(f32(vs) * 0.5));
      expect(pos(columns)).toEqual(expected([150, 0, 0], [0, 0, 0], [0, 0, 0], IDENTITY_BASIS, 200, s));
    }
    // vs = 0.3、h = 0.5：半径 150 → 150 + (200 − 150)·0.15
    const columns = one([150, 0, 0]);
    maintainDistanceToControlPoint(
      fieldsOf("maintaindistancetocontrolpoint", { variablestrength: 0.3 }),
      context(columns),
    );
    expect(columns.position[0][0]).toBeCloseTo(157.5, 3);
  });

  it("T = inverse(mat3(current))：控制点 x 缩放 2 时落在 x 半轴 2·distance 的椭球上", () => {
    const columns = one([100, 0, 0]);
    const ctx = context(columns);
    const basis = [2, 0, 0, 0, 1, 0, 0, 0, 1];
    setPoint(ctx.controlPoints, 0, { basis });
    maintainDistanceToControlPoint(fieldsOf("maintaindistancetocontrolpoint"), ctx);
    // u = 50，f = 200/50 − 1 = 3，p = 4·d
    expect(pos(columns)).toEqual([400, 0, 0]);
    expect(pos(columns)).toEqual(expected([100, 0, 0], [0, 0, 0], [0, 0, 0], inverseBasis(basis), 200, 1));
  });

  it("blend 只乘修正量 f，平移 Δ 不乘", () => {
    const module = { blendinstart: 0, blendinend: 0.5 };
    const fields = fieldsOf("maintaindistancetocontrolpoint", module);
    const columns = one([150, 0, 0], [0, 0, 0], 0.1, 1);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [10, 0, 0], previous: [0, 0, 0] });
    maintainDistanceToControlPoint(fields, ctx);
    const b = blendFactor(readBlend(fields), f32(f32(0.1) * f32(1)));
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(1);
    expect(pos(columns)).toEqual(expected([150, 0, 0], [10, 0, 0], [0, 0, 0], IDENTITY_BASIS, 200, 1, b));
  });

  it("用的是 controlpoint 指定的点", () => {
    const columns = one([0, 50, 0]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 3, { current: [0, 100, 0], previous: [0, 100, 0] });
    maintainDistanceToControlPoint(fieldsOf("maintaindistancetocontrolpoint", { controlpoint: 3, distance: 20 }), ctx);
    expect(pos(columns)[1]).toBeCloseTo(80, 4);
  });
});

describe("maintaindistancebetweencontrolpoints（rea 3.2）", () => {
  it("上一帧线段映射到本帧线段：比例保持、垂直偏移不随线段转、ΔA 平移；两个点的 previous 都读", () => {
    // previous：A (0, 0)、B (100, 0)；current：A (10, 0)、B (10, 100)（转了 90° 并平移）。P = (50, 20)：t = 50、比例 0.5、s = 50
    const columns = one([50, 20, 0]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [10, 0, 0], previous: [0, 0, 0] });
    setPoint(ctx.controlPoints, 1, { current: [10, 100, 0], previous: [100, 0, 0] });
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    // x = ((50·0 − 50·1) + 10) + 50 = 10；y = ((50·1 − 50·0) + 0) + 20 = 70
    expect(pos(columns)).toEqual([10, 70, 0]);
  });

  it("比例夹到 [0, 1]：越过终点的粒子沿线段方向拉回终点所在的平面", () => {
    const columns = one([150, 7, 0]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [0, 0, 0], previous: [0, 0, 0] });
    setPoint(ctx.controlPoints, 1, { current: [100, 0, 0], previous: [100, 0, 0] });
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    // t = 150、比例 1、s = 100：x = (100 − 150) + 150 = 100，垂直偏移 7 不动
    expect(pos(columns)).toEqual([100, 7, 0]);
  });

  it("长度² ≤ 2⁻⁴⁶ 时整条跳过（缺省 0、1 号点都在原点）；本帧、上一帧任一条退化都跳过", () => {
    const columns = one([50, 20, 0]);
    const ctx = context(columns);
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    expect(pos(columns)).toEqual([50, 20, 0]);
    setPoint(ctx.controlPoints, 1, { current: [100, 0, 0], previous: [0, 0, 0] });
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    expect(pos(columns)).toEqual([50, 20, 0]);
    // 恰好 2⁻⁴⁶（2⁻²³ 的平方）不做，稍大就做
    setPoint(ctx.controlPoints, 1, { current: [2 ** -23, 0, 0], previous: [2 ** -23, 0, 0] });
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    expect(pos(columns)).toEqual([50, 20, 0]);
    setPoint(ctx.controlPoints, 1, { current: [2 ** -22, 0, 0], previous: [2 ** -22, 0, 0] });
    maintainDistanceBetweenControlPoints(fieldsOf("maintaindistancebetweencontrolpoints"), ctx);
    expect(columns.position[0][0]).not.toBe(50);
  });

  it("blend：((s·D̂ − t·D̂p) + ΔA)·b + P", () => {
    const module = { blendinstart: 0, blendinend: 0.5 };
    const fields = fieldsOf("maintaindistancebetweencontrolpoints", module);
    const columns = one([50, 20, 0], [0, 0, 0], 0.2, 1);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { current: [10, 0, 0], previous: [0, 0, 0] });
    setPoint(ctx.controlPoints, 1, { current: [10, 100, 0], previous: [100, 0, 0] });
    maintainDistanceBetweenControlPoints(fields, ctx);
    const b = blendFactor(readBlend(fields), f32(0.2));
    expect(pos(columns)).toEqual([f32(f32(-40 * b) + 50), f32(f32(50 * b) + 20), 0]);
  });
});

describe("reducemovementnearcontrolpoint（rea 3.3）", () => {
  /** 手算：L = rsqrt(n)·n、t、r、f、vel·(1 − f)。 */
  function factor(d: number[], inner: number, outer: number, rin: number, rout: number, h: number, b = 1) {
    const n = f32(f32(f32(d[1] * d[1]) + f32(d[0] * d[0])) + f32(d[2] * d[2]));
    const L = f32(rsqrt(n) * n);
    const rcpD = outer === inner ? 1 : f32(1 / f32(outer - inner));
    const sat = (x: number) => (x < 1 ? (0 > x ? 0 : x) : 1);
    const t = sat(f32(f32(L - inner) * rcpD));
    const r = f32(f32(t * (rout === rin ? 1 : f32(rout - rin))) + rin);
    let f = sat(f32(r * h));
    if (b !== 1) f = f32(f * b);
    return f32(1 - f);
  }

  it("vel *= 1 − clamp01((rin + t·Δred)·h)，用 h（不是 k）", () => {
    const module = { distanceinner: 20, distanceouter: 50, reductioninner: 1, reductionouter: 0.2 };
    const columns = one([35, 0, 0], [100, 50, -20]);
    reduceMovementNearControlPoint(fieldsOf("reducemovementnearcontrolpoint", module), context(columns));
    const g = factor([35, 0, 0], 20, 50, 1, 0.2, 0.5);
    // t = 0.5、r = 0.6、f = 0.3
    expect(g).toBeCloseTo(0.7, 5);
    expect(vel(columns)).toEqual([100, 50, -20].map((v) => f32(g * v)));
  });

  it("reductionouter == reductioninner 时差存 1.0（WPE 的 bug）：r = rin + t", () => {
    const module = { distanceinner: 20, distanceouter: 50, reductioninner: 0.4, reductionouter: 0.4 };
    const columns = one([200, 0, 0], [100, 0, 0]);
    reduceMovementNearControlPoint(fieldsOf("reducemovementnearcontrolpoint", module), context(columns));
    // 远处 t = 1：r = 1.4，f = 0.7（按 0 实现是 0.4·0.5 = 0.2）
    expect(columns.velocity[0][0]).toBe(f32(factor([200, 0, 0], 20, 50, 0.4, 0.4, 0.5) * 100));
    expect(columns.velocity[0][0]).toBeCloseTo(30, 4);
  });

  it("distanceouter == distanceinner 时倒数存 1.0；粒子正好在控制点上（n = 0）时 t = 1", () => {
    const equal = { distanceinner: 20, distanceouter: 20, reductioninner: 0, reductionouter: 1 };
    const near = one([20.5, 0, 0], [10, 0, 0]);
    reduceMovementNearControlPoint(fieldsOf("reducemovementnearcontrolpoint", equal), context(near));
    // t = (20.5 − 20)·1 = 0.5，r = 0.5，f = 0.25
    expect(near.velocity[0][0]).toBe(f32(factor([20.5, 0, 0], 20, 20, 0, 1, 0.5) * 10));
    expect(near.velocity[0][0]).toBeCloseTo(7.5, 4);
    const centre = one([0, 0, 0], [10, 0, 0]);
    reduceMovementNearControlPoint(
      fieldsOf("reducemovementnearcontrolpoint", { reductioninner: 0, reductionouter: 1 }),
      context(centre),
    );
    // t = 1：r = 1，f = 0.5
    expect(centre.velocity[0][0]).toBe(5);
  });

  it("blend 乘 f", () => {
    const module = { distanceinner: 20, distanceouter: 50, reductioninner: 1, reductionouter: 1.4, blendinend: 0.5 };
    const fields = fieldsOf("reducemovementnearcontrolpoint", module);
    const columns = one([35, 0, 0], [100, 0, 0], 0.2, 1);
    reduceMovementNearControlPoint(fields, context(columns));
    const b = blendFactor(readBlend(fields), f32(0.2));
    expect(columns.velocity[0][0]).toBe(f32(factor([35, 0, 0], 20, 50, 1, 1.4, 0.5, b) * 100));
  });
});

describe("vortex_v2（rea 第 4 节）", () => {
  /** 粒子在 (100, 0, 0)、静止，轴 z：r̂ = (1, 0, 0)，T = r̂ × a = (0, −1, 0)。 */
  const BASE = { distanceinner: 50, distanceouter: 150, speedinner: 200, speedouter: 100 };

  it("切向乘 k（不是 h），方向 r̂ × a；spd = t·DS + SI", () => {
    const columns = one([100, 0, 0]);
    vortexV2(fieldsOf("vortex_v2", BASE), context(columns));
    // t = 0.5，spd = (0.5·(100 − 200) + 200)·k = 15
    expect(vel(columns)).toEqual([0, -15, 0]);
  });

  it("轴乘控制点 current 的 3×3（不重新归一化）", () => {
    // 绕 x 转 90°：z 轴变成 (0, −1, 0)，T = (1, 0, 0) × (0, −1, 0) = (0, 0, −1)
    const columns = one([100, 0, 0]);
    const ctx = context(columns);
    setPoint(ctx.controlPoints, 0, { basis: eulerBasis([Math.PI / 2, 0, 0]) });
    vortexV2(fieldsOf("vortex_v2", BASE), ctx);
    expect(vel(columns)[1]).toBeCloseTo(0, 5);
    expect(vel(columns)[2]).toBeCloseTo(-15, 4);
    // 缩放 2：轴长 2，切向加倍（L 也在缩放后的 r 上量，这里 r 不变）
    const scaled = one([100, 0, 0]);
    const ctx2 = context(scaled);
    setPoint(ctx2.controlPoints, 0, { basis: [2, 0, 0, 0, 2, 0, 0, 0, 2] });
    vortexV2(fieldsOf("vortex_v2", BASE), ctx2);
    expect(vel(scaled)).toEqual([0, -30, 0]);
  });

  it("axis：|axis|² < 0.001 取 (0, 0, 1)，否则 axis·(1/sqrt(|axis|²))", () => {
    const tangent = (axis: string) => {
      const columns = one([100, 0, 0]);
      vortexV2(fieldsOf("vortex_v2", { ...BASE, axis }), context(columns));
      return vel(columns);
    };
    expect(tangent("0 0 0.01")).toEqual([0, -15, 0]);
    expect(tangent("0 0 -2")).toEqual([0, 15, 0]);
    // (0.6, 0, 0.8)：r = d − 0 = (100, 0, 0)（球形），T = (0·0.8 − 0, 0·0.6 − 1·0.8, 0) = (0, −0.8, 0)
    const inv = f32(1 / f32(Math.sqrt(25)));
    expect(tangent("3 0 4")).toEqual([0, f32(f32(-f32(f32(4) * inv)) * 15), 0]);
  });

  it("柱形（flags bit0）：去掉沿轴分量，按到轴线的距离", () => {
    const sphere = one([100, 0, 100]);
    vortexV2(fieldsOf("vortex_v2", BASE), context(sphere));
    const cyl = one([100, 0, 100]);
    vortexV2(fieldsOf("vortex_v2", { ...BASE, flags: 1 }), context(cyl));
    // 柱形：r = (100, 0, 0)、L = 100、T = (0, −1, 0)、spd 15
    expect(vel(cyl)).toEqual([0, -15, 0]);
    // 球形：L = 141.4，t ≈ 0.914，切向有 z 分量为 0、y 分量按 r̂.x = 0.707
    expect(vel(sphere)[1]).not.toBe(-15);
    expect(vel(sphere)[1]).toBeCloseTo(-0.7071 * f32(f32(f32(0.9142136) * -10) + 20), 2);
  });

  it("centerforce（flags bit2 关、bit1 开）：c = (L·rsqrt(|P′|²) − 1)·cf/h，作用在 P′ = (vel·h + p) − C 上", () => {
    const module = { ...BASE, speedinner: 0, speedouter: 0, flags: 2, centerforce: 0.5 };
    const columns = one([100, 0, 0], [0, 40, 0]);
    vortexV2(fieldsOf("vortex_v2", module), context(columns));
    const P = [100, 20, 0];
    const c = f32(f32(f32(rsqrt(f32(f32(400) + f32(10000))) * 100) - 1) * f32(f32(1 / 0.5) * 0.5));
    expect(vel(columns)).toEqual([f32(f32(P[0] * c) + 0), f32(f32(P[1] * c) + 40), 0]);
    expect(c).toBeLessThan(0);
    // flags 不带 bit1 时 centerforce 不读
    const off = one([100, 0, 0], [0, 40, 0]);
    vortexV2(fieldsOf("vortex_v2", { ...module, flags: 0 }), context(off));
    expect(vel(off)).toEqual([0, 40, 0]);
  });

  it("环形（flags bit2）：拉力 sign(ringradius − L)·(1 − t)·h·pullforce，环带内为 0；ringwidth / ringpulldistance 占内外距离的槽", () => {
    const ring = { speedinner: 0, speedouter: 0, flags: 4, ringradius: 200, ringwidth: 10, ringpulldistance: 100 };
    const pull = (x: number) => {
      const columns = one([x, 0, 0]);
      vortexV2(fieldsOf("vortex_v2", { ...ring, ringpullforce: 2 }), context(columns));
      return columns.velocity[0][0];
    };
    // 内侧 L = 100：e = 100、t = (100 − 10)/100 = 0.9、m = 0.1、pull = 0.1·0.5·2 = 0.1，速度 += P′·pull = 100·0.1
    expect(pull(100)).toBeCloseTo(10, 4);
    expect(pull(100)).toBeGreaterThan(0);
    // 外侧 L = 280：e = −80、t = 0.7、m = 0.3、pull = −0.3：速度 = 280·(−0.3)
    expect(pull(280)).toBeCloseTo(-84, 3);
    // 环带内（|e| ≤ ringwidth）：t = 0、w = 1、m = 0
    expect(Math.abs(pull(195))).toBe(0);
    expect(Math.abs(pull(205))).toBe(0);
    // 环形的 spd 同样按槽位：(|e| − ringwidth)·rcp(ringpulldistance)
    const columns = one([100, 0, 0]);
    vortexV2(fieldsOf("vortex_v2", { ...ring, speedinner: 100, speedouter: 300, ringpullforce: 0 }), context(columns));
    // t = 0.9：spd = (0.9·200 + 100)·k = 28
    expect(columns.velocity[1][0]).toBeCloseTo(-28, 4);
  });

  it("blend：spd·b 与 c·b（环形是 (c₀ + pull)·b）", () => {
    const module = { ...BASE, flags: 6, ringradius: 200, ringwidth: 10, ringpulldistance: 100, blendinend: 0.5 };
    const fields = fieldsOf("vortex_v2", module);
    const columns = one([100, 0, 0], [0, 0, 0], 0.2, 1);
    vortexV2(fields, context(columns));
    const b = blendFactor(readBlend(fields), f32(0.2));
    const plain = one([100, 0, 0]);
    vortexV2(fieldsOf("vortex_v2", { ...module, blendinend: 0 }), context(plain));
    // 静止粒子：c₀ = (100/100 − 1)·cf/h = 0，只剩拉力；两项都乘 b
    expect(columns.velocity[0][0]).toBeCloseTo(plain.velocity[0][0] * b, 4);
    expect(columns.velocity[1][0]).toBeCloseTo(plain.velocity[1][0] * b, 4);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(1);
  });

  it("instanceoverride.speed 乘两个速度（系统 flags bit4 时不乘）", () => {
    const json = (flags: number) => ({
      maxcount: 4,
      flags,
      emitter: [
        { name: "sphererandom", distancemin: 100, distancemax: 100, directions: "1 0 0", sign: "1 0 0", rate: 100 },
      ],
      initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
      operator: [{ name: "vortex_v2", ...BASE }],
    });
    const run = (flags: number) => {
      const s = new ParticleSystem(
        parseParticle(json(flags), { file: "p.json", orthographic: true, instanceoverride: { speed: 2 } }),
        new SeededRandom(1),
        1,
      );
      s.step(0.02, 0.02);
      return s.columns.velocity[1][0];
    };
    expect(run(0)).toBeCloseTo(2 * run(0x10), 4);
  });
});

describe("模拟器：两遍模式与不可见（rea 5.1、5.3）", () => {
  /** 世界系统，0 号点发射（对象原点）、1 号点 offset (200, 0)；maintaindistancetocontrolpoint 读 1 号点，几乎只剩平移。 */
  function system(passes: 1 | 2, extra: JsonObject = {}) {
    return new ParticleSystem(
      parseParticle(
        {
          maxcount: 16,
          flags: 1,
          controlpoint: [{ id: 0 }, { id: 1, offset: "200 0 0" }],
          emitter: [{ name: "sphererandom", distancemin: 0, distancemax: 0, directions: "1 0 0", rate: 1 }],
          initializer: [{ name: "lifetimerandom", min: 100, max: 100 }],
          operator: [{ name: "maintaindistancetocontrolpoint", controlpoint: 1, variablestrength: 1e-9, ...extra }],
        },
        { file: "p.json", orthographic: true },
      ),
      new SeededRandom(1),
      passes,
    );
  }
  const at = (x: number) => ({ world: translation(x, 0, 0), pointer: [0, 0] as const });

  it("previous 只在帧尾更新：两遍模式一帧平移两次 Δcp", () => {
    const moved = (passes: 1 | 2) => {
      const s = system(passes);
      s.prewarm(at(0));
      s.step(1, 1, at(0));
      expect(s.alive).toBe(1);
      const before = s.columns.position[0][0];
      s.step(0.001, 1.001, at(10));
      return s.columns.position[0][0] - before;
    };
    expect(moved(1)).toBeCloseTo(10, 3);
    expect(moved(2)).toBeCloseTo(20, 3);
  });

  it("suspend 按当帧的 W 更新控制点并拷 previous（没有粒子时也做）；重新可见时 Δcp 只有一帧", () => {
    const empty = system(1);
    empty.prewarm(at(0));
    expect(empty.suspend(at(30))).toBe(false);
    expect(Array.from(empty.controlPoints.current(1).translation)).toEqual([230, 0, 0]);
    expect(Array.from(empty.controlPoints.previous(1).translation)).toEqual([230, 0, 0]);

    // 隐藏期间对象从 0 移到 50，重新可见那帧又移 5：新粒子在 55 出生，只跟着 5 的一帧位移
    const s = system(1);
    s.prewarm(at(0));
    s.step(0.5, 0.5, at(0));
    expect(s.suspend(at(20))).toBe(false);
    s.suspend(at(50));
    s.step(1, 2, at(55));
    expect(s.alive).toBe(1);
    expect(s.columns.position[0][0]).toBeCloseTo(60, 3);
    // 对照：不更新控制点的写法会让 Δcp = 55，粒子到 110
  });

  it("suspend 的缺省输入是单位阵（单测用）；有粒子时照旧清空", () => {
    const s = system(1);
    s.prewarm({ world: identity(), pointer: [0, 0] });
    s.step(1, 1);
    expect(s.alive).toBe(1);
    expect(s.suspend()).toBe(true);
    expect(s.alive).toBe(0);
    expect(Array.from(s.controlPoints.previous(1).translation)).toEqual([200, 0, 0]);
  });
});
