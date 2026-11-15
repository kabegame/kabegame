/**
 * P12d-2：骨骼脚本方法在 `ScenePuppets` 上的落点（`boneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation`，
 * rea-p12d-bones 3–6）。手搭的最小 puppet：每根骨骼静止局部矩阵是平移 `100·(i + 1)`，没有动画层，所以静止时蒙皮是单位阵、世界骨骼矩阵一眼可读。
 * 对 WPE 的夹具这一步不做（主会话实测后补）。
 */
import { describe, expect, it } from "vitest";
import { parseBonePhysics } from "../compile/puppet";
import { inverse4, mulFull } from "./math";
import { SKIN_STRIDE } from "./pose";
import { ScenePuppets, type PuppetRig, type PuppetSink } from "./player";

const T = (x: number, y = 0, z = 0) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const PHYSICS = '{"t":true,"se":true,"ts":300,"tf":5,"ti":30,"tm":200}';

/** `parents` 给父下标；`physics` 为每根骨骼的物理 JSON（null = 没开）。 */
function rig(parents: number[], physics: (string | null)[] = []): PuppetRig {
  const n = parents.length;
  const restMatrices = new Float32Array(n * 16);
  const world = new Float32Array(n * 16);
  const inverseBind = new Float32Array(n * 16);
  const temp = new Float32Array(16);
  for (let i = 0; i < n; i++) {
    restMatrices.set(T(100 * (i + 1)), i * 16);
    if (parents[i] < 0) world.set(restMatrices.subarray(i * 16, i * 16 + 16), i * 16);
    else {
      mulFull(world, parents[i] * 16, restMatrices, i * 16, temp, 0);
      world.set(temp, i * 16);
    }
    inverse4(world, i * 16, inverseBind, i * 16);
  }
  const params = physics.map((json) => (json ? parseBonePhysics(json) : null));
  return {
    skeleton: {
      parents: Int32Array.from(parents),
      inverseBind,
      rest: new Float32Array(n * 10),
      restMatrices,
      ...(params.some((item) => item) ? { physics: params } : {}),
    },
    names: ["x", "y", "x"].slice(0, n),
    animations: [],
    layers: [],
    boneAlpha: false,
  } as PuppetRig;
}

/** 图层世界矩阵可变的 sink（测试里原地改 `world`）。 */
function sinkOf(world: Float32Array): PuppetSink {
  return { animationLayer: () => undefined, world: () => world };
}

const DT = 0.016;
const x = (m: Float32Array | null, offset = 12) => m![offset];

describe("选骨与 getBoneTransform", () => {
  const roots = () => new ScenePuppets([{ object: 0, puppet: rig([-1, -1, -1]) }]);

  it("第一次推进之前一律失败；推进后按下标与名字选，世界矩阵 = W · 静止世界", () => {
    const puppets = roots();
    expect(puppets.boneTransform(0, 0)).toBeNull();
    puppets.frame(DT, sinkOf(T(10, 20)));
    expect(puppets.boneTransform(0, 0)!.slice(12, 15)).toEqual(Float32Array.from([110, 20, 0]));
    expect(x(puppets.boneTransform(0, 1))).toBe(210);
    expect(x(puppets.boneTransform(0, 2))).toBe(310);
    // 名字：第一个全名匹配（骨骼 0 与 2 同名 "x"）
    expect(x(puppets.boneTransform(0, "x"))).toBe(110);
    expect(x(puppets.boneTransform(0, "y"))).toBe(210);
  });

  it("越界、负数、非整数、空串、没有的名字、不是 puppet 的对象都是 null；返回的是拷贝", () => {
    const puppets = roots();
    puppets.frame(DT, sinkOf(T(0)));
    for (const bad of [3, -1, 1.5, NaN, "", "z", "X"]) expect(puppets.boneTransform(0, bad), String(bad)).toBeNull();
    expect(puppets.boneTransform(7, 0)).toBeNull();
    const copy = puppets.boneTransform(0, 0)!;
    copy[12] = -1;
    expect(x(puppets.boneTransform(0, 0))).toBe(100);
  });

  it("静止捷径：没有物理、蒙皮不重算，世界骨骼矩阵仍跟着图层走", () => {
    const puppets = roots();
    const world = T(0);
    const sink = sinkOf(world);
    puppets.frame(DT, sink);
    puppets.frame(DT, sink); // 第二帧起走静止捷径
    world.set(T(50, 5));
    puppets.frame(DT, sink);
    expect(puppets.boneTransform(0, 0)!.slice(12, 15)).toEqual(Float32Array.from([150, 5, 0]));
    expect(puppets.boneTransform(0, 2)!.slice(12, 15)).toEqual(Float32Array.from([350, 5, 0]));
    // 蒙皮仍是静止的单位阵（x 平移 0）
    expect(puppets.skin(0)![9]).toBe(0);
  });
});

describe("setBoneTransform", () => {
  it("写三处：世界矩阵 = M、蒙皮改变（W⁻¹·M·绑定逆）；子骨骼当帧不跟；下一帧全部重算", () => {
    const puppets = new ScenePuppets([{ object: 0, puppet: rig([-1, 0]) }]);
    const sink = sinkOf(T(10));
    puppets.frame(DT, sink);
    puppets.frame(DT, sink); // 进入静止捷径，检验 set 会让下一帧重算蒙皮
    puppets.setBoneTransform(0, 0, T(1010));
    expect(x(puppets.boneTransform(0, 0))).toBe(1010);
    // 骨骼 0 静止世界 100，W 平移 10：模型空间 1000，蒙皮平移 = 1000 − 100
    expect(puppets.skin(0)![9]).toBe(900);
    // 子骨骼的蒙皮与世界矩阵都没动
    expect(puppets.skin(0)![SKIN_STRIDE + 9]).toBe(0);
    expect(x(puppets.boneTransform(0, 1))).toBe(10 + 300);
    puppets.frame(DT, sink);
    expect(puppets.skin(0)![9]).toBe(0);
    expect(x(puppets.boneTransform(0, 0))).toBe(110);
  });

  it("选骨失败、矩阵不足 16 个数：什么都不做", () => {
    const puppets = new ScenePuppets([{ object: 0, puppet: rig([-1, -1]) }]);
    puppets.setBoneTransform(0, 0, T(5)); // 还没推进过
    puppets.frame(DT, sinkOf(T(0)));
    puppets.setBoneTransform(0, 2, T(5));
    puppets.setBoneTransform(0, "", T(5));
    puppets.setBoneTransform(0, 1, [1, 2, 3]);
    expect(x(puppets.boneTransform(0, 0))).toBe(100);
    expect(x(puppets.boneTransform(0, 1))).toBe(200);
  });

  it("M 成为下一帧物理的 prev：t + se 骨骼被拉向 M（对照组没有 set 时偏移为 0）；没开物理的骨骼无痕迹", () => {
    const run = (withSet: boolean) => {
      const puppets = new ScenePuppets([{ object: 0, puppet: rig([-1, -1], [PHYSICS, null]) }]);
      const sink = sinkOf(T(0));
      puppets.frame(DT, sink);
      if (withSet) {
        puppets.setBoneTransform(0, 0, T(1100));
        puppets.setBoneTransform(0, 1, T(1100));
      }
      puppets.frame(DT, sink);
      return { off: puppets.physicsStates(0)![0]!.off[0], cur1: x(puppets.boneTransform(0, 1)), puppets };
    };
    const control = run(false);
    const dragged = run(true);
    expect(control.off).toBe(0);
    // e = (o − Mp.o)·0.7 = −700，偏移 = −e 再钳到 tm·s = 200（弹簧速度项在 dt 内很小）
    expect(dragged.off).toBeGreaterThan(150);
    expect(dragged.off).toBeLessThanOrEqual(200 + 1e-3);
    expect(dragged.cur1).toBe(control.cur1);
    expect(dragged.puppets.physicsStates(0)![1]).toBeNull();
  });
});

describe("applyBonePhysicsImpulse / resetBonePhysicsSimulation", () => {
  const physical = () => {
    const puppets = new ScenePuppets([{ object: 0, puppet: rig([-1, -1, -1], [PHYSICS, null, PHYSICS]) }]);
    const sink = sinkOf(T(0));
    puppets.frame(DT, sink);
    puppets.frame(DT, sink);
    return { puppets, sink };
  };
  const states = (puppets: ScenePuppets) => puppets.physicsStates(0)!;

  it("vel 加 dir；缺 ang 时 q 不变；下一帧起骨骼被推开", () => {
    const { puppets, sink } = physical();
    puppets.applyBonePhysicsImpulse(0, 0, [500, 0, 0], [0, 0, 0]);
    expect(Array.from(states(puppets)[0]!.vel)).toEqual([500, 0, 0]);
    expect(Array.from(states(puppets)[0]!.q)).toEqual([1, 0, 0, 0]);
    puppets.frame(DT, sink);
    expect(states(puppets)[0]!.off[0]).toBeGreaterThan(0);
    expect(states(puppets)[2]!.off[0]).toBe(0);
  });

  it("ang 乘进 q；冲量可累加", () => {
    const { puppets } = physical();
    puppets.applyBonePhysicsImpulse(0, 2, [1, 2, 3], [0, 0, 90]);
    puppets.applyBonePhysicsImpulse(0, 2, [1, 2, 3], [0, 0, 0]);
    expect(Array.from(states(puppets)[2]!.vel)).toEqual([2, 4, 6]);
    const q = states(puppets)[2]!.q;
    expect(q[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("没开物理的骨骼、越界、没推进过：空操作不抛错", () => {
    const { puppets } = physical();
    puppets.applyBonePhysicsImpulse(0, 1, [9, 9, 9], [0, 0, 0]);
    puppets.applyBonePhysicsImpulse(0, 5, [9, 9, 9], [0, 0, 0]);
    puppets.applyBonePhysicsImpulse(0, "nosuch", [9, 9, 9], [0, 0, 0]);
    expect(states(puppets)[1]).toBeNull();
    for (const k of [0, 2]) expect(Array.from(states(puppets)[k]!.vel)).toEqual([0, 0, 0]);
    const fresh = new ScenePuppets([{ object: 0, puppet: rig([-1], [PHYSICS]) }]);
    fresh.applyBonePhysicsImpulse(0, 0, [9, 9, 9], [0, 0, 0]);
    fresh.frame(DT, sinkOf(T(0)));
    expect(Array.from(states(fresh)[0]!.vel)).toEqual([0, 0, 0]);
  });

  it("名字取第一个匹配、空串落到骨骼 0；复位的空串也只作用于骨骼 0，不碰世界矩阵", () => {
    const { puppets } = physical();
    puppets.applyBonePhysicsImpulse(0, "x", [1, 0, 0], [0, 0, 0]);
    puppets.applyBonePhysicsImpulse(0, "", [10, 0, 0], [0, 0, 0]);
    puppets.applyBonePhysicsImpulse(0, 2, [100, 0, 0], [0, 0, 0]);
    expect(states(puppets)[0]!.vel[0]).toBe(11);
    expect(states(puppets)[2]!.vel[0]).toBe(100);
    const before = Array.from(puppets.boneTransform(0, 0)!);
    puppets.resetBonePhysicsSimulation(0, "");
    expect(states(puppets)[0]!.vel[0]).toBe(0);
    expect(Array.from(states(puppets)[0]!.q)).toEqual([1, 0, 0, 0]);
    expect(states(puppets)[2]!.vel[0]).toBe(100);
    expect(Array.from(puppets.boneTransform(0, 0)!)).toEqual(before);
  });
});

describe("3359451610 的用法：cursorDown 选骨 → update 里 set → cursorUp 冲量", () => {
  it("拖动中画面是脚本位置，松手后骨骼被物理拉回静止位置", () => {
    const puppets = new ScenePuppets([{ object: 0, puppet: rig([-1, -1, -1], [PHYSICS, null, PHYSICS]) }]);
    const sink = sinkOf(T(0));
    puppets.frame(DT, sink);
    puppets.frame(DT, sink);
    // cursorDown：选离 (130, 0) 最近的骨骼（getBoneCount 次 getBoneTransform）
    let best = -1;
    let bestDistance = Infinity;
    for (let b = 0; b < 3; b++) {
      const distance = Math.abs(x(puppets.boneTransform(0, b)) - 130);
      if (distance < bestDistance) [best, bestDistance] = [b, distance];
    }
    expect(best).toBe(0);
    // 拖动 10 帧：每帧推进后（update）把骨骼 0 摆到 (400, 0)
    for (let k = 0; k < 10; k++) {
      puppets.frame(DT, sink);
      puppets.setBoneTransform(0, 0, T(400));
      expect(x(puppets.boneTransform(0, 0))).toBe(400);
    }
    // 松手：本帧读到的是物理输出，已被拉回一部分但还没回到静止位置
    puppets.frame(DT, sink);
    const released = x(puppets.boneTransform(0, 0));
    expect(released).toBeLessThan(400);
    expect(released).toBeGreaterThan(100);
    // cursorUp 之后的冲量不抛错；弹簧继续把它拉回静止位置
    puppets.applyBonePhysicsImpulse(0, 0, [0, 0, 0], [0, 0, 0]);
    for (let k = 0; k < 400; k++) puppets.frame(DT, sink);
    const settled = x(puppets.boneTransform(0, 0));
    expect(Math.abs(settled - 100)).toBeLessThan(Math.abs(released - 100));
    expect(Math.abs(settled - 100)).toBeLessThan(5);
  });
});
