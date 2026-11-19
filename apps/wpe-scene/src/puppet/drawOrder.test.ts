/**
 * P12f 点 2：`drawOrder.ts` 的纯函数（键与取整、三种叠法、`reorder` 的非降序判断与稳定性、`clippingTable` 按位置建表）。
 * 依据 `rea-p12f-draworder.md` 第 2、3、5 节；float32 的期望值用 numpy float32 逐步算出（`f(f(f(1 − w)·c) + f(v·w))` 等）后写死。
 */
import { describe, expect, it } from "vitest";
import {
  blendDrawOrder,
  clippingTable,
  cvttss2si,
  fileIndices,
  orderedIndices,
  reorder,
  type DrawNode,
  type DrawRecord,
} from "./drawOrder";

const f = Math.fround;
const MIN = -2147483648;

describe("cvttss2si：向零取整，NaN 与越界得 −2³¹", () => {
  it.each<[string, number, number]>([
    ["−0.9 → 0（不是 −1）", -0.9, 0],
    ["−1.5 → −1", -1.5, -1],
    ["1.9 → 1", 1.9, 1],
    ["−100 + 49.5 → −50（float32 相加后取整）", f(-100) + f(49.5), -50],
    ["NaN", NaN, MIN],
    ["+∞", Infinity, MIN],
    ["−∞", -Infinity, MIN],
    ["2³¹ 越界", 2147483648, MIN],
    ["−2³¹ 恰好", -2147483648, MIN],
    ["3e9 越界", 3e9, MIN],
    ["−3e9 越界", -3e9, MIN],
    ["2³¹ 以内最大的 float32", 2147483520, 2147483520],
  ])("%s", (_name, x, want) => {
    expect(cvttss2si(x)).toBe(want);
  });
});

describe("blendDrawOrder：三种叠法（rea-F 2.2）", () => {
  const ones = Uint8Array.of(1, 1);

  it("覆盖：cur = lo 帧的值，不插值、不看基数；返回有写", () => {
    const cur = Float32Array.of(5, 6);
    const track = Float32Array.of(1, 2, 3, 4); // 2 帧 × 2 骨骼
    expect(blendDrawOrder(cur, Int32Array.of(100, 200), track, ones, 2, 1, 1, "override")).toBe(true);
    expect(Array.from(cur)).toEqual([3, 4]);
  });

  it("mask 为 0 的骨骼跳过；全跳过时返回 false 且 cur 不变", () => {
    const cur = Float32Array.of(5, 6);
    const track = Float32Array.of(1, 2, 3, 4);
    expect(blendDrawOrder(cur, Int32Array.of(0, 0), track, Uint8Array.of(1, 0), 2, 0, 1, "override")).toBe(true);
    expect(Array.from(cur)).toEqual([1, 6]);
    const same = Float32Array.of(5, 6);
    expect(blendDrawOrder(same, Int32Array.of(0, 0), track, Uint8Array.of(0, 0), 2, 0, 1, "override")).toBe(false);
    expect(Array.from(same)).toEqual([5, 6]);
  });

  it("混合：f(f(f(1 − w)·cur) + f(v·w))，float32", () => {
    const cases: [number, number, number, number][] = [
      [3, 7, f(0.1), 3.3999998569488525],
      [100, 0, 0.5, 50],
      [f(0.3), f(1.7), f(0.3), 0.7200000286102295],
    ];
    for (const [c, v, w, want] of cases) {
      const cur = Float32Array.of(c);
      blendDrawOrder(cur, Int32Array.of(0), Float32Array.of(v), Uint8Array.of(1), 1, 0, w, "mix");
      expect(cur[0], `cur ${c} v ${v} w ${w}`).toBe(want);
    }
  });

  it("混合：权重 0 时 cur 不变，但仍算写过（返回 true，w0）", () => {
    const cur = Float32Array.of(123.5);
    expect(blendDrawOrder(cur, Int32Array.of(0), Float32Array.of(9), Uint8Array.of(1), 1, 0, 0, "mix")).toBe(true);
    expect(cur[0]).toBe(123.5);
  });

  it("加法：减的是骨骼基数，结果钳在 [min(cur, v), max(cur, v)]", () => {
    const run = (cur0: number, v: number, w: number, base: number) => {
      const cur = Float32Array.of(cur0);
      blendDrawOrder(cur, Int32Array.of(base), Float32Array.of(v), Uint8Array.of(1), 1, 0, f(w), "add");
      return cur[0];
    };
    // 未钳时 s = 200，钳到 max(cur, v) = 150（add_clamp）
    expect(run(100, 150, 2, 100)).toBe(150);
    // 刚好在区间里：s = (140 − 100)·1 + 100 = 140
    expect(run(100, 140, 1, 100)).toBe(140);
    // v 比 cur 小：s = 50 在 [50, 100] 里
    expect(run(100, 50, 1, 100)).toBe(50);
    // 负权重：s = 50 低于 min(cur, v) = 100，钳到 100
    expect(run(100, 150, -1, 100)).toBe(100);
    // 减 0 与减 base 不同（add_base）：base 0 时 s = 150·1 + 100 = 250 → 钳到 150；base 100 时 s = 150
    expect(run(100, 150, 1, 0)).toBe(150);
    expect(run(100, 150, 1, 100)).toBe(150);
    expect(run(100, 120, 1, 0)).toBe(120);
    expect(run(100, 120, 1, 100)).toBe(120);
    // 小数：float32 逐步（numpy float32：s = f(f(f(0.7 − 0)·0.3) + 0.1)，在 [0.1, 0.7] 里不钳）
    expect(run(f(0.1), f(0.7), 0.3, 0)).toBe(0.3100000023841858);
  });

  it("加法：权重 0 时 s = cur，结果仍在区间里、不变", () => {
    const cur = Float32Array.of(80);
    expect(blendDrawOrder(cur, Int32Array.of(50), Float32Array.of(200), Uint8Array.of(1), 1, 0, 0, "add")).toBe(true);
    expect(cur[0]).toBe(80);
  });
});

/** 三个节点，同一根骨骼，base 给定。 */
const nodes3 = (bases: number[]): DrawNode[] => bases.map((base, i) => ({ base, bone: 0, start: 3 * i, count: 3 }));

describe("reorder：非降序不动、稳定、以当前顺序为输入", () => {
  it("键 [50, 50, 10]：乱序 → 稳定排序成 [2, 0, 1]；写进 keys（按节点下标）", () => {
    const order = Int32Array.of(0, 1, 2);
    const keys = new Int32Array(3);
    expect(reorder(order, nodes3([50, 50, 10]), Float32Array.of(0), keys)).toBe(true);
    expect(Array.from(order)).toEqual([2, 0, 1]);
    expect(Array.from(keys)).toEqual([50, 50, 10]);
  });

  it("已经非降序（含并列）返回 false，order 一点都不动", () => {
    const order = Int32Array.of(2, 0, 1);
    expect(reorder(order, nodes3([50, 50, 10]), Float32Array.of(0), new Int32Array(3))).toBe(false);
    expect(Array.from(order)).toEqual([2, 0, 1]);
    // 全并列：不回到组表顺序（hist3 / tie40）
    const tied = Int32Array.of(2, 0, 1);
    expect(reorder(tied, nodes3([5, 5, 5]), Float32Array.of(0), new Int32Array(3))).toBe(false);
    expect(Array.from(tied)).toEqual([2, 0, 1]);
  });

  it("并列保持当前顺序（输入是上一次的结果），不是组表顺序", () => {
    // 当前顺序 [1, 0, 2]，键 node0 = node1 = 7、node2 = 3：2 排到最前，1 仍在 0 前面
    const order = Int32Array.of(1, 0, 2);
    expect(reorder(order, nodes3([7, 7, 3]), Float32Array.of(0), new Int32Array(3))).toBe(true);
    expect(Array.from(order)).toEqual([2, 1, 0]);
  });

  it("键 = trunc(f(base) + cur[骨骼])：cur 变了顺序跟着变，第二次从上一次的顺序出发", () => {
    const nodes: DrawNode[] = [
      { base: 100, bone: 0, start: 0, count: 3 },
      { base: 100, bone: 1, start: 3, count: 3 },
    ];
    const order = Int32Array.of(0, 1);
    const keys = new Int32Array(2);
    // 键 [100, 99.5 → 99] → 1 在前
    expect(reorder(order, nodes, Float32Array.of(0, -0.5), keys)).toBe(true);
    expect(Array.from(order)).toEqual([1, 0]);
    expect(Array.from(keys)).toEqual([100, 99]);
    // 再变成 [100, 100]：当前顺序 [1, 0] 已非降序，不动（不回 [0, 1]）
    expect(reorder(order, nodes, Float32Array.of(0, 0), keys)).toBe(false);
    expect(Array.from(order)).toEqual([1, 0]);
    // 变成 [100, 101]：当前 [1, 0] 键 [101, 100] 乱 → 排回 [0, 1]
    expect(reorder(order, nodes, Float32Array.of(0, 1), keys)).toBe(true);
    expect(Array.from(order)).toEqual([0, 1]);
  });

  it("NaN 与越界的键都是 −2³¹，并列时保持顺序", () => {
    const nodes = nodes3([0, 0, 0]);
    const order = Int32Array.of(0, 1, 2);
    const keys = new Int32Array(3);
    expect(reorder(order, nodes, Float32Array.of(NaN), keys)).toBe(false);
    expect(Array.from(keys)).toEqual([MIN, MIN, MIN]);
  });

  it("按 order 拼索引：各节点的 [start, start + count) 依次接起来", () => {
    const file = Uint16Array.from({ length: 9 }, (_, i) => i);
    expect(Array.from(orderedIndices([2, 0, 1], nodes3([0, 0, 0]), file))).toEqual([6, 7, 8, 0, 1, 2, 3, 4, 5]);
    // 文件索引不够长的部分丢掉
    expect(Array.from(orderedIndices([0], [{ base: 0, bone: 0, start: 7, count: 5 }], file))).toEqual([7, 8]);
  });

  it("fileIndices：没对齐的字节也按小端 u16 读", () => {
    const buffer = new Uint8Array([9, 1, 0, 2, 0, 3, 0]);
    expect(Array.from(fileIndices(buffer.subarray(1)))).toEqual([1, 2, 3]);
  });
});

describe("clippingTable：位置 p 的节点是 order[p]", () => {
  // 4 个节点各 3 个索引，文件索引 = 位置（0..11）
  const nodes = nodes3([0, 0, 0, 0]);
  const file = Uint16Array.from({ length: 12 }, (_, i) => i);
  const idx = (...n: number[]) => Uint16Array.from(n.flatMap((g) => [3 * g, 3 * g + 1, 3 * g + 2]));
  const rec = (list1: number[], list2: number[], name = "m"): DrawRecord => ({
    name,
    flags: 0,
    list1,
    list2,
    parent: -1,
  });

  it("单条记录：组表顺序", () => {
    const table = clippingTable([0, 1, 2, 3], nodes, [rec([1], [0])], file);
    expect(table.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "normal", segment: 3 },
    ]);
    // 普通段 {0}（遮罩节点本身画一次），遮罩 {0}，目标 {1}，末段 {2, 3}
    expect(table.segments).toEqual([idx(0), idx(0), idx(1), idx(2, 3)]);
  });

  it("单条记录：位置 ≠ 组号（节点 0 与 1 互换位置）——目标在位置 0、遮罩在位置 1，段内容按 nodes[order[p]]", () => {
    const table = clippingTable([1, 0, 2, 3], nodes, [rec([1], [0])], file);
    expect(table.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "normal", segment: 3 },
    ]);
    expect(table.segments).toEqual([idx(0), idx(0), idx(1), idx(2, 3)]);
    // 目标节点 1 排在遮罩节点 0 之前：这一次普通段在遮罩位置落，目标仍在遮罩之后画（和上面同样的段，只是位置不同）；
    // 再换到遮罩更早：目标在位置 3、遮罩在位置 0
    const late = clippingTable([0, 2, 3, 1], nodes, [rec([1], [0])], file);
    expect(late.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "normal", segment: 3 },
    ]);
    expect(late.segments).toEqual([idx(0), idx(0), idx(1), idx(2, 3)]);
  });

  it("两条记录 A{目标 3、遮罩 0} B{目标 2、遮罩 1}：组表顺序 → 普通、A、普通、B（clip_two 的一种状态）", () => {
    const records = [rec([3], [0], "a"), rec([2], [1], "b")];
    const table = clippingTable([0, 1, 2, 3], nodes, records, file);
    expect(table.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "normal", segment: 3 },
      { kind: "clip", record: 1, mask: 4, target: 5 },
    ]);
    expect(table.segments).toEqual([idx(0), idx(0), idx(3), idx(1), idx(1), idx(2)]);
  });

  it("同样两条记录，顺序倒过来 [3, 2, 1, 0]：记录先后与段内容按新位置重建（clip_two 的另一种状态）", () => {
    const records = [rec([3], [0], "a"), rec([2], [1], "b")];
    const table = clippingTable([3, 2, 1, 0], nodes, records, file);
    expect(table.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 1, mask: 1, target: 2 },
      { kind: "normal", segment: 3 },
      { kind: "clip", record: 0, mask: 4, target: 5 },
    ]);
    expect(table.segments).toEqual([idx(1), idx(1), idx(2), idx(0), idx(0), idx(3)]);
  });

  it("遮罩区间 = 首末遮罩位置之间除目标外的全部位置（list2 不相邻时含中间的组）", () => {
    // 4 个节点：list2 = {0, 3}，目标 = {1}；位置 1 是目标，不进遮罩段；位置 2 在区间里 → 进
    const table = clippingTable([0, 1, 2, 3], nodes, [rec([1], [0, 3])], file);
    // 位置 0：非目标 → 普通 {0}；0 是遮罩节点但末遮罩位置是 3，不落段。位置 1 目标跳过。位置 2：普通。位置 3：普通并落段，再发射裁切
    expect(table.commands).toEqual([
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
    ]);
    expect(table.segments).toEqual([idx(0, 2, 3), idx(0, 2, 3), idx(1)]);
  });

  it("嵌套父记录：末遮罩位置沿链取最大", () => {
    // 记录 1 的遮罩 {1} 本身被记录 0 裁切（记录 0 的目标含 1）→ 记录 1 的末遮罩位置取 max(1, 记录 0 的末位置 3)
    const records: DrawRecord[] = [rec([1, 2], [3], "a"), { ...rec([0], [1], "b"), parent: 0 }];
    const table = clippingTable([0, 1, 2, 3], nodes, records, file);
    // 两条记录都在位置 3 落：按最小目标位置排（b 的目标在位置 0 < a 的目标位置 1）
    expect(table.commands.map((c) => (c.kind === "clip" ? c.record : "n"))).toEqual(["n", 1, 0]);
  });

  it("没有记录：全部节点是一个普通段（调用方只在有记录时才建表）", () => {
    expect(clippingTable([0, 1, 2, 3], nodes, [], file)).toEqual({
      commands: [{ kind: "normal", segment: 0 }],
      segments: [file],
    });
  });
});
