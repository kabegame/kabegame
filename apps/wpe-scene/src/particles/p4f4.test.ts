/**
 * P4f 步骤 4（一个系统多个 renderer）：轨迹的 `thick` 列看整个系统（rea-p4f-script.md 8.2：sprite 缓冲的厚薄看系统 `flags & 0x3000000`，
 * 有 spritetrail 时同系统的 sprite 那次绘制也是厚格式）；模拟只有一份（多一条 renderer 不改粒子）。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";
import { particleSnapshot, particleTrack } from "./track";

/** 每秒 1 个、寿命 3、向右 130/s 的系统。 */
const json = (renderer: JsonObject[]): JsonObject => ({
  maxcount: 3,
  emitter: [{ name: "sphererandom", origin: "100 850 0", distancemin: 0, distancemax: 0, rate: 1 }],
  initializer: [
    { name: "lifetimerandom", min: 3, max: 3 },
    { name: "sizerandom", min: 120, max: 120 },
    { name: "velocityrandom", min: "130 0 0", max: "130 0 0" },
  ],
  operator: [{ name: "movement" }],
  renderer,
});
const parse = (renderer: JsonObject[]) => parseParticle(json(renderer), { file: "p.json", orthographic: true });

describe("轨迹：厚格式看整个系统（P4f 步骤 4）", () => {
  it("sprite + spritetrail（两种顺序）的快照带 thick = [vx, vy, vz, frame]；只有 sprite 的不带；两个 sprite 也不带", () => {
    for (const renderer of [
      [{ name: "sprite" }, { name: "spritetrail" }],
      [{ name: "spritetrail" }, { name: "sprite" }],
    ]) {
      const system = new ParticleSystem(parse(renderer), new SeededRandom(1), 1);
      system.step(1);
      expect(particleSnapshot(system)[0].thick).toEqual([130, 0, 0, 0]);
    }
    for (const renderer of [[{ name: "sprite" }], [{ name: "sprite" }, { name: "sprite", orientation: "upright" }]]) {
      const system = new ParticleSystem(parse(renderer), new SeededRandom(1), 1);
      system.step(1);
      expect("thick" in particleSnapshot(system)[0]).toBe(false);
    }
  });

  it("模拟只有一份：多一条 renderer 时轨迹的位置等与单 renderer 相同，系统键不变（不按 renderer 分）", () => {
    const track = (renderer: JsonObject[]) =>
      particleTrack({
        layers: [{ object: 0, name: "p", particle: parse(renderer) }],
        dts: [1, 0.5, 0.5],
        frames: [3],
        passes: 1,
      }).frames[0].systems;
    const single = track([{ name: "spritetrail" }]);
    const both = track([{ name: "sprite" }, { name: "spritetrail" }]);
    expect(Object.keys(both)).toEqual(["p"]);
    expect(both).toEqual(single);
  });
});
