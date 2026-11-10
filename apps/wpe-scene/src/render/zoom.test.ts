/**
 * P5a 步骤 4（缩放）：`layout.ts` 的 `sceneViewProjection` / `particleViewProjection` 带 `general.zoom`。GpuScene 的矩阵、眼位、指针反投影、
 * 就地写与渲染器的取值时机在 `parallax.test.ts`「缩放」一节（共用那里的假设备），`particleTrack` 的跟随点在 `particles/simulator.test.ts`。
 * 期望值取 WPE 实测（计划「步骤 4」的补测：`p5a-zoomx15` 第 116 帧、`zoomx08` 第 117 帧，1920×1080，读数 `ignore/p5/s4/out/dump.json`，
 * 核对脚本 `ignore/p5/s4/ana_zoomx.py`），都是 float32 原值。
 */
import { describe, expect, it } from "vitest";
import { particleFov } from "../compile/particles";
import { particleViewProjection, sceneViewProjection } from "./layout";
import { multiply, orthographic, translation, type Mat4 } from "./math";

const W = 1920;
const H = 1080;
const GENERAL = { width: W, height: H, perspectiveOverrideFov: particleFov(95) };

/**
 * WPE 抓帧：方块 A 的 MVP 的线性项（正交投影绕中心乘 zoom 之后的 m00、m11，模型矩阵只有平移），与透视粒子 `pz` 的 MVP 里不受平移
 * 影响的几项（m00、m11、m22、m23）与 m33（= 相机距离 d，对象在 z = 0 平面上）。
 */
const MEASURED = [
  {
    tag: "zoomx15",
    zoom: 1.5,
    m00: 0.0015625001396983862,
    m11: 0.00277777761220932,
    perspective: {
      m00: 0.5154362320899963,
      m11: 0.9163311123847961,
      m22: 0.00033344447729177773,
      d: 329.8792724609375,
    },
  },
  {
    tag: "zoomx08",
    zoom: 0.8,
    m00: 0.00083333341171965,
    m11: 0.00148148147854954,
    perspective: {
      m00: 0.5154362320899963,
      m11: 0.9163311123847961,
      m22: 0.00033344447729177773,
      d: 618.5235595703125,
    },
  },
];

const bytes = (m: Mat4) => Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString("hex");

/** 齐次除法后的 NDC xy。 */
function ndc(m: Mat4, x: number, y: number, z: number): [number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
}

/** 改动之前的 `particleViewProjection`（逐行照抄），zoom 1 的逐字节对照。 */
function particleViewProjectionBefore(general: typeof GENERAL): Mat4 {
  const { width, height } = general;
  const focal = 1 / Math.tan(general.perspectiveOverrideFov / 2);
  const d = (height / 2) * focal;
  const far = Math.max(15000, d + 1000);
  const projection = new Float32Array(16);
  projection[0] = (focal * height) / width;
  projection[5] = focal;
  projection[10] = 5 / (far - 5);
  projection[11] = -1;
  projection[14] = (far * 5) / (far - 5);
  return multiply(projection, translation(-width / 2, -height / 2, -d));
}

describe("缩放的投影（P5a 步骤 4）", () => {
  it("zoom 1 逐字节同以前：正交就是 ortho(0…W, 0…H)，透视粒子的 d 是 (H/2)/tan(fov/2)", () => {
    const ortho = orthographic(0, W, 0, H, 2000, -2000);
    expect(bytes(sceneViewProjection(GENERAL))).toBe(bytes(ortho));
    expect(bytes(sceneViewProjection(GENERAL, 1))).toBe(bytes(ortho));
    expect(bytes(particleViewProjection(GENERAL))).toBe(bytes(particleViewProjectionBefore(GENERAL)));
    expect(bytes(particleViewProjection(GENERAL, 1))).toBe(bytes(particleViewProjectionBefore(GENERAL)));
    // 别的分辨率、窄 fov（远平面跟着 d 走）同样
    const narrow = { width: 3441, height: 2465, perspectiveOverrideFov: particleFov(2) };
    expect(bytes(particleViewProjection(narrow, 1))).toBe(bytes(particleViewProjectionBefore(narrow)));
  });

  it.each(MEASURED)(
    "$tag：正交的线性项逐位等于 WPE 的 f32(zoom)·f32(2/W)，平移项 −zoom，场景中心仍在 NDC 原点，z 行不变",
    ({ zoom, m00, m11 }) => {
      const m = sceneViewProjection(GENERAL, zoom);
      const plain = sceneViewProjection(GENERAL);
      expect(m[0]).toBe(m00);
      expect(m[5]).toBe(m11);
      // 别的取整对不上：按 double 先乘再舍入、或 2/(W/zoom) 都差 1 ulp（所以要按 float32 乘）
      expect(Math.fround((zoom * 2) / W) === m00 && Math.fround((zoom * 2) / H) === m11).toBe(false);
      expect(m[12]).toBe(-Math.fround(zoom));
      expect(m[13]).toBe(-Math.fround(zoom));
      expect([m[10], m[14], m[15]]).toEqual([plain[10], plain[14], plain[15]]);
      const center = ndc(m, W / 2, H / 2, 0);
      expect(Math.abs(center[0])).toBeLessThan(1e-6);
      expect(Math.abs(center[1])).toBeLessThan(1e-6);
      // 可见区：缩放之后 x 方向只看得到 W/zoom 宽
      expect(ndc(m, W / 2 + W / (2 * zoom), H / 2 + H / (2 * zoom), 0).map((v) => Math.round(v * 1e5) / 1e5)).toEqual([
        1, 1,
      ]);
    },
  );

  it.each(MEASURED)(
    "$tag：透视粒子的 d = (H/(2·zoom))/tan(fov/2)，和 WPE 对上；fov、宽高比、远平面（15000）不变；按不缩放的 d 差上百",
    ({ zoom, perspective }) => {
      const m = particleViewProjection(GENERAL, zoom);
      for (const [index, expected] of [
        [0, perspective.m00],
        [5, perspective.m11],
        [10, perspective.m22],
        [11, -1],
      ] as const)
        expect(Math.abs(m[index] - expected), `[${index}]`).toBeLessThanOrEqual(1e-6 * Math.abs(expected));
      // m33 = d（相机在 z = d，对象在 z = 0 平面上）
      expect(m[15]).toBeCloseTo(perspective.d, 3);
      expect(m[15]).toBeCloseTo(H / (2 * zoom) / Math.tan(particleFov(95) / 2), 3);
      expect(Math.abs(particleViewProjection(GENERAL)[15] - perspective.d)).toBeGreaterThan(100);
    },
  );

  it.each([1.5, 0.8, 3])("zoom %s：透视的 z = 0 平面和缩放后的正交画面重合；离开 z = 0 按 d/(d − z) 放大", (zoom) => {
    const ortho = sceneViewProjection(GENERAL, zoom);
    const perspective = particleViewProjection(GENERAL, zoom);
    for (const [x, y] of [
      [0, 0],
      [960, 540],
      [1700, 100],
      [-300, 1500],
    ]) {
      const a = ndc(ortho, x, y, 0),
        b = ndc(perspective, x, y, 0);
      expect(Math.abs(a[0] - b[0]), `${x},${y}`).toBeLessThan(1e-5);
      expect(Math.abs(a[1] - b[1]), `${x},${y}`).toBeLessThan(1e-5);
    }
    const d = H / (2 * zoom) / Math.tan(particleFov(95) / 2);
    const scale = ndc(perspective, 960 + 100, 540, 200)[0] / ndc(ortho, 960 + 100, 540, 0)[0];
    expect(scale).toBeCloseTo(d / (d - 200), 4);
  });

  it("远平面用缩放后的 d：窄 fov 时 far = d + 1000 跟着 zoom 变", () => {
    const general = { ...GENERAL, perspectiveOverrideFov: particleFov(2) };
    for (const zoom of [1, 1.5, 0.8]) {
      // 和实现同一个算式（乘 1/tan），double 结果逐位相同
      const d = (H / (2 * zoom)) * (1 / Math.tan(particleFov(2) / 2));
      expect(d + 1000).toBeGreaterThan(15000);
      expect(particleViewProjection(general, zoom)[10]).toBeCloseTo(Math.fround(5 / (d + 1000 - 5)), 12);
    }
  });
});
