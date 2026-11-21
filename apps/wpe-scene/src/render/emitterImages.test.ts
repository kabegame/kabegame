/**
 * P4j 步骤 2b：发射图候选表的 GPU 半边里不需要 GPU 的部分（`render/emitterImages.ts`）。
 * - 行尾填充：`bytesPerRow` 256 对齐、读回后去掉填充（不去掉时像素错位，变异检查）；
 * - 需要快照的判定：门没过不拍、状态没到 2 或带 `0x20000` 才拍、有人锁了本帧末的一定拍；
 * - 锁定规则（`SnapshotLedger`）：上一帧末拍过就锁它（哪怕还在读回），否则锁本帧末的那份；同一帧两次锁定共享；
 * - 登记：按 `(id, mask)` 去重（含子系统）、第 k 个 `layerimage` 取第 k 项绑定、`0x20000` 记 `timed`；
 * - 与状态机联动（假 GPU 之外的真实 `GpuEmitterImages` 当视图用）：无预热第 1 帧过门、第 2 帧锁定、第 3 帧出表；有预热第 1 帧锁定本帧末、第 2 帧出表。
 */
import { describe, expect, it } from "vitest";
import type { EmitterImageSnapshot } from "../particles/layerImage";
import {
  COPY_ROW_ALIGNMENT,
  GpuEmitterImages,
  compactRows,
  needsSnapshot,
  paddedBytesPerRow,
  SnapshotLedger,
  type SnapshotEntry,
} from "./emitterImages";

describe("行尾填充", () => {
  it("bytesPerRow 向上取 256 的倍数", () => {
    expect(COPY_ROW_ALIGNMENT).toBe(256);
    expect(paddedBytesPerRow(1)).toBe(256);
    expect(paddedBytesPerRow(64)).toBe(256);
    expect(paddedBytesPerRow(65)).toBe(512);
    // 3840×2160 压到 960×540：960 · 4 = 3840 正好是 256 的倍数
    expect(paddedBytesPerRow(960)).toBe(3840);
    expect(paddedBytesPerRow(883)).toBe(3584);
  });

  it("去掉行尾填充：每行只留前 w4 · 4 字节，行优先紧凑", () => {
    const w4 = 3;
    const h4 = 2;
    const bytesPerRow = 256;
    const raw = new Uint8Array(bytesPerRow * h4).fill(0xee);
    for (let i = 0; i < w4 * 4; i++) raw[i] = i + 1;
    for (let i = 0; i < w4 * 4; i++) raw[bytesPerRow + i] = 100 + i;
    const out = compactRows(raw, w4, h4, bytesPerRow);
    expect(out.length).toBe(w4 * h4 * 4);
    expect([...out.subarray(0, 12)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([...out.subarray(12)]).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    // 填充字节一个都没混进来
    expect(out.includes(0xee)).toBe(false);
  });

  it("没有填充（bytesPerRow 正好 w4 · 4）时原样拷贝", () => {
    const raw = Uint8Array.from({ length: 4 * 4 * 2 }, (_, i) => i);
    expect([...compactRows(raw, 4, 2, 16)]).toEqual([...raw]);
  });
});

describe("需要快照的判定", () => {
  const base = { started: true, state: 0 as const, timed: false, wanted: false };
  it("门没过（从没有发射帧）不拍", () => {
    expect(needsSnapshot({ ...base, started: false })).toBe(false);
  });
  it("状态 0 / 1 拍；状态 2 不拍（除非带 0x20000）", () => {
    expect(needsSnapshot({ ...base, state: 0 })).toBe(true);
    expect(needsSnapshot({ ...base, state: 1 })).toBe(true);
    expect(needsSnapshot({ ...base, state: 2 })).toBe(false);
    expect(needsSnapshot({ ...base, state: 2, timed: true })).toBe(true);
  });
  it("有人锁了本帧末的一定拍（即使状态 2、没过门以外的条件都不满足）", () => {
    expect(needsSnapshot({ started: false, state: 2, timed: false, wanted: true })).toBe(true);
  });
});

describe("锁定规则（SnapshotLedger）", () => {
  const entry = (frame: number): SnapshotEntry => ({ frame, snapshot: null });
  const snap = (): EmitterImageSnapshot => ({ pixels: new Uint8Array(16), w4: 2, h4: 2, width: 8, height: 8 });

  it("上一帧末拍过就锁它：读回完成前 snapshot() 为 null，完成后同一个句柄就读得到", () => {
    const ledger = new SnapshotLedger();
    const previous = entry(4);
    ledger.record(previous);
    const handle = ledger.lock(5);
    expect(handle.snapshot()).toBeNull();
    previous.snapshot = snap();
    expect(handle.snapshot()).toBe(previous.snapshot);
    // 没有为本帧末另外安排快照
    expect(ledger.wantedAt(5)).toBeNull();
  });

  it("上一帧末没拍：锁本帧末的那份，本帧编码一定拍它；记录之后落进 latest", () => {
    const ledger = new SnapshotLedger();
    ledger.record(entry(2)); // 更早的一份不算
    const handle = ledger.lock(5);
    const wanted = ledger.wantedAt(5)!;
    expect(wanted.frame).toBe(5);
    expect(handle.snapshot()).toBeNull();
    ledger.record(wanted);
    expect(ledger.latest).toBe(wanted);
    expect(ledger.wantedAt(5)).toBeNull();
    wanted.snapshot = snap();
    expect(handle.snapshot()).toBe(wanted.snapshot);
  });

  it("同一帧里两次锁定共享同一份本帧末的快照", () => {
    const ledger = new SnapshotLedger();
    const a = ledger.lock(3);
    const b = ledger.lock(3);
    const wanted = ledger.wantedAt(3)!;
    wanted.snapshot = snap();
    expect(a.snapshot()).toBe(b.snapshot());
    expect(a.snapshot()).not.toBeNull();
  });

  it("安排了但没编码到的旧请求（帧号过期）不会被当成本帧的", () => {
    const ledger = new SnapshotLedger();
    ledger.lock(3);
    expect(ledger.wantedAt(4)).toBeNull();
  });
});

describe("登记（register）与读数（probe）", () => {
  async function images(systems: unknown[]) {
    return GpuEmitterImages.create(
      {
        device: {} as GPUDevice,
        passes: undefined,
        programs: new Map(),
        pipelineFor: () => {
          throw new Error("没有 pass，不该建管线");
        },
        layerSource: (id) => (id === 7 ? ({ width: 96, height: 64 } as never) : null),
        maskTexture: () => null,
      },
      systems as never,
    );
  }
  const layerimage = (flags: number) => ({ name: "layerimage", fields: { flags } });

  it("按 (id, mask) 去重（含子系统）；第 k 个 layerimage 取第 k 项绑定，0x20000 记 timed", async () => {
    const gpu = await images([
      {
        emitters: [layerimage(0x20000), { name: "sphererandom", fields: {} }, layerimage(0)],
        emitterImages: [
          { id: 7, mask: "", maskTexture: null },
          { id: 8, mask: "m.tex", maskTexture: 3 },
        ],
        children: [
          {
            system: {
              emitters: [layerimage(0)],
              emitterImages: [{ id: 7, mask: "", maskTexture: null }],
              children: [],
            },
          },
        ],
      },
    ]);
    const records = [...gpu.records.all()].map((record) => [record.id, record.mask]);
    expect(records).toEqual([
      [7, ""],
      [8, "m.tex"],
    ]);
    // 带 0x20000 的只有第一个 layerimage（id 7）；再登记同一个 (id, mask) 不变
    const keyed = gpu as unknown as { gpu: Map<string, { timed: boolean; maskTexture: number | null }> };
    expect(keyed.gpu.get("7\0")!.timed).toBe(true);
    expect(keyed.gpu.get("8\0m.tex")!.timed).toBe(false);
    expect(keyed.gpu.get("8\0m.tex")!.maskTexture).toBe(3);
  });

  it("没配上依赖（null）的发射器不登记；layerSize 查不到图层时为 null", async () => {
    const gpu = await images([{ emitters: [layerimage(0)], emitterImages: [null], children: [] }]);
    expect([...gpu.records.all()]).toEqual([]);
    expect(gpu.layerSize(99)).toBeNull();
    expect(gpu.layerSize(7)).toEqual({ width: 96, height: 64 });
  });

  it("probe：状态、降采样尺寸（96×64 → 24×16）与表项数", async () => {
    const gpu = await images([
      { emitters: [layerimage(0)], emitterImages: [{ id: 7, mask: "", maskTexture: null }], children: [] },
    ]);
    const [item] = gpu.probe(true);
    expect(item).toMatchObject({ id: 7, mask: "", state: 0, started: false, w4: 24, h4: 16, count: 0 });
    expect(item.entries).toBeUndefined();
  });
});

describe("与状态机联动（真实 GpuEmitterImages 当视图用，快照由测试按帧填）", () => {
  /** 第 frame 帧末拍快照并「读回完成」：模拟 `encode` + `afterSubmit`（没有 GPU 的部分）。 */
  async function harness() {
    const gpu = await GpuEmitterImages.create(
      {
        device: {} as GPUDevice,
        passes: undefined,
        programs: new Map(),
        pipelineFor: () => {
          throw new Error("x");
        },
        layerSource: () => ({ width: 8, height: 8 }) as never,
        maskTexture: () => null,
      },
      [
        {
          emitters: [{ name: "layerimage", fields: { flags: 0 } }],
          emitterImages: [{ id: 1, mask: "", maskTexture: null }],
          children: [],
        },
      ] as never,
    );
    const binding = { id: 1, mask: "" };
    const record = gpu.records.record(binding);
    const ledger = (gpu as unknown as { gpu: Map<string, { ledger: SnapshotLedger }> }).gpu;
    /** 一个像素的快照（alpha 255），整张 2×2。 */
    const pixels = () => ({
      pixels: Uint8Array.from({ length: 16 }, (_, i) => (i % 4 === 3 ? 255 : 10 + i)),
      w4: 2,
      h4: 2,
      width: 8,
      height: 8,
    });
    /** 本帧末：状态机要求拍（或锁了本帧末）就拍，读回马上完成。 */
    const endFrame = (frame: number) => {
      const rec = ledger.get("1\0")!;
      const wanted = rec.ledger.wantedAt(frame);
      if (wanted || (record.started && record.state < 2)) {
        const entry = wanted ?? { frame, snapshot: null };
        entry.snapshot = pixels();
        rec.ledger.record(entry);
      }
    };
    return { gpu, binding, record, endFrame };
  }

  it("无预热：第 1 个发射帧过门、第 2 个锁定、第 3 个出表（前两帧返回 null）", async () => {
    const { gpu, binding, endFrame } = await harness();
    const got: (number | null)[] = [];
    for (const frame of [1, 2, 3]) {
      got.push(gpu.records.acquire(binding, frame)?.count ?? null);
      endFrame(frame);
    }
    expect(got).toEqual([null, null, 4]);
  });

  it("有预热（帧 0 过门）：第 1 个发射帧锁定本帧末（读回晚到也行）、第 2 个发射帧出表", async () => {
    const { gpu, binding, record, endFrame } = await harness();
    expect(gpu.records.acquire(binding, 0)).toBeNull();
    expect(record.started).toBe(true);
    const first = gpu.records.acquire(binding, 1);
    expect(first).toBeNull();
    expect(record.state).toBe(1);
    endFrame(1);
    expect(gpu.records.acquire(binding, 2)?.count).toBe(4);
    expect(record.state).toBe(2);
  });
});
