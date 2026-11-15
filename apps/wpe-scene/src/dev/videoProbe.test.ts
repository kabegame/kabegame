/**
 * dev 探针的视频时刻（P9a 步骤 3，`videoProbe.ts`）：
 * - 纯函数：`videoTime` 的校验、按纹理路径取时刻、循环取模与钳到 `[0, duration − SEEK_END_MARGIN]`；
 * - `ProbeVideos`（P9d 步骤 2b：WebCodecs 播放器）：解码器替身 + `demux/testMp4.ts` 手造的 MP4 字节，核对读法、跳转的目标帧（关键帧之间的
 *   时刻取显示时间 ≤ 目标的最新一帧）、每个 draw 都交出同一帧、读 / 拆包 / 解码失败保持透明并标出、总时限超时报错、释放后帧都被关掉。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMp4, memoryRead, type Spec } from "../video/demux/testMp4";
import { FakeDecoder, fakeFactories, flush, newFakeEnv, type FakeDecoderOptions } from "../video/fakeDecoder";
import { SEEK_END_MARGIN, type SceneVideoSource } from "../video/player";
import {
  checkVideoTime,
  ProbeVideos,
  ProbeVideoTimeout,
  requestedVideoTime,
  videoSeekTime,
  type VideoTimeOption,
} from "./videoProbe";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

afterEach(() => {
  vi.useRealTimers();
});

describe("videoSeekTime：超过时长按循环取模，再钳到 [0, duration − 0.005]", () => {
  it("时长之内原样；等于、超过时长时取模（WPE 视频纹理缺省循环）", () => {
    expect(videoSeekTime(0, 2.5)).toBe(0);
    expect(videoSeekTime(1.25, 2.5)).toBe(1.25);
    expect(videoSeekTime(2.5, 2.5)).toBe(0);
    expect(videoSeekTime(5.5, 2)).toBe(1.5);
    expect(videoSeekTime(6, 2)).toBe(0);
    expect(videoSeekTime(7.25, 2.5)).toBeCloseTo(2.25, 12);
  });

  it("落在最后 0.005 s 里（取模前后都算）钳到 duration − 0.005，同产品播放器写 currentTime", () => {
    expect(SEEK_END_MARGIN).toBe(0.005);
    expect(videoSeekTime(2.499, 2.5)).toBeCloseTo(2.495, 12);
    expect(videoSeekTime(2.495, 2.5)).toBeCloseTo(2.495, 12);
    expect(videoSeekTime(2.494, 2.5)).toBe(2.494);
    expect(videoSeekTime(2 * 2.5 - 0.001, 2.5)).toBeCloseTo(2.495, 12);
    // 比余量还短的视频：上界取 0
    expect(videoSeekTime(0.003, 0.004)).toBe(0);
  });

  it("时长未知（NaN、Infinity、0）只钳下界；负数钳到 0", () => {
    expect(videoSeekTime(3, Number.NaN)).toBe(3);
    expect(videoSeekTime(3, Number.POSITIVE_INFINITY)).toBe(3);
    expect(videoSeekTime(3, 0)).toBe(3);
    expect(videoSeekTime(-1, 2.5)).toBe(0);
  });
});

describe("requestedVideoTime / checkVideoTime", () => {
  it("缺省 0；数字对全部生效；对象按 path 取，没给的 0（不认原型上的键）", () => {
    expect(requestedVideoTime(undefined, "materials/v.tex")).toBe(0);
    expect(requestedVideoTime(1.5, "materials/v.tex")).toBe(1.5);
    const byPath = { "materials/a.tex": 2, "materials/b.tex": 0 };
    expect(requestedVideoTime(byPath, "materials/a.tex")).toBe(2);
    expect(requestedVideoTime(byPath, "materials/b.tex")).toBe(0);
    expect(requestedVideoTime(byPath, "materials/c.tex")).toBe(0);
    expect(requestedVideoTime(byPath, "toString")).toBe(0);
  });

  it("非负有限数，或「字符串 → 非负有限数」的对象；其余抛 RangeError", () => {
    expect(checkVideoTime(undefined)).toBeUndefined();
    expect(checkVideoTime(0)).toBe(0);
    expect(checkVideoTime(12.5)).toBe(12.5);
    expect(checkVideoTime({ "materials/a.tex": 3 })).toEqual({ "materials/a.tex": 3 });
    expect(checkVideoTime({})).toEqual({});
    for (const bad of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      [1],
      null,
      true,
      { a: -1 },
      { a: "1" },
      { a: null },
    ])
      expect(() => checkVideoTime(bad), JSON.stringify(bad)).toThrow(RangeError);
  });
});

// ———— ProbeVideos ————

/** 8 帧、每帧 0.125 s（二进制下都是精确值）、时长 1 s，关键帧是第 1、5 个样本（显示时间 0、0.5）。 */
const CLIP: Spec = {
  sizes: Array.from({ length: 8 }, () => 10),
  perChunk: [8],
  stts: [[8, 125]],
  timescale: 1000,
  stss: [1, 5],
  movie: [1000, 1000],
};
const CLIP_BYTES = buildMp4(CLIP).bytes;

type Mode = "ok" | "read-fail" | "unsupported";
interface EnvOptions extends FakeDecoderOptions {
  /** 每段视频（按纹理路径）的输入，缺省 `ok`。 */
  modes?: Record<string, Mode>;
  /** 第二次 configure（即跳转）时解码器不再出帧。 */
  haltOnSeek?: boolean;
}

/** 注入替身的 `ProbeVideos`：v1 是散文件、v3 在 scene.pkg 里（起点不是 0）；记下每段视频的读取区间。 */
function env(option: VideoTimeOption | undefined, options: EnvOptions = {}) {
  const fake = newFakeEnv();
  const base = fakeFactories(fake, options);
  const reads: string[] = [];
  const source = (path: string, start: number): SceneVideoSource => ({
    path: `P:/p/${path}`,
    start,
    end: start + CLIP_BYTES.length,
  });
  const textures = [
    { path: "materials/a.tex" },
    { path: "materials/v1.tex", video: source("materials/v1.tex", 91) },
    { path: "materials/b.tex" },
    { path: "materials/v3.tex", video: source("scene.pkg", 5000) },
  ];
  const memory = memoryRead(CLIP_BYTES).read;
  const videos = new ProbeVideos(textures, option, {
    ...base,
    createDecoder: (init) => {
      const decoder = base.createDecoder!(init) as FakeDecoder;
      if (options.haltOnSeek) {
        const configure = decoder.configure.bind(decoder);
        let configures = 0;
        decoder.configure = () => {
          configure();
          if (++configures === 2) decoder.halted = true;
        };
      }
      return decoder;
    },
    readRange: (video) => {
      reads.push(`${video.path} ${video.start} ${video.end}`);
      const mode = options.modes?.[textures.find((texture) => texture.video === video)!.path] ?? "ok";
      if (mode === "read-fail") return () => Promise.reject(new TypeError("Failed to fetch"));
      if (mode === "unsupported") return (start, end) => Promise.resolve(new Uint8Array(end - start));
      return memory;
    },
  });
  return { videos, fake, reads, textures };
}

/** 让读、拆包、解码这一串微任务走完（假定时器下也一样）。 */
async function microtasks() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe("ProbeVideos", () => {
  it("按区间读每段视频，跳到取模后的时刻，交出目标帧（显示时间 ≤ 目标的最新一帧）；每个 draw 都交出同一帧", async () => {
    const { videos, fake, reads } = env(3.25);
    await videos.prepare();
    expect(reads).toEqual([
      `P:/p/materials/v1.tex 91 ${91 + CLIP_BYTES.length}`,
      `P:/p/scene.pkg 5000 ${5000 + CLIP_BYTES.length}`,
    ]);
    // 3.25 超过时长 1：循环取模到 0.25，正好是第 3 帧的显示时间
    expect(videos.results()).toEqual([
      { path: "materials/v1.tex", time: 0.25, frameTime: 0.25, duration: 1, width: 1920, height: 1080, failed: false },
      { path: "materials/v3.tex", time: 0.25, frameTime: 0.25, duration: 1, width: 1920, height: 1080, failed: false },
    ]);
    // 播放器都已释放，只剩探针留的两份 clone
    expect(fake.opened).toBe(2);
    expect(fake.decoders.every((decoder) => decoder.closed)).toBe(true);
    // 确定性优先：同一张纹理每次被画到都交出同一帧；不是视频的下标不交
    videos.beginFrame();
    const v1 = videos.drawn(1) as unknown as { timestamp: number; closed: boolean };
    expect(v1.timestamp).toBe(250_000);
    expect(videos.drawn(1)).toBe(v1);
    expect(videos.drawn(3)).not.toBeNull();
    expect(videos.drawn(3)).not.toBe(v1);
    expect(videos.drawn(0)).toBeNull();
    expect(videos.drawn(2)).toBeNull();
    // 释放：帧都被关掉，之后不再交帧，重复释放无害
    videos.dispose();
    expect(v1.closed).toBe(true);
    expect(fake.opened).toBe(0);
    expect(videos.drawn(1)).toBeNull();
    videos.dispose();
    expect(fake.opened).toBe(0);
  });

  it("关键帧之间的时刻取 ≤ 目标的最新一帧：time 是请求值、frameTime 是帧的显示时间", async () => {
    const { videos } = env(0.3);
    await videos.prepare();
    expect(videos.results().map((r) => [r.time, r.frameTime])).toEqual([
      [0.3, 0.25],
      [0.3, 0.25],
    ]);
    videos.dispose();
  });

  it("按纹理路径分别给时刻，没给的取 0；缺省全部 0；落在最后 0.005 s 里钳到 duration − 0.005", async () => {
    const byPath = env({ "materials/v1.tex": 0.999 });
    await byPath.videos.prepare();
    expect(byPath.videos.results().map((r) => [r.path, r.time, r.frameTime, r.duration])).toEqual([
      ["materials/v1.tex", 0.995, 0.875, 1],
      ["materials/v3.tex", 0, 0, 1],
    ]);
    byPath.videos.dispose();
    const plain = env(undefined);
    await plain.videos.prepare();
    expect(plain.videos.results().map((r) => [r.time, r.frameTime])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    plain.videos.dispose();
  });

  it("videoTime 对象里不是视频纹理的键：建的时候就抛错并列出有哪些；没有视频纹理的场景给数字照常", async () => {
    expect(() => env({ "materials/v1.tex": 1, "materials/a.tex": 2, "v9.tex": 0 })).toThrow(
      /"materials\/a\.tex"、"v9\.tex" 不是这个场景的视频纹理（有："materials\/v1\.tex"、"materials\/v3\.tex"）/,
    );
    expect(() => new ProbeVideos([{ path: "materials/a.tex" }], { "materials/a.tex": 1 })).toThrow(/没有视频纹理/);
    const none = new ProbeVideos([{ path: "materials/a.tex" }], 5);
    await none.prepare();
    expect(none.results()).toEqual([]);
    expect(none.drawn(0)).toBeNull();
    none.dispose();
  });

  it("读不到、拆不了包：这段标为失败、不交帧（透明）、原因带第一条 warn，别的照常", async () => {
    const cases = [
      ["read-fail", /场景视频读取失败.*Failed to fetch/],
      ["unsupported", /场景视频不能拆包/],
    ] as const;
    for (const [mode, message] of cases) {
      const { videos, fake } = env(1, { modes: { "materials/v1.tex": mode } });
      await videos.prepare();
      const [broken, fine] = videos.results();
      expect(broken, mode).toMatchObject({
        path: "materials/v1.tex",
        failed: true,
        frameTime: null,
        width: 0,
        height: 0,
        duration: null,
      });
      expect(broken.error, mode).toMatch(message);
      // 失败时的 time 是请求的时刻
      expect(broken.time, mode).toBe(1);
      expect(fine, mode).toMatchObject({ path: "materials/v3.tex", failed: false, frameTime: 0 });
      expect(videos.drawn(1), mode).toBeNull();
      expect(videos.drawn(3), mode).not.toBeNull();
      expect(fake.opened, mode).toBe(1);
      videos.dispose();
      expect(fake.opened, mode).toBe(0);
    }
  });

  it("解码器出错：这段标为失败，不当成总时限", async () => {
    const { videos, fake } = env(0, { halted: true });
    const preparing = videos.prepare();
    await flush();
    for (const decoder of fake.decoders) decoder.init.error(new DOMException("坏了", "EncodingError"));
    await preparing;
    for (const result of videos.results()) {
      expect(result).toMatchObject({ failed: true, frameTime: null, width: 0 });
      expect(result.error).toMatch(/场景视频解码失败.*坏了/);
    }
    expect(fake.opened).toBe(0);
    videos.dispose();
  });

  it("超过总时限：prepare 抛 ProbeVideoTimeout（不当成透明），消息带路径、阶段与时限", async () => {
    vi.useFakeTimers();
    const first = env(0.5, { halted: true });
    const loading = expect(first.videos.prepare(1000)).rejects.toThrow(
      /等 materials\/v1\.tex \[91, \d+\) 的第一帧：超过总时限 1 s/,
    );
    await microtasks();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    first.videos.dispose();
    expect(first.fake.opened).toBe(0);

    // 第一帧到了、跳转时解码器不再出帧
    const second = env(0.5, { haltOnSeek: true });
    const seeking = second.videos.prepare(500);
    const settled = seeking.then(
      () => null,
      (error: unknown) => error,
    );
    await microtasks();
    await vi.advanceTimersByTimeAsync(500);
    const error = await settled;
    expect(error).toBeInstanceOf(ProbeVideoTimeout);
    expect((error as Error).message).toMatch(/等 materials\/v1\.tex \[91, \d+\) 跳到 0\.5 s：超过总时限 0\.5 s/);
    second.videos.dispose();
    expect(second.fake.opened).toBe(0);
  });

  it("读本身超过总时限也报错，不建解码器", async () => {
    vi.useFakeTimers();
    const fake = newFakeEnv();
    const videos = new ProbeVideos(
      [{ path: "materials/v1.tex", video: { path: "P:/p/materials/v1.tex", start: 0, end: 1000 } }],
      0,
      { ...fakeFactories(fake), readRange: () => () => new Promise<Uint8Array>(() => {}) },
    );
    const reading = expect(videos.prepare(2000)).rejects.toThrow(/等 materials\/v1\.tex .*的第一帧：超过总时限 2 s/);
    await vi.advanceTimersByTimeAsync(2000);
    await reading;
    videos.dispose();
    expect(fake.decoders).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose：还在等的 prepare 以「已释放」失败、定时器清掉、解码器与帧都关掉", async () => {
    vi.useFakeTimers();
    const pending = env(0, { halted: true });
    const waiting = expect(pending.videos.prepare()).rejects.toThrow("视频探针已释放");
    await microtasks();
    expect(pending.fake.decoders).toHaveLength(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    pending.videos.dispose();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.fake.decoders.every((decoder) => decoder.closed)).toBe(true);
    expect(pending.fake.opened).toBe(0);
  });
});
