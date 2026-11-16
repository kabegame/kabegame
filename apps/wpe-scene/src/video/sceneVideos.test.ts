/**
 * 场景的视频纹理（P9a 步骤 1，P9d 步骤 2b 起全部是 WebCodecs 播放器）：解码器替身 + `demux/testMp4.ts` 手造的 MP4，核对 30 帧规则、
 * 加载时就没被画到的视频、宿主暂停与恢复、新帧只交出一次、跨 load 复用与释放、失败（读不到、拆不了包）、等第一帧、结束回调的时机与探针。
 * WPE 依据见 p9-REPORT 与 rea-p9-video 第 3、4、6 节；播放器本身的用例在 `codecPlayer.test.ts`。每个用例结束时打开的帧数为 0。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "../compile/bundle";
import { CodecVideoPlayer } from "./codecPlayer";
import { buildMp4, memoryRead } from "./demux/testMp4";
import { fakeFactories, flush, newFakeEnv, type FakeDecoderOptions } from "./fakeDecoder";
import type { SceneVideoSource } from "./player";
import { layerVideoSource, SceneVideos } from "./sceneVideos";

/** 8 帧、每帧 0.125 s、时长 1 s，关键帧是第 1、5 个样本。 */
const MP4 = buildMp4({
  sizes: Array.from({ length: 8 }, () => 10),
  perChunk: [8],
  stts: [[8, 125]],
  timescale: 1000,
  stss: [1, 5],
  movie: [1000, 1000],
}).bytes;
const a: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 100 + MP4.length };
const b: SceneVideoSource = { path: "P:/p/materials/b.tex", start: 40, end: 40 + MP4.length };

type Mode = "ok" | "read-fail" | "unsupported";
interface SetupOptions extends FakeDecoderOptions {
  /** 每段视频（按路径）的输入，缺省 `ok`；`unsupported` 是不认识的封装（全 0）。 */
  modes?: Record<string, Mode>;
}

function setup(options: SetupOptions = {}) {
  const fake = newFakeEnv();
  const reads: string[] = [];
  const memory = memoryRead(MP4).read;
  const videos = new SceneVideos(
    { warn: (message, detail) => void fake.warnings.push([message, detail]) },
    {
      ...fakeFactories(fake, options),
      readRange: (source) => {
        reads.push(`${source.path} ${source.start} ${source.end}`);
        const mode = options.modes?.[source.path] ?? "ok";
        if (mode === "read-fail") return () => Promise.reject(new TypeError("Failed to fetch"));
        if (mode === "unsupported") return (start, end) => Promise.resolve(new Uint8Array(end - start));
        return memory;
      },
    },
  );
  const track = { videos, fake, reads, warnings: fake.warnings };
  made.push(track);
  return track;
}

/** 推进 n 个实时帧，每帧墙钟走 `ms`；`draw` 给出每帧画到的纹理下标。 */
function frames(env: { videos: SceneVideos; fake: { now: number } }, n: number, draw: number[] = [], ms = 0) {
  for (let i = 0; i < n; i++) {
    env.fake.now += ms;
    env.videos.beginFrame();
    for (const index of draw) env.videos.drawn(index);
  }
}

const timestampOf = (frame: VideoFrame | null) => frame?.timestamp ?? null;

let made: { videos: SceneVideos; fake: { opened: number } }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const env of made) {
    env.videos.dispose();
    expect(env.fake.opened, "释放后仍有没关的帧").toBe(0);
  }
  made = [];
});

describe("SceneVideos", () => {
  it("30 帧规则：一直没画到时第 30 帧还在放、第 31 帧暂停；再画到时立即恢复，currentTime 不跳；期间 isPlaying 为真", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    // 第一次画到时时钟才起步
    expect(env.videos.probe()[0].paused).toBe(true);
    frames(env, 1, [1]);
    expect(env.videos.probe()[0]).toMatchObject({ paused: false, lastDrawn: 1 });
    frames(env, 30, [], 10);
    expect(env.videos.probe()[0].paused).toBe(false);
    frames(env, 1, [], 10);
    expect(env.videos.probe()[0].paused).toBe(true);
    const idle = env.videos.player(1)!.currentTime;
    frames(env, 20, [], 100);
    expect(env.videos.player(1)!.currentTime).toBe(idle);
    expect(env.videos.player(1)!.isPlaying()).toBe(true);
    env.videos.beginFrame();
    env.videos.drawn(1);
    expect(env.videos.probe()[0].paused).toBe(false);
    expect(env.videos.player(1)!.currentTime).toBe(idle);
  });

  it("画到就一直放；最后一次画到之后第 31 帧暂停", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    frames(env, 100, [0]);
    expect(env.videos.probe()[0].paused).toBe(false);
    frames(env, 30);
    expect(env.videos.probe()[0].paused).toBe(false);
    frames(env, 1);
    expect(env.videos.probe()[0]).toMatchObject({ frame: 131, lastDrawn: 100, paused: true, wantPlay: true });
  });

  it("加载时就没被画到的视频：lastDrawn 取建好时的帧号（不是 0）；之后再画到时记新的帧号并起步", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    frames(env, 50, [0]);
    // 第 50 帧才出现的视频
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    expect(env.videos.probe()[1]).toMatchObject({ path: b.path, lastDrawn: 50, paused: true });
    frames(env, 31, [0]);
    env.videos.drawn(1);
    expect(env.videos.probe()[1]).toMatchObject({ lastDrawn: 81, paused: false });
  });

  it("宿主暂停：全部暂停、帧号与空闲不受影响；恢复时连脚本暂停过的也放（照 WPE）", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    frames(env, 5, [0, 1]);
    // 脚本暂停了第二段（P9b 的 pause）
    env.videos.player(1)!.pause();
    expect(env.videos.probe().map((video) => video.paused)).toEqual([false, true]);
    env.videos.setPaused(true);
    env.videos.setPaused(true);
    expect(env.videos.probe().map((video) => video.paused)).toEqual([true, true]);
    // 暂停期间渲染器不调 beginFrame，帧号不走；isPlaying 照报（第一段真，第二段被脚本暂停为假）
    expect(env.videos.probe()[0].frame).toBe(5);
    expect([env.videos.player(0)!.isPlaying(), env.videos.player(1)!.isPlaying()]).toEqual([true, false]);
    env.videos.setPaused(false);
    expect(env.videos.probe().map((video) => video.paused)).toEqual([false, false]);
    expect(env.videos.probe().map((video) => video.wantPlay)).toEqual([true, true]);
  });

  it("宿主暂停期间画到也不放；恢复后照 30 帧规则", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    env.videos.setPaused(true);
    env.videos.drawn(0);
    expect(env.videos.probe()[0].paused).toBe(true);
    env.videos.setPaused(false);
    expect(env.videos.probe()[0].paused).toBe(false);
  });

  it("新帧只交出一次：同一帧被两个 draw 画到只拷一次；没有新帧时返回 null；没有视频的下标返回 null", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    env.videos.beginFrame();
    expect(timestampOf(env.videos.drawn(1))).toBe(0);
    expect(env.videos.drawn(1)).toBeNull();
    env.videos.beginFrame();
    expect(env.videos.drawn(1)).toBeNull();
    env.fake.now += 125;
    env.videos.beginFrame();
    expect(timestampOf(env.videos.drawn(1))).toBe(125_000);
    expect(env.videos.drawn(1)).toBeNull();
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.videos.drawn(7)).toBeNull();
  });

  it("跨 load 复用：同区间同一个播放器、不重读、不打断；下标表重建；用不到的释放解码器", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const first = env.videos.player(0)!;
    frames(env, 10, [0, 1]);
    // 重编译：下标换了位置，a 的区间不变（新对象，同值）
    env.videos.load([{}, { video: { ...a } }]);
    await flush();
    expect(env.fake.decoders).toHaveLength(2);
    expect(env.reads).toEqual([`${a.path} 100 ${a.end}`, `${b.path} 40 ${b.end}`]);
    expect(env.videos.player(1)).toBe(first);
    expect(env.videos.drawn(0)).toBeNull();
    // b 不在了：释放
    expect(env.fake.decoders.map((decoder) => decoder.closed)).toEqual([false, true]);
    // 换场景：全部换掉
    const moved = { ...a, start: a.start + 1, end: a.end + 1 };
    env.videos.load([{ video: moved }]);
    await flush();
    expect(env.fake.decoders).toHaveLength(3);
    expect(env.fake.decoders[0].closed).toBe(true);
    expect(env.videos.probe().map((video) => video.end)).toEqual([moved.end]);
  });

  it("两个下标同一区间：共用一个播放器", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: { ...a } }]);
    await flush();
    expect(env.fake.decoders).toHaveLength(1);
    expect(env.videos.probe()[0].textures).toEqual([0, 1]);
  });

  it("读失败、拆不了包：不再交帧，各记一条 warn（带路径）；不影响别的视频", async () => {
    const env = setup({ modes: { [a.path]: "unsupported", [b.path]: "read-fail" } });
    const c: SceneVideoSource = { path: "P:/p/materials/c.tex", start: 0, end: MP4.length };
    env.videos.load([{ video: a }, { video: b }, { video: c }]);
    await flush();
    env.videos.beginFrame();
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.videos.drawn(1)).toBeNull();
    expect(timestampOf(env.videos.drawn(2))).toBe(0);
    expect(env.warnings).toHaveLength(2);
    expect(env.warnings.map(([message]) => message).join("\n")).toContain(a.path);
    expect(env.warnings.map(([message]) => message).join("\n")).toContain(b.path);
    const messages = env.warnings.map(([message]) => message);
    expect(messages.some((message) => message.includes("场景视频不能拆包"))).toBe(true);
    expect(messages.some((message) => message.includes("场景视频读取失败"))).toBe(true);
    expect(env.videos.probe().map((video) => video.failed)).toEqual([true, true, false]);
    // 没有别的路可退：没有重试、没有第二个播放器
    expect(env.videos.player(0)).toBeInstanceOf(CodecVideoPlayer);
    expect(env.fake.decoders).toHaveLength(1);
  });

  it("firstFrames：都出了第一帧才 resolve；失败的立即算完成；没有视频的下标不等", async () => {
    const env = setup({ modes: { [b.path]: "read-fail" } });
    env.videos.load([{ video: a }, { video: b }, {}]);
    let done = false;
    void env.videos.firstFrames([0, 1, 2, 9], 2000).then(() => (done = true));
    expect(done).toBe(false);
    await flush();
    expect(done).toBe(true);
    await expect(env.videos.firstFrames([0, 1], 2000)).resolves.toBeUndefined();
    await expect(env.videos.firstFrames([], 2000)).resolves.toBeUndefined();
  });

  it("firstFrames：超时也 resolve，不 reject", async () => {
    vi.useFakeTimers();
    const env = setup({ halted: true });
    env.videos.load([{ video: a }]);
    let done = false;
    void env.videos.firstFrames([0], 2000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("firstFrames：已经有第一帧时立即完成", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    expect(env.videos.player(0)!.hasFirstFrame).toBe(true);
    await expect(env.videos.firstFrames([0], 60_000)).resolves.toBeUndefined();
  });

  it("beginFrame 先判定绕回 / 结束再 apply：loop 为假的结束清 wantPlay，时钟随之停住", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    const player = env.videos.player(0)!;
    const log: number[] = [];
    player.addEndedCallback(() => log.push(env.videos.probe()[0].frame));
    player.loop = false;
    frames(env, 3, [0]);
    // 一步走过时长（1 s）：下一个 beginFrame 的 detectEnd 看到 ended
    env.fake.now += 1500;
    frames(env, 3, [0]);
    expect(log).toEqual([4]);
    expect(player.isPlaying()).toBe(false);
    expect(env.videos.probe()[0]).toMatchObject({ wantPlay: false, paused: true, currentTime: 1 });
  });

  it("probe：每段一项，带帧号与下标", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    frames(env, 2, [1]);
    const [probe] = env.videos.probe();
    expect(probe).toMatchObject({
      path: a.path,
      start: 100,
      end: a.end,
      currentTime: 0,
      paused: false,
      wantPlay: true,
      lastDrawn: 2,
      frame: 2,
      fresh: false,
      failed: false,
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 1,
      dropped: 0,
      decodeQueue: 0,
      stallResets: 0,
      textures: [1],
    });
    expect(probe.decoded).toBeGreaterThan(0);
    expect(probe.color).toEqual(expect.any(String));
    expect(probe).not.toHaveProperty("decoder");
    expect(probe).not.toHaveProperty("stallSeeks");
  });

  it("dispose：释放全部，之后的调用都无效", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    env.videos.dispose();
    expect(env.fake.decoders.map((decoder) => decoder.closed)).toEqual([true, true]);
    expect(env.fake.opened).toBe(0);
    env.videos.load([{ video: a }]);
    env.videos.beginFrame();
    env.videos.setPaused(true);
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.fake.decoders).toHaveLength(2);
    expect(env.videos.probe()).toEqual([]);
  });
});

describe("脚本侧的查找（P9b）", () => {
  it("playerFor：按区间键取播放器（新对象同值也认，duration 不进键），下标换了也是同一个；没有这段、释放后为 null", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const first = env.videos.player(0)!;
    expect(env.videos.playerFor(a)).toBe(first);
    expect(env.videos.playerFor({ ...a, duration: 2.517 })).toBe(first);
    expect(env.videos.playerFor(b)).toBe(env.videos.player(1));
    expect(env.videos.playerFor({ ...a, end: a.end + 1 })).toBeNull();
    // 重编译换了下标：按区间照样取到同一个，按旧下标取到的已经是别的
    env.videos.load([{ video: b }, { video: { ...a } }]);
    expect(env.videos.playerFor(a)).toBe(first);
    expect(env.videos.player(0)).not.toBe(first);
    env.videos.load([{ video: b }]);
    expect(env.videos.playerFor(a)).toBeNull();
    env.videos.dispose();
    expect(env.videos.playerFor(b)).toBeNull();
  });

  it("宿主恢复时连失败的播放器也置 wantPlay（isPlaying 为真、仍不交帧），同 WPE 对每个有播放器的纹理调 play()", async () => {
    const env = setup({ modes: { [a.path]: "unsupported" } });
    env.videos.load([{ video: a }]);
    await flush();
    const player = env.videos.player(0)!;
    expect(player.failed).toBe(true);
    expect(player.isPlaying()).toBe(false);
    env.videos.setPaused(true);
    env.videos.setPaused(false);
    expect(player.wantPlay).toBe(true);
    expect(player.isPlaying()).toBe(true);
    env.videos.beginFrame();
    expect(env.videos.drawn(0)).toBeNull();
  });

  it("resetScriptState：每个播放器恢复脚本缺省状态；释放后什么都不做", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const [first, second] = [env.videos.player(0)!, env.videos.player(1)!];
    first.pause();
    second.rate = 3;
    second.loop = false;
    env.videos.resetScriptState();
    expect([first.wantPlay, second.rate, second.loop]).toEqual([true, 1, true]);
    env.videos.dispose();
    expect(() => env.videos.resetScriptState()).not.toThrow();
  });

  it("layerVideoSource：只认图层 passes[0] 槽 0 指向的视频纹理", () => {
    const pass = (textures: Record<number, number>) => ({ textures });
    const bundle = {
      layers: [
        { object: 0, passes: [pass({ 0: 1 })] },
        { object: 1, passes: [pass({ 0: 0 })] },
        { object: 2, passes: [pass({ 1: 1 })] },
        { object: 3, passes: [pass({}), pass({ 0: 1 })] },
        { object: 4, passes: [] },
        { object: 5, passes: [pass({ 0: 9 })] },
      ],
      textures: [{ path: "materials/still.tex" }, { path: "materials/clip.tex", video: a }],
    } as unknown as SceneBundle;
    expect(layerVideoSource(bundle, 0)).toBe(a);
    // 槽 0 是普通纹理、视频只在槽 1、只在第二个 pass、没有 pass、下标越界、没有这个图层
    for (const object of [1, 2, 3, 4, 5, 7]) expect(layerVideoSource(bundle, object), String(object)).toBeUndefined();
    expect(layerVideoSource(null, 0)).toBeUndefined();
    // 手写的 bundle 没有纹理表
    expect(layerVideoSource({ layers: bundle.layers } as unknown as SceneBundle, 0)).toBeUndefined();
  });
});

describe("CodecVideoPlayer 的接线（P9d 步骤 2b）", () => {
  it("drawn 交出 VideoFrame 并按墙钟换帧；跨重编译按区间复用、不重读、不重建解码器", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    const player = env.videos.player(0)!;
    expect(player).toBeInstanceOf(CodecVideoPlayer);
    env.videos.beginFrame();
    expect(timestampOf(env.videos.drawn(0))).toBe(0);
    env.fake.now += 125;
    env.videos.beginFrame();
    expect(timestampOf(env.videos.drawn(0))).toBe(125_000);
    expect(env.videos.probe()[0]).toMatchObject({ textures: [0], frame: 2, currentTime: 0.125 });
    const reads = env.reads.length;
    env.videos.load([{}, { video: { ...a } }]);
    await flush();
    expect(env.videos.player(1)).toBe(player);
    expect(env.videos.playerFor(a)).toBe(player);
    expect(env.reads).toHaveLength(reads);
    expect(env.fake.decoders).toHaveLength(1);
  });

  it("拆不了包：和读失败一样按失败处理，没有退回；firstFrames 立即完成，图层保持透明", async () => {
    const env = setup({ modes: { [a.path]: "unsupported" } });
    env.videos.load([{ video: a }]);
    await env.videos.firstFrames([0], 60_000);
    const player = env.videos.player(0)!;
    expect(player.failed).toBe(true);
    expect(player.wantPlay).toBe(false);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][1]).toMatch(/不是 MP4/);
    env.videos.beginFrame();
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.fake.decoders).toHaveLength(0);
  });
});
