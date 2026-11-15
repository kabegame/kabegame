// P6d1a 点 1：`rotateObjectSpace` / `extractEulerZYX` / `lookAt` / `lookAtYaw` 逐位对 WPE 2.8.42 的实测读回。
// 真值：`ignore/p6/d0/out/p6d1-xform.log`（工程 make_p6d1.py）、`p6d1-round2.log`（make_p6d1b.py）。读回的 `angles` 是度（`radiansToScript`），
// 矩阵是 `getTransformMatrix().m`（无父对象、缩放 1 的层 = 本地矩阵）。逐位比：`Object.is`（NaN 与 NaN 相同）。
import { describe, expect, it } from "vitest";
import { degreesFromScript, radiansToScript } from "../script/f32";
import { anglesRotation, layerLocalMatrix } from "./layout";
import { extractEulerZYX, lookAtAngles, lookAtYawAngles, rotateObjectSpace } from "./rotation";

type V3 = [number, number, number];
const UP: V3 = [0, 1, 0];

/** 脚本写 `angles`（度）进状态的弧度。 */
const fromDeg = (d: V3): V3 => [degreesFromScript(d[0]), degreesFromScript(d[1]), degreesFromScript(d[2])];
const toDeg = (a: readonly number[]): V3 => [radiansToScript(a[0]), radiansToScript(a[1]), radiansToScript(a[2])];
const matrixOf = (origin: V3, angles: readonly number[], rotation: readonly number[] | null = null): number[] =>
  Array.from(layerLocalMatrix({ origin, angles, scale: [1, 1, 1], rotation }));

// 日志里的 -0 与 0 都印成 "0"（读回无法区分符号），所以比之前把 -0 归一成 0；其余逐位（NaN 与 NaN 相同）
const nz = (v: number): number => v + 0;
function expectBits(actual: readonly number[], expected: readonly number[], tag: string): void {
  expect(actual.length, tag).toBe(expected.length);
  actual.forEach((value, i) =>
    expect(Object.is(nz(value), nz(expected[i])), `${tag}[${i}] ${value} vs ${expected[i]}`).toBe(true),
  );
}

/** `rotateObjectSpace` 之后：脚本读回的角度与矩阵（矩阵取乘出来的 3×3）。 */
function rotated(start: readonly number[], v: V3, origin: V3) {
  const R = rotateObjectSpace(anglesRotation(start), v);
  const angles = extractEulerZYX(R);
  return { R, angles, deg: toDeg(angles), m: matrixOf(origin, angles, R) };
}

describe("rotateObjectSpace（p6d1-xform.log）", () => {
  it("R1：z 转 30（弧度）", () => {
    const r = rotated([0, 0, 0], [0, 0, 30], [300, 900, 0]);
    expectBits(r.deg, [0, 0, -81.12661743164062], "angles");
    expectBits(
      r.m,
      [
        0.15425145626068115, -0.9880316257476807, 0, 0, 0.9880316257476807, 0.15425145626068115, 0, 0, 0, 0, 1, 0, 300,
        900, 0, 1,
      ],
      "m",
    );
  });

  it("R2：(10, 20, 30)", () => {
    const r = rotated([0, 0, 0], [10, 20, 30], [700, 900, 0]);
    expectBits(r.deg, [-147.04220581054688, 65.91558837890625, -81.12661743164062], "angles");
    expectBits(
      r.m,
      [
        0.06294725090265274, -0.4031980037689209, -0.9129452705383301, 0, -0.9056399464607239, 0.36128929257392883,
        -0.22200526297092438, 0, 0.41934940218925476, 0.8407743573188782, -0.34241002798080444, 0, 700, 900, 0, 1,
      ],
      "m",
    );
  });

  it("R3：连转两次 z 30", () => {
    const once = rotateObjectSpace(anglesRotation([0, 0, 0]), [0, 0, 30]);
    // 第二次从乘出来的 3×3 起（不经角度重建）
    const R = rotateObjectSpace(once, [0, 0, 30]);
    const angles = extractEulerZYX(R);
    expectBits(toDeg(angles), [0, 0, -162.25323486328125], "angles");
    expectBits(
      matrixOf([1100, 900, 0], angles, R),
      [
        -0.9524129629135132, -0.30481064319610596, 0, 0, 0.30481064319610596, -0.9524129629135132, 0, 0, 0, 0, 1, 0,
        1100, 900, 0, 1,
      ],
      "m",
    );
  });

  it("R4：angles 写 (10, 20, 30) 度，按角度重建", () => {
    const a = fromDeg([10, 20, 30]);
    expectBits(toDeg(a), [10, 20, 30.000001907348633], "angles");
    expectBits(
      matrixOf([1500, 900, 0], a),
      [
        0.813797652721405, 0.46984630823135376, -0.3420201241970062, 0, -0.4409696161746979, 0.8825640678405762,
        0.16317591071128845, 0, 0.37852227687835693, 0.01802830398082733, 0.9254165291786194, 0, 1500, 900, 0, 1,
      ],
      "m",
    );
  });

  it("R5：转完再把读回的角度写回去，矩阵变成按角度重建", () => {
    const r = rotated([0, 0, 0], [10, 20, 30], [300, 600, 0]);
    expectBits(
      r.m,
      [
        0.06294725090265274, -0.4031980037689209, -0.9129452705383301, 0, -0.9056399464607239, 0.36128929257392883,
        -0.22200526297092438, 0, 0.41934940218925476, 0.8407743573188782, -0.34241002798080444, 0, 300, 600, 0, 1,
      ],
      "a",
    );
    const back = fromDeg(r.deg);
    expectBits(toDeg(back), [-147.04220581054688, 65.91558837890625, -81.12661743164062], "angles b");
    expectBits(
      matrixOf([300, 600, 0], back),
      [
        0.06294723600149155, -0.4031980037689209, -0.9129452109336853, 0, -0.9056400060653687, 0.3612891733646393,
        -0.222005233168602, 0, 0.41934934258461, 0.8407742977142334, -0.3424100875854492, 0, 300, 600, 0, 1,
      ],
      "b",
    );
  });

  it("R10 / R11：x 转 90、y 转 90（弧度）", () => {
    const a = rotated([0, 0, 0], [90, 0, 0], [700, 300, 0]);
    expectBits(a.deg, [116.62015533447266, 0, 0], "R10 angles");
    expectBits(
      a.m,
      [
        1, 0, 0, 0, 0, -0.4480736255645752, 0.8939966559410095, 0, 0, -0.8939966559410095, -0.4480736255645752, 0, 700,
        300, 0, 1,
      ],
      "R10 m",
    );
    const b = rotated([0, 0, 0], [0, 90, 0], [1100, 300, 0]);
    expectBits(b.deg, [-180, 63.379844665527344, 180], "R11 angles");
    expectBits(
      b.m,
      [
        -0.4480736255645752, 0, -0.8939966559410095, 0, 0, 1, 0, 0, 0.8939966559410095, 0, -0.4480736255645752, 0, 1100,
        300, 0, 1,
      ],
      "R11 m",
    );
  });

  it("C（带父，只比本地角度）：lookAt 后再 z 转 30", () => {
    const look = lookAtAngles([100, 0, 0], [1500, 150, 0], UP, false)!;
    expectBits(toDeg(look), [173.88450622558594, 90, 180], "C a");
    const r = extractEulerZYX(rotateObjectSpace(anglesRotation(look), [0, 0, 30]));
    expectBits(toDeg(r), [-90, 8.873385429382324, -83.8844985961914], "C b");
  });
});

describe("lookAt / lookAtYaw（p6d1-xform.log）", () => {
  it("R6：lookAt", () => {
    const a = lookAtAngles([700, 600, 0], [1500, 1000, 0], UP, false)!;
    expectBits(toDeg(a), [153.43495178222656, 90, 180], "angles");
    expectBits(
      matrixOf([700, 600, 0], a),
      [
        4.371138828673793e-8, 3.82137093032941e-15, -1, 0, -0.4472135901451111, 0.8944271802902222,
        -1.954832384853944e-8, 0, 0.8944271802902222, 0.4472135901451111, 3.9096654802506237e-8, 0, 700, 600, 0, 1,
      ],
      "m",
    );
  });

  it("R7：lookAtYaw", () => {
    const a = lookAtYawAngles([1100, 600, 0], [1500, 1000, 0], UP, false)!;
    expectBits(toDeg(a), [0, 90, 0], "angles");
    expectBits(
      matrixOf([1100, 600, 0], a),
      [-4.371138828673793e-8, 0, -1, 0, 0, 1, 0, 0, 1, 0, -4.371138828673793e-8, 0, 1100, 600, 0, 1],
      "m",
    );
  });

  it("R8：看自己什么也不做", () => {
    expect(lookAtAngles([1500, 600, 0], [1500, 600, 0], UP, false)).toBeNull();
  });

  it("R9：lookAt", () => {
    const a = lookAtAngles([300, 300, 0], [700, 150, 500], UP, false)!;
    expectBits(toDeg(a), [13.184399604797363, 38.65980911254883, 0], "angles");
    expectBits(
      matrixOf([300, 300, 0], a),
      [
        0.7808687686920166, 0, -0.6246950626373291, 0, 0.14248405396938324, 0.973641037940979, 0.17810505628585815, 0,
        0.6082287430763245, -0.22808577120304108, 0.7602858543395996, 0, 300, 300, 0, 1,
      ],
      "m",
    );
  });

  it("R1 after zero：lookAt((0,0,0)) 覆盖之前的角度", () => {
    const a = lookAtAngles([300, 900, 0], [0, 0, 0], UP, false)!;
    expectBits(toDeg(a), [71.56504821777344, -90, 0], "angles");
    expectBits(
      matrixOf([300, 900, 0], a),
      [
        -4.371138828673793e-8, 0, 1, 0, -0.9486832618713379, 0.3162277936935425, -4.1468261713362153e-8, 0,
        -0.3162277936935425, -0.9486832618713379, -1.3822756272929837e-8, 0, 300, 900, 0, 1,
      ],
      "m",
    );
  });
});

const P: V3 = [960, 540, 0];

describe("round2（p6d1-round2.log）", () => {
  const mm = (origin: V3, angles: readonly number[], R: readonly number[] | null = null) =>
    matrixOf(origin, angles, R).slice(0, 11);

  it("R1：从 0 转 (0.3, 0.2, 0.1)", () => {
    const r = rotated([0, 0, 0], [0.3, 0.2, 0.1], P);
    expectBits(r.deg, [17.18873405456543, 11.459155082702637, 5.729578018188477], "angles");
    expectBits(
      r.m.slice(0, 11),
      [
        0.975170373916626, 0.09784340113401413, -0.19866932928562164, 0, -0.036957018077373505, 0.956425130367279,
        0.2896294891834259, 0, 0.21835066378116608, -0.2750958502292633, 0.9362934231758118,
      ],
      "m",
    );
  });

  it("R1c：z 转 90（弧度）", () => {
    expectBits(rotated([0, 0, 0], [0, 0, 90], P).deg, [0, 0, 116.62015533447266], "angles");
  });

  it("R2 / R3：angles z 30 度后 x 转 0.5；再写回角度", () => {
    const start = fromDeg([0, 0, 30]);
    const r = rotated(start, [0.5, 0, 0], P);
    const m = [
      0.8660253882408142, 0.5, 0, 0, -0.43879127502441406, 0.7600087523460388, 0.4794255495071411, 0,
      0.23971277475357056, -0.41519469022750854, 0.8775825500488281,
    ];
    expectBits(r.deg, [28.647890090942383, 0, 30.000001907348633], "R2 angles");
    expectBits(r.m.slice(0, 11), m, "R2 m");
    // R3：`R.angles = R.angles`——读回的度再写回，按角度重建；WPE 读回的矩阵与 R2 完全相同
    const back = fromDeg(r.deg);
    expectBits(toDeg(back), [28.647890090942383, 0, 30.000001907348633], "R3 angles");
    expectBits(mm(P, back), m, "R3 m");
  });

  it("R4：400 度归一化成 40.000004", () => {
    // WPE 是 JSON 写 "0 0 6.981317"（f32 弧度），读回 400
    expectBits(toDeg([0, 0, Math.fround(6.981317)]), [0, 0, 400], "R4a");
    const b = rotated([0, 0, Math.fround(6.981317)], [0, 0, 0], P);
    expectBits(b.deg, [0, 0, 40.000003814697266], "R4b");
    const c = rotated(b.angles, [0, 0, 0], P); // rotateObjectSpace(5) 等于零向量，再来一遍
    expectBits(c.deg, [0, 0, 40.000003814697266], "R4c");
  });

  it("L1 / L1b：z 轴正负方向", () => {
    const a = lookAtAngles(P, [960, 540, 1000], UP, false)!;
    expectBits(toDeg(a), [0, 0, 0], "L1 angles");
    expectBits(mm(P, a).slice(8, 11), [0, 0, 1], "L1 z");
    const b = lookAtAngles(P, [960, 540, -1000], UP, false)!;
    expectBits(toDeg(b), [180, 0, 180], "L1b angles");
    expectBits(mm(P, b).slice(8, 11), [7.64274186065882e-15, -8.742277657347586e-8, -1], "L1b z");
  });

  it("L2 / L4：lookAt (1060, 640, 500)；子层本地原点 (100, 0, 0) 看 (200, 100, 500) 同角度", () => {
    const a = lookAtAngles(P, [1060, 640, 500], UP, false)!;
    expectBits(toDeg(a), [-11.095804214477539, 11.309932708740234, 0], "L2 angles");
    expectBits(mm(P, a).slice(8, 11), [0.19245009124279022, 0.19245009124279022, 0.9622504711151123], "L2 z");
    const q = lookAtAngles([100, 0, 0], [200, 100, 500], UP, false)!;
    expectBits(toDeg(q), [-11.095804214477539, 11.309932708740234, 0], "L4");
  });

  it("L3：看自己不动（null）", () => {
    expect(lookAtAngles(P, [960, 540, 0], UP, false)).toBeNull();
  });

  it("L3b / KN：视线与缺省 up 平行得 NaN", () => {
    const a = lookAtAngles(P, [960, 640, 0], UP, false)!;
    expectBits(toDeg(a), [NaN, NaN, NaN], "angles");
    expectBits(mm(P, a), [NaN, NaN, NaN, 0, NaN, NaN, NaN, 0, NaN, NaN, NaN], "m");
    expectBits(toDeg(lookAtAngles([1500, 300, 0], [1500, 400, 0], UP, false)!), [NaN, NaN, NaN], "KN");
  });

  it("L7 / L9：缺目标、非向量目标当 (0, 0, 0)", () => {
    expectBits(toDeg(lookAtAngles(P, [0, 0, 0], UP, false)!), [29.357755661010742, -90, 0], "L7");
  });

  it("Y1 / Y1b / Y2 / Y3 / L8", () => {
    expectBits(toDeg(lookAtYawAngles(P, [1060, 590, 300], UP, false)!), [0, 18.434947967529297, 0], "Y1");
    expectBits(
      toDeg(lookAtAngles(P, [1060, 590, 300], UP, false)!),
      [-8.984877586364746, 18.434947967529297, 0],
      "Y1b",
    );
    expect(lookAtYawAngles(P, [960, 640, 0], UP, false), "Y2").toBeNull();
    expectBits(
      toDeg(lookAtYawAngles(P, [1060, 590, 300], [0, 2, 0], false)!),
      [25.37693214416504, 18.434947967529297, 0],
      "Y3",
    );
    expectBits(
      toDeg(lookAtAngles(P, [1060, 590, 300], [1, 1, 0], false)!),
      [-19.347370147705078, 6.72136926651001, -45],
      "L8",
    );
  });

  it("L6：相机用 −Z 对着目标", () => {
    expectBits(
      toDeg(lookAtAngles([0, 0, 0], [100, 100, 500], UP, true)!),
      [-168.90420532226562, -11.309932708740234, 180],
      "L6",
    );
  });
});

describe("layerLocalMatrix", () => {
  /** 抽出 `anglesRotation` 之前的实现（HEAD 原样）。 */
  function legacy(layer: {
    origin: readonly number[];
    angles: readonly number[];
    scale: readonly number[];
  }): Float32Array {
    const [x = 0, y = 0, z = 0] = layer.origin;
    const [sx = 1, sy = 1, sz = 1] = layer.scale;
    const [ax = 0, ay = 0, az = 0] = layer.angles;
    const f = Math.fround;
    const cz = f(Math.cos(f(az))),
      szn = f(Math.sin(f(az)));
    const cy = f(Math.cos(f(ay))),
      syn = f(Math.sin(f(ay)));
    const cx = f(Math.cos(f(ax))),
      sxn = f(Math.sin(f(ax)));
    const R = [
      f(cy * cz),
      f(cy * szn),
      f(-syn),
      f(f(f(syn * cz) * sxn) - f(cx * szn)),
      f(f(f(syn * szn) * sxn) + f(cx * cz)),
      f(sxn * cy),
      f(f(f(cx * cz) * syn) + f(sxn * szn)),
      f(f(f(cx * szn) * syn) - f(sxn * cz)),
      f(cx * cy),
    ];
    const scale = [sx, sy, sz === 0 ? 1 : sz];
    const m = new Float32Array(16);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = f(f(scale[c]) * R[c * 3 + r]);
    m[12] = x;
    m[13] = y;
    m[14] = z;
    m[15] = 1;
    return m;
  }

  it("rotation 为 null / 缺省时与抽取前逐字节相同", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 14;
    for (let i = 0; i < 50; i++) {
      const layer = {
        origin: [rnd() * 100, rnd() * 100, rnd()],
        angles: [rnd(), rnd(), rnd()],
        scale: [1 + rnd() / 5, 1 + rnd() / 5, i % 7 === 0 ? 0 : 1 + rnd() / 5],
      };
      const old = legacy(layer);
      for (const rotation of [undefined, null]) {
        const now = layerLocalMatrix({ ...layer, rotation });
        expect(Buffer.from(now.buffer).equals(Buffer.from(old.buffer))).toBe(true);
      }
    }
  });

  it("rotation 有值时用它代替按角度算的 3×3", () => {
    const R = [0, 1, 0, -1, 0, 0, 0, 0, 1];
    const m = layerLocalMatrix({ origin: [1, 2, 3], angles: [1, 2, 3], scale: [2, 1, 1], rotation: R });
    expectBits(Array.from(m), [0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], "m");
  });
});
