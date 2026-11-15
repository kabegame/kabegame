import { describe, expect, it, vi } from "vitest";
import { SCENE_PROGRESS_INTERVAL_MS, SceneLoadProgress } from "./progress";
import { decodeEncodedTextures, TextureDecodeCache } from "./compile/decode";
import type { SceneBundle } from "./compile/bundle";

function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("SceneLoadProgress", () => {
  it("阶段变化立即发；同一阶段 100 ms 内只发一条，阶段最后一条照发", () => {
    const time = clock();
    const sink = vi.fn();
    const load = new SceneLoadProgress(sink, time.now);
    load.report("compile", 0, 10);
    load.report("compile", 3, 10);
    time.advance(SCENE_PROGRESS_INTERVAL_MS);
    load.report("compile", 6, 10);
    load.report("compile", 10, 10);
    load.report("decode", 0, 4);
    expect(sink.mock.calls).toEqual([
      ["compile", 0, 10],
      ["compile", 6, 10],
      ["compile", 10, 10],
      ["decode", 0, 4],
    ]);
  });

  it("mark: false 只报进度不记分段点，这个阶段之后第一次正常报告才记", () => {
    const time = clock();
    const sink = vi.fn();
    const load = new SceneLoadProgress(sink, time.now);
    load.report("compile", 1, 1);
    time.advance(10);
    load.mark("准备");
    load.report("gpu", 0, 1, { mark: false });
    time.advance(50);
    // 同一阶段 100 ms 内的中间值被节流，但分段点照记
    load.report("gpu", 0, 5);
    time.advance(5);
    load.report("gpu", 5, 5);
    expect(sink.mock.calls).toEqual([
      ["compile", 1, 1],
      ["gpu", 0, 1],
      ["gpu", 5, 5],
    ]);
    expect(load.summary()).toBe("等目标与设置 0 ms、编译 10 ms、准备 50 ms、建 GPU 场景 5 ms");
  });

  it("sink 为 null 时只计时（重编译）", () => {
    const load = new SceneLoadProgress(null);
    expect(() => load.report("gpu", 1, 2)).not.toThrow();
  });

  it("summary 按分段点给各段用时：阶段第一次报时与 mark 各起一段，同名不重复", () => {
    const time = clock();
    const load = new SceneLoadProgress(null, time.now);
    time.advance(12);
    load.report("compile", 0, 4);
    time.advance(300);
    load.report("compile", 4, 4);
    time.advance(40);
    load.report("decode", 0, 1);
    time.advance(20);
    load.mark("准备");
    load.mark("准备");
    time.advance(5);
    load.mark("取设备");
    time.advance(30);
    load.report("gpu", 0, 3);
    time.advance(100);
    load.report("frame", 0, 1);
    time.advance(16);
    expect(load.summary()).toBe(
      "等目标与设置 12 ms、编译 340 ms、解码 20 ms、准备 5 ms、取设备 30 ms、建 GPU 场景 100 ms、首帧 16 ms",
    );
  });
});

describe("decodeEncodedTextures 的进度", () => {
  it("开解前报 0 / 总 mip 数，每解完一个报一次；已有 mip 的纹理不算", async () => {
    const reader = { readRange: async (_path: string, start: number, end: number) => new Uint8Array(end - start) };
    const bitmap = (width: number) => ({ width, height: 1 }) as unknown as ImageBitmap;
    const cache = new TextureDecodeCache(reader as never, async (bytes) => bitmap(bytes.length));
    const encoded = (path: string, sizes: number[]) => ({
      path,
      mime: "image/png",
      mips: sizes.map((size, index) => ({ start: index * 100, end: index * 100 + size })),
    });
    const bundle = {
      textures: [
        { encoded: encoded("a.tex", [4, 2]), mips: [] },
        { encoded: encoded("b.tex", [8]), mips: [] },
        { encoded: encoded("c.tex", [1]), mips: [{ width: 1, height: 1 }] },
        { mips: [] },
      ],
    } as unknown as SceneBundle;
    const progress = vi.fn();
    await decodeEncodedTextures(bundle, cache, progress);
    expect(progress.mock.calls[0]).toEqual([0, 3]);
    expect(progress.mock.calls.map(([done]) => done)).toEqual([0, 1, 2, 3]);
    expect(progress.mock.calls.every(([, total]) => total === 3)).toBe(true);
    expect((bundle.textures[0] as { mips: { width: number }[] }).mips.map((mip) => mip.width)).toEqual([4, 2]);
  });
});
