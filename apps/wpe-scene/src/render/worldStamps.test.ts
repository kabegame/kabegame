/**
 * 世界矩阵缓存的影子（`WorldStamps`，步骤 6b，B1）：照生成工程 `p12-lag` 的对象表逐帧模拟「更新阶段 → 脚本 / 动画写 → 渲染阶段」，
 * 断言每个对象渲染阶段取到的是新值还是滞后一帧的值（祖先的变换取上一帧、姿势取本帧）；没有写入时和 `worldMatrixOf` 逐字节相同。
 */
import { describe, expect, it } from "vitest";
import { layerLocalMatrix, worldMatrixOf } from "./layout";
import type { Mat4 } from "./math";
import { WorldStamps } from "./worldStamps";

type L = { origin: number[]; angles: number[]; scale: number[]; parent: number | null };

// objects 下标（FR 0、CLK 1 不进表）
const R = 2,
  Q = 3,
  A1 = 4,
  A5 = 5,
  A7 = 6,
  A2 = 7,
  A3 = 8,
  A6 = 9,
  G = 10,
  Q2 = 11,
  B1 = 12,
  R2 = 13,
  Q3 = 14,
  C1 = 15,
  X = 16,
  R3 = 17;
const PARENTS: Record<number, number | null> = {
  [R]: null,
  [Q]: R,
  [A1]: Q,
  [A5]: A1,
  [A7]: Q,
  [A2]: Q,
  [A3]: Q,
  [A6]: Q,
  [G]: null,
  [Q2]: G,
  [B1]: Q2,
  [R2]: null,
  [Q3]: R2,
  [C1]: Q3,
  [X]: R3,
  [R3]: null,
};
const ATTACHED = new Set([A1, A7, A2, A3, A6, B1, C1]);
/** 更新循环里取世界矩阵的对象：蒙皮 puppet 与粒子层。 */
const UPDATED = [Q, A1, A7, A3, A6, Q2, B1, Q3, C1, X];
/** 渲染阶段画出来的对象（G 是纯分组、不画），objects 顺序。 */
const DRAWN = [R, Q, A1, A5, A7, A2, A3, A6, Q2, B1, R2, Q3, C1, X, R3];
/** 每帧被脚本 / 关键帧动画写 origin 的对象。 */
const MOVERS = [R, G, R3, A6, R2];
/** 渲染阶段的期望：true = 新值，false = 滞后一帧（祖先取上一帧的变换、姿势取本帧）。 */
const FRESH: Record<number, boolean> = {
  [R]: true,
  [Q]: true,
  [A1]: false,
  [A5]: false,
  [A7]: false,
  [A2]: true,
  [A3]: false,
  [A6]: true,
  [Q2]: true,
  [B1]: false,
  [R2]: true,
  [Q3]: true,
  [C1]: false,
  [X]: true,
  [R3]: true,
};

/** 第 f 帧 mover 的 origin（每帧不同）。 */
const originAt = (object: number, f: number): number[] => [object * 100 + f * 17, object * 10 - f * 5, 0];

function layersAt(f: number): Map<number, L> {
  const layers = new Map<number, L>();
  for (const [key, parent] of Object.entries(PARENTS)) {
    const object = Number(key);
    layers.set(object, {
      origin: MOVERS.includes(object) ? originAt(object, f) : [object, -object, 0],
      angles: [0, 0, object * 0.01],
      scale: [1, 1, 1],
      parent,
    });
  }
  return layers;
}

/** 第 f 帧的姿势钩子：挂点对象的 `Pose · Att` 每帧不同（只给挂点对象）。 */
const attachAt =
  (f: number) =>
  (object: number): Mat4 | null =>
    ATTACHED.has(object)
      ? layerLocalMatrix({ origin: [object + f * 3, f, 0], angles: [0, 0, 0.1 * f + object], scale: [1, 1, 1] })
      : null;

const bytes = (m: Mat4) => Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString("hex");
const fresh = (object: number, layers: Map<number, L>, attach: (o: number) => Mat4 | null) =>
  worldMatrixOf(object, layers, new Map(), attach);
const isAttached = (object: number) => ATTACHED.has(object);

describe("WorldStamps 照 p12-lag 的对象表", () => {
  it("渲染阶段：挂点 puppet / 局部空间粒子 / 它们的子对象滞后一帧，其余是新值", () => {
    const stamps = new WorldStamps();
    for (let f = 1; f <= 6; f++) {
      const attach = attachAt(f);
      // 更新阶段：脚本写之前的状态（上一帧的 origin）
      const before = layersAt(f - 1);
      stamps.nextFrame();
      for (const object of UPDATED) stamps.evaluate(object, before, isAttached, attach);
      // 脚本 / 动画写
      const now = layersAt(f);
      stamps.invalidate(MOVERS);
      for (const object of DRAWN) {
        const got = stamps.evaluate(object, now, isAttached, attach);
        if (f === 1) {
          // 首帧例外：更新阶段已把父链算过（戳 1），父先于它画（戳被重算成本帧号）的不挂点 puppet Q / Q3 命中旧值；Q2 的父 G 不画、戳停在 0，所以 Q2 照常新
          if ([Q, Q3].includes(object)) expect(bytes(got), `首帧 ${object}`).toBe(bytes(fresh(object, before, attach)));
          if ([R, R2, R3, X, Q2].includes(object))
            expect(bytes(got), `首帧 ${object}`).toBe(bytes(fresh(object, now, attach)));
          continue;
        }
        // 第 2 帧的滞后对象带着首帧例外（Q 在第 1 帧取了旧值，它的缓存是第 0 帧的），从第 3 帧起才是「上一帧」
        if (f === 2 && !FRESH[object]) continue;
        const expected = FRESH[object] ? fresh(object, now, attach) : fresh(object, before, attach);
        expect(bytes(got), `第 ${f} 帧 对象 ${object}（${FRESH[object] ? "新" : "滞后"}）`).toBe(bytes(expected));
        // 新旧必须真的不同，否则断言没有区分力
        if (!FRESH[object]) expect(bytes(got)).not.toBe(bytes(fresh(object, now, attach)));
      }
    }
  });

  it("滞后的姿势是本帧的：A1 = 旧 Q · (本帧 Pose · L)", () => {
    const stamps = new WorldStamps();
    let last: Mat4 | null = null;
    for (let f = 1; f <= 3; f++) {
      const attach = attachAt(f);
      const before = layersAt(f - 1);
      stamps.nextFrame();
      for (const object of UPDATED) stamps.evaluate(object, before, isAttached, attach);
      stamps.invalidate(MOVERS);
      const now = layersAt(f);
      for (const object of DRAWN) {
        const got = stamps.evaluate(object, now, isAttached, attach);
        if (object === A1) last = got;
      }
      if (f >= 2) {
        // 用上一帧的 origin、上一帧的姿势：必须不同于结果（姿势确实是本帧的）
        const stalePose = fresh(A1, before, attachAt(f - 1));
        expect(bytes(last!)).not.toBe(bytes(stalePose));
      }
    }
  });

  it("没有写入时和 worldMatrixOf 逐字节相同（姿势每帧变）", () => {
    const stamps = new WorldStamps();
    const layers = layersAt(0);
    for (let f = 1; f <= 4; f++) {
      const attach = attachAt(f);
      stamps.nextFrame();
      for (const object of UPDATED) stamps.evaluate(object, layers, isAttached, attach);
      for (const object of DRAWN)
        expect(bytes(stamps.evaluate(object, layers, isAttached, attach)), `第 ${f} 帧 对象 ${object}`).toBe(
          bytes(fresh(object, layers, attach)),
        );
    }
  });

  it("父对象不在表里当根，对象不在表里是单位阵，环不会死循环", () => {
    const stamps = new WorldStamps();
    stamps.nextFrame();
    const layers = new Map<number, L>([
      [1, { origin: [5, 6, 0], angles: [0, 0, 0], scale: [1, 1, 1], parent: 99 }],
      [2, { origin: [1, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1], parent: 3 }],
      [3, { origin: [0, 1, 0], angles: [0, 0, 0], scale: [1, 1, 1], parent: 2 }],
    ]);
    const none = () => false;
    const noPre = () => null;
    expect(bytes(stamps.evaluate(1, layers, none, noPre))).toBe(bytes(layerLocalMatrix(layers.get(1)!)));
    expect(stamps.evaluate(7, layers, none, noPre)[0]).toBe(1);
    expect(() => stamps.evaluate(2, layers, none, noPre)).not.toThrow();
  });
});
