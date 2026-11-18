/**
 * WebCodecs 播放器（P9d 步骤 2a / 2b）：解码器替身（`fakeDecoder.ts`）按喂入顺序在微任务里吐出带时间戳的假帧（可按显示顺序重排、可停止
 * 输出），墙钟注入，输入是 `demux/testMp4.ts` 手造的 MP4。核对起步、按时钟挑帧与丢帧、循环不停顿与跨循环的时间戳、不循环时结束、
 * 跳转到关键帧之间（含 B 帧）与 `seeked()`、暂停、速率、空闲、宿主暂停、卡住重置、失败（含拆不了包）、释放、流控与预读、两种区间读取
 * （文件与 Blob）；每个用例最后打开的帧数为 0。语义对照 WPE（p9-REPORT、rea-p9-video 第 3、4、6、7 节）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobRangeReader, CodecVideoPlayer, fileRangeReader, MAX_AHEAD, MAX_IN_FLIGHT } from "./codecPlayer";
import { buildMkv, cluster, el, info, MKV, payload, simpleBlock, trackEntry } from "./demux/testMkv";
import { AVCC, buildMp4, memoryRead, type Spec } from "./demux/testMp4";
import type { ReadRange } from "./demux/mp4";
import { FakeFrame, fakeFactories, flush, newFakeEnv, type FakeEnv } from "./fakeDecoder";
import type { SceneVideoSource } from "./player";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => `file:///${path}` }));

// ———— 输入 ————

/** 8 帧、每帧 0.125 s（二进制下都是精确值）、时长 1 s，关键帧是第 1、5 个样本（显示时间 0、0.5）。 */
const CLIP: Spec = {
  sizes: Array.from({ length: 8 }, () => 10),
  perChunk: [8],
  stts: [[8, 125]],
  timescale: 1000,
  stss: [1, 5],
  movie: [1000, 1000],
};

function clip(over: Partial<Spec> = {}): Uint8Array {
  return buildMp4({ ...CLIP, ...over }).bytes;
}

/**
 * B 帧：解码顺序 I0 P3 B1 B2 | I4 P7 B5 B6（数字是显示的帧号，每帧 0.1 s），时长 0.8 s；ctts v1 有符号。
 */
const B_FRAMES: Spec = {
  sizes: Array.from({ length: 8 }, () => 10),
  perChunk: [8],
  stts: [[8, 100]],
  ctts: {
    version: 1,
    rows: [
      [1, 0],
      [1, 200],
      [2, -100],
      [1, 0],
      [1, 200],
      [2, -100],
    ],
  },
  timescale: 1000,
  stss: [1, 5],
  movie: [1000, 800],
};

interface SetupOptions {
  bytes?: Uint8Array;
  depth?: number;
  supported?: boolean;
  read?: ReadRange;
  blockBytes?: number;
  source?: Partial<SceneVideoSource>;
  /** 解码器一建好就不出帧。 */
  halted?: boolean;
}

function setup(options: SetupOptions = {}) {
  const env: FakeEnv = newFakeEnv();
  const bytes = options.bytes ?? clip();
  const memory = memoryRead(bytes).read;
  const read: ReadRange = options.read ?? ((start, end) => (env.reads.push([start, end]), memory(start, end)));
  const source: SceneVideoSource = { path: "P:/p/materials/clip.tex", start: 0, end: bytes.length, ...options.source };
  const player = new CodecVideoPlayer(source, 0, {
    report: { warn: (message, detail) => void env.warnings.push([message, detail]) },
    readRange: () => read,
    ...fakeFactories(env, options),
    blockBytes: options.blockBytes,
  });
  const driver = new Driver(player, env);
  return { player, env, driver, decoder: () => env.decoders[env.decoders.length - 1] };
}

/** 照 `SceneVideos` 推进：墙钟走 `ms`、帧号 +1、`detectEnd` + `apply`，再画到（`draw`），返回交出的帧的时间戳（没交出 null）。 */
class Driver {
  frame = 0;
  hostPaused = false;
  constructor(
    readonly player: CodecVideoPlayer,
    readonly env: FakeEnv,
  ) {}
  tick(ms: number, draw = true): number | null {
    this.env.now += ms;
    this.frame++;
    this.player.detectEnd();
    this.player.apply(this.frame, this.hostPaused);
    if (!draw) return null;
    return this.player.drawn(this.frame, this.hostPaused)?.timestamp ?? null;
  }
  /** 连续 n 帧，收集交出的时间戳（帧与帧之间不让解码器出帧，只用已解出的）。 */
  run(n: number, ms: number): (number | null)[] {
    return Array.from({ length: n }, () => this.tick(ms));
  }
  /** 连续 n 帧，每帧之后让解码器吐出（同实时播放时解码器在帧间出帧）。 */
  async play(n: number, ms: number): Promise<(number | null)[]> {
    const shown: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      shown.push(this.tick(ms));
      await flush();
    }
    return shown;
  }
}

/** 全部释放后打开的帧数为 0。 */
let disposeAll: (() => void)[] = [];
function track<T extends { player: CodecVideoPlayer; env: FakeEnv }>(made: T): T {
  disposeAll.push(() => {
    made.player.dispose();
    expect(made.env.opened, "释放后仍有没关的帧").toBe(0);
  });
  return made;
}
afterEach(() => {
  for (const check of disposeAll) check();
  disposeAll = [];
});

const ms = (seconds: number) => Math.round(seconds * 1e6);

// ———— 用例 ————

describe("CodecVideoPlayer：起步与挑帧", () => {
  it("拆包、配置、从 0 喂；第一次画到才起步（之前的墙钟不算）", async () => {
    const { player, env, driver, decoder } = track(setup());
    expect(player.hasFirstFrame).toBe(false);
    let first = false;
    void player.firstFrame().then(() => (first = true));
    await flush();
    expect(first).toBe(true);
    expect(player.hasFirstFrame).toBe(true);
    expect(decoder().configures).toBe(1);
    expect(decoder().resets).toBe(0);
    env.now += 500;
    expect(player.currentTime).toBe(0);
    expect(driver.tick(0)).toBe(0);
    expect(driver.tick(0)).toBeNull();
    expect(driver.tick(125)).toBe(ms(0.125));
    expect(player.currentTime).toBe(0.125);
    expect(player.probe()).toMatchObject({
      paused: false,
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 1,
      color: expect.stringContaining("场景视频恒为 bt709"),
    });
    // 只有一种解码器，探针里没有旧播放器的字段
    expect(player.probe()).not.toHaveProperty("decoder");
    expect(player.probe()).not.toHaveProperty("stallSeeks");
  });

  it("没画到过的视频时钟不走（消掉开场时视频比场景早）", async () => {
    const { player, env, driver } = track(setup());
    await flush();
    for (let i = 0; i < 10; i++) driver.tick(100, false);
    expect(player.currentTime).toBe(0);
    expect(player.probe().paused).toBe(true);
    expect(driver.tick(0)).toBe(0);
  });

  it("第一帧之前画到：不交帧，时钟从第一帧到了才走", async () => {
    const { player, env, driver } = track(setup());
    expect(driver.tick(0)).toBeNull();
    env.now += 300;
    await flush();
    expect(player.currentTime).toBe(0);
    env.now += 125;
    expect(driver.tick(0)).toBe(ms(0.125));
  });

  it("显示时间 ≤ 媒体时间的最新一帧：正好到时间就换；越过的关掉并计丢帧；同一帧不交两次", async () => {
    const { player, driver, env } = track(setup());
    await flush();
    driver.tick(0);
    // 正好 0.125 s：时间戳 125000 ≤ 125000
    expect(driver.tick(125)).toBe(ms(0.125));
    // 0.125 → 0.5：越过 0.25、0.375
    expect(driver.tick(375)).toBe(ms(0.5));
    expect(player.probe()).toMatchObject({ dropped: 2 });
    // 差一点不到下一帧：不换
    expect(driver.tick(124)).toBeNull();
    expect(driver.tick(1)).toBe(ms(0.625));
    // 打开的帧 = 当前帧 + 已解出未显示的
    expect(env.opened).toBe(1 + player.probe().queued);
  });

  it("流控：解码队列 + 已解出未显示的帧不超过 8；显示掉之后接着喂", async () => {
    const bytes = clip({
      sizes: Array.from({ length: 24 }, () => 10),
      perChunk: [24],
      stts: [[24, 125]],
      movie: [1000, 3000],
    });
    const { player, driver, decoder } = track(setup({ bytes }));
    await flush();
    // 第一帧成了当前帧，之后攒满 8 个
    expect(decoder().fed).toHaveLength(1 + MAX_AHEAD);
    expect(player.probe()).toMatchObject({ queued: MAX_AHEAD, decodeQueue: 0 });
    driver.tick(0);
    driver.tick(250);
    await flush();
    expect(decoder().fed).toHaveLength(1 + MAX_AHEAD + 2);
    expect(player.probe().queued).toBe(MAX_AHEAD);
  });

  it("预读：按解码顺序连续读一块（不超过块大小），至多两块在手", async () => {
    // 每块 2 个样本（20 字节 ≤ 25）；索引只读盒子头与 moov，不会正好 20 字节
    const { env, driver, decoder } = track(setup({ blockBytes: 25 }));
    await flush();
    const blocks = env.reads.filter(([start, end]) => end - start === 20);
    const base = blocks[0][0];
    const block = (k: number) => [base + 20 * k, base + 20 * (k + 1)];
    // 喂了 9 个（8 个样本 + 下一遍的第 1 个）：第 0–3 块，下一遍的第 0 块，以及它之后预读的第 1 块
    expect(decoder().fed).toHaveLength(9);
    expect(blocks).toEqual([block(0), block(1), block(2), block(3), block(0), block(1)]);
    driver.tick(0);
    driver.tick(250);
    await flush();
    // 喂到下一遍的第 1 块时预读第 2 块
    expect(env.reads.filter(([start, end]) => end - start === 20).slice(6)).toEqual([block(2)]);
  });

  it("残留输出（不在本次跳转的登记里）直接关掉", async () => {
    const { env, decoder, player } = track(setup());
    await flush();
    const before = player.probe().decoded;
    decoder().init.output(new FakeFrame(env, 4_321) as unknown as VideoFrame);
    expect(env.opened).toBe(1 + player.probe().queued);
    expect(player.probe().decoded).toBe(before);
  });
});

describe("CodecVideoPlayer：循环与结束", () => {
  it("loop：不停顿地接着喂下一遍（时间戳加时长、不 flush），时钟绕回，结束回调每次绕回一次", async () => {
    const { player, driver, decoder } = track(setup());
    const ended: number[] = [];
    player.addEndedCallback(() => ended.push(driver.frame));
    await flush();
    driver.tick(0);
    const shown = await driver.play(20, 125);
    // 交出的时间戳是展开的：第二遍第 k 帧是 1 s + k × 0.125 s
    expect(shown).toEqual(Array.from({ length: 20 }, (_, i) => ms((i + 1) * 0.125)));
    // 媒体时间绕回：2.5 s → 0.5 s
    expect(player.currentTime).toBe(0.5);
    expect(ended).toEqual([9, 17]);
    expect(decoder().flushes).toBe(0);
    expect(decoder().resets).toBe(0);
    // 下一遍从关键帧（样本 0）接着喂
    expect(decoder().fed.slice(7, 10)).toEqual([ms(0.875), ms(1), ms(1.125)]);
    expect(player.isPlaying()).toBe(true);
  });

  it("跨循环的时间戳换算：第二遍里画到的帧对得上媒体时间", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    await driver.play(9, 125);
    // 第二遍 0.125 s
    expect(player.currentTime).toBe(0.125);
    expect(driver.tick(250)).toBe(ms(1.375));
    expect(player.currentTime).toBe(0.375);
  });

  it("不 loop：停在时长、ended，结束回调一次并清 wantPlay；只 flush 一次、不喂下一遍；之后 play() 从 0 开始", async () => {
    const { player, driver, decoder } = track(setup());
    player.loop = false;
    const ended: number[] = [];
    player.addEndedCallback(() => ended.push(driver.frame));
    await flush();
    driver.tick(0);
    const shown = driver.run(12, 125);
    expect(shown.slice(0, 7)).toEqual(Array.from({ length: 7 }, (_, i) => ms((i + 1) * 0.125)));
    // 停在最后一帧，不换上下一遍的第一帧
    expect(shown.slice(7)).toEqual([null, null, null, null, null]);
    expect(player.currentTime).toBe(1);
    expect(player.isPlaying()).toBe(false);
    expect(player.wantPlay).toBe(false);
    expect(ended).toEqual([9]);
    expect(decoder().flushes).toBe(1);
    expect(decoder().fed.filter((ts) => typeof ts === "number" && ts >= ms(1))).toEqual([]);
    expect(player.probe().paused).toBe(true);
    // WPE：if (isEnded) setCurrentTime(0); play()
    player.play();
    expect(player.currentTime).toBe(0);
    expect(decoder().resets).toBe(1);
    await flush();
    expect(driver.tick(0)).toBe(0);
    expect(driver.tick(125)).toBe(ms(0.125));
  });

  it("loop 中途关掉：已经预喂的下一遍不显示，停在时长", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    driver.run(6, 125);
    player.loop = false;
    // 一步越过时长（0.875 → 1.175）：时钟停在 1，下一遍 1–1.175 s 的帧不换上
    expect([driver.tick(125), driver.tick(300), driver.tick(125)]).toEqual([ms(0.875), null, null]);
    expect(player.currentTime).toBe(1);
    // 结束后宿主恢复（`SceneVideos.setPaused(false)` 把 wantPlay 置真、不跳转）：纹理仍停在最后一帧，不交出越过时长的帧
    player.wantPlay = true;
    expect([driver.tick(0), player.currentTime, player.isPlaying()]).toEqual([null, 1, false]);
  });
});

describe("CodecVideoPlayer：跳转", () => {
  it("跳到两个关键帧之间：reset + configure，从前一个关键帧喂，早于目标的输出丢掉（不计丢帧），目标帧到了才换", async () => {
    const { player, driver, decoder, env } = track(setup());
    await flush();
    driver.tick(0);
    driver.tick(125);
    decoder().halted = true;
    player.currentTime = 0.8;
    // 读回立即是写的值；目标帧到之前不换帧、时钟不走
    expect(player.currentTime).toBe(0.8);
    expect(decoder().resets).toBe(1);
    expect(decoder().configures).toBe(2);
    const fed = decoder().fed;
    expect(fed.slice(fed.indexOf("reset") + 1, fed.indexOf("reset") + 4)).toEqual([ms(0.5), ms(0.625), ms(0.75)]);
    expect(driver.tick(500)).toBeNull();
    expect(player.currentTime).toBe(0.8);
    decoder().resume();
    await flush();
    expect(driver.tick(0)).toBe(ms(0.75));
    // 早于目标的输出在跳转里丢掉，不进已解出的队列、不算越过
    expect(player.probe().dropped).toBe(0);
    // 时钟从 0.8 接着走
    expect(driver.tick(75)).toBe(ms(0.875));
    expect(env.opened).toBe(1 + player.probe().queued);
  });

  it("B 帧：关键帧按解码顺序往回找、目标按显示时间判断", async () => {
    const { player, driver, decoder } = track(setup({ bytes: buildMp4(B_FRAMES).bytes, depth: 2 }));
    await flush();
    // 解码顺序喂、显示顺序出
    expect(decoder().fed.slice(0, 4)).toEqual([0, ms(0.3), ms(0.1), ms(0.2)]);
    driver.tick(0);
    expect(driver.run(3, 100)).toEqual([ms(0.1), ms(0.2), ms(0.3)]);
    // 0.65 s：目标是显示 0.6 的 B 帧（解码第 8 个），从解码第 5 个（I，显示 0.4）喂
    player.currentTime = 0.65;
    const fed = decoder().fed;
    const after = fed.slice(fed.lastIndexOf("reset") + 1);
    expect(after.slice(0, 4)).toEqual([ms(0.4), ms(0.7), ms(0.5), ms(0.6)]);
    await flush();
    expect(driver.tick(0)).toBe(ms(0.6));
    expect(driver.tick(50)).toBe(ms(0.7));
  });

  it("跳到第一帧之前、跳过时长：钳到 [0, duration − 0.005]；loop 下自己造成的回退不触发结束回调", async () => {
    const { player, driver } = track(setup());
    const ended: number[] = [];
    player.addEndedCallback(() => ended.push(driver.frame));
    await flush();
    driver.tick(0);
    driver.run(4, 125);
    player.currentTime = -3;
    expect(player.currentTime).toBe(0);
    driver.tick(0);
    player.currentTime = 99;
    expect(player.currentTime).toBe(0.995);
    await flush();
    expect(driver.tick(0)).toBe(ms(0.875));
    player.currentTime = 0.1;
    driver.tick(0);
    expect(ended).toEqual([]);
  });

  it("脚本暂停期间跳转：读回变、不交帧，play() 之后第一次画到才换", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    player.pause();
    player.currentTime = 0.5;
    await flush();
    expect(player.currentTime).toBe(0.5);
    expect(driver.tick(100)).toBeNull();
    player.play();
    expect(driver.tick(0)).toBe(ms(0.5));
  });

  it("stop：暂停并回到 0，isPlaying 为假", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    driver.run(3, 125);
    player.stop();
    expect([player.currentTime, player.isPlaying(), player.wantPlay]).toEqual([0, false, false]);
    await flush();
    expect(driver.tick(500)).toBeNull();
    expect(player.currentTime).toBe(0);
  });
});

describe("CodecVideoPlayer：时钟的条件", () => {
  it("脚本暂停：时间停住、不交帧；恢复后接着走", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    driver.tick(125);
    player.pause();
    expect(player.isPlaying()).toBe(false);
    expect(driver.tick(500)).toBeNull();
    expect(player.currentTime).toBe(0.125);
    player.play();
    expect(driver.tick(125)).toBe(ms(0.25));
  });

  it("速率：时钟每墙钟秒走 rate 秒；负数按 0 并记一次 warn；0 停住", async () => {
    const { player, driver, env } = track(setup());
    await flush();
    driver.tick(0);
    player.rate = 2;
    expect(driver.tick(125)).toBe(ms(0.25));
    expect(player.currentTime).toBe(0.25);
    player.rate = -1;
    player.rate = -2;
    expect(player.rate).toBe(0);
    expect(env.warnings).toHaveLength(1);
    driver.tick(500);
    expect(player.currentTime).toBe(0.25);
    player.rate = 0.5;
    driver.tick(250);
    expect(player.currentTime).toBe(0.375);
  });

  it("宿主的播放速度：和脚本的 rate 相乘，换速度前走过的墙钟按旧速度结清；脚本读到的 rate 不含它", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    player.setHostRate(2);
    driver.tick(100);
    expect(player.currentTime).toBeCloseTo(0.2, 9);
    player.rate = 1.5;
    driver.tick(100);
    expect(player.currentTime).toBeCloseTo(0.5, 9);
    expect(player.rate).toBe(1.5);
    // 走了 100 ms 才换速度：这 100 ms 按旧的 3× 记
    driver.env.now += 100;
    player.setHostRate(0.25);
    driver.tick(0);
    expect(player.currentTime).toBeCloseTo(0.8, 9);
    driver.tick(400);
    expect(player.currentTime).toBeCloseTo(0.95, 9);
  });

  it("空闲：30 帧没画到就停住，再画到时接着走、不追赶", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.tick(0);
    for (let i = 0; i < 40; i++) driver.tick(10, false);
    // 第 1–31 帧之间的 31 段在走，第 32 帧起停住
    const idle = player.currentTime;
    expect(idle).toBeCloseTo(0.31, 9);
    expect(player.probe().paused).toBe(true);
    for (let i = 0; i < 20; i++) driver.tick(10, false);
    expect(player.currentTime).toBe(idle);
    expect(player.isPlaying()).toBe(true);
    driver.tick(0);
    driver.tick(10);
    expect(player.currentTime).toBeCloseTo(idle + 0.01, 9);
  });

  it("宿主暂停：时钟停住，wantPlay 不变、照常交帧", async () => {
    const { player, driver } = track(setup());
    await flush();
    driver.hostPaused = true;
    expect(driver.tick(0)).toBe(0);
    driver.tick(500);
    expect(player.currentTime).toBe(0);
    expect(player.isPlaying()).toBe(true);
    // 恢复之前的那段墙钟按暂停结算
    driver.hostPaused = false;
    expect(driver.tick(125)).toBeNull();
    expect(driver.tick(125)).toBe(ms(0.125));
  });

  it("wantPlay 由外部置真（宿主恢复）前后的时间分开结算", async () => {
    const { player, driver, env } = track(setup());
    await flush();
    driver.tick(0);
    player.pause();
    env.now += 400;
    player.wantPlay = true;
    env.now += 125;
    expect(player.currentTime).toBe(0.125);
  });
});

describe("CodecVideoPlayer：卡住与失败", () => {
  it("在放、没有已解出的帧、有待解的输入，画到时连续 2 s 没有输出：reset 并从当前时间重跳，记 warn 与计数", async () => {
    const { player, driver, decoder, env } = track(setup({ halted: true }));
    await flush();
    expect(player.hasFirstFrame).toBe(false);
    expect(driver.tick(0)).toBeNull();
    driver.tick(1999);
    expect(player.probe().stallResets).toBe(0);
    driver.tick(1);
    expect(player.probe().stallResets).toBe(1);
    expect(decoder().resets).toBe(1);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain("2000 ms 没有输出");
    expect(player.currentTime).toBe(0);
    decoder().resume();
    await flush();
    expect(driver.tick(0)).toBe(0);
    expect(driver.tick(125)).toBe(ms(0.125));
  });

  it("卡住只算连续看着的那段：中间 2 s 没画到就从现在重新计时；宿主暂停时不算", async () => {
    const { player, driver, decoder, env } = track(setup());
    await flush();
    driver.tick(0);
    decoder().halted = true;
    player.currentTime = 0.5;
    driver.tick(0);
    // 2.5 s 没画到
    env.now += 2500;
    driver.tick(0);
    expect(player.probe().stallResets).toBe(0);
    driver.tick(1999);
    expect(player.probe().stallResets).toBe(0);
    driver.hostPaused = true;
    driver.tick(1000);
    expect(player.probe().stallResets).toBe(0);
    driver.hostPaused = false;
    driver.tick(0);
    driver.tick(1999);
    expect(player.probe().stallResets).toBe(0);
    driver.tick(1);
    expect(player.probe().stallResets).toBe(1);
  });

  it("配置不支持：失败、记 warn、清 wantPlay、不交帧、不建解码器", async () => {
    const { player, driver, env } = track(setup({ supported: false }));
    let first = false;
    void player.firstFrame().then(() => (first = true));
    await flush();
    expect(player.failed).toBe(true);
    expect(first).toBe(true);
    expect(env.decoders).toHaveLength(0);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toMatch(/解码配置不支持.*图层保持透明/);
    expect(player.wantPlay).toBe(false);
    expect(driver.tick(0)).toBeNull();
    // 失败后脚本 play() 照常置真（WPE 探测失败同样）、仍没有帧
    player.play();
    expect(player.isPlaying()).toBe(true);
    expect(driver.tick(0)).toBeNull();
  });

  it("解码器 error：失败、关掉全部帧与解码器", async () => {
    const { player, driver, decoder, env } = track(setup());
    await flush();
    driver.tick(0);
    decoder().init.error(new DOMException("坏了", "EncodingError"));
    expect(player.failed).toBe(true);
    expect(env.opened).toBe(0);
    expect(decoder().closed).toBe(true);
    expect(driver.tick(125)).toBeNull();
    expect(env.warnings[0][0]).toContain("解码失败");
  });

  it("读失败：失败、记 warn、不建解码器", async () => {
    const { player, env } = track(setup({ read: () => Promise.reject(new TypeError("Failed to fetch")) }));
    await flush();
    expect(player.failed).toBe(true);
    expect(env.decoders).toHaveLength(0);
    expect(env.warnings[0][0]).toContain("读取失败");
  });

  it("块的长度不符：失败", async () => {
    const bytes = clip();
    const memory = memoryRead(bytes).read;
    // 8 个样本 × 10 字节是一块（索引的读法不会正好 80 字节）
    const read: ReadRange = async (start, end) => (end - start === 80 ? new Uint8Array(3) : memory(start, end));
    const { player, env } = track(setup({ bytes, read }));
    await flush();
    expect(player.failed).toBe(true);
    expect(env.warnings[0][1]).toMatch(/长度不符/);
  });

  it("拆不了包（不认识的封装）：和读失败一样按失败处理，记原因、不建解码器、没有退回", async () => {
    // 既不是 EBML 魔数、第一个盒子头也不认识
    const unknown = new Uint8Array(64);
    const { player, env, driver } = track(setup({ bytes: unknown }));
    let first = false;
    void player.firstFrame().then(() => (first = true));
    player.currentTime = 1.5;
    await flush();
    expect(first).toBe(true);
    expect(player.failed).toBe(true);
    expect(player.wantPlay).toBe(false);
    expect(env.decoders).toHaveLength(0);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain("场景视频不能拆包");
    expect(env.warnings[0][1]).toMatch(/不是 MP4/);
    expect(driver.tick(0)).toBeNull();
  });
});

describe("CodecVideoPlayer：Matroska", () => {
  it("Matroska 也自己拆包解码：时间戳按块的显示时间，挑帧照常", async () => {
    // 解码顺序 I0 P2 B1 I3（数字是显示的帧号，每帧 0.125 s），时长 0.5 s（Info.Duration 500 ms）
    const bytes = buildMkv([
      info(undefined, 500),
      el(MKV.Tracks, trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", codecPrivate: AVCC })),
      cluster(
        0,
        simpleBlock(1, 0, 0x80, payload(1)),
        simpleBlock(1, 250, 0, payload(2)),
        simpleBlock(1, 125, 0, payload(3)),
        simpleBlock(1, 375, 0x80, payload(4)),
      ),
    ]);
    const { player, env, driver, decoder } = track(setup({ bytes }));
    await flush();
    expect(player.failed).toBe(false);
    expect(env.warnings).toEqual([]);
    // 第一遍按解码顺序、时间戳是显示时间；loop 下接着喂下一遍（加时长）
    expect(decoder().fed.slice(0, 5)).toEqual([0, ms(0.25), ms(0.125), ms(0.375), ms(0.5)]);
    expect(driver.tick(0)).toBe(0);
    expect(driver.tick(125)).toBe(ms(0.125));
    expect(driver.tick(125)).toBe(ms(0.25));
    expect(player.duration).toBe(0.5);
  });
});

describe("CodecVideoPlayer：seeked()", () => {
  it("跳转中等到目标帧到手才 resolve；之后写下一次跳转同理", async () => {
    const { player, driver, decoder } = track(setup());
    await flush();
    driver.tick(0);
    decoder().halted = true;
    player.currentTime = 0.8;
    let done = false;
    void player.seeked().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    decoder().resume();
    await flush();
    expect(done).toBe(true);
    // 目标帧已经成了当前帧
    expect(driver.tick(0)).toBe(ms(0.75));
  });

  it("拆包期间写的时间：等到解码器建好、那次跳转完成", async () => {
    const { player, driver } = track(setup());
    // 构造之后立即写：帧表还没拆出来，时间记在 pendingSeek
    player.currentTime = 0.6;
    let done = false;
    void player.seeked().then(() => (done = true));
    expect(done).toBe(false);
    await flush();
    expect(done).toBe(true);
    expect(driver.tick(0)).toBe(ms(0.5));
    expect(player.currentTime).toBe(0.6);
  });

  it("没在跳转：立即 resolve（含拆包完成、没有等着的跳转）", async () => {
    const { player } = track(setup());
    await flush();
    await expect(player.seeked()).resolves.toBeUndefined();
    await expect(player.seeked()).resolves.toBeUndefined();
  });

  it("失败或释放时 resolve，不 reject", async () => {
    const failing = track(setup({ halted: true }));
    await flush();
    failing.player.currentTime = 0.5;
    const failed = failing.player.seeked();
    failing.decoder().init.error(new DOMException("坏了", "EncodingError"));
    await expect(failed).resolves.toBeUndefined();
    await expect(failing.player.seeked()).resolves.toBeUndefined();

    const disposing = track(setup({ halted: true }));
    await flush();
    const pending = disposing.player.seeked();
    disposing.player.currentTime = 0.5;
    const second = disposing.player.seeked();
    disposing.player.dispose();
    await expect(pending).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(disposing.player.seeked()).resolves.toBeUndefined();
  });
});

describe("区间读取", () => {
  it("fileRangeReader：按区间 fetch(file:)，Range 是闭区间、偏移加 source.start；200 也收，只认长度", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(new Uint8Array(30), { status: 200 });
    });
    try {
      const read = fileRangeReader({ path: "P:/p/scene.pkg", start: 100, end: 164 });
      expect((await read(10, 40)).length).toBe(30);
      expect(calls).toEqual([["file:///P:/p/scene.pkg", { headers: { Range: "bytes=110-139" } }]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fileRangeReader：Range 被忽略（拿到整个文件）、HTTP 失败、区间无效：都拒绝", async () => {
    const read = fileRangeReader({ path: "P:/p/scene.pkg", start: 100, end: 164 });
    try {
      vi.stubGlobal("fetch", async () => new Response(new Uint8Array(1000), { status: 200 }));
      await expect(read(0, 30)).rejects.toThrow("长度不符");
      vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
      await expect(read(0, 30)).rejects.toThrow("HTTP 404");
      await expect(read(5, 5)).rejects.toThrow(RangeError);
      await expect(read(0, 65)).rejects.toThrow(RangeError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blobRangeReader：切片、越界、长度", async () => {
    const blob = new Blob([Uint8Array.from({ length: 64 }, (_, i) => i)]);
    const read = blobRangeReader(blob);
    expect(Array.from(await read(0, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(await read(60, 64))).toEqual([60, 61, 62, 63]);
    await expect(read(60, 65)).rejects.toThrow(RangeError);
    await expect(read(-1, 4)).rejects.toThrow(RangeError);
    await expect(read(4, 4)).rejects.toThrow(RangeError);
    await expect(read(0.5, 4)).rejects.toThrow(RangeError);
  });

  it("blobRangeReader 接进播放器：从 Blob 切片读帧表与样本，解到目标帧", async () => {
    const bytes = clip();
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
    const env = newFakeEnv();
    const player = new CodecVideoPlayer({ path: "blob", start: 0, end: blob.size }, 0, {
      report: { warn: (message, detail) => void env.warnings.push([message, detail]) },
      readRange: () => blobRangeReader(blob),
      ...fakeFactories(env),
    });
    const made = track({ player, env, driver: new Driver(player, env) });
    player.currentTime = 0.5;
    await player.seeked();
    await flush();
    expect(player.failed).toBe(false);
    expect(made.driver.tick(0)).toBe(ms(0.5));
  });
});

describe("CodecVideoPlayer：脚本状态与释放", () => {
  it("resetScriptState：回调清空、loop 真、rate 1、想放、结束判定重新装上；不跳转", async () => {
    const { player, driver, decoder } = track(setup());
    const fired: number[] = [];
    player.addEndedCallback(() => fired.push(1));
    await flush();
    driver.tick(0);
    driver.run(3, 125);
    player.loop = false;
    player.rate = 3;
    player.pause();
    player.resetScriptState();
    expect([player.loop, player.rate, player.wantPlay]).toEqual([true, 1, true]);
    expect(player.currentTime).toBe(0.375);
    expect(decoder().resets).toBe(0);
    driver.run(10, 125);
    expect(fired).toEqual([]);
  });

  it("释放：不再交帧、关掉全部帧与解码器；之后的输出直接关掉", async () => {
    const { player, driver, decoder, env } = track(setup());
    await flush();
    driver.tick(0);
    const d = decoder();
    player.dispose();
    expect(env.opened).toBe(0);
    expect(d.closed).toBe(true);
    expect(driver.tick(125)).toBeNull();
    d.init.output(new FakeFrame(env, 0) as unknown as VideoFrame);
    expect(env.opened).toBe(0);
    player.play();
    player.currentTime = 0.5;
    expect(player.isPlaying()).toBe(false);
  });

  it("拆包之前释放：之后什么都不建", async () => {
    const { player, env } = track(setup());
    player.dispose();
    await flush();
    expect(env.decoders).toHaveLength(0);
    expect(env.opened).toBe(0);
  });
});

describe("颜色规则（步骤 4 走查）", () => {
  /** 240 高、没标颜色的片子：交给 `isConfigSupported` 的配置。 */
  async function configured(colorRule?: "scene" | "user"): Promise<VideoDecoderConfig> {
    const env = newFakeEnv();
    const bytes = clip({ width: 320, height: 240 });
    let seen: VideoDecoderConfig | null = null;
    const player = new CodecVideoPlayer({ path: "P:/p/v.mp4", start: 0, end: bytes.length }, 0, {
      report: { warn: (message, detail) => void env.warnings.push([message, detail]) },
      readRange: () => memoryRead(bytes).read,
      ...fakeFactories(env),
      isConfigSupported: async (config) => ((seen = config), { supported: true }),
      ...(colorRule ? { colorRule } : {}),
    });
    await player.firstFrame();
    player.dispose();
    return seen!;
  }

  it("缺省是场景视频：矩阵恒为 bt709，不按分辨率", async () => {
    expect((await configured()).colorSpace).toMatchObject({ matrix: "bt709", primaries: "bt709", transfer: "bt709" });
    expect((await configured("scene")).colorSpace?.matrix).toBe("bt709");
  });

  it("用户视频：没标时按分辨率（240 高 → smpte170m）", async () => {
    expect((await configured("user")).colorSpace?.matrix).toBe("smpte170m");
  });
});

describe("补喂由解码器驱动（P6e 报的 12 张场景探针超时）", () => {
  /** 40 帧、每帧 0.125 s、时长 5 s，关键帧在第 0、20 帧。 */
  const LONG = {
    sizes: Array.from({ length: 40 }, () => 10),
    perChunk: [40],
    stts: [[40, 125]] as [number, number][],
    stss: [1, 21],
    movie: [1000, 5000] as [number, number],
  };

  it("解码器憋着 16 帧的重排缓冲才出帧：不跑帧循环（只 apply 一次）也能出第一帧、能跳转", async () => {
    const { player, env, decoder } = setup({ bytes: clip(LONG), depth: 16 });
    player.apply(0, true);
    for (let i = 0; i < 50 && !player.hasFirstFrame; i++) await flush();
    expect(player.hasFirstFrame).toBe(true);
    expect(decoder().fed.filter((t) => t !== "reset").length).toBeGreaterThan(16);
    player.currentTime = 2.5;
    let settled = false;
    void player.seeked().then(() => (settled = true));
    for (let i = 0; i < 50 && !settled; i++) await flush();
    expect(settled).toBe(true);
    expect(player.drawn(0, true)?.timestamp).toBe(2_500_000);
    player.dispose();
    await flush();
    expect(env.opened).toBe(0);
  });

  it("只吞不吐的解码器：已喂未出到 MAX_IN_FLIGHT 就停喂", async () => {
    const sizes = Array.from({ length: 80 }, () => 10);
    const { player, decoder } = setup({
      bytes: clip({ sizes, perChunk: [80], stts: [[80, 125]], stss: [1], movie: [1000, 10000] }),
      depth: 1000,
    });
    player.apply(0, true);
    for (let i = 0; i < 30; i++) await flush();
    expect(decoder().fed.filter((t) => t !== "reset")).toHaveLength(MAX_IN_FLIGHT);
    expect(player.hasFirstFrame).toBe(false);
    player.dispose();
  });
});
