/**
 * P4b 步骤 2：帧表系统的 frame 列（rea-p4b-render.md 2.5）、轨迹的 `thick` 输出与探针的 `R` 注入。帧号的网格换算在着色器里，
 * 这里只核对引擎侧写进顶点的 frame 原值。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle, type SceneParticle } from "../compile/particles";
import { injectedR, SeededRandom } from "./random";
import { ParticleSystem } from "./system";
import { particleSnapshot, particleTrack } from "./track";

const f32 = Math.fround;

/** 每秒 `rate` 个、寿命 `lifetime`、向右 130/s，同 `gen_b.py` 的 `sheet()`。 */
function sheetJson(extra: JsonObject = {}, lifetime = 3, rate = 1, maxcount = 3): JsonObject {
  const fixed = (name: string, value: number | string) => ({ name, min: value, max: value });
  return {
    maxcount,
    emitter: [{ name: "sphererandom", origin: "100 850 0", distancemin: 0, distancemax: 0, rate }],
    initializer: [fixed("lifetimerandom", lifetime), fixed("sizerandom", 120), fixed("velocityrandom", "130 0 0")],
    operator: [{ name: "movement" }],
    ...extra,
  };
}
function particle(json: JsonObject, spriteSheet = true): SceneParticle {
  return { ...parseParticle(json, { file: "sheet.json", orthographic: true }), spriteSheet };
}
/** WPE 的公式（`0x140237022`），倒数用精确除法：`(1 / life)·age·m`，逐步舍入。 */
const expected = (age: number, life: number, m: number) => f32(f32(f32(1 / life) * age) * f32(m));

describe("frame 列：sequence 模式（P4b 步骤 2）", () => {
  it("出生当帧 0，之后每帧 frame = (1 / life)·age·sequencemultiplier（判死之后、用本帧更新过的 age）", () => {
    const system = new ParticleSystem(particle(sheetJson()), new SeededRandom(1), 1);
    system.step(1);
    // 第 1 帧出生一个：age 0、frame 0
    expect([system.alive, system.columns.age[0], system.columns.frame[0]]).toEqual([1, 0, 0]);
    for (const dt of [0.25, 0.1, 0.0170369]) {
      system.step(dt);
      const { age, frame } = system.columns;
      expect(frame[0]).toBe(expected(age[0], 3, 1));
      expect(frame[0]).toBeGreaterThan(0);
    }
  });

  it("sequencemultiplier 2、3：同一年龄的 frame 成倍数，大于 1 不回绕（引擎不取小数）", () => {
    const run = (m: number) => {
      const system = new ParticleSystem(particle(sheetJson({ sequencemultiplier: m })), new SeededRandom(1), 1);
      for (const dt of [1, 1, 0.5, 0.7]) system.step(dt);
      return system;
    };
    const one = run(1);
    const [two, three] = [run(2), run(3)];
    // 槽 0 是第一个粒子：age 2.2 s、寿命 3
    expect(one.columns.age[0]).toBe(f32(f32(f32(0 + 1) + 0.5) + 0.7));
    expect(one.columns.frame[0]).toBe(expected(one.columns.age[0], 3, 1));
    expect(two.columns.frame[0]).toBe(f32(one.columns.frame[0] * 2));
    expect(three.columns.frame[0]).toBe(expected(one.columns.age[0], 3, 3));
    expect(three.columns.frame[0]).toBeGreaterThan(2);
    // 非整数倍数同样照乘
    expect(run(0.5).columns.frame[0]).toBe(expected(one.columns.age[0], 3, 0.5));
  });

  it("序列帧在发射之前：本帧出生的粒子保留出生时写的 +0（倍数为负时，放在发射之后会算出 −0）", () => {
    const system = new ParticleSystem(particle(sheetJson({ sequencemultiplier: -1 }, 3, 2)), new SeededRandom(1), 1);
    system.step(0.5);
    system.step(0.5);
    const { frame, age } = system.columns;
    // 槽 0 是上一帧出生的：按负倍数倒放；槽 1 是本帧出生的
    expect(frame[0]).toBe(expected(age[0], 3, -1));
    expect(frame[0]).toBeLessThan(0);
    expect(age[1]).toBe(0);
    expect(Object.is(frame[1], 0)).toBe(true);
  });

  it("预热走同一个 advance：预热后的 frame 已按年龄算好", () => {
    const system = new ParticleSystem(particle(sheetJson({ starttime: 3 })), new SeededRandom(1), 1);
    system.prewarm();
    expect(system.alive).toBeGreaterThanOrEqual(2);
    expect(system.columns.age[0]).toBeGreaterThan(1);
    expect(system.columns.frame[0]).toBe(expected(system.columns.age[0], 3, 1));
  });

  it("不是帧表系统（槽 0 纹理没有帧表）：frame 不更新，保持出生时的 0", () => {
    const system = new ParticleSystem(particle(sheetJson({ sequencemultiplier: 2 }), false), new SeededRandom(1), 1);
    for (const dt of [1, 0.5, 0.5]) system.step(dt);
    expect(system.columns.age[0]).toBe(1);
    expect(system.columns.frame[0]).toBe(0);
  });
});

describe("frame 列：randomframe", () => {
  it("出生时写 R，整生不变（帧表与否都不更新）", () => {
    for (const spriteSheet of [true, false]) {
      const system = new ParticleSystem(
        particle(sheetJson({ animationmode: "randomframe", sequencemultiplier: 3 }), spriteSheet),
        new SeededRandom(5),
        1,
      );
      system.step(1);
      const r = system.columns.random[0];
      expect(system.columns.frame[0]).toBe(r);
      for (const dt of [0.3, 0.6, 0.9]) {
        system.step(dt);
        expect(system.columns.frame[0]).toBe(r);
      }
      expect(r).toBeGreaterThan(0);
    }
  });
});

describe("轨迹：thick 与 R 注入", () => {
  it("帧表系统的快照多一项 thick = [vx, vy, vz, frame 原值]；不是帧表系统没有这一项", () => {
    const system = new ParticleSystem(particle(sheetJson({ sequencemultiplier: 3 })), new SeededRandom(1), 1);
    for (const dt of [1, 1, 0.9]) system.step(dt);
    const [first] = particleSnapshot(system);
    expect(first.thick).toEqual([130, 0, 0, system.columns.frame[0]]);
    expect(first.thick![3]).toBeGreaterThan(1);
    const plain = new ParticleSystem(particle(sheetJson(), false), new SeededRandom(1), 1);
    plain.step(1);
    expect("thick" in particleSnapshot(plain)[0]).toBe(false);
  });

  it("injectedR：按出生顺序顶替，用完退回照常抽到的值；按 float32 存", () => {
    const override = injectedR([0.1, 0.9]);
    expect([override(0.5), override(0.5), override(0.5), override(0.25)]).toEqual([f32(0.1), f32(0.9), 0.5, 0.25]);
  });

  it("particleTrack 的 random：只顶替指定 objects 下标的系统的 R，别的抽取不变", () => {
    const layers = [0, 1].map((object) => ({
      object,
      name: `s${object}`,
      particle: particle(sheetJson({ animationmode: "randomframe" })),
    }));
    const dts = [1, 1, 1, 0.5];
    const plain = particleTrack({ layers, dts, frames: [4], passes: 1 });
    const injected = particleTrack({ layers, dts, frames: [4], passes: 1, random: { 1: [0.125, 0.75] } });
    // 第 4 帧：三个粒子按槽序，前两个是注入的
    const frames = (track: typeof plain, name: string) => track.frames[0].systems[name].map((p) => p.thick![3]);
    expect(frames(injected, "s1").slice(0, 2)).toEqual([0.125, 0.75]);
    expect(frames(injected, "s1")[2]).toBe(frames(plain, "s1")[2]);
    expect(frames(injected, "s0")).toEqual(frames(plain, "s0"));
    // 位置等其余字段与不注入时逐位相同
    const strip = (track: typeof plain) => track.frames[0].systems.s1.map(({ thick: _thick, ...rest }) => rest);
    expect(strip(injected)).toEqual(strip(plain));
  });
});
