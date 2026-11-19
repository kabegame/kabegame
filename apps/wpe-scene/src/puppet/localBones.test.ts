/**
 * P12g 点 2：局部矩阵的纯函数（`localBones.ts`）。读回值与矩阵取自 WPE 实测（`ignore/p12/g/meas/REPORT.md` 表 7、8、10，夹具 `fixtures/p12g-local.json` 里
 * la 的 u1 / t4–t9 与 la2 的 t4–t11）；`recomputeSubtree` 的子树判定与「完整乘法」用手算的小骨架验。
 */
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/p12g-local.json";
import { localAngles, recomputeSubtree, writeLocalAngles } from "./localBones";
import { mulFull } from "./math";

const f = Math.fround;
const logs = (fixture as unknown as { local: { logs: Record<string, string[]> } }).local.logs.la;
const mat = (text: string) => Float32Array.from(text.split(" ").map(Number));
/** la 的日志行 `tN,<矩阵>[,ang,<三个数>]` 里的矩阵与角度。 */
const row = (tag: string) =>
  logs.find((line) => line.startsWith(`${tag},`) && !line.startsWith(`${tag},done`))!.split(",");

const B1 = mat("1.7320507764816284 1 0 0 -0.5 0.8660253882408142 0 0 0 0 1 0 100 0 0 1");
const IDENTITY = mat("1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1");

describe("localAngles（getLocalBoneAngles）", () => {
  it("(0.3, 0.4, 0.5) 的 Rz·Ry·Rx 读回原值（t5 的读回值，逐位；矩阵用 writeLocalAngles 现算，日志里的 -0 会被打印成 0）", () => {
    const m = Float32Array.from(IDENTITY);
    writeLocalAngles(m, 0, [f(0.3), f(0.4), f(0.5)]);
    expect(localAngles(m, 0).map(String)).toEqual(row("t5")[3].split(" "));
  });

  it("(0, 2, 0) 读回等价的另一组角 (π, π − 2, −π)（t6，|y| > π/2；符号由 c0.y = -0 决定）", () => {
    const m = Float32Array.from(IDENTITY);
    writeLocalAngles(m, 0, [0, 2, 0]);
    expect(localAngles(m, 0).map(String)).toEqual(row("t6")[3].split(" "));
    expect(localAngles(m, 0).map(String)).toEqual(["3.141592502593994", "1.1415926218032837", "-3.1415927410125732"]);
  });

  it("不去缩放：b1（30°、S(2,1,1)）读回 (0, 0, 0.5236)，缩放不影响 z；非均匀缩放让 x 失真（t7：Rx(0.5)·S(1,2,1) 读回 0.2666…）", () => {
    expect(localAngles(B1, 0).map(String)).toEqual(["0", "0", "0.5235987901687622"]);
    const t7 = row("t7").length ? logs.find((line) => line.startsWith("t7,set,"))!.split(",") : [];
    expect(localAngles(mat(t7[2]), 0).map(String)).toEqual(t7[4].split(" "));
    expect(localAngles(mat(t7[2]), 0)[0]).toBe(f(0.2666466236114502));
  });

  it("读矩阵的偏移 o：第二根骨骼的局部矩阵", () => {
    const both = new Float32Array(32);
    both.set(IDENTITY, 0);
    both.set(B1, 16);
    expect(localAngles(both, 16)[2]).toBe(f(0.5235987901687622));
    expect(localAngles(both, 0).map(String)).toEqual(["0", "0", "0"]);
  });
});

describe("writeLocalAngles（setLocalBoneAngles）", () => {
  it("t4：(0, 0, 1.5707964) 转 90°（弧度，不是度）", () => {
    const m = Float32Array.from(IDENTITY);
    writeLocalAngles(m, 0, [0, 0, f(1.5707964)]);
    expect(Array.from(m, String).join(" ")).toBe(row("t4")[1]);
  });

  it("t5、t6：Rz·Ry·Rx 的前三列逐位", () => {
    for (const [tag, v] of [
      ["t5", [f(0.3), f(0.4), f(0.5)]],
      ["t6", [0, 2, 0]],
    ] as const) {
      const m = Float32Array.from(IDENTITY);
      writeLocalAngles(m, 0, v);
      expect(Array.from(m, String).join(" "), tag).toBe(row(tag)[1]);
    }
  });

  it("t8：b1 写 (0.5, 0, 0)：缩放与剪切丢掉（前三列整个重写、w 写 0），平移 (100, 0, 0) 与 m[15] 保留", () => {
    const m = Float32Array.from(B1);
    m[3] = 7; // 脏的 w 也要被写成 0
    m[15] = 1;
    writeLocalAngles(m, 0, [f(0.5), 0, 0]);
    expect(Array.from(m, String).join(" ")).toBe(row("t8")[1]);
    expect(m[3]).toBe(0);
    expect(Array.from(m.slice(12))).toEqual([100, 0, 0, 1]);
  });

  it("写进偏移 o 处，别的骨骼不动", () => {
    const both = new Float32Array(32).fill(9);
    writeLocalAngles(both, 16, [0, 0, 0]);
    expect(Array.from(both.slice(0, 16))).toEqual(new Array(16).fill(9));
    expect(Array.from(both.slice(16, 28), String)).toEqual([
      "1",
      "0",
      "0",
      "0",
      "0",
      "1",
      "0",
      "0",
      "0",
      "0",
      "1",
      "0",
    ]);
    expect(Array.from(both.slice(28))).toEqual([9, 9, 9, 9]);
  });
});

/** 平移矩阵（列主序）。 */
const T = (x: number, y = 0, z = 0) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** 5 根骨骼：0 根 → 1 → 2；3 独立根；4 是 0 的另一个子（1 的兄弟）。局部都是平移，绑定逆是单位阵，世界 / 蒙皮 / cur 预填哨兵值。 */
function skeleton(parents: number[], locals: Float32Array[]) {
  const n = parents.length;
  const local = new Float32Array(n * 16);
  locals.forEach((m, i) => local.set(m, i * 16));
  const inverseBind = new Float32Array(n * 16);
  for (let i = 0; i < n; i++) inverseBind.set(IDENTITY, i * 16);
  return {
    parents: Int32Array.from(parents),
    local,
    inverseBind,
    world: new Float32Array(n * 16).fill(-1),
    skin: new Float32Array(n * 12).fill(-2),
    cur: new Float32Array(n * 16).fill(-3),
  };
}
const slot = (a: Float32Array, i: number, stride: number) => Array.from(a.slice(i * stride, i * stride + stride));

describe("recomputeSubtree（子树重算）", () => {
  const W = T(1000, 0, 0);

  it("只算 i 与它的子孙：兄弟、别的根、祖先原样不动", () => {
    const s = skeleton([-1, 0, 1, -1, 0], [T(10), T(20), T(30), T(40), T(50)]);
    // 先从根 0 算一遍（0、1、2、4；独立根 3 不在 0 的子树里，保持哨兵），记下快照
    recomputeSubtree(0, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    expect(slot(s.world, 3, 16)).toEqual(new Array(16).fill(-1));
    const before = { world: s.world.slice(), skin: s.skin.slice(), cur: s.cur.slice() };
    // 改 1 的局部（并把 0、3、4 的局部也改掉，让它们的世界矩阵「过期」）、只从 1 重算：1 与它的子孙 2 变（父 0 的姿势读已有的），
    // 祖先 0、兄弟 4、别的根 3 一个字节都不动（兄弟的父与 1 相同，但不在 1 的子树里）
    s.local.set(T(200), 16);
    for (const i of [0, 3, 4]) s.local.set(T(999 + i), i * 16);
    recomputeSubtree(1, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    for (const i of [0, 3, 4]) {
      expect(slot(s.world, i, 16), `world ${i}`).toEqual(slot(before.world, i, 16));
      expect(slot(s.skin, i, 12), `skin ${i}`).toEqual(slot(before.skin, i, 12));
      expect(slot(s.cur, i, 16), `cur ${i}`).toEqual(slot(before.cur, i, 16));
    }
    for (const i of [1, 2]) {
      expect(slot(s.world, i, 16), `world ${i}`).not.toEqual(slot(before.world, i, 16));
      expect(slot(s.skin, i, 12), `skin ${i}`).not.toEqual(slot(before.skin, i, 12));
      expect(slot(s.cur, i, 16), `cur ${i}`).not.toEqual(slot(before.cur, i, 16));
    }
    // 1 的新姿势 = 已有的 Pose[0]（10）· 新局部（200）
    expect(slot(s.world, 1, 16).slice(12, 15)).toEqual([210, 0, 0]);
    expect(slot(s.world, 2, 16).slice(12, 15)).toEqual([240, 0, 0]);
  });

  it("三份输出：Pose = 父 Pose · Local，K = Pose · 绑定逆（12 个数），World = W · Pose", () => {
    const s = skeleton([-1, 0, 1], [T(10), T(20), T(30)]);
    // 先整根算一遍，再只改 1 的局部、从 1 重算：0 不动，1 与 2 跟着变
    recomputeSubtree(0, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    expect(slot(s.world, 2, 16).slice(12, 15)).toEqual([60, 0, 0]);
    expect(slot(s.skin, 2, 12).slice(9)).toEqual([60, 0, 0]);
    expect(slot(s.cur, 2, 16).slice(12, 15)).toEqual([1060, 0, 0]);
    s.local.set(T(200), 16);
    recomputeSubtree(1, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    expect(slot(s.world, 0, 16).slice(12, 15)).toEqual([10, 0, 0]);
    expect(slot(s.world, 1, 16).slice(12, 15)).toEqual([210, 0, 0]);
    expect(slot(s.world, 2, 16).slice(12, 15)).toEqual([240, 0, 0]);
    expect(slot(s.cur, 2, 16).slice(12, 15)).toEqual([1240, 0, 0]);
    expect(slot(s.cur, 0, 16).slice(12, 15)).toEqual([1010, 0, 0]);
  });

  it("i 自己是根时 Pose = Local（不看哨兵），W 是调用传进来的那一份", () => {
    const s = skeleton([-1, 0], [T(5), T(6)]);
    recomputeSubtree(0, s.parents, s.local, s.inverseBind, T(0, 700, 0), s.world, s.skin, s.cur);
    expect(slot(s.world, 0, 16)).toEqual(Array.from(T(5)));
    expect(slot(s.cur, 1, 16).slice(12, 15)).toEqual([11, 700, 0]);
  });

  it("父下标比子大的骨骼不会被算（同 WPE：只按下标往后扫）", () => {
    // 1 的父是 2（在它后面）；从 0 重算：脏集合 {0}，扫到 1 时父 2 不在集合里 → 跳过；2 的父是 0 → 算
    const s = skeleton([-1, 2, 0], [T(10), T(20), T(30)]);
    recomputeSubtree(0, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    expect(slot(s.world, 1, 16)).toEqual(new Array(16).fill(-1));
    expect(slot(s.world, 2, 16).slice(12, 15)).toEqual([40, 0, 0]);
  });

  it("乘法是完整 4×4：第 4 行（w 分量）参与，原样结果与 mulFull 逐位相同", () => {
    // 局部矩阵的 c0.w = 0.5：仿射乘法只读 xyz、算不出这个值；完整乘法让 Pose[child] 的 c0.w = 0.5
    const odd = Float32Array.from(IDENTITY);
    odd[3] = 0.5;
    const s = skeleton([-1, 0], [IDENTITY, odd]);
    recomputeSubtree(0, s.parents, s.local, s.inverseBind, W, s.world, s.skin, s.cur);
    expect(s.world[16 + 3]).toBe(0.5);
    // 不整的链：与 mulFull 的逐位对照
    const chain = skeleton(
      [-1, 0, 1],
      [
        Float32Array.from([1.13, 0.37, 0, 0, -0.37, 0.91, 0, 0, 0, 0, 1, 0, 13.7, -21.3, 0, 1]),
        Float32Array.from([0.83, 0.71, 0, 0, -0.71, 1.27, 0, 0, 0, 0, 1, 0, 97.1, 11.9, 0, 1]),
        Float32Array.from([1.31, -1.13, 0, 0, 1.13, 1.31, 0, 0, 0, 0, 1, 0, 61.3, -7.7, 0, 1]),
      ],
    );
    // W 取带旋转与缩放的仿射矩阵：World = W·Pose 的结合顺序（完整乘法）要靠它才看得出
    const rotated = Float32Array.from([0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1.3, 0, 1000.3, -37.7, 5.1, 1]);
    recomputeSubtree(0, chain.parents, chain.local, chain.inverseBind, rotated, chain.world, chain.skin, chain.cur);
    const expected = new Float32Array(16);
    const pose = new Float32Array(16);
    mulFull(chain.world, 0, chain.local, 16, expected, 0);
    pose.set(expected);
    mulFull(pose, 0, chain.local, 32, expected, 0);
    expect(slot(chain.world, 2, 16)).toEqual(Array.from(expected));
    const world = new Float32Array(16);
    mulFull(rotated, 0, expected, 0, world, 0);
    expect(slot(chain.cur, 2, 16)).toEqual(Array.from(world));
  });
});
