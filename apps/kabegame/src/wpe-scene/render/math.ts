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

/** 绕 z 轴逆时针旋转（弧度，y 向上的右手系）。 */
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

/** 法线矩阵：左上 3×3 的逆转置，列主序 9 个数；不可逆时退回单位阵。 */
export function normalMatrix(m: Mat4): number[] {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (!det || !Number.isFinite(det)) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = 1 / det;
  // 逆矩阵的转置 = 余子式矩阵 / det（列主序直接按余子式排）
  return [
    (e * i - f * h) * k,
    (f * g - d * i) * k,
    (d * h - e * g) * k,
    (c * h - b * i) * k,
    (a * i - c * g) * k,
    (b * g - a * h) * k,
    (b * f - c * e) * k,
    (c * d - a * f) * k,
    (a * e - b * d) * k,
  ];
}
