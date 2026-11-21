/**
 * `mt19937`（P4j 步骤 4a）与「全场共用一个随机源」的单测：
 * - 标准 `std::mt19937` 的自检值（C++ 标准 [rand.predef]）；
 * - `particleTrack` 给 `mt19937` 时两个系统按对象顺序交替从同一串里抽，和手写的「两个系统共用一个 `SeededRandom`」逐位相同；
 * - 不给 `mt19937` 时仍是 `seed + i`（逐字节同以前）；`mt19937` 与 `seed` 同给报错。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { mt19937, SeededRandom } from "./random";
import { ParticleSystem } from "./system";
import { particleTrack } from "./track";

const spec: JsonObject = {
  emitter: [{ name: "sphererandom", origin: "0 0 0", distancemin: 0, distancemax: 100, rate: 20 }],
  initializer: [
    { name: "lifetimerandom", min: 30, max: 30 },
    { name: "velocityrandom", min: "0 0 0", max: "0 0 0" },
  ],
  operator: [{ name: "movement", gravity: "0 0 0" }],
  maxcount: 64,
};
const parsed = () => parseParticle(spec, { file: "p.json", orthographic: true });
const layers = [
  { object: 0, name: "a", particle: parsed() },
  { object: 1, name: "b", particle: parsed() },
];

describe("mt19937", () => {
  it("标准 std::mt19937：种子 5489 的第 1 个是 3499211612、第 10000 个是 4123659995", () => {
    const next = mt19937(5489);
    expect(next()).toBe(3499211612);
    let last = 0;
    for (let i = 1; i < 10000; i++) last = next();
    expect(last).toBe(4123659995);
  });

  it("种子相同序列相同；种子按 u32 取模", () => {
    const a = mt19937(1007);
    const b = mt19937(1007 + 2 ** 32);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("SeededRandom 收它：u32() 就是原始输出，a() / b() 取同一串", () => {
    const direct = mt19937(1007);
    const random = new SeededRandom(mt19937(1007));
    expect(random.u32()).toBe(direct());
    random.a();
    direct();
    random.b();
    direct();
    expect(random.u32()).toBe(direct());
  });
});

describe("particleTrack 的 mt19937（全场共用一个随机源）", () => {
  const dts = [0.1, 0.1, 0.1];

  it("两个系统按对象顺序交替抽：预热依次、每帧步进依次，和手写的共用一个 SeededRandom 逐位相同", () => {
    const track = particleTrack({ layers, dts, frames: [3], passes: 1, mt19937: 1007 });
    const shared = new SeededRandom(mt19937(1007));
    const systems = layers.map((layer) => new ParticleSystem(layer.particle!, shared, 1));
    for (const system of systems) system.prewarm();
    for (const dt of dts) for (const system of systems) system.step(dt);
    ["a", "b"].forEach((name, i) => {
      const columns = systems[i].columns;
      const expected = [...Array(systems[i].highWater).keys()]
        .filter((slot) => columns.life[slot] !== 0)
        .map((slot) => [0, 1, 2].map((axis) => columns.position[axis][slot]));
      expect(track.frames[0].systems[name].map((p) => p.pos)).toEqual(expected);
    });
    expect(track.random).toMatch(/mt19937\(1007\)/);
  });

  it("共用一串和各取 seed + i 不同；不给 mt19937 时逐字节同以前（没有 random 行）", () => {
    const shared = particleTrack({ layers, dts, frames: [3], passes: 1, mt19937: 1 });
    const separate = particleTrack({ layers, dts, frames: [3], passes: 1, seed: 1 });
    expect(separate.random).toBeUndefined();
    expect(shared.frames[0].systems.a).not.toEqual(separate.frames[0].systems.a);
    expect(separate.frames).toEqual(particleTrack({ layers, dts, frames: [3], passes: 1 }).frames);
  });

  it("mt19937 与 seed 同给报错", () => {
    expect(() => particleTrack({ layers, dts, frames: [3], passes: 1, mt19937: 1, seed: 1 })).toThrow(/只能给一个/);
  });
});
