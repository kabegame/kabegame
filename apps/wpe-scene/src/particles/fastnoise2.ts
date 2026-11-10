/**
 * `remapvalue` 的两种噪声（P4d 步骤 4b）：WPE 2.8.42 内嵌的 FastNoise2 二维 `Simplex` 与 `FractalFBm`，逐位移植。依据
 * `.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md` 2.9（读码【确】），汇编原件 `ignore/p4/rea/p4d-mod/noise2_sse4.asm`
 * （槽 1，`0x1400fbe90`）、`fbm2_sse4.asm`（槽 4，`0x1400fbc70`）、归一系数（槽 3，`0x1400fb740`，在 `ignore/p4/rea/wp.asm`）。
 * 步骤 0 的 Python 移植 `ignore/p4/d0/fastnoise2.py` 已和实测对上（rv-noise 三分量残差 ≤ 4e-4），单测的已知值取它的输出
 * （`ignore/p4/d4b/fn2_values.py`）。
 *
 * - 全局噪声对象启动时按 CPUID 建（SSE4.1 / SSE2 两套虚表），字段 gain 0.5、weighted strength 0、lacunarity 2.0，之后不写；这里照 SSE4.1
 *   版写（SSE2 版的取整与整数乘写法不同，`|x| < 2³¹` 时结果应相同，rea 2.9【推】）。
 * - 编译时没有 FMA：`a·b + c` 是先乘后加，每一步 `Math.fround`；整数是 32 位回绕（`Math.imul`、`| 0`）。
 * - 取整是 `roundps` 向下（`Math.floor`，float32 的 floor 仍是 float32），转整数是 `cvtps2dq`：越界与 NaN 得 `0x80000000`
 *   （Python 移植用任意精度整数，`|floor| ≥ 2³¹` 时和这里不同，那里的结果不作数）。
 *
 * remapvalue 的调用（rea 2.5、2.9）：`x = v·s`、`y = 0`，种子是每粒子 `R` 的位（y、z 分量另异或两个常量，在 `remap.ts`）。
 */
import { f32 } from "./f32";

const bitsView = new DataView(new ArrayBuffer(4));
/** float32 位模式 → 数值。 */
function fromBits(bits: number): number {
  bitsView.setUint32(0, bits);
  return bitsView.getFloat32(0);
}

/** 斜切系数 `F2 = (√3 − 1)/2`（`0x3ebb67ae`）。 */
const F2 = fromBits(0x3ebb67ae);
/** 反斜切 `G2 = (3 − √3)/6`（`0x3e58658c`）。 */
const G2 = fromBits(0x3e58658c);
/** 第三个角的偏移 `2·G2 − 1`（`0xbf13cd3a`）。 */
const G2_CORNER2 = fromBits(0xbf13cd3a);
/** `HashPrimes` 的两个素数（`0x1dde90c9`、`0x43c42e4d`）。 */
const PRIME_X = 501125321;
const PRIME_Y = 1136930381;
/** 哈希乘数（`0x27d4eb2d`）。 */
const HASH_MULTIPLIER = 0x27d4eb2d;
/** 梯度的 `1 + √2`（`0x401a827a`）。 */
const ROOT2_PLUS_1 = fromBits(0x401a827a);
/** 输出缩放（`0x4219227f`）。 */
const SIMPLEX2_SCALE = fromBits(0x4219227f);
/** 全局噪声对象的三个字段（`0x14000c646` 建对象时写，rea 2.9）。 */
const GAIN = 0.5;
const WEIGHTED_STRENGTH = 0;
const LACUNARITY = 2;
const INT_INDEFINITE = -2147483648;

/** `cvtps2dq`（输入已是整数值）：越界与 NaN 得 `0x80000000`。 */
function toInt32(x: number): number {
  return x >= -2147483648 && x < 2147483648 ? x : INT_INDEFINITE;
}

/** `GetHash`：`H = ((b ^ a) ^ seed)·0x27d4eb2d`，再 `H ^= H >> 15`（算术右移）。`a`、`b` 是已乘过素数的格坐标。 */
function hash(seed: number, a: number, b: number): number {
  const h = Math.imul(b ^ a ^ seed, HASH_MULTIPLIER);
  return (h >> 15) ^ h;
}

/**
 * `GetGradientDot`：bit0 翻 x 的符号、bit1 翻 y 的符号（`xorps` 符号位），bit2 交换两者，返回 `(1 + √2)·a + b`（先乘后加）。
 */
function gradientDot(h: number, x: number, y: number): number {
  const gx = h & 1 ? -x : x;
  const gy = h & 2 ? -y : y;
  const swap = (h & 4) !== 0;
  const a = swap ? gy : gx;
  const b = swap ? gx : gy;
  return f32(f32(ROOT2_PLUS_1 * a) + b);
}

/** 一个角的衰减 `t = max(0, (0.5 − y²) − x²)`，再平方两次（`maxps t, 0`：t 为 NaN 时得 0）。 */
function falloff(x: number, y: number): number {
  const raw = f32(f32(0.5 - f32(y * y)) - f32(x * x));
  const t = raw > 0 ? raw : 0;
  const t2 = f32(t * t);
  return f32(t2 * t2);
}

/**
 * FastNoise2 `Simplex` 2D（槽 1，`0x1400fbe90`，rea 2.9）：
 * ```
 * f  = (x + y)·F2;  xs = floor(x + f);  ys = floor(y + f)
 * i  = int(xs)·PX;  j = int(ys)·PY                       // 32 位回绕乘
 * g  = (ys + xs)·G2;  x0 = x − (xs − g);  y0 = y − (ys − g)
 * m  = y0 < x0
 * x1 = (x0 − m) + G2;  y1 = (y0 − !m) + G2;  x2 = x0 + (2·G2 − 1);  y2 = y0 + (2·G2 − 1)
 * h0 = hash(i, j);  h1 = hash(i + (m ? PX : 0), j + (m ? 0 : PY));  h2 = hash(i + PX, j + PY)
 * return 38.2836876·(g0·t0 + (g1·t1 + g2·t2))
 * ```
 * 结果约在 [−1, 1]；输入是 float32。
 */
export function simplex2(seed: number, x: number, y: number): number {
  const f = f32(f32(x + y) * F2);
  const xs = Math.floor(f32(x + f));
  const ys = Math.floor(f32(y + f));
  const i = Math.imul(toInt32(xs), PRIME_X);
  const j = Math.imul(toInt32(ys), PRIME_Y);
  const g = f32(f32(ys + xs) * G2);
  const x0 = f32(x - f32(xs - g));
  const y0 = f32(y - f32(ys - g));
  // `cmpltps y0, x0`：NaN 时为假
  const m = y0 < x0;
  const x1 = f32(f32(x0 - (m ? 1 : 0)) + G2);
  const y1 = f32(f32(y0 - (m ? 0 : 1)) + G2);
  const x2 = f32(x0 + G2_CORNER2);
  const y2 = f32(y0 + G2_CORNER2);
  const h0 = hash(seed, i, j);
  const h1 = hash(seed, (i + (m ? PRIME_X : 0)) | 0, (j + (m ? 0 : PRIME_Y)) | 0);
  const h2 = hash(seed, (i + PRIME_X) | 0, (j + PRIME_Y) | 0);
  const n0 = f32(gradientDot(h0, x0, y0) * falloff(x0, y0));
  const n1 = f32(gradientDot(h1, x1, y1) * falloff(x1, y1));
  const n2 = f32(gradientDot(h2, x2, y2) * falloff(x2, y2));
  return f32(SIMPLEX2_SCALE * f32(n0 + f32(n1 + n2)));
}

/**
 * FBm 的归一系数（槽 3，`0x1400fb740`，解析期算好存 `rec+0x110`）：`1/(1 + g + g² + …)` 共 `octaves` 项，`divss`；`octaves ≤ 1`
 * （无符号）时为 1。逐项 float32 累加；`g^k` 下溢成 0 之后各项都是 0，提前停下结果相同（只为 `octaves` 很大时不空转）。
 */
export function fractalBounding(octaves: number): number {
  let total = 1;
  let amp = GAIN;
  for (let i = 1; i < octaves && amp !== 0; i++) {
    total = f32(total + amp);
    amp = f32(amp * GAIN);
  }
  return f32(1 / total);
}

/**
 * FastNoise2 `FractalFBm`（槽 4，`0x1400fbc70`，rea 2.9）：
 * ```
 * n = simplex2(seed, x, y);  amp = bounding;  sum = n·amp
 * for i in 1 .. octaves − 1:                      // 无符号比较；octaves ≤ 1 只算一层
 *     x = x·2;  y = y·2;  seed = seed + 1         // 32 位回绕
 *     amp = (amp·((((n + 1)·0.5) − 1)·0 + 1))·0.5  // weighted strength 0：乘 1（n 非有限时是 NaN）
 *     n = simplex2(seed, x, y);  sum = sum + n·amp
 * return sum
 * ```
 * `octaves` 是解析值（`transformoctaves`，`asUInt` 不钳制，可以很大）。两种提前停下和走完逐位相同（不计零的符号，之后的 `·0.5 + 0.5`
 * 抹掉它）：`sum` 成了 NaN 之后一直是 NaN；`amp` 下溢成 0、坐标又是 (0, 0) 时之后每层只加 ±0。坐标非零时每层翻倍，至多约 280 层就溢出
 * 成 inf、`n` 得 NaN，所以循环次数有界。
 */
export function fbm2(seed: number, x: number, y: number, octaves: number): number {
  let n = simplex2(seed, x, y);
  let amp = fractalBounding(octaves);
  let sum = f32(n * amp);
  let s = seed | 0;
  let px = x;
  let py = y;
  for (let i = 1; i < octaves; i++) {
    px = f32(px * LACUNARITY);
    py = f32(py * LACUNARITY);
    s = (s + 1) | 0;
    const weight = f32(f32(f32(f32(f32(n + 1) * 0.5) - 1) * WEIGHTED_STRENGTH) + 1);
    amp = f32(f32(amp * weight) * GAIN);
    n = simplex2(s, px, py);
    sum = f32(sum + f32(n * amp));
    if (Number.isNaN(sum)) break;
    if (amp === 0 && px === 0 && py === 0) break;
  }
  return sum;
}
