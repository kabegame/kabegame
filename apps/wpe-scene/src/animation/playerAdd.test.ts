/**
 * L3b 点 1：`SceneAnimations.add` / `removeObjects`（`.claude/plans/wpe-import/3-scene/live/phase-l3b-host-subsystems.md`）。
 * - 新加的条目建出那一帧不写，下一帧写 `dt` 处的值（L0 的 K2：f=90 读静态值 0.5，f=91 读 dt 处的值）；
 * - 联动的主人是条目不是下标：前面的对象增删之后，后面对象的联动照样借父的时钟；
 * - 删除后 `control(id)` 为 null、已给出的控制对象作废（方法空操作、读值留在摘掉那一刻）；
 * - 整场构造 = 逐对象 `add`：每帧写出的值与事件序列逐位相同（全语料对照在 `ignore/live/l3b/subsystems.test.ts`）；
 * - L6 `replaceObjects`：同 id、时钟参数相同的接回 t / flags / rate（之后的写入与没替换过的逐位相同），不同的从 0 开始。
 */
import { describe, expect, it } from "vitest";
import type { SceneBinding } from "../compile/bindings";
import type { SceneScalar } from "../compile/model";
import { type AnimationSink, SceneAnimations } from "./player";
import type { ParsedKey } from "./curve";
import type { AnimationClockParams, AnimationEventRecord, SceneAnimation } from "./types";

const f = Math.fround;
const DT = 1 / 60;

const key = (frame: number, value: number): ParsedKey => ({
  frame,
  value: f(value),
  flags: 0,
  bx: 0,
  by: 0,
  fx: 0,
  fy: 0,
});
const LIN = [key(0, 0), key(60, 600)];
const CLOCK: AnimationClockParams = { fps: 30, length: 60, mode: 0, startpaused: false };

function anim(object: number, field: string, options: Partial<SceneAnimation> = {}): SceneAnimation {
  const id = `objects/${object}/${field}`;
  return {
    id,
    target: { kind: "layer", object, field: field as "alpha" },
    valueType: "float",
    channels: [LIN],
    parent: null,
    events: [],
    writes: true,
    name: "",
    object,
    owner: `objects/${object}`,
    inert: false,
    clock: { ...CLOCK },
    ...options,
  };
}

function recorder() {
  const writes: [string, SceneScalar][] = [];
  const state: AnimationSink = {
    write(binding: SceneBinding, raw: SceneScalar) {
      const target = binding.target as { object?: number; field?: string };
      writes.push([`${target.object}:${target.field}`, raw]);
      return "applied";
    },
  };
  return { writes, state };
}

describe("SceneAnimations.add / removeObjects（L3b）", () => {
  it("新加的条目建出那一帧不写，下一帧写 dt 处的值（L0 K2：f=90 静态值，f=91 dt 处的值）", () => {
    const players = new SceneAnimations([anim(0, "alpha")]);
    const { writes, state } = recorder();
    for (let i = 0; i < 90; i++) players.frame(DT, state);
    expect(writes.filter(([target]) => target.startsWith("1:"))).toEqual([]);
    // 90 帧之后加对象 1：add 本身不写
    writes.length = 0;
    players.add([anim(1, "alpha")]);
    expect(writes).toEqual([]);
    // 下一帧：对象 1 的时钟从 0 先推进一个 dt 再求值，值取 dt 处（f = 30 fps × dt = 0.5 帧，线性 0→600 over 60 帧 = 5）
    players.frame(DT, state);
    const fresh = new SceneAnimations([anim(1, "alpha")]);
    const reference = recorder();
    fresh.frame(DT, reference.state);
    expect(writes.find(([target]) => target === "1:alpha")).toEqual(reference.writes[0]);
    // 对象 0 的动画一直在走：第 91 帧的值不是第 1 帧的值
    expect(writes.find(([target]) => target === "0:alpha")![1]).not.toEqual(reference.writes[0][1]);
  });

  it("联动的主人是条目：前面的对象增删之后，后面对象的子借父的时钟照旧", () => {
    // 对象 0：单条；对象 1：子（片段内下标 0）借同一对象内的父（片段内下标 1）
    const child = (object: number): SceneAnimation =>
      anim(object, "alpha", {
        parent: 1,
        channels: [[key(0, 0), key(60, 6)]],
        clock: { fps: 10, length: 10, mode: 0, startpaused: true },
      });
    const parent = (object: number): SceneAnimation =>
      anim(object, "origin", {
        valueType: "vec3",
        target: { kind: "layer", object, field: "origin" },
        channels: [LIN, LIN, LIN],
      });
    const players = new SceneAnimations([]);
    players.add([anim(0, "alpha")]);
    players.add([child(1), parent(1)]);
    players.add([child(2), parent(2)]);
    const { writes, state } = recorder();
    players.frame(DT, state);
    const childOf1 = writes.find(([target]) => target === "1:alpha")!;
    const childOf2 = writes.find(([target]) => target === "2:alpha")!;
    // 子按父的时钟（30 fps、length 60）解读自己的关键帧：值与单独整场构造的一份相同（独立参照）
    const reference = recorder();
    new SceneAnimations([child(1), parent(1)]).frame(DT, reference.state);
    expect(childOf1[1]).toEqual(reference.writes.find(([target]) => target === "1:alpha")![1]);
    expect(childOf2[1]).toBe(childOf1[1]);
    // 摘掉最前面的对象 0 与中间的对象 1：对象 2 的子仍然借自己的父（下标整体前移，owner 不能按旧下标）
    players.removeObjects(new Set([0, 1]));
    expect(players.size).toBe(2);
    writes.length = 0;
    players.frame(DT, state);
    const probe = players.probe().list;
    expect(probe.map((item) => [item.id, item.owner])).toEqual([
      ["objects/2/alpha", 1],
      ["objects/2/origin", 1],
    ]);
    const two = new SceneAnimations([child(2), parent(2)]);
    const twoWrites = recorder();
    two.frame(DT, twoWrites.state);
    twoWrites.writes.length = 0;
    two.frame(DT, twoWrites.state);
    expect(writes.find(([target]) => target === "2:alpha")![1]).toEqual(
      twoWrites.writes.find(([target]) => target === "2:alpha")![1],
    );
  });

  it("暂停中被摘掉的条目：作废的控制对象 play 也不播（上一条里时钟本来就在播，拦不拦 play 看不出）", () => {
    const players = new SceneAnimations([anim(0, "alpha")]);
    const control = players.control("objects/0/alpha")!;
    control.pause();
    players.removeObjects(new Set([0]));
    control.play();
    expect(control.isPlaying()).toBe(false);
  });

  it("删除后 control(id) 为 null；已给出的控制对象作废：方法空操作，读值留在摘掉那一刻", () => {
    const players = new SceneAnimations([anim(0, "alpha"), anim(1, "alpha")]);
    const { state } = recorder();
    players.frame(DT, state);
    const control = players.control("objects/1/alpha")!;
    const frameBefore = control.getFrame();
    players.removeObjects(new Set([1]));
    expect(players.control("objects/1/alpha")).toBeNull();
    expect(players.control("objects/0/alpha")).not.toBeNull();
    control.setFrame(30);
    control.pause();
    control.stop();
    control.play();
    control.rate = 9;
    expect(control.getFrame()).toBe(frameBefore);
    expect(control.isPlaying()).toBe(true);
    expect(control.rate).toBe(1);
    // 摘掉的条目不再写
    const { writes, state: after } = recorder();
    players.frame(DT, after);
    expect(writes.map(([target]) => target)).toEqual(["0:alpha"]);
  });

  it("同 id 的再加：removeObjects 之后 add 是新条目，旧控制对象仍是作废的", () => {
    const players = new SceneAnimations([anim(0, "alpha")]);
    const old = players.control("objects/0/alpha")!;
    players.removeObjects(new Set([0]));
    players.add([anim(0, "alpha")]);
    const fresh = players.control("objects/0/alpha")!;
    expect(fresh).not.toBe(old);
    fresh.setFrame(30);
    old.setFrame(0);
    expect(fresh.getFrame()).toBeCloseTo(30, 4);
  });

  it("整场构造与逐对象 add：每帧写出的值与事件序列逐位相同", () => {
    const events = [{ time: 0.2, json: '{"frame":6,"name":"hit"}' }];
    const list = [
      anim(0, "alpha", { events, clock: { fps: 30, length: 30, mode: 0, startpaused: false } }),
      anim(1, "alpha", { parent: 2, channels: [[key(0, 0), key(60, 6)]] }),
      anim(1, "origin", {
        valueType: "vec3",
        target: { kind: "layer", object: 1, field: "origin" },
        channels: [LIN, LIN, LIN],
      }),
      anim(2, "alpha", { clock: { fps: 24, length: 48, mode: 1, startpaused: false } }),
    ];
    // 逐对象的片段：联动的 parent 是片段内下标
    const slices = [[list[0]], [{ ...list[1], parent: 1 }, list[2]], [list[3]]];
    const whole = new SceneAnimations(list);
    const stepped = new SceneAnimations([]);
    for (const slice of slices) stepped.add(slice.map((item) => ({ ...item })));
    const a = recorder();
    const b = recorder();
    const eventsA: AnimationEventRecord[] = [];
    const eventsB: AnimationEventRecord[] = [];
    for (let i = 0; i < 120; i++) {
      whole.frame(DT, a.state, { event: (event) => eventsA.push(event) });
      stepped.frame(DT, b.state, { event: (event) => eventsB.push(event) });
    }
    expect(b.writes).toEqual(a.writes);
    expect(eventsB).toEqual(eventsA);
    expect(eventsA.length).toBeGreaterThan(0);
  });
});

describe("SceneAnimations.replaceObjects（L6）", () => {
  /** 两个对象各一条：对象 1 的那条是要被替换的。 */
  const two = () => [
    anim(0, "alpha"),
    anim(1, "alpha", { clock: { fps: 24, length: 48, mode: 1, startpaused: false } }),
  ];

  it("同 id、时钟参数相同：接回 t / flags / rate，之后每帧写出的值与没替换过的逐位相同；别的对象不受影响", () => {
    const replaced = new SceneAnimations(two());
    const reference = new SceneAnimations(two());
    const a = recorder();
    const b = recorder();
    for (let i = 0; i < 37; i++) {
      replaced.frame(DT, a.state);
      reference.frame(DT, b.state);
    }
    // 脚本改过的速率与暂停状态也接回来
    replaced.control("objects/1/alpha")!.rate = 2;
    reference.control("objects/1/alpha")!.rate = 2;
    replaced.replaceObjects(new Set([1]), [two()[1]]);
    a.writes.length = 0;
    b.writes.length = 0;
    for (let i = 0; i < 60; i++) {
      replaced.frame(DT, a.state);
      reference.frame(DT, b.state);
    }
    const sorted = (writes: [string, SceneScalar][]) => [...writes].sort((x, y) => x[0].localeCompare(y[0]));
    expect(sorted(a.writes)).toEqual(sorted(b.writes));
    expect(replaced.control("objects/1/alpha")!.rate).toBe(2);
    expect(replaced.control("objects/1/alpha")!.getFrame()).toBe(reference.control("objects/1/alpha")!.getFrame());
  });

  it("暂停的接回来还是暂停（flags 整个拷）", () => {
    const players = new SceneAnimations(two());
    const { state } = recorder();
    for (let i = 0; i < 10; i++) players.frame(DT, state);
    players.control("objects/1/alpha")!.pause();
    const frame = players.control("objects/1/alpha")!.getFrame();
    players.replaceObjects(new Set([1]), [two()[1]]);
    for (let i = 0; i < 10; i++) players.frame(DT, state);
    expect(players.control("objects/1/alpha")!.isPlaying()).toBe(false);
    expect(players.control("objects/1/alpha")!.getFrame()).toBe(frame);
  });

  it("不同 id、时钟参数变了：从 0 开始（同新加的条目）；已给出的控制对象作废", () => {
    const players = new SceneAnimations(two());
    const { state } = recorder();
    for (let i = 0; i < 30; i++) players.frame(DT, state);
    const old = players.control("objects/1/alpha")!;
    players.replaceObjects(new Set([1]), [
      anim(1, "brightness"),
      // 同 id 但 fps 变了：不接
      anim(1, "alpha", { clock: { fps: 30, length: 48, mode: 1, startpaused: false } }),
    ]);
    expect(players.control("objects/1/brightness")!.getFrame()).toBe(0);
    expect(players.control("objects/1/alpha")!.getFrame()).toBe(0);
    expect(players.control("objects/1/alpha")).not.toBe(old);
    // 对象 0 的不动
    expect(players.control("objects/0/alpha")!.getFrame()).toBeGreaterThan(0);
  });

  it("联动：父与子一起换，新子借新父的（接回来的）时钟", () => {
    const list = [anim(1, "alpha", { parent: 1 }), anim(1, "brightness")];
    const replaced = new SceneAnimations(list);
    const reference = new SceneAnimations(list);
    const a = recorder();
    const b = recorder();
    for (let i = 0; i < 20; i++) {
      replaced.frame(DT, a.state);
      reference.frame(DT, b.state);
    }
    replaced.replaceObjects(
      new Set([1]),
      list.map((item) => ({ ...item })),
    );
    a.writes.length = 0;
    b.writes.length = 0;
    for (let i = 0; i < 20; i++) {
      replaced.frame(DT, a.state);
      reference.frame(DT, b.state);
    }
    expect(a.writes).toEqual(b.writes);
  });
});
