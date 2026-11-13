// P4c 步骤 2：光标下的场景点（`sceneCursor`）。依据报告「P4c 语义的实测核对」末尾「步骤 2 补测」：窗口和场景比例不同时，
// WPE 把居中盖满裁切做进 `P·V`，跟随点是光标下的场景点（读数 `ignore/p4/out/ana_ptr2.txt`）。
import { describe, expect, it } from "vitest";
import { pointerScenePoint } from "../particles/controlpoints";
import {
  layerLocalMatrix,
  scenePlacement,
  scenePointer,
  sceneCursor,
  sceneViewProjection,
  type SceneStyle,
} from "./layout";
import { multiply, orthographic, rotationX, rotationY, rotationZ, scaling, translation } from "./math";

const VP_1080 = sceneViewProjection({ width: 1920, height: 1080 });

/** RenderDoc 读到的 WPE `P·V`（列主序）：1920×800 窗口只显示场景 y ∈ [140, 940]，1440×1080 只显示 x ∈ [240, 1680]。 */
const WPE_VP: Record<string, Float32Array> = {
  "1920x800": new Float32Array([1 / 960, 0, 0, 0, 0, 2 / 800, 0, 0, 0, 0, 0.00025, 0, -1, -1.35, 0.5, 1]),
  "1440x1080": new Float32Array([1 / 720, 0, 0, 0, 0, 1 / 540, 0, 0, 0, 0, 0.00025, 0, -4 / 3, -1, 0.5, 1]),
};

/** 抓帧里 WPE 当帧的 `g_PointerPosition`（窗口归一化坐标）与当帧新出生粒子的跟随点（`ana_ptr2.txt`，±0.02）。 */
const MEASURED: Record<string, { pointer: [number, number]; follow: [number, number] }[]> = {
  "1920x800": [
    { pointer: [0.6432291865348816, 0.5550000071525574], follow: [1235.0, 496.0] },
    { pointer: [0.653124988079071, 0.6212499737739563], follow: [1254.0, 443.0] },
    { pointer: [0.6541666388511658, 0.6587499976158142], follow: [1256.0, 413.0] },
  ],
  "1440x1080": [
    { pointer: [0.31111112236976624, 0.7805555462837219], follow: [688.0, 237.0] },
    { pointer: [0.3645833432674408, 0.7972221970558167], follow: [765.0, 219.0] },
    { pointer: [0.5145833492279053, 0.7916666865348816], follow: [981.0, 225.0] },
  ],
};

const close = (actual: readonly number[], expected: readonly number[], tolerance: number, label = "") =>
  expected.forEach((value, i) =>
    expect(Math.abs(actual[i] - value), `${label}[${i}] ${actual[i]} vs ${value}`).toBeLessThanOrEqual(tolerance),
  );

describe("sceneCursor（P4c 步骤 2）", () => {
  it("fill：1920×800、1440×1080 窗口下等于 WPE 投影里的居中盖满裁切，跟随点和实测吻合", () => {
    for (const [size, samples] of Object.entries(MEASURED)) {
      const [w, h] = size.split("x").map(Number);
      const placement = scenePlacement("fill", 1920, 1080, w, h);
      for (const { pointer, follow } of samples) {
        const ours = pointerScenePoint(VP_1080, sceneCursor("fill", placement, w, h, ...pointer));
        // 同一串反投影直接用 WPE 的 P·V（窗口指针）：只差 float 舍入
        close(ours, pointerScenePoint(WPE_VP[size], pointer), 1e-3, `${size} WPE P·V`);
        close(ours, follow, 0.05, `${size} 实测`);
        // 朴素的 px·1920、(1 − py)·1080 差十几到几十像素（补测：12–45）
        const naive = pointerScenePoint(VP_1080, pointer);
        expect(Math.max(Math.abs(naive[0] - follow[0]), Math.abs(naive[1] - follow[1])), size).toBeGreaterThan(5);
      }
    }
  });

  it("fill：窗口和场景同比例时就是窗口坐标（WPE 铺满时 X = px·W、Y = (1 − py)·H）", () => {
    const placement = scenePlacement("fill", 1920, 1080, 1920, 1080);
    expect(sceneCursor("fill", placement, 1920, 1080, 0.2958333194255829, 0.6787037253379822)).toEqual([
      0.2958333194255829, 0.6787037253379822,
    ]);
    // 场景宽于窗口：裁左右，光标在窗口最左边对着场景的 (1 − scale) / 2
    const wide = scenePlacement("fill", 2200, 1080, 1920, 1080);
    close(sceneCursor("fill", wide, 1920, 1080, 0, 0.5), [(1 - 1920 / 2200) / 2, 0.5], 1e-12);
  });

  it("fit：画面内是光标下的点，留白处线性外推到 0…1 之外", () => {
    const pillar = scenePlacement("fit", 1000, 1000, 2000, 1000);
    close(sceneCursor("fit", pillar, 2000, 1000, 0.5, 0.5), [0.5, 0.5], 1e-12);
    close(sceneCursor("fit", pillar, 2000, 1000, 0.25, 0), [0, 0], 1e-12);
    close(sceneCursor("fit", pillar, 2000, 1000, 0.75, 1), [1, 1], 1e-12);
    // 左边留白宽 500：画布最左边是场景 u = −0.5，线性外推、不钳制
    close(sceneCursor("fit", pillar, 2000, 1000, 0, 0.5), [-0.5, 0.5], 1e-12);
    close(sceneCursor("fit", pillar, 2000, 1000, 1, 0.5), [1.5, 0.5], 1e-12);
    // 反投影后同样外推：场景 1000×1000，u = −0.5 是 x = −500
    close(pointerScenePoint(sceneViewProjection({ width: 1000, height: 1000 }), [-0.5, 0.25]), [-500, 750], 1e-3);
  });

  it("center：一个场景像素对一个布局 CSS 像素，场景大于画布时只看到中间", () => {
    const large = scenePlacement("center", 4000, 2000, 2000, 1000);
    close(sceneCursor("center", large, 2000, 1000, 0, 0), [0.25, 0.25], 1e-12);
    close(sceneCursor("center", large, 2000, 1000, 1, 1), [0.75, 0.75], 1e-12);
    // 场景小于画布：四周留白，外推
    const small = scenePlacement("center", 800, 600, 1920, 1080);
    close(sceneCursor("center", small, 1920, 1080, 560 / 1920, 240 / 1080), [0, 0], 1e-12);
    close(sceneCursor("center", small, 1920, 1080, 0, 0), [-560 / 800, -240 / 600], 1e-12);
  });

  it("stretch：恒等（逐位）", () => {
    const whole = scenePlacement("stretch", 1000, 1000, 1920, 1080);
    expect(sceneCursor("stretch", whole, 1920, 1080, 0.123456789, 1.75)).toEqual([0.123456789, 1.75]);
  });

  it("tile：取所在那一块（取小数部分）", () => {
    const tile = scenePlacement("tile", 1000, 1000, 2000, 1000);
    close(sceneCursor("tile", tile, 2000, 1000, 0, 0.5), [0.5, 0.5], 1e-12);
    close(sceneCursor("tile", tile, 2000, 1000, 0.5, 0.5), [0.5, 0.5], 1e-12);
    close(sceneCursor("tile", tile, 2000, 1000, 0.875, 0.25), [0.25, 0.25], 1e-12);
    // 不取小数时会是 −0.5、1.25
    for (const x of [0, 0.125, 0.875, 1]) {
      const [u] = sceneCursor("tile", tile, 2000, 1000, x, 0.5);
      expect(u >= 0 && u < 1, String(x)).toBe(true);
    }
  });

  it("scenePointer（g_PointerPosition）逐位不变：fill / stretch 原样，其余样式等于 sceneCursor", () => {
    // 改动前的写法，逐位比较
    const before = (
      style: SceneStyle,
      placement: ReturnType<typeof scenePlacement>,
      w: number,
      h: number,
      x: number,
      y: number,
    ) => {
      if (style === "fill" || style === "stretch") return [x, y];
      const [left, top, width, height] = placement.rect;
      const u = placement.offset[0] + ((x * w - left) / width) * placement.scale[0];
      const v = placement.offset[1] + ((y * h - top) / height) * placement.scale[1];
      return style === "tile" ? [u - Math.floor(u), v - Math.floor(v)] : [u, v];
    };
    const styles: SceneStyle[] = ["fill", "fit", "stretch", "center", "tile"];
    for (const style of styles)
      for (const [w, h] of [
        [1920, 800],
        [1440, 1080],
        [333, 777],
      ]) {
        const placement = scenePlacement(style, 1920, 1080, w, h, 1.5);
        for (const [x, y] of [
          [0.1, 0.9],
          [0.6401041746139526, 0.5425000190734863],
          [-0.3, 1.7],
        ]) {
          const pointer = scenePointer(style, placement, w, h, x, y);
          expect(pointer, `${style} ${w}x${h}`).toEqual(before(style, placement, w, h, x, y));
          if (style !== "fill") expect(pointer).toEqual(sceneCursor(style, placement, w, h, x, y));
        }
      }
    // fill 下两者不同：g_PointerPosition 仍是窗口坐标（P2a），跟随点是光标下的场景点
    const crop = scenePlacement("fill", 1920, 1080, 1920, 800);
    expect(scenePointer("fill", crop, 1920, 800, 0.5, 0.25)).toEqual([0.5, 0.25]);
    expect(sceneCursor("fill", crop, 1920, 800, 0.5, 0.25)[1]).not.toBeCloseTo(0.25, 3);
  });
});

// 矩阵按 WPE 的 float32 顺序（phase-f32-matrix.md 点 2；读码 rea-matrix-order 2.2、3.1、3.2）
describe("layerLocalMatrix：照 WPE 按元素填", () => {
  const plusZero = (m: ArrayLike<number>) => Array.from(m, (v) => v + 0);
  it("角度为 0 时等于 diag(scale) + origin（−0 视同 0）", () => {
    const m = layerLocalMatrix({ origin: [12.5, -7, 3], angles: [0, 0, 0], scale: [2, 0.5, 4] });
    expect(plusZero(m)).toEqual([2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 4, 0, 12.5, -7, 3, 1]);
  });
  it("scale.z 为 0 时按 1（P1 兜底保留）", () => {
    const m = layerLocalMatrix({ origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 0] });
    expect(m[10]).toBe(1);
  });
  it("三轴旋转时和旧的连乘结果差 ≤ 2 ulp（量级按 1 算）", () => {
    const cases = [
      { origin: [100, 50, 7], angles: [0.2, 0.3, 0.4], scale: [1, 1, 1] },
      { origin: [-30, 800, 0], angles: [-1.1, 0.7, 2.5], scale: [2, 3, 0.5] },
      { origin: [0, 0, 0], angles: [0.5, -0.9, 0.1], scale: [0.67623, 0.72657, 1] },
    ];
    for (const layer of cases) {
      const [x, y, z] = layer.origin;
      const [ax, ay, az] = layer.angles;
      const [sx, sy, sz] = layer.scale;
      const old = multiply(
        multiply(multiply(multiply(translation(x, y, z), rotationZ(az)), rotationY(ay)), rotationX(ax)),
        scaling(sx, sy, sz),
      );
      const now = layerLocalMatrix(layer);
      for (let i = 0; i < 16; i++) {
        const tolerance = 2 * 2 ** -23 * Math.max(1, Math.abs(old[i]), Math.abs(now[i]));
        expect(Math.abs(now[i] - old[i]), `[${i}] ${now[i]} vs ${old[i]}`).toBeLessThanOrEqual(tolerance);
      }
    }
  });
});

describe("sceneViewProjection：缩放照帧函数的三步 f32（rea-matrix-order 2.2）", () => {
  it("zoom 1 逐位等于 orthographic", () => {
    const p = sceneViewProjection({ width: 3840, height: 2130 });
    const ortho = orthographic(0, 3840, 0, 2130, 2000, -2000);
    expect(Array.from(p)).toEqual(Array.from(ortho));
    expect(Array.from(sceneViewProjection({ width: 3840, height: 2130 }, 1))).toEqual(Array.from(ortho));
  });
  it("zoom 1.5 时线性项 = f32(z)·f32(2/W)（P5a 步骤 4 的 WPE 实测 0.0015625001396983862）", () => {
    const f = Math.fround;
    const p = sceneViewProjection({ width: 1920, height: 1080 }, 1.5);
    expect(p[0]).toBe(f(f(1.5) * f(2 / 1920)));
    expect(p[0]).toBe(0.0015625001396983862);
    expect(p[5]).toBe(f(f(1.5) * f(2 / 1080)));
    expect(p[5]).toBe(0.00277777761220932);
  });
});
