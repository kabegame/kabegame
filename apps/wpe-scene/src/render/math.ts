/**
 * 场景渲染用的最小 4×4 矩阵工具。
 *
 * 约定与翻译器一致（`src-tauri/wpesl2wgsl/README.md`）：WPESL 的 `mul(v, M)` 被改写成 `M * v`，
 * 所以缓冲里放的是「列向量」约定下的数学矩阵，按 **列主序** 存（与 glm 的 `value_ptr`、WGSL `mat4x4<f32>` 相同）：
 * `m[c * 4 + r]` 是第 c 列第 r 行。裁剪空间按 WebGPU：y 向上、深度 0…1。
 */

export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** `a * b`（先作用 b，再作用 a）。 */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** 绕 x 轴旋转（弧度，右手系）：数学矩阵 `[[1, 0, 0], [0, c, −s], [0, s, c]]`。 */
export function rotationX(radians: number): Mat4 {
  const m = identity();
  const c = Math.cos(radians),
    s = Math.sin(radians);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

/** 绕 y 轴旋转（弧度，右手系）：数学矩阵 `[[c, 0, s], [0, 1, 0], [−s, 0, c]]`。 */
export function rotationY(radians: number): Mat4 {
  const m = identity();
  const c = Math.cos(radians),
    s = Math.sin(radians);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** 绕 z 轴逆时针旋转（弧度，y 向上的右手系）：数学矩阵 `[[c, −s, 0], [s, c, 0], [0, 0, 1]]`。 */
export function rotationZ(radians: number): Mat4 {
  const m = identity();
  const c = Math.cos(radians),
    s = Math.sin(radians);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/**
 * 正交投影（右手系、看向 −z，同 glm `orthoRH_ZO`）：x ∈ [left, right] → [−1, 1]，y ∈ [bottom, top] → [−1, 1]，
 * 视空间 z ∈ [−far, −near] → 深度 [0, 1]。
 */
export function orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number) {
  const m = new Float32Array(16);
  m[0] = 2 / (right - left);
  m[5] = 2 / (top - bottom);
  m[10] = -1 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -near / (far - near);
  m[15] = 1;
  return m;
}

/** 一般 4×4 求逆（余子式展开）；奇异矩阵返回 null。 */
export function invert(m: Mat4): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10,
    b01 = a00 * a12 - a02 * a10,
    b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11,
    b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30,
    b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31,
    b10 = a21 * a33 - a23 * a31,
    b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const d = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}

/** `m * (x, y, z, 1)`，返回齐次坐标。 */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/** `fastInverseSqrt` 的位转换用的 4 字节暂存。 */
const FLOAT_BITS = new DataView(new ArrayBuffer(4));

/**
 * WPE 的快速倒数平方根（rea-p5-mesh 2.3）：魔数 `0x5f375a86` 给初值，再一次牛顿迭代，全程 float32。迭代照 Quake 的写法
 * `y · (1.5 − (0.5x · y) · y)`（C 的 `x2 * y * y` 左结合）：`p5c-matrix` 三个模型的 `g_NormalModelMatrix` 27 个值逐位相同；换成
 * `0.5x · (y · y)` 或 `1.5y − …` 的结合方式有 1 ulp 的差（`ignore/p5/c2/nmm_variants.mjs`）。x 为 0 时得到一个很大的有限数，
 * 乘回 0 分量仍是 0，不出 NaN（同 WPE）。
 */
export function fastInverseSqrt(x: number): number {
  const f = Math.fround;
  FLOAT_BITS.setFloat32(0, x, true);
  FLOAT_BITS.setUint32(0, (0x5f375a86 - (FLOAT_BITS.getUint32(0, true) >>> 1)) >>> 0, true);
  const y = FLOAT_BITS.getFloat32(0, true);
  return f(y * f(1.5 - f(f(f(0.5 * x) * y) * y)));
}

/**
 * 法线矩阵（`g_NormalModelMatrix`，P5c 步骤 2）：不是逆转置，是世界矩阵左上 3×3 的三个本地轴（列主序的三列，WPE 内存里的三行）各自
 * 归一化（rea-p5-mesh 2.3，`0x1400d8840`）。长度平方按 float32 逐项累加，乘 `fastInverseSqrt`，结果取 float32。p5-REPORT「P5c 语义的
 * 实测核对」：`p5c-matrix` 三个模型（3D 旋转、非均匀缩放、挂在带变换的父层下）逐位相同；精确归一化差 0.9e-3–1.7e-3（就是快速倒数平方根
 * 的误差），逆转置差 0.4–0.67。WPE 的 uniform 写入函数是所有对象共用的，图像层光照路径（`genericimage2/3/4`）读到的也是它。
 * 列主序 9 个数。
 */
export function normalMatrix(m: Mat4): number[] {
  const f = Math.fround;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const x = m[c * 4],
      y = m[c * 4 + 1],
      z = m[c * 4 + 2];
    const k = fastInverseSqrt(f(f(f(x * x) + f(y * y)) + f(z * z)));
    out.push(f(x * k), f(y * k), f(z * k));
  }
  return out;
}
