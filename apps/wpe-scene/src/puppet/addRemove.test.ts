/**
 * L3b 点 2：`ScenePuppets.add` / `remove` 与 `puppetEntry`（`.claude/plans/wpe-import/3-scene/live/phase-l3b-host-subsystems.md`）。
 * 用 `p12-mix` 的十三个 puppet（骨骼、动画层、叠法各不同）：
 * - `add` 建好就按 t = 0 算好一次姿势（和整场构造的第一帧之前一样，不用先 `frame`）；
 * - 逐个 `add` 与整场构造按同一串 dt 推进，蒙皮矩阵、骨骼透明度、变形 uniform 每帧逐位相同；
 * - `remove` 之后 `skin` / `pose` 等读它们的都是 null，别的对象不受影响，之后再 `add` 同一对象是新运行时；
 * - `puppetEntry(layer)` 与 `puppetEntries([layer])` 是同一规则（图像层 puppet / 带骨骼的模型 / 都不是）。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import mix from "./fixtures/p12-mix.json";
import { puppetEntries, puppetEntry, ScenePuppets } from "./player";

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function load(item: (typeof mix.puppets)[number]): ScenePuppet {
  return buildPuppet(parseMdl(mdlBytes(item.mdlGzip)), item.layers, item.path).puppet!;
}

const entries = () => mix.puppets.map((item) => ({ object: item.object, puppet: load(item) }));

/** 一个对象这一刻的全部输出（蒙皮、世界骨骼、骨骼透明度、变形 uniform），拷成数组便于逐位比。 */
function snapshot(puppets: ScenePuppets, object: number): unknown {
  const bits = (view: Float32Array | Uint32Array | null | undefined) =>
    view ? Array.from(new Uint32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))) : null;
  const morph = puppets.morph(object);
  return {
    skin: bits(puppets.skin(object)),
    pose: bits(puppets.pose(object)),
    alpha: bits(puppets.boneAlpha(object)),
    morphOffsets: bits(morph?.offsets),
    morphWeights: bits(morph?.weights),
  };
}

describe("ScenePuppets.add / remove（L3b）", () => {
  it("add 建好就按 t = 0 算一次姿势：不用 frame，蒙皮与整场构造的第一帧之前逐位相同", () => {
    const whole = new ScenePuppets(entries());
    const stepped = new ScenePuppets([]);
    for (const item of entries()) stepped.add([item]);
    for (const item of mix.puppets) {
      expect(snapshot(stepped, item.object), item.name).toEqual(snapshot(whole, item.object));
      expect(stepped.skin(item.object), item.name).not.toBeNull();
    }
    // 至少有一个对象的蒙皮不是全 0（t = 0 的姿势确实算过）
    expect(mix.puppets.some((item) => stepped.skin(item.object)!.some((value) => value !== 0))).toBe(true);
  });

  it("逐个 add 与整场构造按同一串 dt 推进 120 帧：蒙皮、世界骨骼、骨骼透明度、变形 uniform 每帧逐位相同", () => {
    const whole = new ScenePuppets(entries());
    const stepped = new ScenePuppets([]);
    for (const item of entries()) stepped.add([item]);
    for (let k = 0; k < 120; k++) {
      const dt = mix.dt[k % mix.dt.length];
      whole.frame(dt);
      stepped.frame(dt);
      for (const item of mix.puppets)
        expect(snapshot(stepped, item.object), `${item.name} 帧 ${k + 1}`).toEqual(snapshot(whole, item.object));
    }
  });

  it("remove：读它的 skin / pose / boneAlpha / morph 都是 null，别的对象照常推进；之后同一对象再 add 是新的运行时", () => {
    const puppets = new ScenePuppets(entries());
    puppets.frame(0.1);
    const keptBefore = snapshot(puppets, 3);
    puppets.remove(new Set([2, 4]));
    for (const object of [2, 4]) {
      expect(puppets.skin(object)).toBeNull();
      expect(puppets.pose(object)).toBeNull();
      expect(puppets.boneAlpha(object)).toBeNull();
      expect(puppets.layerCount(object)).toBe(0);
      expect(puppets.objects().has(object)).toBe(false);
    }
    expect(snapshot(puppets, 3)).toEqual(keptBefore);
    // 没被摘的继续推进，且和一份从头只加剩下那些的结果一致
    const kept = new ScenePuppets(entries().filter((item) => item.object !== 2 && item.object !== 4));
    kept.frame(0.1);
    puppets.frame(0.2);
    kept.frame(0.2);
    for (const item of mix.puppets)
      if (item.object !== 2 && item.object !== 4)
        expect(snapshot(puppets, item.object), item.name).toEqual(snapshot(kept, item.object));
    // 再加回 2：新运行时，时钟从 0 起，姿势与刚构造的相同
    puppets.add(entries().filter((item) => item.object === 2));
    const fresh = new ScenePuppets(entries().filter((item) => item.object === 2));
    expect(snapshot(puppets, 2)).toEqual(snapshot(fresh, 2));
  });

  it("建删 100 次：运行时与按对象的表不留残留", () => {
    const puppets = new ScenePuppets([]);
    const item = entries()[0];
    for (let i = 0; i < 100; i++) {
      puppets.add([item]);
      puppets.frame(0.05);
      puppets.remove(new Set([item.object]));
    }
    expect((puppets as unknown as { runtimes: unknown[] }).runtimes).toHaveLength(0);
    expect((puppets as unknown as { byObject: Map<number, unknown> }).byObject.size).toBe(0);
    expect(puppets.objects().size).toBe(0);
  });

  it("puppetEntry：同 puppetEntries 的规则（图像层 puppet、带骨骼的模型、都不是）", () => {
    const puppet = load(mix.puppets[0]);
    const skeleton = { skeleton: puppet.skeleton, animations: puppet.animations, layers: puppet.layers };
    const layers = [
      { object: 0, puppet, model: undefined },
      { object: 1, puppet: undefined, model: { skeleton } },
      { object: 2, puppet: undefined, model: undefined },
    ] as unknown as Parameters<typeof puppetEntries>[0];
    expect(layers.flatMap((layer) => puppetEntry(layer))).toEqual(puppetEntries(layers));
    expect(puppetEntry(layers[0]).map((item) => item.kind)).toEqual(["image"]);
    expect(puppetEntry(layers[1]).map((item) => item.kind)).toEqual(["model"]);
    expect(puppetEntry(layers[2])).toEqual([]);
  });
});
