/**
 * P13e 的渲染侧纯函数（`.claude/plans/wpe-import/3-scene/phase13/phase-13e-volumetrics.md`，rea-p13-volumetrics V4）：相机是否在灯体内
 * （决定正面换不换全屏三角形）。
 */
import { describe, expect, it } from "vitest";
import { glmInverse, spotViewProjection } from "../compile/volumetrics";
import { layerLocalMatrix } from "./layout";
import { insideLightVolume, VolumetricsRenderer } from "./volumetrics";

const FORWARD = [0, 0, -1];

describe("insideLightVolume（V4）", () => {
  it("点光：p = eye + 0.2·F 在半径内（严格小于）才算", () => {
    const light = { kind: "point" as const, radius: 5, position: [0, 3, 7] as [number, number, number] };
    // p13e-in：相机 (0, 3, 8) 看向 (0, 1, 0)，在半径 5 的球里
    expect(insideLightVolume(light, [0, 3, 8], [0, -0.24, -0.97])).toBe(true);
    // 正交：eye (960, 540, 2000)，p.z = 1999.8；灯 z = 200、r = 600 离得远
    const ortho = { kind: "point" as const, radius: 600, position: [1300, 700, 200] as [number, number, number] };
    expect(insideLightVolume(ortho, [960, 540, 2000], FORWARD)).toBe(false);
    // 恰好在球面上不算（`r² > d²`）：p = (0, 0, 4.8)，d = 4.8
    expect(insideLightVolume({ kind: "point", radius: 4.8, position: [0, 0, 0] }, [0, 0, 5], FORWARD)).toBe(false);
    expect(insideLightVolume({ kind: "point", radius: 4.81, position: [0, 0, 0] }, [0, 0, 5], FORWARD)).toBe(true);
  });

  it("聚光：沿灯轴 0 < t ≤ radius 且离轴距离在锥内", () => {
    const matrix = layerLocalMatrix({ origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1] });
    const inverse = glmInverse(spotViewProjection(matrix, 30, 10, false));
    // 远平面（z = 10 处）上圆的半径约 10·tan(30°)：视图三列照 WPE 用快速倒数平方根（一次牛顿）归一化，长度差约 0.17%
    const unproject = (y: number) => {
      const w = inverse[7] * y + inverse[15];
      return [0, 1, 2].map((k) => (inverse[4 + k] * y + inverse[12 + k]) / w);
    };
    const [a, b] = [unproject(0), unproject(1)];
    const farRadius = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    expect(Math.abs(farRadius / (10 * Math.tan(Math.PI / 6)) - 1)).toBeLessThan(0.002);
    const light = {
      kind: "spot" as const,
      radius: 10,
      position: [0, 0, 0] as [number, number, number],
      spot: { axis: [1, 0, 0] as [number, number, number], farRadius },
    };
    // 灯照 +X：p = eye + 0.2·F
    expect(insideLightVolume(light, [5, 0, 0.2], FORWARD)).toBe(true);
    expect(insideLightVolume(light, [5, 4, 0.2], FORWARD)).toBe(false);
    expect(insideLightVolume(light, [-1, 0, 0.2], FORWARD)).toBe(false);
    expect(insideLightVolume(light, [11, 0, 0.2], FORWARD)).toBe(false);
  });
});

describe("VolumetricsRenderer.frame（P13f2）", () => {
  it("灯的常量每帧按 frameOf 给的几何写（不是编译期初值），在内判定也用它", () => {
    const written: Record<string, ArrayLike<number>>[] = [];
    const renderer = Object.create(VolumetricsRenderer.prototype) as {
      lights: unknown[];
      write: (draw: unknown, values: Record<string, ArrayLike<number>>) => void;
      frame: VolumetricsRenderer["frame"];
    };
    const draws = {
      light: { object: 4, kind: "point", radius: 1, position: [0, 0, 0], constants: { g_RenderVar2: [0, 0, 0, 2] } },
      back: {},
      front: {},
      fullscreen: {},
      inside: false,
    };
    renderer.lights = [draws];
    renderer.write = (_draw, values) => written.push({ ...values });
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    renderer.frame(() => ({
      viewProjection: identity,
      eye: [5, 6, 7.1],
      forward: [0, 0, -1],
      geometry: { radius: 3, position: [5, 6, 7], constants: { g_RenderVar2: [5, 6, 7, 2] } },
    }));
    expect(written.map((values) => Array.from(values.g_RenderVar2))).toEqual([
      [5, 6, 7, 2],
      [5, 6, 7, 2],
    ]);
    // 眼睛在 (5, 6, 7) 半径 3 的球里：按这一帧的几何判，不是编译期的 (0, 0, 0) 半径 1
    expect(draws.inside).toBe(true);
  });
});
