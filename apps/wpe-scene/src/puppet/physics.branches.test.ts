/**
 * P12d-1 补测：语料覆盖不到（或没碰到）的物理分支，对读码 python 模型 `physmodel.solve` 逐帧比。
 *
 * 夹具 `fixtures/phys-branches.json`（生成脚本 `ignore/p12/d/impl1/mkfix_branches.py`）：两骨骼、图层前 8 帧平移、dt 0.05，记下每次 solve 的
 * 输入（`mw`、`mp`、`dt`、`s`、求解前的状态）与输出（求解后的状态、增量 D）。四组：
 * - `la`：角度钳制撞到限位，扣角速度那一步生效（语料两张带 `la` 的场景都没碰到限位）；
 * - `lt`：每轴角速度限幅（语料 0 处）；
 * - `tre`：`t + re`，平移只有惯性（语料 0 处）；
 * - `tlock`：平移轴锁（语料 0 处）。
 * 这些分支没有 WPE 实测，只证明 TS 与读码模型一致。两边只差 `A⁻¹` 的求法（numpy 双精度求逆 / 伴随矩阵），容差按相对 1e-5。
 */
import { describe, expect, it } from "vitest";
import { parseBonePhysics } from "../compile/puppet";
import fixture from "./fixtures/phys-branches.json";
import { createBoneState, solveBone } from "./physics";

interface StateJson {
  q: number[];
  ang: number[];
  off: number[];
  vel: number[];
}
interface FrameJson {
  mw: number[];
  mp: number[];
  dt: number;
  s: number;
  before: StateJson;
  after: StateJson;
  d: number[];
}

const cases = fixture as unknown as Record<string, { json: string; frames: FrameJson[] }>;

/** 相对误差（分母至少 1，接近 0 的分量按绝对误差）。 */
function worst(got: ArrayLike<number>, want: readonly number[]): number {
  let max = 0;
  for (let i = 0; i < want.length; i++)
    max = Math.max(max, Math.abs(got[i] - want[i]) / Math.max(1, Math.abs(want[i])));
  return max;
}

describe("骨骼物理：语料覆盖不到的分支对读码模型（phys-branches）", () => {
  for (const name of ["la", "lt", "tre", "tlock"]) {
    it(`${name}：每帧求解后的状态与增量 D 与 physmodel.solve 一致`, () => {
      const { json, frames } = cases[name];
      const params = parseBonePhysics(json)!;
      expect(params).not.toBeNull();
      expect(frames.length).toBeGreaterThan(10);
      const out = new Float32Array(16);
      let max = 0;
      for (const frame of frames) {
        const state = createBoneState();
        state.q.set(frame.before.q);
        state.ang.set(frame.before.ang);
        state.off.set(frame.before.off);
        state.vel.set(frame.before.vel);
        solveBone(params, state, Float32Array.from(frame.mw), Float32Array.from(frame.mp), frame.s, frame.dt, out);
        for (const key of ["q", "ang", "off", "vel"] as const) max = Math.max(max, worst(state[key], frame.after[key]));
        max = Math.max(max, worst(out, frame.d));
      }
      expect(max).toBeLessThan(1e-5);
    });
  }

  it("la：钳制真的发生了（转角停在限位上，夹具不是空跑）", () => {
    const last = cases.la.frames.at(-1)!.after.ang;
    expect(Math.abs(Math.abs(last[2]) - 0.05)).toBeLessThan(1e-6);
  });

  it("tlock：平移沿 x 列的分量被去掉", () => {
    for (const frame of cases.tlock.frames) expect(Math.abs(frame.after.off[0])).toBeLessThan(1e-4);
    expect(Math.abs(cases.tlock.frames.at(-1)!.after.off[1])).toBeGreaterThan(0);
  });
});
