/**
 * puppet 的 float32 数学（P12a 步骤 1、2）：编译期（逆绑定、静止姿势、欧拉转四元数）与运行时（`pose.ts`）共用的一份。纯 TS。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/rea-p12-runtime.md` 第 1.1、1.3、4–7 节（读码），参考实现
 * `ignore/p12/rea/runtime/posemodel.py`（和 WPE 抓到的 `g_Bones` 逐帧对到 1.9e-6，p12-REPORT 用例 1–3）。
 * - 全程 float32：每一步运算后 `Math.fround`，加法的结合顺序照读码（同 python 模型），乘法、加法本身可交换，只有分组影响舍入；
 * - 矩阵一律是 glm 的列主序、列向量约定（`v' = M·v`），16 个数，第 c 列在 `[4c .. 4c+3]`，平移在 `[12..14]`；
 * - 四元数在内存里按 **w x y z**（`GLM_FORCE_QUAT_DATA_WXYZ`，rea-RT「结构的叫法」）。
 * 函数都按「数组 + 偏移」读写，不分配内存（编译期的少数函数例外，见各自说明）。
 */

const f = Math.fround;

/** 位转换用的一格（快速倒数平方根）。 */
const bitsF = new Float32Array(1);
const bitsU = new Uint32Array(bitsF.buffer);

/**
 * 快速倒数平方根（`FUN_140214eb0`，rea-RT 7）：魔数 `0x5f375a86` 加一次牛顿迭代，相对误差可达 0.175%。只用于静止姿势的分解，所以单位
 * 旋转的静止四元数是 `(0.99936533, 0, 0, 0)`，不是单位长度（rea-RT 7；`3203778110` 的 `blend 0.58` / `0.21` 两层据此逐位对上）。
 * 运算顺序照 python 模型：`t = ((n2·0.5)·y)·y`，结果 `(1.5 − t)·y`。
 */
export function fastInvSqrt(n2: number): number {
  bitsF[0] = n2;
  bitsU[0] = (0x5f375a86 - (bitsU[0] >>> 1)) >>> 0;
  const y = bitsF[0];
  const t = f(f(f(n2 * 0.5) * y) * y);
  return f(f(1.5 - t) * y);
}

/**
 * 采样与混合的归一化（`0x1401f8df1`，rea-RT 4、7）：`rsqrtps` 后一次牛顿，`(3 − r·r·n2)·(r·0.5)`。`rsqrtps` 是硬件近似（Intel / AMD 的表
 * 不同），不逐位复刻：用 `1 / Math.sqrt` 代替（同 python 模型与 P4 的「近似倒数不复刻」），和 WPE 差 ≤ 2–5 ulp（p12-REPORT 用例 1、3）。
 */
export function nrRsqrt(n2: number): number {
  const r = f(1 / Math.sqrt(n2));
  return f(f(3 - f(f(r * r) * n2)) * f(r * 0.5));
}

/** 符号位：`andps −0` 取的是位，所以 −0 也算负（rea-RT 4、5.2）。 */
export function signBit(value: number): boolean {
  return value < 0 || Object.is(value, -0);
}

/**
 * 欧拉角（弧度）→ 四元数，写 `out[o .. o+3]` 为 w x y z（加载时的转换 `0x14026419d`–`0x1402642ae`，rea-p12-mdl 4.5、rea-RT 1.3）：
 * 半角，`q = qz·qy·qx`（`R = Rz·Ry·Rx`，和对象 `angles` 同一个约定），不归一化。`cosf` / `sinf` 是 MSVC CRT，按「double 里算、结果舍入到
 * float」实现（python 模型同样，实测对上）；小角度分支（cos 返回 1、sin 返回 x）这样算出来也一样。
 */
export function eulerToQuat(rx: number, ry: number, rz: number, out: Float32Array, o: number): void {
  const hx = f(rx * 0.5);
  const hy = f(ry * 0.5);
  const hz = f(rz * 0.5);
  const cz = f(Math.cos(hz));
  const cy = f(Math.cos(hy));
  const cx = f(Math.cos(hx));
  const sz = f(Math.sin(hz));
  const sy = f(Math.sin(hy));
  const sx = f(Math.sin(hx));
  const sxsy = f(sy * sx);
  const cxcy = f(cy * cx);
  const sxcy = f(sx * cy);
  const sycx = f(sy * cx);
  out[o] = f(f(sxsy * sz) + f(cxcy * cz));
  out[o + 1] = f(f(sxcy * cz) - f(sycx * sz));
  out[o + 2] = f(f(sxcy * sz) + f(sycx * cz));
  out[o + 3] = f(f(cxcy * sz) - f(sxsy * cz));
}

/**
 * `glm::quat_cast`（`0x140215730`，标量实现，rea-RT 7）：取 `m[mo ..]` 的左上 3×3，按「最大分量」分支，`0.25 / (sqrt(· + 1)·0.5)`，写
 * `out[o .. o+3]` 为 w x y z。
 */
export function quatCast(m: ArrayLike<number>, mo: number, out: Float32Array, o: number): void {
  const m00 = m[mo];
  const m01 = m[mo + 1];
  const m02 = m[mo + 2];
  const m10 = m[mo + 4];
  const m11 = m[mo + 5];
  const m12 = m[mo + 6];
  const m20 = m[mo + 8];
  const m21 = m[mo + 9];
  const m22 = m[mo + 10];
  const fx = f(f(m00 - m11) - m22);
  const fy = f(f(m11 - m00) - m22);
  const fz = f(f(m22 - m00) - m11);
  const fw = f(f(m00 + m11) + m22);
  let big = fw;
  let index = 0;
  if (fx > big) {
    big = fx;
    index = 1;
  }
  if (fy > big) {
    big = fy;
    index = 2;
  }
  if (fz > big) {
    big = fz;
    index = 3;
  }
  const value = f(f(Math.sqrt(f(big + 1))) * 0.5);
  const mult = f(0.25 / value);
  let w: number, x: number, y: number, z: number;
  if (index === 0) {
    w = value;
    x = f(f(m12 - m21) * mult);
    y = f(f(m20 - m02) * mult);
    z = f(f(m01 - m10) * mult);
  } else if (index === 1) {
    w = f(f(m12 - m21) * mult);
    x = value;
    y = f(f(m01 + m10) * mult);
    z = f(f(m20 + m02) * mult);
  } else if (index === 2) {
    w = f(f(m20 - m02) * mult);
    x = f(f(m01 + m10) * mult);
    y = value;
    z = f(f(m12 + m21) * mult);
  } else {
    w = f(f(m01 - m10) * mult);
    x = f(f(m20 + m02) * mult);
    y = f(f(m12 + m21) * mult);
    z = value;
  }
  out[o] = w;
  out[o + 1] = x;
  out[o + 2] = y;
  out[o + 3] = z;
}

/**
 * 局部矩阵 `[mat4_cast(q)·diag(S) | T]`（rea-RT 6.1）：`mat4_cast`（`0x140215200`，括号就是运算顺序，不归一化 q），前三列整列（4 个分量）
 * 乘 S 的对应分量（`FUN_14005eb60`），第四列 `(T, 1)`。读 `pose[po ..]` 的 T(3) q(4) S(3)，写 `out[o .. o+15]`。
 */
export function trsMatrix(pose: ArrayLike<number>, po: number, out: Float32Array, o: number): void {
  const w = pose[po + 3];
  const x = pose[po + 4];
  const y = pose[po + 5];
  const z = pose[po + 6];
  const sx = pose[po + 7];
  const sy = pose[po + 8];
  const sz = pose[po + 9];
  const zz = f(z * z);
  const yy = f(y * y);
  const xx = f(x * x);
  // 第 3 行（w 分量）的 0 也乘缩放（照 python 模型；S 为负时是 −0，仿射乘法不读它）
  out[o] = f(f(1 - f(f(zz + yy) * 2)) * sx);
  out[o + 1] = f(f(f(f(z * w) + f(x * y)) * 2) * sx);
  out[o + 2] = f(f(f(f(x * z) - f(y * w)) * 2) * sx);
  out[o + 3] = f(0 * sx);
  out[o + 4] = f(f(f(f(x * y) - f(z * w)) * 2) * sy);
  out[o + 5] = f(f(1 - f(f(zz + xx) * 2)) * sy);
  out[o + 6] = f(f(f(f(x * w) + f(y * z)) * 2) * sy);
  out[o + 7] = f(0 * sy);
  out[o + 8] = f(f(f(f(y * w) + f(x * z)) * 2) * sz);
  out[o + 9] = f(f(f(f(y * z) - f(x * w)) * 2) * sz);
  out[o + 10] = f(f(1 - f(f(yy + xx) * 2)) * sz);
  out[o + 11] = f(0 * sz);
  out[o + 12] = pose[po];
  out[o + 13] = pose[po + 1];
  out[o + 14] = pose[po + 2];
  out[o + 15] = 1;
}

/**
 * 仿射乘法 `out = A · B`（父链 `0x140200c6b` 与蒙皮 `0x140205360`，rea-RT 6.1）：只读 B 每列的 xyz（前三列按 w = 0、第四列按 w = 1），
 * 加法顺序固定：前三列 `(y·A1 + z·A2) + x·A0`，第四列 `((z·A2 + A3) + y·A1) + x·A0`。`out` 不能和 A、B 重叠（调用方用临时格）。
 */
export function mulAffine(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  out: Float32Array,
  o: number,
): void {
  for (let j = 0; j < 4; j++) {
    const bx = b[bo + 4 * j];
    const by = b[bo + 4 * j + 1];
    const bz = b[bo + 4 * j + 2];
    for (let r = 0; r < 4; r++) {
      const ax = a[ao + r];
      const ay = a[ao + 4 + r];
      const az = a[ao + 8 + r];
      out[o + 4 * j + r] =
        j < 3
          ? f(f(f(by * ay) + f(bz * az)) + f(bx * ax))
          : f(f(f(f(bz * az) + a[ao + 12 + r]) + f(by * ay)) + f(bx * ax));
    }
  }
}

/**
 * 完整 4×4 乘法 `out = A · B`（加载时的绑定姿势，`0x1401fc2b2`，rea-RT 1.1）：`((A0·b0 + A1·b1) + A2·b2) + A3·b3`。`out` 不能和 A、B 重叠。
 */
export function mulFull(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  out: Float32Array,
  o: number,
): void {
  for (let j = 0; j < 4; j++) {
    const b0 = b[bo + 4 * j];
    const b1 = b[bo + 4 * j + 1];
    const b2 = b[bo + 4 * j + 2];
    const b3 = b[bo + 4 * j + 3];
    for (let r = 0; r < 4; r++)
      out[o + 4 * j + r] = f(
        f(f(f(a[ao + r] * b0) + f(a[ao + 4 + r] * b1)) + f(a[ao + 8 + r] * b2)) + f(a[ao + 12 + r] * b3),
      );
  }
}

/**
 * `glm::inverse` 的标量 `compute_inverse<4, 4>`（`FUN_14005f730`，rea-RT 1.1、7）：`m[mo ..]` 的逆写 `out[o ..]`，每步 float32，式子与
 * 结合顺序照 glm（同 python 模型的 `inverse`）。`g(c, r)` 是第 c 列第 r 行。
 */
export function inverse4(m: ArrayLike<number>, mo: number, out: Float32Array, o: number): void {
  const g = (c: number, r: number) => m[mo + 4 * c + r];
  const det = (a: number, b: number, c: number, d: number) => f(f(a * b) - f(c * d));
  const c00 = det(g(2, 2), g(3, 3), g(3, 2), g(2, 3));
  const c02 = det(g(1, 2), g(3, 3), g(3, 2), g(1, 3));
  const c03 = det(g(1, 2), g(2, 3), g(2, 2), g(1, 3));
  const c04 = det(g(2, 1), g(3, 3), g(3, 1), g(2, 3));
  const c06 = det(g(1, 1), g(3, 3), g(3, 1), g(1, 3));
  const c07 = det(g(1, 1), g(2, 3), g(2, 1), g(1, 3));
  const c08 = det(g(2, 1), g(3, 2), g(3, 1), g(2, 2));
  const c10 = det(g(1, 1), g(3, 2), g(3, 1), g(1, 2));
  const c11 = det(g(1, 1), g(2, 2), g(2, 1), g(1, 2));
  const c12 = det(g(2, 0), g(3, 3), g(3, 0), g(2, 3));
  const c14 = det(g(1, 0), g(3, 3), g(3, 0), g(1, 3));
  const c15 = det(g(1, 0), g(2, 3), g(2, 0), g(1, 3));
  const c16 = det(g(2, 0), g(3, 2), g(3, 0), g(2, 2));
  const c18 = det(g(1, 0), g(3, 2), g(3, 0), g(1, 2));
  const c19 = det(g(1, 0), g(2, 2), g(2, 0), g(1, 2));
  const c20 = det(g(2, 0), g(3, 1), g(3, 0), g(2, 1));
  const c22 = det(g(1, 0), g(3, 1), g(3, 0), g(1, 1));
  const c23 = det(g(1, 0), g(2, 1), g(2, 0), g(1, 1));
  const fac = [
    [c00, c00, c02, c03],
    [c04, c04, c06, c07],
    [c08, c08, c10, c11],
    [c12, c12, c14, c15],
    [c16, c16, c18, c19],
    [c20, c20, c22, c23],
  ];
  const vec = [0, 1, 2, 3].map((r) => [g(1, r), g(0, r), g(0, r), g(0, r)]);
  // Inv_k = V_a·F_x − V_b·F_y + V_c·F_z（按分量，左结合），再乘 SignA / SignB（乘 ±1 是精确的取负）
  const terms: [number, number, number, number, number, number][] = [
    [1, 0, 2, 1, 3, 2],
    [0, 0, 2, 3, 3, 4],
    [0, 1, 1, 3, 3, 5],
    [0, 2, 1, 4, 2, 5],
  ];
  const inv = terms.map(([va, fa, vb, fb, vc, fc], col) =>
    [0, 1, 2, 3].map((i) => {
      const value = f(f(f(vec[va][i] * fac[fa][i]) - f(vec[vb][i] * fac[fb][i])) + f(vec[vc][i] * fac[fc][i]));
      const sign = (col + i) % 2 === 0 ? 1 : -1;
      return sign * value;
    }),
  );
  const dot = f(
    f(f(g(0, 0) * inv[0][0]) + f(g(0, 1) * inv[1][0])) + f(f(g(0, 2) * inv[2][0]) + f(g(0, 3) * inv[3][0])),
  );
  const oneOver = f(1 / dot);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[o + 4 * c + r] = f(inv[c][r] * oneOver);
}

/**
 * 静止姿势的分解（`0x1401fe2f2`–`0x1401fe65d`，rea-RT 7）：读来源矩阵 `m[mo ..]`，写 `out[o ..]` 的 T(3) q(4) S(3)。
 * - T = 第 4 列的 xyz；
 * - 前三列各自乘 `fastInvSqrt((w² + z²) + (y² + x²))` 后 `quat_cast`（单位旋转得 `(0.99936533, 0, 0, 0)`）；
 * - S = 原矩阵前三列的 vec4 长度 `sqrtf((w² + z²) + (y² + x²))`（`FUN_1401e24b0`）。
 */
export function decomposeRest(m: ArrayLike<number>, mo: number, out: Float32Array, o: number): void {
  const normalized = new Float32Array(16);
  for (let k = 0; k < 16; k++) normalized[k] = m[mo + k];
  for (let c = 0; c < 3; c++) {
    const x = m[mo + 4 * c];
    const y = m[mo + 4 * c + 1];
    const z = m[mo + 4 * c + 2];
    const w = m[mo + 4 * c + 3];
    const n2 = f(f(f(w * w) + f(z * z)) + f(f(y * y) + f(x * x)));
    const r = fastInvSqrt(n2);
    normalized[4 * c] = f(x * r);
    normalized[4 * c + 1] = f(y * r);
    normalized[4 * c + 2] = f(z * r);
    normalized[4 * c + 3] = f(w * r);
    out[o + 7 + c] = f(Math.sqrt(n2));
  }
  out[o] = m[mo + 12];
  out[o + 1] = m[mo + 13];
  out[o + 2] = m[mo + 14];
  quatCast(normalized, 0, out, o + 3);
}
