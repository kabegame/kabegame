/**
 * 透视相机三段的逐步 float32（P5d 补修）：期望值由与实现分开写的逐步 fround 参考函数算出后写死。
 */
import { describe, expect, it } from "vitest";
import type { CameraPath } from "../compile/camera";
import {
  XM_SINCOS_CONSTANTS as K,
  initialCameraPathState,
  lookAtRH,
  lookAtVectors,
  perspectiveFov,
  perspectiveRH,
  stepCameraPath,
  xmScalarSinCos,
} from "./camera";

describe("xmScalarSinCos 常量", () => {
  it("位模式对应的十进制近似", () => {
    expect(K.C_1DIV2PI).toBeCloseTo(0.159154937, 8);
    expect(K.C_2PI).toBeCloseTo(6.283185482, 7);
    expect(K.C_PIDIV2).toBeCloseTo(1.570796371, 7);
    expect(K.C_PI).toBeCloseTo(3.141592741, 7);
    expect(K.S6 / 2.3889859e-8).toBeCloseTo(1, 6);
    expect(K.S5 / 2.7525562e-6).toBeCloseTo(1, 6);
    expect(K.S4 / 1.9840874e-4).toBeCloseTo(1, 6);
    expect(K.S3 / 8.333331e-3).toBeCloseTo(1, 6);
    expect(K.S2).toBeCloseTo(0.16666667, 7);
    expect(K.C5 / 2.6051615e-7).toBeCloseTo(1, 6);
    expect(K.C4 / 2.4760495e-5).toBeCloseTo(1, 6);
    expect(K.C3 / 1.3888378e-3).toBeCloseTo(1, 6);
    expect(K.C2 / 4.1666638e-2).toBeCloseTo(1, 6);
  });
});

describe("xmScalarSinCos", () => {
  const cases: [number, number, number][] = [
    [0, 0, 1],
    [0.4363323, 0.42261824011802673, 0.9063078165054321],
    [1.5707963, 1, 5.960464477539063e-8],
    [1.5707964, 0.9999998807907104, -1.1920928955078125e-7],
    [1.570797, 1, -4.76837158203125e-7],
    [1.6, 0.9995735883712769, -0.02919948101043701],
    [-0.7, -0.6442176699638367, 0.76484215259552],
    [-2, -0.909297525882721, -0.41614675521850586],
    [3.5, -0.35078316926956177, -0.9364567399024963],
    [6.5, 0.21511980891227722, 0.9765876531600952],
  ];
  it.each(cases)("y = %d 逐位写死，且和 Math.sin/cos 差在 1e-6 量级", (y, s, c) => {
    const [sin, cos] = xmScalarSinCos(y);
    expect(sin).toBe(s);
    expect(cos).toBe(c);
    expect(Math.abs(sin - Math.sin(y))).toBeLessThan(1e-6);
    expect(Math.abs(cos - Math.cos(y))).toBeLessThan(1e-6);
  });
  it("和旧 double 写法不同（能区分）", () => {
    expect(xmScalarSinCos(1.5707963)[1]).not.toBe(Math.fround(Math.cos(1.5707963)));
  });
});

describe("lookAtRH", () => {
  it("一般位置：轴与平移逐位写死", () => {
    const eye: [number, number, number] = [1.1, 2.3, 3.7];
    const m = lookAtRH(eye, [0.3, -0.9, 0.2], [0.1, 1, 0.05]);
    const expected = [
      0.9856796860694885, -0.027674391865730286, 0.1663421094417572, 0, -0.09148523211479187, 0.7408882975578308,
      0.665368378162384, 0, -0.14165456593036652, -0.671057939529419, 0.7277467250823975, 0, -0.34970980882644653,
      0.8093132972717285, -4.405986785888672, 1,
    ];
    // 列主序：m[0]=sx m[4]=sy m[8]=sz m[1]=ux' ... 与上表同序
    expect(Array.from(m)).toEqual(expected.map(Math.fround));
    const v = lookAtVectors(eye, [0.3, -0.9, 0.2], [0.1, 1, 0.05]);
    expect(v.forward).toEqual([-0.1663421094417572, -0.665368378162384, -0.7277467250823975]);
    expect(v.right).toEqual([0.9856796860694885, -0.09148523211479187, -0.14165456593036652]);
    expect(v.up).toEqual([-0.027674391865730286, 0.7408882975578308, -0.671057939529419]);
  });
  it("正交退化：单位阵加平移的形状", () => {
    const m = lookAtRH([0, 0, 0], [0, 0, -1], [0, 1, 0]);
    expect(Array.from(m, (v) => v + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const t = lookAtRH([5, 7, 0], [5, 7, -1], [0, 1, 0]);
    expect(Array.from(t, (v) => v + 0)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, -7, 0, 1]);
  });
  it("长度为 0 照 WPE 得 NaN", () => {
    const m = lookAtRH([1, 1, 1], [1, 1, 1], [0, 1, 0]);
    expect(Number.isNaN(m[2])).toBe(true);
  });
});

describe("perspectiveRH", () => {
  it("fov 50°、16:9、near 0.1、far 10000", () => {
    const fov = perspectiveFov(50);
    expect(fov).toBe(0.8726646304130554);
    const m = perspectiveRH(fov, Math.fround(16 / 9), 0.1, 10000);
    expect(m[0]).toBe(1.206284999847412);
    expect(m[5]).toBe(2.1445066928863525);
    expect(m[10]).toBe(0.000010000099791795947);
    expect(m[11]).toBe(-1);
    expect(m[14]).toBe(0.10000099986791611);
    // 旧 double 写法 cot = cos/sin 的 m5 不同
    expect(m[5]).not.toBe(Math.fround(Math.cos(fov / 2) / Math.sin(fov / 2)));
  });

  it("m32 = f(range·far)：near 0.3、far 777.7 时和 double 的 n·f/(f − n) 差 1 ulp", () => {
    const m = perspectiveRH(perspectiveFov(50), Math.fround(16 / 9), 0.3, 777.7);
    expect(m[14]).toBe(0.30011576414108276);
  });
});

describe("lookAtRH：逐步 float32 的写法能区分", () => {
  // 先求 1/len 再乘、平方和逐步 f：逐分量除或平方和在 double 里求，这组输入的结果都会变（期望值来自独立手写的参考实现）
  it("斜相机的 16 项", () => {
    const m = lookAtRH(
      [3.103080987930298, -3.9037132263183594, 2.649669647216797],
      [9.917621612548828, 3.5892295837402344, 3.4624671936035156],
      [-0.6546039581298828, 1, 0.7663441300392151],
    );
    const [sx, sy, sz, tx, ux, uy, uz, ty, fx, fy, fz, tz] = [
      0.3532203137874603, -0.4123344123363495, 0.8397712707519531, -4.93082332611084, -0.6522589325904846,
      0.5349514484405518, 0.5370153188705444, 2.689396381378174, 0.6706666946411133, 0.7374330163002014,
      0.0799930989742279, -0.5856385231018066,
    ];
    expect([...m]).toEqual([sx, ux, -fx, 0, sy, uy, -fy, 0, sz, uz, -fz, 0, tx, ty, tz, 1]);
  });
});

describe("路径段内插值", () => {
  const path = (t1: number, a: number, b: number): CameraPath =>
    ({
      duration: 10,
      keys: [
        { t: 0, eye: [a, -2.7, 100.5], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
        { t: t1, eye: [b, 0.33, 100.7], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
      ],
    }) as unknown as CameraPath;
  it.each([
    [0.1, 1, 1.1, 5.3, 1.3687999248504639, -2.506080150604248, 100.51280212402344],
    [0.37, 1.3, 1.1, 5.3, 2.111196517944336, -1.9704939126968384, 100.54814910888672],
  ])("t=%d 段长 %d", (t, t1, a, b, x, y, z) => {
    const p = path(t1, a, b);
    const { pose } = stepCameraPath([p], { path: 0, key: 0, t: Math.fround(t) }, 0);
    expect(pose.eye).toEqual([x, y, z]);
  });
  it("初始状态在第一帧之前取 k[0]", () => {
    const { pose } = stepCameraPath([path(1, 1.1, 5.3)], initialCameraPathState(), 0);
    expect(pose.eye[0]).toBe(Math.fround(1.1));
  });
});
