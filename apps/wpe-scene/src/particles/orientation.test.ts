/**
 * P4c 步骤 5：renderer 朝向的解析（`FUN_1401c22e0`，rea-p4c-render.md 7.1）与 `g_Orientation*`（`FUN_1402298b0`，7.2、7.4）。
 * 实测：24 组四角（`ignore/p4/c5` 的离线四角，p4-particles-REPORT.md「P4c 语义的实测核对」）。
 */
import { describe, expect, it } from "vitest";
import { identity, multiply, rotationX, rotationZ, scaling, translation, type Mat4 } from "../render/math";
import { readParticleModule } from "./modules";
import {
  orientationBasis,
  orientationMode,
  orientationVectors,
  readOrientation,
  VIEW_FORWARD,
  VIEW_UP,
  type OrientationBasis,
  type ParticleOrientation,
} from "./orientation";

const f = Math.fround;
/** 按模块表解析一个 renderer 再读朝向（和编译路径同一个函数链）。 */
const parse = (fields: Record<string, unknown>, name = "sprite"): ParticleOrientation =>
  readOrientation(readParticleModule("renderer", { name, ...fields }, true).fields);
const basis = (fields: Record<string, unknown>, model: Mat4 = identity()) =>
  orientationBasis(parse(fields), model, VIEW_FORWARD, VIEW_UP);

/** 逐分量接近（±0 视为相同）。 */
function close(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, i) => expect(actual[i] + 0, `[${i}] ${actual} vs ${expected}`).toBeCloseTo(value, digits));
}
function closeBasis(actual: OrientationBasis | null, right: number[], up: number[], forward: number[]): void {
  expect(actual).not.toBeNull();
  close(actual!.right, right);
  close(actual!.up, up);
  close(actual!.forward, forward);
}

const H = Math.SQRT1_2;

describe("解析（FUN_1401c22e0，rea-p4c-render.md 7.1）", () => {
  it("orientation 只认精确的 upright / fixed（区分大小写）；其它字符串都是 screen", () => {
    expect(orientationMode("upright")).toBe(1);
    expect(orientationMode("fixed")).toBe(2);
    for (const value of ["screen", "Upright", "FIXED", "foo", "", " upright", undefined, 1])
      expect(orientationMode(value), String(value)).toBe(0);
    expect(parse({ orientation: "upright" }).mode).toBe(1);
    expect(parse({ orientation: "fixed" }).mode).toBe(2);
    expect(parse({ orientation: "Upright" }).mode).toBe(0);
    expect(parse({ orientation: "foo" }).mode).toBe(0);
    expect(parse({}).mode).toBe(0);
    expect(parse({ orientation: "fixed" }, "spritetrail").mode).toBe(2);
  });

  it('axis：精确零换成 (0,1,0)（-0 也算零），否则归一化；只认精确零，"0 0 0.000001" 归一化成 (0,0,1)', () => {
    expect(parse({}).axis).toEqual([0, 1, 0]);
    expect(parse({ axis: "0 0 0" }).axis).toEqual([0, 1, 0]);
    expect(parse({ axis: "-0 0 -0" }).axis).toEqual([0, 1, 0]);
    close(parse({ axis: "0 0 0.000001" }).axis, [0, 0, 1]);
    expect(parse({ axis: "0 0 1" }).axis).toEqual([0, 0, 1]);
    expect(parse({ axis: "0 -1 0" }).axis).toEqual([0, -1, 0]);
    expect(parse({ axis: "3 0 4" }).axis).toEqual([f(0.6), 0, f(0.8)]);
    // 分量先按 float32 存（atof 后 cvtsd2ss），再归一化：(x² + y²) + z²，1 / sqrt 再乘
    const s = f(f(f(f(0.1) * f(0.1)) + f(f(0.2) * f(0.2))) + f(f(0.3) * f(0.3)));
    const inv = f(1 / f(Math.sqrt(s)));
    expect(parse({ axis: "0.1 0.2 0.3" }).axis).toEqual([f(f(0.1) * inv), f(f(0.2) * inv), f(f(0.3) * inv)]);
  });

  it("t：axis.x == axis.z == 0 时是 (0,0,−1)（axis 的符号不起作用）；一般情形 normalize(cross(axis, r'))，r' 不归一化", () => {
    expect(parse({}).t).toEqual([0, 0, -1]);
    expect(parse({ axis: "0 -1 0" }).t).toEqual([0, 0, -1]);
    expect(parse({ axis: "0 5 0" }).t).toEqual([0, 0, -1]);
    // 一般情形：r' = (az − ay·0, ax·0 − az·0, ay·0 − ax)
    close(parse({ axis: "1 0 0" }).t, [0, 1, 0]);
    close(parse({ axis: "0 0 1" }).t, [0, 1, 0]);
    close(parse({ axis: "0 0 -1" }).t, [0, 1, 0]);
    close(parse({ axis: "0 1 1" }).t, [0, H, -H]);
    close(parse({ axis: "1 0 1" }).t, [0, 1, 0]);
    // 特例只看 x、z 是不是精确的 0：x 稍微离开 0 就走一般情形，t 跳到 (−1, ε, 0)（WPE 同样不连续）
    close(parse({ axis: "0.000001 1 0" }).t, [-1, 0, 0], 5);
    expect(parse({ axis: "0.000001 1 0" }).t[1]).toBeGreaterThan(0);
    // 三个分量都非零：逐步 float32，结果钉住（叉乘每个分量 f(f(a·b) − f(c·d))，平方和 (x² + y²) + z²）
    const [ax, ay, az] = parse({ axis: "0.3 0.5 0.7" }).axis;
    const r = [f(az - f(ay * 0)), f(f(ax * 0) - f(az * 0)), f(f(ay * 0) - ax)];
    const c = [f(f(ay * r[2]) - f(az * r[1])), f(f(az * r[0]) - f(ax * r[2])), f(f(ax * r[1]) - f(ay * r[0]))];
    const inv = f(1 / f(Math.sqrt(f(f(f(c[0] * c[0]) + f(c[1] * c[1])) + f(c[2] * c[2])))));
    expect(parse({ axis: "0.3 0.5 0.7" }).t).toEqual([f(c[0] * inv), f(c[1] * inv), f(c[2] * inv)]);
  });

  it("flags 只留低 8 位", () => {
    expect(parse({ flags: 1 }).flags).toBe(1);
    expect(parse({ flags: 256 }).flags).toBe(0);
    expect(parse({ flags: 257 }).flags).toBe(1);
    expect(parse({ flags: -1 }).flags).toBe(255);
    expect(parse({}).flags).toBe(0);
  });
});

describe("g_Orientation*（FUN_1402298b0，rea-p4c-render.md 7.2）", () => {
  it("7.4 的表（正交、对象无旋转）逐行", () => {
    for (const flags of [0, 1, 2, 255]) closeBasis(basis({ flags }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright" }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright", axis: "0 1 0" }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright", axis: "1 0 0" }), [0, -1, 0], [1, 0, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright", axis: "0 -1 0" }), [-1, 0, 0], [0, -1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright", axis: "1 1 0" }), [H, -H, 0], [H, H, 0], [0, 0, 1]);
    expect(basis({ orientation: "upright", axis: "0 0 1" })).toBeNull();
    // fixed 缺省轴（解析成 (0,1,0)）：躺在 XZ 平面，Up = (0,0,−1)
    closeBasis(basis({ orientation: "fixed" }), [1, 0, 0], [0, 0, -1], [0, 1, 0]);
    closeBasis(basis({ orientation: "fixed", axis: "0 0 1" }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "fixed", axis: "0 0 -1" }), [-1, 0, 0], [0, 1, 0], [0, 0, -1]);
    closeBasis(basis({ orientation: "fixed", axis: "1 0 1" }), [H, 0, -H], [0, 1, 0], [H, 0, H]);
    closeBasis(basis({ orientation: "fixed", axis: "0 1 1" }), [1, 0, 0], [0, H, -H], [0, H, H]);
    // S14：只认精确零
    closeBasis(basis({ orientation: "fixed", axis: "0 0 0.000001" }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "fixed", axis: "0 0 0" }), [1, 0, 0], [0, 0, -1], [0, 1, 0]);
  });

  it("对象转 0.5 弧度（S13）：flags 0 时本地基同上表（随对象转），flags 1 时本地基反向转（世界里保持直立）", () => {
    const model = multiply(translation(300, 200, 0), rotationZ(0.5));
    const [c, s] = [Math.cos(0.5), Math.sin(0.5)];
    closeBasis(basis({}, model), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "upright", axis: "1 0 0" }, model), [0, -1, 0], [1, 0, 0], [0, 0, 1]);
    closeBasis(basis({ orientation: "fixed", axis: "0 0 1" }, model), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    for (const fields of [
      { flags: 1 },
      { orientation: "upright", axis: "1 0 0", flags: 1 },
      { orientation: "fixed", axis: "0 0 1", flags: 1 },
    ])
      closeBasis(basis(fields, model), [c, -s, 0], [s, c, 0], [0, 0, 1]);
  });

  it("upright 的 flags bit0：上方向固定为 (0,1,0)，axis 被忽略（S6）", () => {
    closeBasis(basis({ orientation: "upright", axis: "1 0 0", flags: 1 }), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    // 平行于视线的轴也不读：不退化
    expect(basis({ orientation: "upright", axis: "0 0 1", flags: 1 })).not.toBeNull();
  });

  it("fixed 的 flags bit0：axis、t 原样当世界向量（不乘 M），再经 Mᵀ 回到本地", () => {
    // 对象绕 x 转：flags 0 时轴随对象（本地基不变），flags 1 时轴固定在世界
    const model = rotationX(0.4);
    closeBasis(basis({ orientation: "fixed", axis: "0 0 1" }, model), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    const world = basis({ orientation: "fixed", axis: "0 0 1", flags: 1 }, model)!;
    // Mᵀ·(0,0,1) = (m2, m6, m10)
    close(world.forward, [model[2], model[6], model[10]]);
    close(world.up, [model[1], model[5], model[9]]);
  });

  it("screen 的 flags 0：U 取对象 Y 轴并对 F 做一次 Gram-Schmidt；对象绕 x 转时 Forward 仍朝相机（本地里倾斜）", () => {
    const model = rotationX(0.4);
    const b = basis({}, model)!;
    // F = (0,0,1) 世界 → 本地 Mᵀ·F
    close(b.forward, [model[2], model[6], model[10]]);
    // flags 1：U 取相机上方向，结果相同（Gram-Schmidt 之后都是世界 y 在 F 垂面上的分量）
    close(basis({ flags: 1 }, model)!.up, b.up);
  });

  it("世界空间系统用单位阵（绘制的模型矩阵）：flags 1 的本地基不再反向转", () => {
    closeBasis(basis({ flags: 1 }, identity()), [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    const rotated = basis({ flags: 1 }, rotationZ(0.5))!;
    expect(rotated.right[1]).toBeLessThan(-0.4);
  });

  it("运算顺序：三个分量都非零的轴与带旋转、缩放的模型矩阵，逐位等于按汇编写的逐步 float32", () => {
    const model = multiply(multiply(rotationZ(0.7), rotationX(0.3)), scaling(1.5, 0.8, 1.2));
    for (const [orientation, flags] of [
      ["upright", 0],
      ["fixed", 0],
      ["fixed", 1],
      ["screen", 0],
    ] as const) {
      const o = parse({ orientation, axis: "0.3 0.5 0.7", flags });
      const m = model;
      const [ax, ay, az] = o.axis;
      const [tx, ty, tz] = o.t;
      // v·M（0x14022997d / 0x140229ab8）：(v.y·m[4+j] + v.x·m[j]) + v.z·m[8+j]
      const vm = (x: number, y: number, z: number) =>
        [0, 1, 2].map((j) => f(f(f(y * m[4 + j]) + f(x * m[j])) + f(z * m[8 + j])));
      // M·v（0x140229d55）：(v.y·m[4i+1] + v.x·m[4i]) + v.z·m[4i+2]
      const mv = (v: number[]) =>
        [0, 1, 2].map((i) => f(f(f(v[1] * m[4 * i + 1]) + f(v[0] * m[4 * i])) + f(v[2] * m[4 * i + 2])));
      const cross = (a: number[], b: number[]) => [
        f(f(a[1] * b[2]) - f(a[2] * b[1])),
        f(f(a[2] * b[0]) - f(a[0] * b[2])),
        f(f(a[0] * b[1]) - f(a[1] * b[0])),
      ];
      const unit = (v: number[]) => {
        const inv = f(1 / f(Math.sqrt(f(f(f(v[1] * v[1]) + f(v[0] * v[0])) + f(v[2] * v[2])))));
        return v.map((x) => f(x * inv));
      };
      let F: number[];
      let U: number[];
      if (orientation === "upright") {
        U = vm(ax, ay, az);
        F = cross(cross([0, 0, -1], U), U);
      } else if (orientation === "fixed") {
        F = flags ? [ax, ay, az] : vm(ax, ay, az);
        U = flags ? [tx, ty, tz] : vm(tx, ty, tz);
      } else {
        F = [-0, -0, 1];
        U = vm(0, 1, 0);
        const d = f(f(f(F[1] * U[1]) + f(F[0] * U[0])) + f(F[2] * U[2]));
        U = [f(U[0] - f(F[0] * d)), f(U[1] - f(F[1] * d)), f(U[2] - f(d * F[2]))];
      }
      const F2 = mv(F);
      const U2 = mv(U);
      const ours = orientationVectors(o, model, VIEW_FORWARD, VIEW_UP);
      expect(ours.forward, orientation).toEqual(unit(F2));
      expect(ours.up, orientation).toEqual(unit(U2));
      expect(ours.right, orientation).toEqual(unit(cross(U2, F2)));
      // 换成行（Mᵀ 当 M）就不同：输入有足够的非对称性钉住记号
      const swapped = [0, 1, 2].map((i) => f(f(f(F[1] * m[4 + i]) + f(F[0] * m[i])) + f(F[2] * m[8 + i])));
      expect(unit(swapped), orientation).not.toEqual(ours.forward);
    }
  });

  it("NaN 返回 null；orientationVectors 给出原值（upright 轴平行于视线时 Up 有限、Right / Forward 是 NaN）", () => {
    const o = parse({ orientation: "upright", axis: "0 0 1" });
    expect(orientationBasis(o, identity(), VIEW_FORWARD, VIEW_UP)).toBeNull();
    const raw = orientationVectors(o, identity(), VIEW_FORWARD, VIEW_UP);
    expect(raw.up).toEqual([0, 0, 1]);
    expect(raw.right.every(Number.isNaN)).toBe(true);
    expect(raw.forward.every(Number.isNaN)).toBe(true);
    // 对象把轴恰好转到视线上同样退化（本地 y 轴 → 世界 z）；转开就不退化
    const tilt = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    expect(basis({ orientation: "upright", axis: "0 1 0" }, tilt)).toBeNull();
    expect(basis({ orientation: "upright", axis: "0 1 0" }, rotationX(0.3))).not.toBeNull();
    // 模型矩阵把对象 y 轴压成 0：screen 的 U 是 0，归一化得 NaN；压 x 轴不影响 screen
    expect(basis({}, scaling(1, 0, 1))).toBeNull();
    expect(basis({}, scaling(0, 1, 1))).not.toBeNull();
  });
});
