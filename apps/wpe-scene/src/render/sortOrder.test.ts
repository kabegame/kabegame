/**
 * P5d 步骤 4 的 `transparentDrawOrder` / `transparentSortKey`（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`
 * 「步骤 4」点 2、点 4）：
 * - 步骤 0 的 7 组 WPE 实测顺序逐个复现（p5-REPORT「步骤 4 步骤 0：透明排序」，工程 `ignore/p5/d4/gen_d4.py`，抓帧 `A:\p5d\sort\`），
 *   期望取 WPE 的结果；`-off` / `-ortho` 在渲染器那一层不调排序（`p5d4-sort.test.ts`），这里只核对「全不透明 / 开关关时」不重排；
 * - 稳定（键相同保持原顺序，含两个 `last`）、用状态里的当帧 origin（不是编译期的值、不是世界位置）、任意前向、键按 float32。
 * 前向照渲染器取透视相机的视线方向（`lookAtVectors`，float32）。
 */
import { describe, expect, it } from "vitest";
import type { SortClass } from "../compile/bundle";
import type { Vec3 } from "../compile/camera";
import { lookAtVectors } from "./camera";
import { transparentDrawOrder, transparentSortKey, type SortState } from "./sortOrder";

interface Item {
  object: number;
  name: string;
  sortClass?: SortClass;
}
interface Spec {
  name: string;
  sortClass?: SortClass;
  /** 当帧状态里的局部 origin。 */
  origin: number[];
  /** 父对象的下标（状态里同 `LayerState.parent`）：排序不该看它。 */
  parent?: number;
}

/** 按 `objects` 顺序的对象 → 图层与状态（状态带 `parent`，同 `SceneState.layers`）。 */
function scene(specs: Spec[]): { items: Item[]; state: SortState } {
  const items = specs.map((spec, object) => ({ object, name: spec.name, sortClass: spec.sortClass }));
  const layers = new Map(specs.map((spec, object) => [object, { origin: spec.origin, parent: spec.parent ?? null }]));
  return { items, state: { layers } };
}
const names = (items: readonly Item[]) => items.map((item) => item.name);
/** 透视相机的视线方向（同 `perspectiveCamera` 的 `vectors.forward`：float32）。 */
const forwardOf = (eye: Vec3, center: Vec3 = [0, 0, 0], up: Vec3 = [0, 1, 0]): Vec3 =>
  lookAtVectors(eye, center, up).forward.map((value) => Math.fround(value) + 0) as Vec3;
/** 步骤 0 的基准相机：eye (0, 0, 10) 看向原点。 */
const BASE_FORWARD = forwardOf([0, 0, 10]);
/** 工程最前面的帧号 / 时钟图层（normal，原点 (0, 0, 0)）。 */
const HEAD: Spec[] = [
  { name: "FR", sortClass: "opaque", origin: [0, 0, 0] },
  { name: "CLK", sortClass: "opaque", origin: [0, 0, 0] },
];

describe("transparentDrawOrder：步骤 0 的 7 组 WPE 实测顺序", () => {
  it("基准相机的前向是 (0, 0, −1)", () => {
    expect(BASE_FORWARD).toEqual([0, 0, -1]);
  });

  /** `p5d-sort-a` 的对象；S 编译期的 z 是 −9，原点脚本返回 +5，这里是脚本写回之后的状态。 */
  const SORT_A: Spec[] = [
    ...HEAD,
    { name: "A", sortClass: "opaque", origin: [-1, 0, -5] },
    { name: "B", sortClass: "translucent", origin: [-0.5, 0, 2] },
    { name: "C", sortClass: "translucent", origin: [0, 0, -8] },
    { name: "D", sortClass: "opaque", origin: [0.5, 0, 3] },
    { name: "E", sortClass: "translucent", origin: [1, 0, 0] }, // additive
    { name: "M1", sortClass: "translucent", origin: [0, 1, -6] }, // 网格全 translucent
    { name: "M2", sortClass: "opaque", origin: [0, -1, -7] }, // normal 网格
    { name: "P", sortClass: "translucent", origin: [1.5, 1, -4] }, // 粒子
    { name: "S", sortClass: "translucent", origin: [-1.5, 0, 5] },
  ];

  it("p5d-sort-a（开）：FR、CLK、A、D、M2 → C(8)、M1(6)、粒子(4)、E(0)、B(−2)、S(−5)", () => {
    const { items, state } = scene(SORT_A);
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD))).toEqual([
      "FR",
      "CLK",
      "A",
      "D",
      "M2",
      "C",
      "M1",
      "P",
      "E",
      "B",
      "S",
    ]);
  });

  it("p5d-sort-a 的 S 若按编译期的 z −9 排会排到最前（键 9）：排序读的是状态里脚本写回之后的值", () => {
    const stored = SORT_A.map((spec) => (spec.name === "S" ? { ...spec, origin: [-1.5, 0, -9] } : spec));
    const { items, state } = scene(stored);
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD)).slice(5, 7)).toEqual(["S", "C"]);
  });

  it("p5d-sort-off（关）：渲染器不调排序；全都不在半透明名单时同样是 objects 顺序", () => {
    const { items, state } = scene(SORT_A.map((spec) => ({ ...spec, sortClass: undefined })));
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD))).toEqual(SORT_A.map((spec) => spec.name));
  });

  it("p5d-sort-rot（相机在 +x 看向原点）：J(x −5)、L(x 0)、K(x +3)", () => {
    const forward = forwardOf([10, 0, 0]);
    expect(forward).toEqual([-1, 0, 0]);
    const { items, state } = scene([
      ...HEAD,
      { name: "K", sortClass: "translucent", origin: [3, 0, 0] },
      { name: "J", sortClass: "translucent", origin: [-5, 0, 0] },
      { name: "L", sortClass: "translucent", origin: [0, 0, 0.5] },
    ]);
    expect(names(transparentDrawOrder(items, state, forward))).toEqual(["FR", "CLK", "J", "L", "K"]);
  });

  it("p5d-sort-par：F 在分组 G（z +5）下、局部 z −6（世界 −1）排在 H（z −3）前面：用局部 origin", () => {
    const { items, state } = scene([
      ...HEAD,
      { name: "G", origin: [0, 0, 5] }, // 分组节点：没有类别
      { name: "H", sortClass: "translucent", origin: [1, 0, -3] },
      { name: "F", sortClass: "translucent", origin: [-1, 0, -6], parent: 2 },
    ]);
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD))).toEqual(["FR", "CLK", "G", "F", "H"]);
  });

  it("p5d-sort-eq：I1、I2、I3 同在 z −2，I0 在 z −9 → I0、I1、I2、I3（稳定）", () => {
    const { items, state } = scene([
      ...HEAD,
      { name: "I1", sortClass: "translucent", origin: [-1, 0, -2] },
      { name: "I2", sortClass: "translucent", origin: [0, 0, -2] },
      { name: "I3", sortClass: "translucent", origin: [1, 0, -2] },
      { name: "I0", sortClass: "translucent", origin: [0, 1, -9] },
    ]);
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD))).toEqual(["FR", "CLK", "I0", "I1", "I2", "I3"]);
  });

  it("p5d-sort-fs：FR、CLK、N → T1(3)、T2(0) → FS、PL（−∞ 排最后、原点在最远处也一样，两者保持原顺序）", () => {
    const { items, state } = scene([
      ...HEAD,
      { name: "FS", sortClass: "last", origin: [0, 0, -20] },
      { name: "PL", sortClass: "last", origin: [0, 0, -20] },
      { name: "T1", sortClass: "translucent", origin: [-1, 0, -3] },
      { name: "T2", sortClass: "translucent", origin: [1, 0, 0] },
      { name: "N", sortClass: "opaque", origin: [0, 1, -1] },
    ]);
    expect(names(transparentDrawOrder(items, state, BASE_FORWARD))).toEqual(["FR", "CLK", "N", "T1", "T2", "FS", "PL"]);
  });

  it("p5d-sort-ortho：正交场景渲染器不调排序（`p5d4-sort.test.ts`）；这里核对正交那一组若被排会和 WPE 不同（排序确实改顺序）", () => {
    const { items, state } = scene([
      ...HEAD,
      { name: "A", sortClass: "opaque", origin: [760, 540, -5] },
      { name: "B", sortClass: "translucent", origin: [860, 540, 2] },
      { name: "C", sortClass: "translucent", origin: [960, 540, -8] },
      { name: "D", sortClass: "opaque", origin: [1060, 540, 3] },
    ]);
    // WPE 的结果是 objects 顺序（FR、CLK、A、B、C、D）；正交的视线是 −z，排了就成了下面这样
    expect(names(transparentDrawOrder(items, state, [0, 0, -1]))).toEqual(["FR", "CLK", "A", "D", "C", "B"]);
  });
});

describe("transparentDrawOrder：稳定、当帧状态、任意前向", () => {
  it("键相同保持原顺序，不论在列表的哪一段；两个 last 保持原顺序", () => {
    const { items, state } = scene([
      { name: "a", sortClass: "translucent", origin: [0, 0, -1] },
      { name: "L1", sortClass: "last", origin: [0, 0, 100] },
      { name: "b", sortClass: "translucent", origin: [0, 0, -3] },
      { name: "c", sortClass: "translucent", origin: [5, 0, -1] },
      { name: "L2", sortClass: "last", origin: [0, 0, -100] },
      { name: "d", sortClass: "translucent", origin: [0, 9, -3] },
      { name: "e", sortClass: "translucent", origin: [0, 0, -1] },
    ]);
    expect(names(transparentDrawOrder(items, state, [0, 0, -1]))).toEqual(["b", "d", "a", "c", "e", "L1", "L2"]);
  });

  it("last 排在键最小的半透明之后（含键为负的、−1e30 的）", () => {
    const { items, state } = scene([
      { name: "L", sortClass: "last", origin: [0, 0, -1e9] },
      { name: "far", sortClass: "translucent", origin: [0, 0, 1e30] },
      { name: "near", sortClass: "translucent", origin: [0, 0, 5] },
    ]);
    expect(names(transparentDrawOrder(items, state, [0, 0, -1]))).toEqual(["near", "far", "L"]);
  });

  it("不透明与没有类别的保持原顺序排在前面，不看 origin", () => {
    const { items, state } = scene([
      { name: "t", sortClass: "translucent", origin: [0, 0, -9] },
      { name: "o1", sortClass: "opaque", origin: [0, 0, 9] },
      { name: "x", origin: [0, 0, -50] },
      { name: "o2", sortClass: "opaque", origin: [0, 0, -50] },
    ]);
    expect(names(transparentDrawOrder(items, state, [0, 0, -1]))).toEqual(["o1", "x", "o2", "t"]);
  });

  it("读状态里该对象当前的 origin：同一份图层，状态变了顺序跟着变；状态里没有的按原点", () => {
    const items: Item[] = [
      { object: 3, name: "p", sortClass: "translucent" },
      { object: 7, name: "q", sortClass: "translucent" },
      { object: 9, name: "r", sortClass: "translucent" },
    ];
    const layers = new Map<number, { origin: number[] }>([
      [3, { origin: [0, 0, 1] }],
      [7, { origin: [0, 0, -1] }],
    ]);
    // r 不在状态里：键 0
    expect(names(transparentDrawOrder(items, { layers }, [0, 0, -1]))).toEqual(["q", "r", "p"]);
    layers.set(3, { origin: [0, 0, -4] });
    expect(names(transparentDrawOrder(items, { layers }, [0, 0, -1]))).toEqual(["p", "q", "r"]);
  });

  it("任意前向：键是 origin · forward（斜向、y 轴、反向）", () => {
    const { items, state } = scene([
      { name: "a", sortClass: "translucent", origin: [1, 0, 0] },
      { name: "b", sortClass: "translucent", origin: [0, 1, 0] },
      { name: "c", sortClass: "translucent", origin: [0, 0, 1] },
      { name: "d", sortClass: "translucent", origin: [1, 1, 1] },
    ]);
    const diagonal = forwardOf([-3, -2, -1]);
    // 斜向 (3, 2, 1)/√14：d(6) > a(3) > b(2) > c(1)
    expect(names(transparentDrawOrder(items, state, diagonal))).toEqual(["d", "a", "b", "c"]);
    // 相机在 +y 上方往下看：前向 (0, −1, 0)
    expect(names(transparentDrawOrder(items, state, forwardOf([0, 10, 0], [0, 0, 0], [0, 0, 1])))).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
    // 前向 (0, 0, 1)：c、d 并列取原顺序
    expect(names(transparentDrawOrder(items, state, [0, 0, 1]))).toEqual(["c", "d", "a", "b"]);
  });

  it("不改输入，返回新数组", () => {
    const { items, state } = scene([
      { name: "a", sortClass: "translucent", origin: [0, 0, 1] },
      { name: "b", sortClass: "translucent", origin: [0, 0, -1] },
    ]);
    const before = [...items];
    const order = transparentDrawOrder(items, state, [0, 0, -1]);
    expect(names(order)).toEqual(["b", "a"]);
    expect(items).toEqual(before);
    expect(order).not.toBe(items);
  });
});

describe("transparentSortKey：float32 依次乘加", () => {
  it("值逐项按 float32 取整", () => {
    const f = Math.fround;
    const origin = [0.1, 0.2, 0.3];
    const forward = [0.6, 0.7, 0.4];
    const expected = f(f(f(f(0.1) * f(0.6)) + f(f(0.2) * f(0.7))) + f(f(0.3) * f(0.4)));
    expect(transparentSortKey(origin, forward)).toBe(expected);
    expect(transparentSortKey([1, 2, 3], [0, 0, -1])).toBe(-3);
    // 缺分量按 0
    expect(transparentSortKey([2], [1, 1, 1])).toBe(2);
  });

  it("双精度下不同、float32 下相同的两个键算并列，保持原顺序", () => {
    const { items, state } = scene([
      { name: "a", sortClass: "translucent", origin: [0, 0, -1] },
      { name: "b", sortClass: "translucent", origin: [0, 0, -(1 + 1e-9)] },
    ]);
    expect(transparentSortKey([0, 0, -(1 + 1e-9)], [0, 0, -1])).toBe(transparentSortKey([0, 0, -1], [0, 0, -1]));
    expect(names(transparentDrawOrder(items, state, [0, 0, -1]))).toEqual(["a", "b"]);
  });

  it("x、y、z 依次加（先 x + y 再加 z）：和先加 y + z 的结果不同的一组", () => {
    const f = Math.fround;
    // x·1 + y·1 先加在 float32 里丢掉 y，再加 z；按 x + (y + z) 会保留 y + z
    const origin = [16777216, 1, 1];
    expect(transparentSortKey(origin, [1, 1, 1])).toBe(f(f(f(16777216) + 1) + 1));
    expect(transparentSortKey(origin, [1, 1, 1])).toBe(16777216);
    expect(f(16777216 + f(1 + 1))).toBe(16777218);
  });
});
