// P4h 步骤 1：boids 的解析与能力键（compile 一侧）。依据 rea-p4h-boids.md 第 1 节；语料滴水场景（3826719942）的 boids 条目是下面的 DRIP。
import { describe, expect, it } from "vitest";
import { checkParticleFeatures } from "./features";
import type { JsonObject } from "./model";
import { parseParticle } from "./particles";

const DRIP: JsonObject = {
  name: "boids",
  id: 14,
  flags: 0,
  alignmentfactor: 5,
  cohesionfactor: 5,
  separationfactor: 0,
  neighborthreshold: 150,
};

function keysOf(operator: JsonObject[], orthographic = true): string[] {
  const keys = new Set<string>();
  checkParticleFeatures({ maxcount: 16, emitter: [{ name: "sphererandom" }], operator }, orthographic, keys);
  return [...keys].sort();
}

describe("boids 的能力键与解析", () => {
  it("在模块表里：不再报 particle:operator:boids（滴水场景的条目、只写名字、透视都是）", () => {
    expect(keysOf([DRIP])).toEqual([]);
    expect(keysOf([{ name: "boids" }])).toEqual([]);
    expect(keysOf([{ name: "boids" }], false)).toEqual([]);
  });

  it("键的取值形状不对时按字段报（字符串当 float 的取值规则同其它 operator）", () => {
    expect(keysOf([{ name: "boids", neighborthreshold: { x: 1 } }]).length).toBeGreaterThan(0);
  });

  it("parseParticle 把 boids 留在 operator 里，缺省值按场景正交 / 透视选", () => {
    const parse = (orthographic: boolean) =>
      parseParticle(
        { maxcount: 16, emitter: [{ name: "sphererandom" }], operator: [{ name: "movement" }, { name: "boids" }] },
        { file: "t.json", orthographic },
      );
    expect(parse(true).operators.map((operator) => operator.name)).toEqual(["movement", "boids"]);
    expect(parse(false).operators.map((operator) => operator.name)).toEqual(["movement", "boids"]);
  });
});
