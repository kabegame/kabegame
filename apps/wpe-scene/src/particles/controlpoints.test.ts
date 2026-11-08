// P4c 步骤 1：控制点状态（`controlpoints.ts`）。依据 rea-p4c-sim.md 第 1–2 节，实测见报告「P4c 语义的实测核对」。
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { invert, multiply, rotationZ, scaling, translation, transformPoint, type Mat4 } from "../render/math";
import { ControlPointSet, controlPointCount, eulerBasis, identityControlPoints } from "./controlpoints";
import { mulBasis } from "./f32";

const def = (json: JsonObject, instanceoverride?: unknown) =>
  parseParticle(json, { file: "p.json", orthographic: true, instanceoverride });
const sphere = (controlpoint?: number): JsonObject => ({
  name: "sphererandom",
  ...(controlpoint === undefined ? {} : { controlpoint }),
});
const translationOf = (set: ControlPointSet, i: number) => Array.from(set.current(i).translation);
const basisOf = (set: ControlPointSet, i: number) => Array.from(set.current(i).basis);
const IDENTITY_3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const closeTo = (actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 3) => {
  expect(actual.length).toBe(expected.length);
  Array.from(actual).forEach((value, i) => expect(value, `第 ${i} 项`).toBeCloseTo(expected[i], digits));
};
/** 对象世界矩阵：T(960, 540)·Rz(0.5)·S(2, 2, 1)（报告实测 cp-flag2 的对象）。 */
const W: Mat4 = multiply(multiply(translation(960, 540, 0), rotationZ(0.5)), scaling(2, 2, 1));
/** `M·B` 的平移与 3×3（double 参考值）。 */
function reference(matrix: Mat4, basis: number[], t: number[]) {
  const point = transformPoint(matrix, t[0], t[1], t[2]);
  const column = (c: number) => {
    const v = [basis[c * 3], basis[c * 3 + 1], basis[c * 3 + 2]];
    return [0, 1, 2].map((r) => matrix[r] * v[0] + matrix[4 + r] * v[1] + matrix[8 + r] * v[2]);
  };
  return { translation: point.slice(0, 3), basis: [...column(0), ...column(1), ...column(2)] };
}

describe("个数 n = max(controlpoint + 1)（rea-p4c-sim.md 1.1）", () => {
  it("遍历三类模块里模块表有 controlpoint 字段的项；没有时为 0；表外模块不计", () => {
    expect(controlPointCount(def({}))).toBe(0);
    expect(controlPointCount(def({ initializer: [{ name: "lifetimerandom" }] }))).toBe(0);
    // emitter 缺省读控制点 0
    expect(controlPointCount(def({ emitter: [sphere()] }))).toBe(1);
    expect(
      controlPointCount(
        def({
          emitter: [sphere(), { name: "boxrandom", controlpoint: 2 }],
          operator: [{ name: "vortex", controlpoint: 5 }],
        }),
      ),
    ).toBe(6);
    // -1 钳成 7
    expect(controlPointCount(def({ emitter: [sphere(-1)] }))).toBe(8);
    expect(
      controlPointCount(def({ emitter: [sphere()], operator: [{ name: "controlpointattract", controlpoint: 3 }] })),
    ).toBe(1);
  });

  it("n 之外的点不建：JSON 和实例覆盖写了也没有", () => {
    const set = new ControlPointSet(
      def({ emitter: [sphere(1)], controlpoint: [{}, {}, { offset: "5 5 5", flags: 2 }] }, { controlpoint3: "1 2 3" }),
    );
    expect(set.count).toBe(2);
    expect(() => set.current(2)).toThrow();
    expect(() => set.current(3)).toThrow();
  });
});

describe("初值：base = I + offset（1.3）", () => {
  it("offset 平移，JSON 的 angles 不起作用；current = previous = base", () => {
    const set = new ControlPointSet(
      def({ emitter: [sphere(1)], controlpoint: [{}, { offset: "100 50 -3", angles: "0 0 1.5708" }] }),
    );
    expect(translationOf(set, 1)).toEqual([100, 50, -3]);
    expect(basisOf(set, 1)).toEqual(IDENTITY_3);
    expect(Array.from(set.previous(1).translation)).toEqual([100, 50, -3]);
    expect(Array.from(set.previous(1).basis)).toEqual(IDENTITY_3);
    expect(translationOf(set, 0)).toEqual([0, 0, 0]);
  });

  it("offset 不是字符串、分量不足、有非数字", () => {
    const offset = (value: unknown) =>
      translationOf(new ControlPointSet(def({ emitter: [sphere()], controlpoint: [{ offset: value as never }] })), 0);
    expect(offset(5)).toEqual([0, 0, 0]);
    expect(offset({ value: "1 2 3" })).toEqual([0, 0, 0]);
    expect(offset("7")).toEqual([7, 0, 0]);
    expect(offset("7 8")).toEqual([7, 8, 0]);
    expect(offset("abc 2 3")).toEqual([0, 2, 3]);
    // 存 float32
    expect(offset("0.1 0 0")[0]).toBe(Math.fround(0.1));
  });
});

describe("instanceoverride 的控制点（第 2 节）", () => {
  const json = { emitter: [sphere(1)], controlpoint: [{}, { offset: "100 0 0" }] };

  it("controlpointN 替换平移，不加 offset；controlpointangleN 替换 3×3；两者各管一半", () => {
    expect(translationOf(new ControlPointSet(def(json, { controlpoint1: "0 200 0" })), 1)).toEqual([0, 200, 0]);
    const angled = new ControlPointSet(def(json, { controlpointangle1: "0 0 1.5707964" }));
    expect(translationOf(angled, 1)).toEqual([100, 0, 0]);
    expect(basisOf(angled, 1)).toEqual(Array.from(eulerBasis([0, 0, 1.5707964])));
    const both = new ControlPointSet(def(json, { controlpoint1: "1 2 3", controlpointangle1: "0 0 1" }));
    expect(translationOf(both, 1)).toEqual([1, 2, 3]);
    expect(basisOf(both, 1)).toEqual(Array.from(eulerBasis([0, 0, 1])));
    // 没设的控制点、读不出的值不动
    expect(translationOf(new ControlPointSet(def(json, { controlpoint0: "9 9 9", controlpoint1: "abc" })), 1)).toEqual([
      100, 0, 0,
    ]);
  });

  it("flags 1、4、0x10000（以及它们的组合）的点不覆盖；2、8、16 照常覆盖（0x14022bf26 的 0x10005）", () => {
    const at = (flags: number) =>
      new ControlPointSet(
        def(
          { emitter: [sphere(1)], controlpoint: [{}, { offset: "100 0 0", flags }] },
          {
            controlpoint1: "0 300 0",
            controlpointangle1: "0 0 1",
          },
        ),
      );
    for (const flags of [1, 4, 0x10000, 5, 6, 0x10002]) {
      expect(translationOf(at(flags), 1), String(flags)).toEqual([100, 0, 0]);
      expect(basisOf(at(flags), 1), String(flags)).toEqual(IDENTITY_3);
    }
    for (const flags of [0, 2, 8, 16, 24]) expect(translationOf(at(flags), 1), String(flags)).toEqual([0, 300, 0]);
  });

  it("eulerBasis：R = Rz·Ry·Rx，弧度；(0, 0, π/2) 把 x 轴转到 y 轴", () => {
    closeTo(mulBasis(eulerBasis([0, 0, Math.PI / 2]), [1, 0, 0]), [0, 1, 0], 6);
    closeTo(mulBasis(eulerBasis([0, 0, Math.PI / 2]), [0, 1, 0]), [-1, 0, 0], 6);
    // 三轴都非零：逐项和 double 的 Rz·Ry·Rx 比，并确认 Rx·Ry·Rz 明显不同（能区分乘法顺序）
    const [a, b, c] = [0.3, -0.7, 1.1];
    const rx = [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)];
    const ry = [Math.cos(b), 0, -Math.sin(b), 0, 1, 0, Math.sin(b), 0, Math.cos(b)];
    const rz = [Math.cos(c), Math.sin(c), 0, -Math.sin(c), Math.cos(c), 0, 0, 0, 1];
    const mul3 = (p: number[], q: number[]) =>
      Array.from({ length: 9 }, (_, i) => {
        const col = Math.floor(i / 3);
        const row = i % 3;
        return p[row] * q[col * 3] + p[3 + row] * q[col * 3 + 1] + p[6 + row] * q[col * 3 + 2];
      });
    const zyx = mul3(mul3(rz, ry), rx);
    const xyz = mul3(mul3(rx, ry), rz);
    const basis = eulerBasis([a, b, c]);
    closeTo(basis, zyx, 6);
    expect(Math.max(...zyx.map((value, i) => Math.abs(value - xyz[i])))).toBeGreaterThan(0.1);
  });
});

describe("每帧更新 FUN_14022e3e0（1.5）", () => {
  const points = (flags: number[], world = false) =>
    def({
      flags: world ? 1 : 0,
      emitter: [sphere(flags.length - 1)],
      controlpoint: flags.map((f) => ({ offset: "100 100 0", flags: f })),
    });

  it("本地系统：flags 2 是 inverse(W)·base，flags 0、4、16 不动；指针点（步骤 2）先是 base", () => {
    const set = new ControlPointSet(points([2, 0, 4, 16, 1, 6]));
    set.update({ world: W });
    const expected = reference(invert(W)!, IDENTITY_3, [100, 100, 0]);
    closeTo(translationOf(set, 0), expected.translation, 3);
    closeTo(basisOf(set, 0), expected.basis, 6);
    // 报告实测：对象 scale 2、angles 0.5 时基准点在场景 (100, 100)；W 乘回去就是它
    closeTo(transformPoint(W, ...(translationOf(set, 0) as [number, number, number])).slice(0, 2), [100, 100], 3);
    for (const i of [1, 2, 3, 4]) {
      expect(translationOf(set, i), String(i)).toEqual([100, 100, 0]);
      expect(basisOf(set, i), String(i)).toEqual(IDENTITY_3);
    }
    // flags 4 在顶层系统走缺省更新：4 | 2 同样 inverse(W)
    closeTo(translationOf(set, 5), expected.translation, 3);
  });

  it("世界系统：W·base；控制点 0 忽略 bit1，其余带 bit1 的不动", () => {
    const set = new ControlPointSet(points([2, 0, 2], true));
    set.update({ world: W });
    const expected = reference(W, IDENTITY_3, [100, 100, 0]);
    closeTo(translationOf(set, 0), expected.translation, 3);
    closeTo(basisOf(set, 0), expected.basis, 6);
    closeTo(translationOf(set, 1), expected.translation, 3);
    expect(translationOf(set, 2)).toEqual([100, 100, 0]);
  });

  it("0x10000 的点跳过（本地、世界都是）；current 一直是 base", () => {
    for (const world of [false, true]) {
      const set = new ControlPointSet(points([0x10002, 0x10000], world));
      set.update({ world: W });
      expect(translationOf(set, 0)).toEqual([100, 100, 0]);
      expect(translationOf(set, 1)).toEqual([100, 100, 0]);
    }
  });

  it("每次都从 base 算，不累乘；W 奇异时写 NaN", () => {
    const set = new ControlPointSet(points([2]));
    set.update({ world: W });
    set.update({ world: W });
    closeTo(translationOf(set, 0), reference(invert(W)!, IDENTITY_3, [100, 100, 0]).translation, 3);
    set.update({ world: scaling(0, 1, 1) });
    expect(translationOf(set, 0).every(Number.isNaN)).toBe(true);
  });

  it("实例覆盖之后的 base 参与换算（角度也乘）", () => {
    const set = new ControlPointSet(
      def(
        { emitter: [sphere(1)], controlpoint: [{}, { flags: 2 }] },
        { controlpoint1: "100 100 0", controlpointangle1: "0 0 1" },
      ),
    );
    set.update({ world: W });
    const expected = reference(invert(W)!, Array.from(eulerBasis([0, 0, 1])), [100, 100, 0]);
    closeTo(translationOf(set, 1), expected.translation, 3);
    closeTo(basisOf(set, 1), expected.basis, 6);
  });

  it("endFrame：previous ← current（在 update 之后才变）", () => {
    const set = new ControlPointSet(points([2]));
    set.update({ world: W });
    expect(Array.from(set.previous(0).translation)).toEqual([100, 100, 0]);
    set.endFrame();
    expect(Array.from(set.previous(0).translation)).toEqual(translationOf(set, 0));
    expect(Array.from(set.previous(0).basis)).toEqual(basisOf(set, 0));
    // previous 是拷贝，不随 current 变
    set.update({ world: translation(1000, 0, 0) });
    expect(Array.from(set.previous(0).translation)).not.toEqual(translationOf(set, 0));
  });

  it("identityControlPoints：8 个单位阵", () => {
    const set = identityControlPoints();
    expect(set.count).toBe(8);
    set.update({ world: W });
    for (let i = 0; i < 8; i++) {
      expect(translationOf(set, i)).toEqual([0, 0, 0]);
      expect(basisOf(set, i)).toEqual(IDENTITY_3);
    }
  });
});

describe("mulBasis（FUN_140184440 与两个发射器的旋转，汇编核对过求和顺序）", () => {
  it("(x·M0j + y·M1j) + z·M2j，逐步 float32；单位阵精确", () => {
    const f = Math.fround;
    const basis = [0.1, 0.2, 0.3, 1.5, -2.5, 3.5, 7, 8, 9].map(f);
    const v = [f(1.1), f(-2.2), f(3.3)];
    expect(mulBasis(basis, v)).toEqual(
      [0, 1, 2].map((j) => f(f(f(v[0] * basis[j]) + f(v[1] * basis[3 + j])) + f(v[2] * basis[6 + j]))),
    );
    expect(mulBasis([1, 0, 0, 0, 1, 0, 0, 0, 1], v)).toEqual(v);
  });
});
