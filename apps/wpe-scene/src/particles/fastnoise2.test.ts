/**
 * P4d 步骤 4b：`remapvalue` 的 FastNoise2 噪声（`fastnoise2.ts`）与 `remapinitialvalue` 的 `fbm1`（`noise.ts`）。
 * - 已知值取步骤 0 的 Python 移植 `ignore/p4/d0/fastnoise2.py` 的输出（已和 rv-noise 实测对上），由 `ignore/p4/d4b/fn2_values.py` 算出、
 *   原样抄在这里（`[种子, x, y, 结果]`），覆盖负坐标、跨格、y0 与 x0 的两种大小、种子回绕与 R 的三种种子。
 * - 倍频与归一按 rea-p4d-modules.md 2.5、2.9 的式子逐步 float32 写出期望（不读产品代码的中间量）。
 */
import { describe, expect, it } from "vitest";
import { fbm2, fractalBounding, simplex2 } from "./fastnoise2";
import { fbm1, snoise1 } from "./noise";

const f32 = Math.fround;
const bitsOf = (x: number) => new Int32Array(new Float32Array([x]).buffer)[0];
/** rv-noise 第 921 帧第一个粒子的 frame（`R`）。 */
const R = 0.1783294677734375;

/** fn2_values.py 的 simplex2 输出。 */
const SIMPLEX: [number, number, number, number][] = [
  [0, 0.0, 0.0, 0.0],
  [1337, 0.5, 0.25, 0.3911823034286499],
  [1043766272, 1.2339999675750732, 0.0, 0.6131976246833801],
  [890222765, 1.2339999675750732, 0.0, -0.6665222644805908],
  [1997279875, 1.2339999675750732, 0.0, 0.38788095116615295],
  [12345, -3.700000047683716, 0.0, 0.5019945502281189],
  [-1, -0.30000001192092896, -2.9000000953674316, -0.17492759227752686],
  [7, 0.7300000190734863, 0.0, -0.7409238219261169],
  [7, 0.7400000095367432, 0.0, -0.7620591521263123],
  [5, 0.20000000298023224, 0.6000000238418579, -0.3431723713874817],
  [5, 0.6000000238418579, 0.20000000298023224, 0.5273056030273438],
  [2147483647, 2.5, 0.0, -0.7971199750900269],
  [-2147483648, 2.5, 0.0, -0.5152724385261536],
  [99, 1000.3699951171875, 0.0, 0.49007928371429443],
  [99, -12345.677734375, 0.0, 0.5642107129096985],
  [42, 3.0, 0.0, 0.4393031895160675],
];

/** fn2_values.py 的 fbm2 输出（`[种子, x, y, octaves, 结果]`）。 */
const FBM: [number, number, number, number, number][] = [
  [1043766272, 1.2339999675750732, 0.0, 0, 0.6131976246833801],
  [1043766272, 1.2339999675750732, 0.0, 1, 0.6131976246833801],
  [1043766272, 1.2339999675750732, 0.0, 2, 0.5074140429496765],
  [1043766272, 1.2339999675750732, 0.0, 3, 0.3329288363456726],
  [1043766272, -7.25, 0.0, 5, -0.30283674597740173],
  [2147483647, 0.3700000047683716, 0.0, 3, -0.3880676031112671],
  [123, 0.3700000047683716, 0.800000011920929, 4, -0.002445608377456665],
];

describe("FastNoise2 Simplex 2D（rea 2.9）", () => {
  it("和步骤 0 的 Python 移植逐位相同（负坐标、跨格、两种单形、种子回绕、R 的三种种子）", () => {
    for (const [seed, x, y, value] of SIMPLEX) expect(simplex2(seed, x, y), `${seed} ${x} ${y}`).toBe(value);
  });

  it("R 的三种种子：x 是 R 的位，y、z 异或 0x0b3924ad、0x493a8e83", () => {
    const bits = bitsOf(R);
    expect(bits).toBe(1043766272);
    expect(bits ^ 0x0b3924ad).toBe(890222765);
    expect(bits ^ 0x493a8e83).toBe(1997279875);
  });

  it("结果有界、种子不同结果不同", () => {
    let max = 0;
    for (let i = 0; i < 2000; i++) {
      const x = f32(-50 + i * 0.0517);
      max = Math.max(max, Math.abs(simplex2(i * 7919, x, f32(i * 0.013))));
    }
    expect(max).toBeLessThan(1.01);
    expect(simplex2(1, 1.234, 0)).not.toBe(simplex2(2, 1.234, 0));
  });
});

describe("FastNoise2 FBm（rea 2.9）", () => {
  it("和步骤 0 的 Python 移植逐位相同（octaves 0 / 1 只算一层，第二层的种子从 2³¹ − 1 回绕）", () => {
    for (const [seed, x, y, octaves, value] of FBM)
      expect(fbm2(seed, x, y, octaves), `${seed} ${x} ${y} ${octaves}`).toBe(value);
  });

  it("归一系数：1/(1 + 0.5 + … 共 octaves 项)，octaves ≤ 1 时为 1", () => {
    expect([0, 1, 2, 3, 5].map(fractalBounding)).toEqual([1, 1, f32(1 / 1.5), f32(1 / 1.75), f32(1 / 1.9375)]);
  });

  it("倍频：种子 +1、坐标 ×2、振幅 ×0.5（从归一系数起），逐层累加", () => {
    const seed = 777;
    const x = f32(0.83);
    const y = f32(-0.4);
    const bounding = f32(1 / 1.75);
    const n0 = simplex2(seed, x, y);
    const a1 = f32(f32(bounding * 1) * 0.5);
    const n1 = simplex2(seed + 1, f32(x * 2), f32(y * 2));
    const a2 = f32(f32(a1 * 1) * 0.5);
    const n2 = simplex2(seed + 2, f32(x * 4), f32(y * 4));
    const expected = f32(f32(f32(n0 * bounding) + f32(n1 * a1)) + f32(n2 * a2));
    expect(fbm2(seed, x, y, 3)).toBe(expected);
    // 只差一个种子、不归一、不倍频的写法都不同
    expect(fbm2(seed, x, y, 3)).not.toBe(f32(f32(f32(n0 * 1) + f32(n1 * 0.5)) + f32(n2 * 0.25)));
    expect(fbm2(seed, x, y, 2)).toBe(f32(f32(n0 * f32(1 / 1.5)) + f32(n1 * f32(f32(1 / 1.5) * 0.5))));
  });

  it("octaves 很大时提前停下，和照常走完逐位相同（坐标非零溢出成 NaN，坐标很小时振幅先下溢、仍要走到溢出；坐标为 0 时收敛）", () => {
    // 照常走完：rea 2.9 的伪代码原样
    const naive = (seed: number, x: number, y: number, octaves: number) => {
      let total = 1;
      let g = 0.5;
      for (let i = 1; i < octaves; i++) {
        total = f32(total + g);
        g = f32(g * 0.5);
      }
      let n = simplex2(seed, x, y);
      let amp = f32(1 / total);
      let sum = f32(n * amp);
      for (let i = 1; i < octaves; i++) {
        x = f32(x * 2);
        y = f32(y * 2);
        seed = (seed + 1) | 0;
        amp = f32(f32(amp * f32(f32(f32(f32(f32(n + 1) * 0.5) - 1) * 0) + 1)) * 0.5);
        n = simplex2(seed, x, y);
        sum = f32(sum + f32(n * amp));
      }
      return f32(f32(sum * 0.5) + 0.5);
    };
    const ours = (seed: number, x: number, y: number, octaves: number) =>
      f32(f32(fbm2(seed, x, y, octaves) * 0.5) + 0.5);
    for (const octaves of [24, 150, 200, 300, 600])
      for (const [x, y] of [
        [0, 0],
        [f32(0.37), 0],
        [f32(-12.5), f32(0.25)],
        // 振幅约 150 层下溢成 0，坐标要约 230 层才溢出：中间这段不能停
        [f32(1e-30), 0],
      ])
        expect(ours(5, x, y, octaves), `${octaves} ${x} ${y}`).toBe(naive(5, x, y, octaves));
    expect(Number.isNaN(naive(5, f32(1e-30), 0, 300))).toBe(true);
    expect(Number.isNaN(fbm2(5, f32(0.37), 0, 2 ** 32))).toBe(true);
    expect(Number.isNaN(fbm2(5, f32(1e-30), 0, 2 ** 32))).toBe(true);
    expect(ours(5, 0, 0, 2 ** 32)).toBe(naive(5, 0, 0, 600));
    expect(fractalBounding(2 ** 32)).toBe(f32(1 / naiveTotal(600)));
  });
});

/** 归一系数的分母照常累加 n 项。 */
function naiveTotal(n: number): number {
  let total = 1;
  let g = 0.5;
  for (let i = 1; i < n; i++) {
    total = f32(total + g);
    g = f32(g * 0.5);
  }
  return total;
}

describe("fbm1（remapinitialvalue 的 fbmnoise，FUN_14027b4b0）", () => {
  it("频率从 s 起 ×2、振幅从 1 起 ×0.5，除以实际的振幅和；没有种子", () => {
    const v = f32(0.37);
    const s = 10;
    const n = [0, 1, 2].map((i) => snoise1(f32(f32(s * 2 ** i) * v)));
    const sum = f32(f32(f32(0 + f32(n[0] * 1)) + f32(n[1] * 0.5)) + f32(n[2] * 0.25));
    expect(fbm1(v, s, 3)).toBe(f32(sum / 1.75));
    expect(fbm1(v, s, 1)).toBe(snoise1(f32(s * v)));
    expect(fbm1(v, s, 2)).toBe(f32(f32(f32(n[0] * 1) + f32(n[1] * 0.5)) / 1.5));
    // 和 FastNoise2 的归一（先乘归一系数）不是一回事：这里 Σ a·n / Σ a
    expect(fbm1(v, s, 3)).not.toBe(
      f32(f32(f32(n[0] * f32(1 / 1.75)) + f32(n[1] * f32(0.5 / 1.75))) + f32(n[2] * f32(0.25 / 1.75))),
    );
  });

  it("octaves = 0 时 0/0 得 NaN；整数输入时 snoise1 为 0", () => {
    expect(Number.isNaN(fbm1(0.5, 2, 0))).toBe(true);
    expect(fbm1(1, 2, 1)).toBe(0);
  });

  it("octaves 很大时提前停下，和照常走完逐位相同", () => {
    const naive = (v: number, s: number, octaves: number) => {
      let sum = 0;
      let total = 0;
      let f = s;
      let a = 1;
      for (let i = 0; i < octaves; i++) {
        const n = snoise1(f32(f * v));
        total = f32(total + a);
        f = f32(f * 2);
        sum = f32(sum + f32(n * a));
        a = f32(a * 0.5);
      }
      return f32(f32(f32(sum / total) * 0.5) + 0.5);
    };
    const ours = (v: number, s: number, octaves: number) => f32(f32(fbm1(v, s, octaves) * 0.5) + 0.5);
    for (const octaves of [30, 150, 200, 400, 700])
      for (const [v, s] of [
        [f32(0.37), 10],
        [0, 10],
        [f32(0.37), 0],
        // 振幅约 150 层下溢成 0，频率要约 230 层才溢出：中间这段不能停
        [f32(0.37), f32(1e-30)],
      ])
        expect(ours(v, s, octaves), `${octaves} ${v} ${s}`).toBe(naive(v, s, octaves));
    expect(Number.isNaN(naive(f32(0.37), f32(1e-30), 400))).toBe(true);
    expect(ours(f32(0.37), 0, 2 ** 32)).toBe(naive(f32(0.37), 0, 700));
    expect(Number.isNaN(fbm1(f32(0.37), 10, 2 ** 32))).toBe(true);
    expect(Number.isNaN(fbm1(f32(0.37), f32(1e-30), 2 ** 32))).toBe(true);
  });
});
