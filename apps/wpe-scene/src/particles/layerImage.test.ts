/**
 * P4j 步骤 2a 的单测（`.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md`「2a 的测试」）：发射图候选表的状态机与建表。
 * 依据 `rea-p4j-layerimage.md` 2.1–2.5、3.1，时序按 `p4-particles-REPORT.md`「P4j 语义的实测核对」的计数：
 * 无预热丢前两个发射帧、有预热只丢一个、共享记录后调用的早一帧拿到表。
 * - `emitterImageSize`：2.2 的压缩与 `max(2, ·)`；
 * - `buildEmitterImageTable`：列优先、alpha 126 / 127、float32 截断、y 用 x 方向的 `s`；步骤 0 抓帧核对过的 `p4j-li-map` 表逐项相同；
 * - 状态机（`ScriptedEmitterImageView` 当假 GPU）：各种时序、快照晚到、尺寸变化、`refresh`、空表、图层不存在；
 * - 系统：`layerimage` 只在 `n > 0` 的帧取表，`0x20000` 的计时（`fmodf`、严格大于 1）。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import table from "./fixtures/p4j-map-table.json";
import {
  buildEmitterImageTable,
  EmitterImageRecords,
  emitterImageSize,
  ScriptedEmitterImageView,
  type EmitterImageBinding,
  type EmitterImageSnapshot,
  type EmitterImageSource,
} from "./layerImage";
import { SeededRandom } from "./random";
import { ParticleSystem } from "./system";

describe("emitterImageSize：2.2 的尺寸", () => {
  it("不压：96×64 → 24×16；3840×2160 → 960×540", () => {
    expect(emitterImageSize(96, 64)).toEqual({ w4: 24, h4: 16 });
    expect(emitterImageSize(3840, 2160)).toEqual({ w4: 960, h4: 540 });
  });

  it("压：4025×2460（雨景）→ 883×540；5000×1000（宽于 16:9）→ 960×192", () => {
    expect(emitterImageSize(4025, 2460)).toEqual({ w4: 883, h4: 540 });
    expect(emitterImageSize(5000, 1000)).toEqual({ w4: 960, h4: 192 });
  });

  it("窄于 16:9 按高压；小于 8 像素取 2", () => {
    expect(emitterImageSize(2000, 4000)).toEqual({ w4: 270, h4: 540 });
    expect(emitterImageSize(1, 1)).toEqual({ w4: 2, h4: 2 });
    expect(emitterImageSize(7, 3)).toEqual({ w4: 2, h4: 2 });
  });
});

/** w4 × h4 的 RGBA8，`alpha(col, row)` 与 `rgb(col, row)` 逐像素给。 */
function snapshotOf(
  width: number,
  height: number,
  w4: number,
  h4: number,
  alpha: (col: number, row: number) => number,
  rgb: (col: number, row: number) => [number, number, number] = (col, row) => [col, row, 9],
): EmitterImageSnapshot {
  const pixels = new Uint8Array(w4 * h4 * 4);
  for (let row = 0; row < h4; row++)
    for (let col = 0; col < w4; col++) {
      const i = (row * w4 + col) * 4;
      pixels.set(rgb(col, row), i);
      pixels[i + 3] = alpha(col, row);
    }
  return { pixels, w4, h4, width, height };
}

const entries = (t: ReturnType<typeof buildEmitterImageTable>) =>
  Array.from({ length: t.count }, (_, i) => [t.x[i], t.y[i], t.rgb[i * 3], t.rgb[i * 3 + 1], t.rgb[i * 3 + 2]]);

describe("buildEmitterImageTable：2.3 的建表", () => {
  it("列优先（x 外层）、alpha 126 跳过 / 127 收、rgb 取像素", () => {
    // 4×4，s = 2、hs = 1：x′ = 2x − 4 + 1
    const snapshot = snapshotOf(8, 8, 4, 4, (col, row) =>
      col === 1 && row === 2 ? 126 : col === 2 && row === 1 ? 127 : 0,
    );
    expect(entries(buildEmitterImageTable(snapshot))).toEqual([[1, -1, 2, 1, 9]]);
    const all = buildEmitterImageTable(snapshotOf(8, 8, 4, 4, () => 255));
    expect(all.count).toBe(16);
    // 先 x 后 y：前四项是 x = 0 列的四行
    expect(entries(all).slice(0, 5)).toEqual([
      [-3, -3, 0, 0, 9],
      [-3, -1, 0, 1, 9],
      [-3, 1, 0, 2, 9],
      [-3, 3, 0, 3, 9],
      [-1, -3, 1, 0, 9],
    ]);
  });

  it("float32 截断（向 0，不是 floor）、奇数宽高丢 0.5、y 也用 x 方向的 s", () => {
    // 10×6 → 2×2：s = 5、hs = 2.5（y 若用 H / h4 = 3，y = 1 的坐标会是 1）；W >> 1 = 5、H >> 1 = 3
    const t = buildEmitterImageTable(snapshotOf(10, 6, 2, 2, () => 255));
    expect(entries(t).map(([x, y]) => [x, y])).toEqual([
      [-2, 0], // −2.5 → −2（floor 会得 −3）；−0.5 → 0
      [-2, 4],
      [2, 0],
      [2, 4],
    ]);
    // 奇数宽高：W = 9 → W >> 1 = 4（不是 4.5）；s = 4.5、hs = 2.25：x = 0 → −4 + 2.25 = −1.75 → −1
    const odd = buildEmitterImageTable(snapshotOf(9, 5, 2, 2, () => 255));
    expect(odd.x[0]).toBe(-1);
  });

  it("全透明得空表", () => {
    expect(buildEmitterImageTable(snapshotOf(8, 8, 4, 4, () => 0)).count).toBe(0);
  });

  it("p4j-li-map 的表（步骤 0 抓帧核对过）逐项相同", () => {
    const snapshot: EmitterImageSnapshot = {
      pixels: Uint8Array.from(table.pixels),
      w4: table.w4,
      h4: table.h4,
      width: table.width,
      height: table.height,
    };
    expect(entries(buildEmitterImageTable(snapshot))).toEqual(table.entries);
  });
});

// 状态机 -------------------------------------------------------------------------------------------------------------------------------

const BINDING: EmitterImageBinding = { id: 2, mask: "" };
const solid = (value = 200) =>
  snapshotOf(
    8,
    8,
    4,
    4,
    () => 255,
    () => [value, value, value],
  );

/** 假 GPU：`has(frame)` 为真的帧才有「第 frame 帧末」的快照（还没读回的帧为假）。 */
function setup(options: { has: (frame: number) => boolean; snapshot?: () => EmitterImageSnapshot }) {
  const state = { size: { width: 8, height: 8 } as { width: number; height: number } | null };
  const view = new ScriptedEmitterImageView({
    layerSize: () => state.size,
    snapshotAt: (_id, _mask, frame) => (options.has(frame) ? (options.snapshot ?? (() => solid()))() : null),
  });
  return { state, records: new EmitterImageRecords(view) };
}

describe("EmitterImageRecord：2.1 的状态机", () => {
  it("无预热：第 1 个发射帧过门、第 2 个锁定、第 3 个出表，前两帧返回 null", () => {
    const { records } = setup({ has: (frame) => frame >= 1 });
    const record = records.record(BINDING);
    const got = [1, 2, 3, 4].map((frame) => records.acquire(BINDING, frame));
    expect(got.map((value) => value !== null)).toEqual([false, false, true, true]);
    expect(record.state).toBe(2);
    expect(record.table!.count).toBe(16);
  });

  it("有预热（帧号 0 过门）：第 1 帧锁定「本帧末」的那份、第 2 帧出表", () => {
    // 加载那一帧没画（frame 0 没有快照），第 1 帧末才有
    const { records } = setup({ has: (frame) => frame >= 1 });
    expect(records.acquire(BINDING, 0)).toBeNull();
    expect(records.acquire(BINDING, 1)).toBeNull();
    expect(records.record(BINDING).state).toBe(1);
    expect(records.acquire(BINDING, 2)).not.toBeNull();
  });

  it("快照没到：留在状态 1、一直返回 null，到了的下一个发射帧出表", () => {
    let ready = false;
    // 上一帧末没有快照，只有锁定的「本帧末」那份，读回晚到
    const { records } = setup({ has: (frame) => frame === 2 && ready });
    const record = records.record(BINDING);
    expect(records.acquire(BINDING, 1)).toBeNull(); // 门
    expect(records.acquire(BINDING, 2)).toBeNull(); // 状态 0 → 1，锁 frame 2 的那份
    expect(records.acquire(BINDING, 3)).toBeNull(); // 没读回
    expect(record.state).toBe(1);
    ready = true;
    expect(records.acquire(BINDING, 4)).not.toBeNull();
    expect(record.state).toBe(2);
  });

  it("两个发射器共享一条记录：同一帧里后调的接着推进，早一帧出表", () => {
    const { records } = setup({ has: (frame) => frame >= 1 });
    const a: unknown[] = [];
    const b: unknown[] = [];
    for (const frame of [1, 2, 3]) {
      a.push(records.acquire(BINDING, frame));
      b.push(records.acquire({ ...BINDING }, frame));
    }
    // 第 1 帧：A 过门，B 与门同一帧；第 2 帧：A 0 → 1，B 1 → 2 出表；第 3 帧 A 才有表
    expect(a.map((v) => v !== null)).toEqual([false, false, true]);
    expect(b.map((v) => v !== null)).toEqual([false, true, true]);
    expect(a[2]).toBe(b[1]);
  });

  it("不同 mask 是不同的记录", () => {
    const { records } = setup({ has: () => true });
    expect(records.record({ id: 2, mask: "" })).not.toBe(records.record({ id: 2, mask: "m" }));
    expect(records.record({ id: 2, mask: "m" })).toBe(records.record({ id: 2, mask: "m" }));
  });

  it("合成 RT 尺寸变了回状态 0：期间返回旧表，之后换成新表", () => {
    let version = 0;
    const { records, state } = setup({
      has: (frame) => frame >= 1,
      snapshot: () => solid(version === 0 ? 100 : 50),
    });
    for (const frame of [1, 2, 3]) records.acquire(BINDING, frame);
    const old = records.record(BINDING).table!;
    expect(old.rgb[0]).toBe(100);
    version = 1;
    state.size = { width: 16, height: 16 };
    expect(records.acquire(BINDING, 4)).toBe(old);
    expect(records.record(BINDING).state).toBe(0);
    expect(records.acquire(BINDING, 5)).toBe(old); // 0 → 1
    const fresh = records.acquire(BINDING, 6);
    expect(fresh).not.toBe(old);
    expect(fresh!.rgb[0]).toBe(50);
    expect(records.record(BINDING).width).toBe(16);
  });

  it("refresh：状态 1 时不动，其余回状态 0、表保留", () => {
    const { records } = setup({ has: (frame) => frame >= 1 });
    const record = records.record(BINDING);
    records.acquire(BINDING, 1);
    records.acquire(BINDING, 2);
    expect(record.state).toBe(1);
    record.refresh();
    expect(record.state).toBe(1);
    records.acquire(BINDING, 3);
    expect(record.state).toBe(2);
    const kept = record.table;
    record.refresh();
    expect(record.state).toBe(0);
    expect(record.table).toBe(kept);
  });

  it("空表返回 null（WPE「表非空才发」）：状态仍进 2", () => {
    const { records } = setup({ has: (frame) => frame >= 1, snapshot: () => snapshotOf(8, 8, 4, 4, () => 0) });
    for (const frame of [1, 2, 3]) expect(records.acquire(BINDING, frame)).toBeNull();
    expect(records.record(BINDING).state).toBe(2);
  });

  it("图层不存在 / 没有独占 RT：返回 null 且不过门；图层出现后从头走", () => {
    const { records, state } = setup({ has: () => true });
    state.size = null;
    for (const frame of [1, 2, 3]) expect(records.acquire(BINDING, frame)).toBeNull();
    const record = records.record(BINDING);
    expect(record.started).toBe(false);
    expect(record.state).toBe(0);
    state.size = { width: 8, height: 8 };
    expect([4, 5, 6].map((frame) => records.acquire(BINDING, frame) !== null)).toEqual([false, false, true]);
  });

  it("refresh（2.5）：状态 2 回 0、表留着到下一次建表；状态 1 不动", () => {
    const { records } = setup({ has: (frame) => frame >= 1 });
    const record = records.record(BINDING);
    for (const frame of [1, 2, 3]) records.acquire(BINDING, frame);
    expect(record.state).toBe(2);
    const table = record.table;
    records.refresh(BINDING);
    expect(record.state).toBe(0);
    expect(record.table).toBe(table);
    expect(records.acquire(BINDING, 4)).toBe(table); // 状态 0：锁定，返回旧表
    expect(record.state).toBe(1);
    records.refresh(BINDING);
    expect(record.state).toBe(1);
  });
});

// 系统 ---------------------------------------------------------------------------------------------------------------------------------

function layerSystem(emitter: JsonObject, binding = true) {
  const particle = parseParticle(
    {
      maxcount: 50,
      emitter: [{ name: "layerimage", ...emitter }],
      initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
    } as JsonObject,
    { file: "p.json", orthographic: true },
  );
  particle.emitterImages = [binding ? { id: 2, mask: "", maskTexture: null } : null];
  return new ParticleSystem(particle, new SeededRandom(1), 1);
}

describe("ParticleSystem：layerimage 取表", () => {
  const recorder = () => {
    const calls: [string, number][] = [];
    const source: EmitterImageSource = {
      acquire: (binding, frame) => (calls.push([`acquire:${binding.id}`, frame]), null),
      refresh: (binding) => void calls.push([`refresh:${binding.id}`, -1]),
    };
    return { calls, source };
  };

  it("只在 n > 0 的帧调 acquire，带帧号；没有来源时什么都不调、一颗不生", () => {
    const { calls, source } = recorder();
    const idle = layerSystem({ rate: 0 });
    idle.setEmitterImages(source);
    idle.step(0.5);
    expect(calls).toEqual([]);

    const system = layerSystem({ rate: 10 });
    system.step(0.5); // 没有来源
    expect(calls).toEqual([]);
    system.setEmitterImages(source);
    system.setEmitterImageFrame(7);
    system.step(0.5);
    expect(calls).toEqual([["acquire:2", 7]]);
    expect(system.alive).toBe(0);
  });

  it("绑定为 null 的发射器什么都不调", () => {
    const { calls, source } = recorder();
    const system = layerSystem({ rate: 10 }, false);
    system.setEmitterImages(source);
    system.step(0.5);
    expect(calls).toEqual([]);
  });

  it("0x20000：发射器自己的计时器按 dt′ 累加，严格大于 1 才 refresh，refresh 在 acquire 之前；不带这一位从不 refresh", () => {
    const plain = recorder();
    const a = layerSystem({ rate: 10, flags: 0x10000 });
    a.setEmitterImages(plain.source);
    for (let i = 0; i < 3; i++) a.step(0.5);
    expect(plain.calls.map(([name]) => name)).toEqual(["acquire:2", "acquire:2", "acquire:2"]);
    const timed = recorder();
    const b = layerSystem({ rate: 10, flags: 0x30000 });
    b.setEmitterImages(timed.source);
    for (let i = 0; i < 3; i++) b.step(0.5); // 计时 0.5、1（恰为 1 不重建）、1.5 → 重建，余 0.5
    expect(timed.calls.map(([name]) => name)).toEqual(["acquire:2", "acquire:2", "refresh:2", "acquire:2"]);
  });

  it("0x20000 的计时器每个发射器各一个（rec+0x7c）：两个发射器共享一条记录时不会累加成两倍速", () => {
    const particle = parseParticle(
      {
        maxcount: 50,
        emitter: [
          { name: "layerimage", rate: 10, flags: 0x30000 },
          { name: "layerimage", rate: 10, flags: 0x30000 },
        ],
      } as JsonObject,
      { file: "p.json", orthographic: true },
    );
    particle.emitterImages = [
      { id: 2, mask: "", maskTexture: null },
      { id: 2, mask: "", maskTexture: null },
    ];
    const system = new ParticleSystem(particle, new SeededRandom(1), 1);
    const { calls, source } = recorder();
    system.setEmitterImages(source);
    for (let i = 0; i < 4; i++) system.step(0.25); // 各自 0.25 … 1：都不重建（合成一个计时器的话第 3 帧就过 1）
    expect(calls.some(([name]) => name === "refresh:2")).toBe(false);
    system.step(0.25); // 各自 1.25：两个发射器各 refresh 一次
    expect(calls.filter(([name]) => name === "refresh:2").length).toBe(2);
  });

  it("0x20000 的计时与重建：fmodf、严格大于 1，状态 2 的记录被拉回 0", () => {
    const view = new ScriptedEmitterImageView({
      layerSize: () => ({ width: 8, height: 8 }),
      snapshotAt: () => solid(),
    });
    const records = new EmitterImageRecords(view);
    const system = layerSystem({ rate: 10, flags: 0x30000 });
    system.setEmitterImages(records);
    const record = records.record({ id: 2, mask: "" });
    const run = (frame: number) => {
      system.setEmitterImageFrame(frame);
      system.step(0.25);
    };
    for (const frame of [1, 2, 3]) run(frame); // 计时 0.75
    expect(record.state).toBe(2);
    run(4); // 计时恰为 1：不重建
    expect(record.state).toBe(2);
    run(5); // 1.25 → fmodf 余 0.25，重建：refresh 回 0，同一次调用里取表又走了状态 0 → 1
    expect(record.state).toBe(1);
    run(6); // 0.5：不重建；状态 1 读回建表
    expect(record.state).toBe(2);
    run(7); // 0.75：不重建（不取 fmodf 的话计时器停在 1 以上、每个发射帧都重建）
    expect(record.state).toBe(2);
  });
});
