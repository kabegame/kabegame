/**
 * P10a 步骤 3 的播放器单测（`player.ts`）：按帧写入、联动借父的时钟（子排在父前面也不晚一帧、每个时钟每帧只推进一次）、暂停照写、
 * 不写的照走照收事件、事件每帧清空、`carryOver`（时钟与标志接上、曲线相同复用 `Channel`、参数不同不接）、`seek` 三种模式、不能就地写的
 * 目标、声音的回调。依据 `.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md`「步骤 3」与 `rea-p10-keyframes.md` 第 1、4、7、8、
 * 9、12 节。期望值由步骤 1 已逐位验过的 `AnimationClock` + `frameValues` 另算一遍（独立建时钟、独立推进），再配几处手算。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneBinding } from "../compile/bindings";
import { compileScene, type SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { JsonObject, SceneScalar } from "../compile/model";
import { SceneState } from "../render/state";
import { AnimationClock, BACK, DONE, PAUSED } from "./clock";
import { Channel, frameValues, type ParsedKey } from "./curve";
import { EMPTY_ANIMATIONS_PROBE, SceneAnimations, type AnimationSink } from "./player";
import type { AnimationClockParams, SceneAnimation } from "./types";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f = Math.fround;
const DT = 1 / 60;

/** 两侧切线都关的关键帧。 */
const key = (frame: number, value: number, flags = 0): ParsedKey => ({
  frame,
  value: f(value),
  flags,
  bx: 0,
  by: 0,
  fx: 0,
  fy: 0,
});
const LIN = [key(0, 0), key(60, 600)];

const CLOCK: AnimationClockParams = { fps: 30, length: 60, mode: 0, startpaused: false };

function anim(
  id: string,
  options: { clock?: Partial<AnimationClockParams> } & Partial<Omit<SceneAnimation, "clock">> = {},
): SceneAnimation {
  const { clock, ...rest } = options;
  return {
    id,
    target: { kind: "layer", object: 0, field: "alpha" },
    valueType: "float",
    channels: [LIN],
    parent: null,
    events: [],
    writes: true,
    ...rest,
    clock: { ...CLOCK, ...clock },
  };
}

/** 照读码独立算：一个新时钟按 `dts` 推进（rate 1），再对 `channels` 帧间插值。 */
function oracle(params: AnimationClockParams, channels: readonly ParsedKey[][], dts: number[]): number[] {
  const clock = new AnimationClock(params);
  for (const dt of dts) clock.advance(f(f(1) * f(dt)), []);
  const out = new Float32Array(channels.length);
  frameValues(
    clock,
    channels.map((keys) => new Channel(keys)),
    out,
  );
  return Array.from(out);
}

/** 逐帧累加的 float32 时间（同 `AnimationClock.advance` 的 `t1 = f(d + t0)`）。 */
function accumulated(dts: number[]): number {
  let t = 0;
  for (const dt of dts) t = f(f(dt) + t);
  return t;
}

const label = (binding: SceneBinding) => {
  const target = binding.target as { kind: string; object?: number; field?: string };
  return `${target.kind}:${target.object ?? ""}:${target.field ?? ""}`;
};

/** 记下每次写入（目标、原值）的替身。 */
function recorder() {
  const writes: [string, SceneScalar][] = [];
  const state: AnimationSink = {
    write(binding, raw) {
      writes.push([label(binding), raw]);
      return "applied";
    },
  };
  return { writes, state };
}

/** 读私有的通道（核对 `carryOver` 复用的是不是同一个 `Channel`）。 */
const channelsOf = (players: SceneAnimations, index: number) =>
  (players as unknown as { tracks: { channels: Channel[] }[] }).tracks[index].channels;

function memory(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return new TextEncoder().encode(JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}

/** scene.json 里的关键帧值（同 `p10.py` 的写法）。 */
function kf(channels: unknown[][], options: JsonObject, value: unknown): JsonObject {
  const animation: JsonObject = { options: { fps: 30, length: 60, mode: "loop", ...options } };
  channels.forEach((channel, i) => (animation[`c${i}`] = channel));
  return { animation, value };
}
const jsonKey = (frame: number, value: number) => ({
  frame,
  value,
  back: { enabled: false, x: -1, y: 0 },
  front: { enabled: false, x: 1, y: 0 },
});

/** 内存里编译一个只有图像层的场景（不要翻译器），用真的 bundle 与 `SceneState`。 */
function compile(objects: JsonObject[]): Promise<SceneBundle> {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memory({
      "P:/p/project.json": { file: "scene.json", general: { properties: {} } },
      "P:/p/scene.json": { general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects },
      "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
      "P:/p/materials/a.json": { passes: [{ shader: "simple" }] },
    }),
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

const image = (extra: JsonObject): JsonObject => ({ image: "models/a.json", size: "40 60", ...extra });

describe("SceneAnimations：按帧写入（真的 bundle 与 SceneState）", () => {
  it("每个实时帧推进、求值、写进状态；float 与 vec3 都对得上独立求值，布尔不写", async () => {
    const alpha = [jsonKey(0, 0), jsonKey(60, 1)];
    const x = [jsonKey(0, 100), jsonKey(60, 700)];
    const y = [jsonKey(0, 50), jsonKey(30, 80)];
    const z = [jsonKey(0, 0)];
    const bundle = await compile([
      image({
        id: 1,
        alpha: kf([alpha], {}, 0.25),
        origin: kf([x, y, z], {}, "10 20 0"),
        visible: kf([[jsonKey(0, 0), jsonKey(60, 1)]], {}, true),
      }),
    ]);
    // 没有翻译器只报 `shader:wasm-missing`；关键帧不报能力键（过渡键已删）
    expect(bundle.unsupported).toEqual(["shader:wasm-missing"]);
    expect(bundle.animations!.map((item) => [item.id, item.writes])).toEqual([
      ["objects/0/alpha", true],
      ["objects/0/origin", true],
      ["objects/0/visible", false],
    ]);
    const state = SceneState.fromBundle(bundle);
    // 编译期的初值是 `value`（WPE 加载时写的也是它）
    expect(state.layers.get(0)!.alpha).toBe(0.25);
    expect(state.layers.get(0)!.origin).toEqual([10, 20, 0]);
    const players = new SceneAnimations(bundle.animations!);
    const dts: number[] = [];
    for (let i = 0; i < 5; i++) {
      players.frame(DT, state);
      dts.push(DT);
      const [a] = oracle(bundle.animations![0].clock, bundle.animations![0].channels, dts);
      expect(state.layers.get(0)!.alpha).toBe(a);
      expect(state.layers.get(0)!.origin).toEqual(
        oracle(bundle.animations![1].clock, bundle.animations![1].channels, dts),
      );
      expect(state.layers.get(0)!.visible).toBe(true);
    }
    // 手算：第 5 帧 t = 5/60 s = 第 2.5 帧，线性 0 → 1（60 帧）约 2.5 / 60；origin.x 100 → 700 约 125。两侧切线都关的贝塞尔
    // 反解容差 0.01 帧，误差在「斜率 × 0.01 帧」以内（x 每帧 10，所以 0.1 以内，读码第 2 节）
    expect(state.layers.get(0)!.alpha).toBeCloseTo(2.5 / 60, 3);
    expect(Math.abs(state.layers.get(0)!.origin[0] - 125)).toBeLessThan(0.1);
    const probe = players.probe();
    expect(probe.list.map((item) => [item.id, item.owner, item.writes, item.target, item.value !== null])).toEqual([
      ["objects/0/alpha", 0, true, "layer", true],
      ["objects/0/origin", 1, true, "layer", true],
      ["objects/0/visible", 2, false, "layer", false],
    ]);
    expect(probe.list[0].t).toBe(accumulated(dts));
    expect(probe.list[0].value).toEqual([state.layers.get(0)!.alpha]);
    expect(probe.frameMs.count).toBe(5);
  });

  it("startpaused：时钟不走，每帧照写第 0 帧的值（首帧不在 0 时是首帧值），脚本或用户写进的值只活一帧", async () => {
    const bundle = await compile([
      image({ id: 1, alpha: kf([[jsonKey(15, 0.3), jsonKey(45, 0.9)]], { startpaused: true }, 0.7) }),
    ]);
    const state = SceneState.fromBundle(bundle);
    const binding = { property: "", target: bundle.animations![0].target };
    const players = new SceneAnimations(bundle.animations!);
    for (let i = 0; i < 3; i++) {
      players.frame(DT, state);
      expect(state.layers.get(0)!.alpha).toBe(f(0.3));
      // 动画之后别人写的值（脚本写回、用户属性），下一帧被动画覆盖
      state.write(binding, 0.9);
    }
    const [entry] = players.probe().list;
    expect(entry).toMatchObject({ t: 0, frame: 0, playing: false });
    expect(entry.flags & PAUSED).toBe(PAUSED);
  });
});

describe("SceneAnimations：联动（读码第 7 节）", () => {
  it("子借父的时钟：子排在父前面时第一次用到就推进父的，当帧生效；子自己的 fps / length / startpaused / events 不起作用", () => {
    const childKeys = [key(0, 0), key(60, 6)];
    const list = [
      anim("objects/0/alpha", {
        parent: 1,
        channels: [childKeys],
        clock: { fps: 10, length: 10, startpaused: true },
        events: [{ time: 0, json: '{"frame":0,"name":"child"}' }],
      }),
      anim("objects/0/origin", {
        target: { kind: "layer", object: 0, field: "origin" },
        valueType: "vec3",
        channels: [LIN, LIN, LIN],
      }),
    ];
    const { writes, state } = recorder();
    const players = new SceneAnimations(list);
    const dts: number[] = [];
    for (let i = 0; i < 4; i++) {
      writes.length = 0;
      players.frame(DT, state);
      dts.push(DT);
      // 子的值按父的时钟（30 fps、length 60）解读自己的关键帧，和父同一帧
      const [child] = oracle(CLOCK, [childKeys], dts);
      const parent = oracle(CLOCK, [LIN, LIN, LIN], dts);
      expect(writes).toEqual([
        ["layer:0:alpha", child],
        ["layer:0:origin", parent.join(" ")],
      ]);
      // 子的事件永远不触发（子的时钟从不推进）
      expect(players.events).toEqual([]);
    }
    const probe = players.probe().list;
    // 每个时钟每帧只推进一次：4 帧后正好是 4 个 dt
    expect(probe.map((item) => [item.owner, item.t])).toEqual([
      [1, accumulated(dts)],
      [1, accumulated(dts)],
    ]);
  });

  it("一个父两个子：父的时钟每帧只推进一次；父暂停时子也不动（照写当前值）", () => {
    const list = [
      anim("objects/0/alpha", { parent: 2 }),
      anim("objects/0/brightness", { parent: 2, target: { kind: "layer", object: 0, field: "brightness" } }),
      anim("objects/0/origin", {
        target: { kind: "layer", object: 0, field: "origin" },
        valueType: "vec3",
        channels: [LIN, LIN, LIN],
      }),
    ];
    const { state } = recorder();
    const players = new SceneAnimations(list);
    for (let i = 0; i < 3; i++) players.frame(DT, state);
    expect(new Set(players.probe().list.map((item) => item.t))).toEqual(new Set([accumulated([DT, DT, DT])]));

    const paused = [
      anim("objects/0/alpha", { parent: 1 }),
      anim("objects/0/brightness", {
        target: { kind: "layer", object: 0, field: "brightness" },
        clock: { startpaused: true },
      }),
    ];
    const recorded = recorder();
    const still = new SceneAnimations(paused);
    for (let i = 0; i < 3; i++) still.frame(DT, recorded.state);
    expect(recorded.writes.filter(([target]) => target === "layer:0:alpha").map(([, raw]) => raw)).toEqual([0, 0, 0]);
  });

  it("父无效（越界、自己、父还有父）时用自己的时钟", () => {
    const list = [
      anim("a", { parent: 5 }),
      anim("b", { parent: 1 }),
      anim("c", { parent: 0, clock: { startpaused: true } }),
      anim("d", { parent: 4 }),
      anim("e"),
    ];
    const players = new SceneAnimations(list);
    players.frame(DT, recorder().state);
    expect(players.probe().list.map((item) => [item.owner, item.t])).toEqual([
      // 越界、自己：用自己的
      [0, f(DT)],
      [1, f(DT)],
      // c 的父 a 自己有父（哪怕 a 的父无效）：不认，用自己的（startpaused，不走）
      [2, 0],
      // d 的父 e 有效（排在后面也行）
      [4, f(DT)],
      [4, f(DT)],
    ]);
  });
});

describe("SceneAnimations：写不写与事件", () => {
  it("writes 为假的不写，但时钟照走、事件照收", () => {
    const { writes, state } = recorder();
    const players = new SceneAnimations([
      anim("objects/0/visible", { writes: false, events: [{ time: 0, json: '{"frame":0,"name":"e0"}' }] }),
    ]);
    players.frame(DT, state);
    expect(writes).toEqual([]);
    expect(players.events).toEqual([{ animation: 0, json: '{"frame":0,"name":"e0"}' }]);
    expect(players.probe().list[0]).toMatchObject({ t: f(DT), value: null, writes: false });
  });

  it("事件按主人的下标记、每帧开头清空；loop 回绕后再收", () => {
    const spf = f(1 / 30);
    // 子（下标 0）排在父前面：事件记在父（时钟主人）的下标上
    const players = new SceneAnimations([
      anim("objects/0/alpha", { parent: 1 }),
      anim("objects/0/origin", {
        target: { kind: "layer", object: 0, field: "origin" },
        valueType: "vec3",
        channels: [LIN, LIN, LIN],
        clock: { length: 6 },
        events: [
          { time: 0, json: "e0" },
          { time: f(f(4) * spf), json: "e4" },
        ],
      }),
    ]);
    const { state } = recorder();
    const seen: string[][] = [];
    // D = 6 / 30 = 0.2 s，第 4 帧的事件在 0.133 s；每帧 0.06 s（都离边界远）
    for (let i = 0; i < 6; i++) {
      players.frame(0.06, state);
      seen.push(players.events.map((event) => `${event.animation}:${event.json}`));
    }
    // [0, 0.06) 收第 0 帧的；[0.06, 0.12) 什么都没有（上一帧的不残留）；[0.12, 0.18) 收第 4 帧的；[0.18, 0.24) 回绕到 0.04、再收
    // [0, 0.04) 的第 0 帧；之后同理
    expect(seen).toEqual([["1:e0"], [], ["1:e4"], ["1:e0"], [], ["1:e4"]]);
  });

  it("目标是 recompile / unsupported / script-property 的一律不写（只有 dev 强制渲染会走到）；时钟照走", () => {
    const { writes, state } = recorder();
    const players = new SceneAnimations([
      anim("x", { target: { kind: "recompile", reason: "layer-structure", path: "objects/0/colorBlendMode" } }),
      anim("y", { target: { kind: "unsupported", path: "objects/0/instanceoverride/x" } as never }),
      anim("z", { target: { kind: "script-property", script: "objects/0/alpha", key: "speed" } }),
      anim("w"),
    ]);
    players.frame(DT, state);
    players.write(state);
    expect(writes.map(([target]) => target)).toEqual(["layer:0:alpha", "layer:0:alpha"]);
    expect(players.probe().list.map((item) => [item.t, item.value === null])).toEqual([
      [f(DT), true],
      [f(DT), true],
      [f(DT), true],
      [f(DT), false],
    ]);
  });

  it("声音目标：写完当场回调（回调里读到的是新值）；write 同样回调；别的目标不回调", () => {
    const volumes = new Map([[3, 1]]);
    const state: AnimationSink = {
      write(binding, raw) {
        if (binding.target.kind === "sound") volumes.set(binding.target.object, Number(raw));
        return "applied";
      },
    };
    const keys = [key(0, 1), key(60, 0)];
    const players = new SceneAnimations([
      anim("objects/0/alpha"),
      anim("objects/3/volume", { target: { kind: "sound", object: 3, field: "volume" }, channels: [keys] }),
    ]);
    const seen: [number, number][] = [];
    const hook = (object: number) => void seen.push([object, volumes.get(object)!]);
    players.frame(DT, state, hook);
    const [expected] = oracle(CLOCK, [keys], [DT]);
    expect(expected).toBeLessThan(1);
    expect(seen).toEqual([[3, expected]]);
    players.write(state, hook);
    expect(seen).toEqual([
      [3, expected],
      [3, expected],
    ]);
  });
});

describe("SceneAnimations：write 与探针", () => {
  it("write 不推进，按当前时钟写会写的每条；frame 之前探针的值为 null", () => {
    const { writes, state } = recorder();
    const players = new SceneAnimations([anim("objects/0/alpha", { channels: [[key(0, 0.4), key(60, 1)]] })]);
    expect(players.probe().list[0].value).toBeNull();
    players.write(state);
    players.write(state);
    expect(writes).toEqual([
      ["layer:0:alpha", f(0.4)],
      ["layer:0:alpha", f(0.4)],
    ]);
    expect(players.probe().list[0]).toMatchObject({ t: 0, value: [f(0.4)] });
    expect(players.probe().frameMs.count).toBe(0);
  });

  it("耗时只留最近 600 次；空播放器的探针同空结果", () => {
    const players = new SceneAnimations([anim("a")]);
    const { state } = recorder();
    for (let i = 0; i < 700; i++) players.frame(DT, state);
    const probe = players.probe();
    expect(probe.frameMs.count).toBe(600);
    expect(probe.frameMs.mean).toBeGreaterThanOrEqual(0);
    expect(probe.frameMs.p95).toBeGreaterThanOrEqual(0);
    expect(new SceneAnimations([]).probe()).toEqual(EMPTY_ANIMATIONS_PROBE);
  });
});

describe("SceneAnimations：carryOver（重编译接回）", () => {
  const params = (clock: Partial<AnimationClockParams> = {}) =>
    anim("objects/0/alpha", { channels: [[key(0, 0), key(60, 600)]], clock });

  it("时钟连续：t 与 flags 接上，之后接着走", () => {
    const { state } = recorder();
    const before = new SceneAnimations([params()]);
    for (let i = 0; i < 3; i++) before.frame(DT, state);
    const after = new SceneAnimations([structuredClone(params())]);
    after.carryOver(before);
    expect(after.probe().list[0].t).toBe(accumulated([DT, DT, DT]));
    after.frame(DT, state);
    expect(after.probe().list[0].t).toBe(accumulated([DT, DT, DT, DT]));
    // 新的没有 carryOver 时从 0 开始
    const fresh = new SceneAnimations([params()]);
    fresh.carryOver(null);
    expect(fresh.probe().list[0].t).toBe(0);
  });

  it("flags 整个拷：暂停（startpaused 不同也照拷）、结束、mirror 的反向位", () => {
    const { state } = recorder();
    // 旧的在播，新的 startpaused：接上后仍在播
    const playing = new SceneAnimations([params()]);
    playing.frame(DT, state);
    const paused = new SceneAnimations([params({ startpaused: true })]);
    paused.carryOver(playing);
    expect(paused.probe().list[0]).toMatchObject({ t: f(DT), playing: true });
    // 旧的暂停，新的不暂停：接上后仍暂停
    const pausedOld = new SceneAnimations([params({ startpaused: true })]);
    const resumed = new SceneAnimations([params()]);
    resumed.carryOver(pausedOld);
    expect(resumed.probe().list[0].playing).toBe(false);
    // single 播完（DONE）
    const single = new SceneAnimations([params({ mode: 2, length: 3 })]);
    for (let i = 0; i < 10; i++) single.frame(DT, state);
    const singleAfter = new SceneAnimations([params({ mode: 2, length: 3 })]);
    singleAfter.carryOver(single);
    expect(singleAfter.probe().list[0].flags & DONE).toBe(DONE);
    expect(singleAfter.probe().list[0].t).toBe(single.probe().list[0].t);
    // mirror 正在反向（BACK）
    const mirror = new SceneAnimations([params({ mode: 1, length: 3 })]);
    for (let i = 0; i < 8; i++) mirror.frame(DT, state);
    expect((mirror.probe().list[0].flags & BACK) >>> 0).toBe(BACK);
    const mirrorAfter = new SceneAnimations([params({ mode: 1, length: 3 })]);
    mirrorAfter.carryOver(mirror);
    expect(mirrorAfter.probe().list[0].flags).toBe(mirror.probe().list[0].flags);
    expect(mirrorAfter.probe().list[0].t).toBe(mirror.probe().list[0].t);
  });

  it("时钟参数（fps / length / mode）不同、id 找不到、新的是子时从 0 开始；曲线照样按 id 比", () => {
    const { state } = recorder();
    const before = new SceneAnimations([params(), anim("other")]);
    before.frame(DT, state);
    for (const changed of [{ fps: 60 }, { length: 30 }, { mode: 1 as const }]) {
      const after = new SceneAnimations([params(changed)]);
      after.carryOver(before);
      expect(after.probe().list[0].t).toBe(0);
    }
    const renamed = new SceneAnimations([anim("objects/0/brightness")]);
    renamed.carryOver(before);
    expect(renamed.probe().list[0].t).toBe(0);
    // 原来是主人、现在是子：没有自己的时钟可接，借新父的（新父 other 也接回了）
    const child = new SceneAnimations([anim("other"), anim("objects/0/alpha", { parent: 0 })]);
    child.carryOver(before);
    expect(child.probe().list.map((item) => [item.owner, item.t])).toEqual([
      [0, f(DT)],
      [0, f(DT)],
    ]);
  });

  it("关键帧逐项相同的复用旧的 Channel（整数帧缓存跟着来），不同的用新的", () => {
    const { state } = recorder();
    const keysA = [key(0, 0), key(60, 600)];
    const keysB = [key(0, 0), key(60, 300)];
    const before = new SceneAnimations([
      anim("objects/0/origin", {
        target: { kind: "layer", object: 0, field: "origin" },
        valueType: "vec3",
        channels: [keysA, keysA, keysA],
      }),
    ]);
    before.frame(DT, state);
    const old = channelsOf(before, 0);
    const after = new SceneAnimations([
      anim("objects/0/origin", {
        target: { kind: "layer", object: 0, field: "origin" },
        valueType: "vec3",
        // 第 0 条逐项相同（另一份拷贝），第 1 条值不同，第 2 条多一个关键帧
        channels: [structuredClone(keysA), keysB, [...keysA, key(90, 1)]],
      }),
    ]);
    const fresh = channelsOf(after, 0);
    after.carryOver(before);
    const reused = channelsOf(after, 0);
    expect(reused[0]).toBe(old[0]);
    expect(reused[1]).toBe(fresh[1]);
    expect(reused[2]).toBe(fresh[2]);
    // 用的是新曲线：第 1 条按 keysB 求值
    const recorded = recorder();
    after.write(recorded.state);
    const expected = oracle(CLOCK, [keysA, keysB, [...keysA, key(90, 1)]], [DT]);
    expect(recorded.writes).toEqual([["layer:0:origin", expected.join(" ")]]);
  });
});

describe("SceneAnimations：seek（dev 探针）", () => {
  // fps 30、length 60：D = 2 s
  const seekOne = (clock: Partial<AnimationClockParams>, time: number) => {
    const players = new SceneAnimations([anim("a", { clock })]);
    players.seek(time);
    return players.probe().list[0];
  };

  it("loop 取 fmodf；mirror 三角波（奇数轮置 BACK、偶数轮清）；single 钳到 D、到头置 DONE", () => {
    expect(seekOne({}, 2.5)).toMatchObject({ t: f(0.5), flags: 0 });
    expect(seekOne({}, 4)).toMatchObject({ t: 0 });
    expect(seekOne({ mode: 1 }, 2.5)).toMatchObject({ t: f(1.5), flags: (1 | BACK) >>> 0 });
    expect(seekOne({ mode: 1 }, 4.5)).toMatchObject({ t: f(0.5), flags: 1 });
    expect(seekOne({ mode: 1 }, 6)).toMatchObject({ t: 2, flags: (1 | BACK) >>> 0 });
    expect(seekOne({ mode: 1 }, 1.25)).toMatchObject({ t: f(1.25), flags: 1 });
    expect(seekOne({ mode: 2 }, 1)).toMatchObject({ t: 1, flags: 2, playing: true });
    expect(seekOne({ mode: 2 }, 3)).toMatchObject({ t: 2, flags: (2 | DONE) >>> 0, playing: false });
    // 不是正的有限数时按 0
    expect(seekOne({}, -1).t).toBe(0);
    expect(seekOne({}, Number.NaN).t).toBe(0);
  });

  it("暂停的不动；single 到头后再 seek 回来清 DONE、mirror 回到偶数轮清 BACK；子没有自己的时钟", () => {
    expect(seekOne({ startpaused: true }, 1).t).toBe(0);
    const players = new SceneAnimations([anim("a", { clock: { mode: 2 } }), anim("b", { parent: 0 })]);
    players.seek(3);
    expect(players.probe().list[0].flags & DONE).toBe(DONE);
    players.seek(0.5);
    expect(players.probe().list.map((item) => [item.owner, item.t, item.playing])).toEqual([
      [0, f(0.5), true],
      [0, f(0.5), true],
    ]);
    const mirror = new SceneAnimations([anim("m", { clock: { mode: 1 } })]);
    mirror.seek(3);
    expect((mirror.probe().list[0].flags & BACK) >>> 0).toBe(BACK);
    mirror.seek(1);
    expect(mirror.probe().list[0]).toMatchObject({ t: 1, flags: 1 });
  });

  it("seek 之后 write：值同独立时钟停在这个时刻的求值", () => {
    const players = new SceneAnimations([anim("a")]);
    const { writes, state } = recorder();
    players.seek(0.75);
    players.write(state);
    const clock = new AnimationClock(CLOCK);
    clock.t = f(0.75);
    const out = new Float32Array(1);
    frameValues(clock, [new Channel(LIN)], out);
    expect(writes).toEqual([["layer:0:alpha", out[0]]]);
  });
});
