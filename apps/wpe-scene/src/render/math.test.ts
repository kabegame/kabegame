/**
 * 矩阵运算的 float32 顺序（`render/math.ts`，`.claude/plans/wpe-import/3-scene/phase-f32-matrix.md`、`rea-matrix-order.md`）：
 * `multiply` 是 WPE 的 glm 乘法（逐步 f32 舍入），`mulAffine` 是 VP / MVP 的仿射乘法，`translateGlm` 与 `alignOffset` 只改平移列。
 * 最后一组用 WPE 抓帧的 MVP 平移分量（`2903412088` 走查，`rea-matrix-order` 第 6 节）逐位核对产品代码路径。
 */
import { describe, expect, it } from "vitest";
import { alignOffset, identity, mulAffine, multiply, orthographic, translateGlm, type Mat4 } from "./math";
import { drawMatrixOf, layerLocalMatrix, sceneViewProjection } from "./layout";

const f = Math.fround;

/** 确定性的伪随机数（mulberry32）：测试不依赖 `Math.random`。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMatrix(next: () => number): Mat4 {
  const m = new Float32Array(16);
  for (let i = 0; i < 16; i++) m[i] = f((next() - 0.5) * 4000);
  return m;
}

/** 参考实现：每步 `fround`、k 从 0 到 3（rea-matrix-order 1.1）。 */
function referenceGlm(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = f(a[r] * b[c * 4]);
      for (let k = 1; k < 4; k++) s = f(s + f(a[k * 4 + r] * b[c * 4 + k]));
      out[c * 4 + r] = s;
    }
  return out;
}

/** 读码 2.1 的伪代码：`out = A ⊗ B`（这里 A 是 WPE 的 V / M，B 是 P / VP，所以 `mulAffine(a, b)` 对应 `affine(b, a)`）。 */
function referenceAffine(A: Mat4, B: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = f(f(f(A[c * 4 + 2] * B[8 + r]) + f(A[c * 4 + 1] * B[4 + r])) + f(A[c * 4] * B[r]));
  for (let r = 0; r < 4; r++)
    o[12 + r] = f(f(f(f(A[14] * B[8 + r]) + B[12 + r]) + f(A[13] * B[4 + r])) + f(A[12] * B[r]));
  return o;
}

/** 位级比较（区分 −0 与 +0）。 */
function bits(m: ArrayLike<number>): number[] {
  const view = new DataView(new ArrayBuffer(4));
  return Array.from(m, (v) => {
    view.setFloat32(0, v);
    return view.getUint32(0);
  });
}

describe("multiply：glm 乘法的逐步 f32 舍入", () => {
  it("随机 f32 矩阵 1000 组，和逐步 fround、k 从 0 到 3 的参考实现逐位相同", () => {
    const next = rng(1);
    for (let i = 0; i < 1000; i++) {
      const a = randomMatrix(next),
        b = randomMatrix(next);
      expect(bits(multiply(a, b))).toEqual(bits(referenceGlm(a, b)));
    }
  });
  it("单位阵与普通例子", () => {
    const m = Float32Array.from({ length: 16 }, (_, i) => i + 1);
    expect(Array.from(multiply(identity(), m))).toEqual(Array.from(m));
    expect(Array.from(multiply(m, identity()))).toEqual(Array.from(m));
  });
  it("逐步舍入和 double 累加不同：存在末位不同的输入", () => {
    const next = rng(2);
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const a = randomMatrix(next),
        b = randomMatrix(next);
      const stepwise = multiply(a, b);
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
          if (f(sum) !== stepwise[c * 4 + r]) differ++;
        }
    }
    expect(differ).toBeGreaterThan(0);
  });
});

describe("mulAffine：WPE 的仿射乘法（FUN_1400d4200）", () => {
  it("1000 组随机矩阵，和读码 2.1 的伪代码逐位相同", () => {
    const next = rng(3);
    for (let i = 0; i < 1000; i++) {
      const p = randomMatrix(next),
        v = randomMatrix(next);
      // mulAffine(a, b)：a 是 WPE 的 B（P / VP），b 是 WPE 的 A（V / M）
      expect(bits(mulAffine(p, v))).toEqual(bits(referenceAffine(v, p)));
    }
  });
  it("右乘数 b 的第 3 行（内存 3、7、11、15）随便填，结果不变", () => {
    const next = rng(4);
    for (let i = 0; i < 100; i++) {
      const a = randomMatrix(next),
        b = randomMatrix(next);
      const noisy = Float32Array.from(b);
      noisy[3] = 123.5;
      noisy[7] = -9;
      noisy[11] = 0.25;
      noisy[15] = 77;
      expect(bits(mulAffine(a, noisy))).toEqual(bits(mulAffine(a, b)));
    }
  });
  it("右乘数是仿射矩阵（第 3 行是 0, 0, 0, 1）时，数学上等于 multiply（小整数无舍入）", () => {
    const a = Float32Array.from({ length: 16 }, (_, i) => (i * 7) % 11);
    const b = Float32Array.from([2, 3, 5, 0, 7, 11, 13, 0, 17, 19, 23, 0, 29, 31, 37, 1]);
    expect(Array.from(mulAffine(a, b))).toEqual(Array.from(multiply(a, b)));
  });
  it("单位阵 V：mulAffine(P, I) 逐位等于 P", () => {
    const p = orthographic(0, 3840, 0, 2130, 2000, -2000);
    expect(bits(mulAffine(p, identity()))).toEqual(bits(p));
  });
});

describe("translateGlm / alignOffset：只改平移列", () => {
  it("translateGlm：m · T(t)，((m0·x + m4·y) + m8·z) + m12", () => {
    const m = Float32Array.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1]);
    const out = translateGlm(m, [1, 10, 100]);
    // 手算：x 行 1·1 + 4·10 + 7·100 + 10 = 751，y 行 2 + 50 + 800 + 11 = 863，z 行 3 + 60 + 900 + 12 = 975
    expect(Array.from(out.slice(12, 16))).toEqual([751, 863, 975, 1]);
    expect(Array.from(out.slice(0, 12))).toEqual(Array.from(m.slice(0, 12)));
  });
  it("alignOffset：W 的平移列 + 偏移，W15 不动", () => {
    const w = Float32Array.from([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1]);
    const out = alignOffset(w, [10, -4, 0]);
    expect(Array.from(out.slice(12, 16))).toEqual([120, 188, 300, 1]);
    expect(Array.from(out.slice(0, 12))).toEqual(Array.from(w.slice(0, 12)));
  });
  it("带旋转时 alignOffset 和 translateGlm 结果不同（求和顺序有意义）", () => {
    const next = rng(5);
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const angle = next() * 6;
      const w = layerLocalMatrix({
        origin: [f(next() * 4000), f(next() * 2000), 95],
        angles: [0, 0, angle],
        scale: [f(0.3 + next()), f(0.3 + next()), 1],
      });
      const a = [f(next() * 800 - 400), f(next() * 40 - 20), 0];
      if (bits(alignOffset(w, a)).join() !== bits(translateGlm(w, a)).join()) differ++;
    }
    expect(differ).toBeGreaterThan(0);
  });
});

describe("WPE 抓帧：MVP 平移分量逐位相同（2903412088 走查，rea-matrix-order 第 6 节）", () => {
  const general = { width: 3840, height: 2130 };
  const scale = [f(0.67623), f(0.72657), 1];
  // 文本层的对齐偏移（W/2 的整数一半、−16）：`drawMatrixOf` 的 `offset` 字段
  const offset = [410.5, -16, 0];
  /** 末 pass：模型 = W_al，MVP = M ⊗ (V ⊗ P)，V 是单位阵。 */
  function mvpOf(origin: number[]): Mat4 {
    const layers = new Map([[1, { origin, angles: [0, 0, 0], scale, offset, parent: null }]]);
    const world = drawMatrixOf(1, layers, new Map());
    const vp = mulAffine(sceneViewProjection(general), identity());
    return mulAffine(vp, world);
  }
  it("对象 179：tx、ty", () => {
    const mvp = mvpOf([f(3299.2512), f(2021.7534), 95]);
    expect(mvp[12]).toBe(0.8629395961761475);
    expect(mvp[13]).toBe(0.8874444961547852);
  });
  it("对象 67：tx、ty", () => {
    const mvp = mvpOf([f(3302.4), f(2023.5), 86]);
    expect(mvp[12]).toBe(0.8645793199539185);
    expect(mvp[13]).toBe(0.8890844583511353);
  });
  it("画字形进合成 RT 的那个 draw：ty", () => {
    // 模型 = glm::translate(I, (0, 185, 0))，V = I，P = ortho(0, 821, 0, 306, −1000, 1000)
    const projection = orthographic(0, 821, 0, 306, 1000, -1000);
    const model = translateGlm(identity(), [0, 185, 0]);
    const mvp = mulAffine(mulAffine(projection, identity()), model);
    expect(mvp[13]).toBe(0.2091503143310547);
  });
});
