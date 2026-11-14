/**
 * 视频纹理播放器（P9a 步骤 1）：用替身元素核对 Blob 的读法与失败、元素设置、新帧标志、30 帧规则的单段部分、
 * 留给 P9b 的脚本接口（rate / currentTime 钳制 / stop / 结束回调）与释放，以及 P9c 步骤 1 卡住的兜底（注入时钟）。
 * 场景级的规则在 `sceneVideos.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeVideo, flush, videoEnv } from "./fakeVideo";
import {
  IDLE_FRAMES,
  STALL_MAX_RELOADS,
  STALL_MS,
  STALL_SEEKS_BEFORE_RELOAD,
  VideoTexturePlayer,
  attachToDocument,
  fetchVideoBlob,
  videoSourceKey,
  type SceneVideoSource,
} from "./player";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => `file:///${path}` }));

const pkg: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 164 };

function setup(options: Parameters<typeof videoEnv>[0] = {}, frame = 0) {
  const env = videoEnv(options);
  const player = new VideoTexturePlayer(pkg, frame, { ...env.factories, report: env.report });
  const element = env.elements[0];
  return { ...env, player, element };
}

/** 读完 Blob、挂上 src，并按帧 0 应用一次。 */
async function ready(options: Parameters<typeof videoEnv>[0] = {}) {
  const env = setup(options);
  await flush();
  env.player.apply(0, false);
  return env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchVideoBlob", () => {
  it("按区间 fetch(file:)，Range 是闭区间；200 也收，只认长度", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(new Uint8Array(64), { status: 200 });
    });
    const blob = await fetchVideoBlob(pkg);
    expect(blob.size).toBe(64);
    expect(calls).toEqual([["file:///P:/p/scene.pkg", { headers: { Range: "bytes=100-163" } }]]);
  });

  it("Range 被忽略（拿到整个文件）、HTTP 失败、区间无效：都拒绝", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(1000), { status: 200 }));
    await expect(fetchVideoBlob(pkg)).rejects.toThrow("长度不符");
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    await expect(fetchVideoBlob(pkg)).rejects.toThrow("HTTP 404");
    await expect(fetchVideoBlob({ path: "a", start: 5, end: 5 })).rejects.toThrow(RangeError);
  });

  it("复用键：路径、起点、终点", () => {
    expect(videoSourceKey(pkg)).toBe("P:/p/scene.pkg\n100\n164");
  });
});

describe("VideoTexturePlayer", () => {
  it("元素：静音、内联、缺省循环、预加载；读完区间挂上对象地址，挂上之前不调 play", async () => {
    const env = setup();
    const { element } = env;
    expect(element.muted).toBe(true);
    expect(element.playsInline).toBe(true);
    expect(element.loop).toBe(true);
    expect(element.preload).toBe("auto");
    env.player.apply(0, false);
    expect(element.calls).toEqual([]);
    await flush();
    expect(env.reads).toEqual(["P:/p/scene.pkg 100 164"]);
    expect(element.src).toBe("blob:1");
    // 挂上时按上一次 apply 的结论放
    expect(element.calls).toEqual(["play"]);
    expect(env.player.isPlaying()).toBe(true);
  });

  it("读到的 Blob 长度不符：失败、记一条 warn（带路径）、不挂 src、不交出元素", async () => {
    const env = setup({ read: async () => new Blob([new Uint8Array(10)]) });
    env.player.apply(0, false);
    await flush();
    expect(env.player.failed).toBe(true);
    expect(env.element.getAttribute("src")).toBeNull();
    expect(env.created).toEqual([]);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain("P:/p/scene.pkg");
    expect(env.warnings[0][1]).toContain("长度不符");
    env.element.present();
    expect(env.player.drawn(1, false)).toBeNull();
    expect(env.player.isPlaying()).toBe(false);
  });

  it("读取失败（含同步抛错）：失败、warn 一次", async () => {
    const env = setup({ read: () => Promise.reject(new TypeError("Failed to fetch")) });
    await flush();
    expect(env.player.failed).toBe(true);
    expect(env.warnings.map(([message]) => message)).toEqual([
      "场景视频读取失败，图层保持透明：P:/p/scene.pkg [100, 164)",
    ]);
    const sync = setup({
      read: () => {
        throw new Error("同步");
      },
    });
    await flush();
    expect(sync.player.failed).toBe(true);
  });

  it("元素 error：失败、warn 一次（MediaError 换成码与消息）、释放元素与对象地址，之后的帧回调不再置位", async () => {
    const env = await ready();
    const { element, player } = env;
    element.present();
    element.fail();
    element.fire("error");
    expect(player.failed).toBe(true);
    expect(player.fresh).toBe(false);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain("解码失败");
    expect(env.warnings[0][1]).toBe("MediaError 4：DEMUXER_ERROR_COULD_NOT_OPEN");
    expect(element.getAttribute("src")).toBeNull();
    expect(env.revoked).toEqual(["blob:1"]);
    expect(element.pendingFrameCallbacks).toBe(0);
    element.present();
    element.fire("seeked");
    expect(player.drawn(1, false)).toBeNull();
    // 失败之后 apply 不再碰元素
    const before = element.calls.length;
    player.apply(100, false);
    expect(element.calls.length).toBe(before);
  });

  it("新帧标志：帧回调每次置位并重新登记，loadeddata、seeked 也置位；交出即清", async () => {
    const env = await ready();
    const { element, player } = env;
    expect(player.drawn(1, false)).toBeNull();
    element.loadData();
    expect(player.drawn(1, false)).toBe(element);
    expect(player.drawn(1, false)).toBeNull();
    element.present();
    expect(element.pendingFrameCallbacks).toBe(1);
    expect(player.drawn(2, false)).toBe(element);
    element.fire("seeked");
    expect(player.drawn(3, false)).toBe(element);
    element.present();
    element.present();
    expect(player.drawn(4, false)).toBe(element);
    expect(player.drawn(4, false)).toBeNull();
  });

  it("没有 requestVideoFrameCallback 时只靠事件", async () => {
    const env = await ready({ frameCallbacks: false });
    expect(typeof env.element.requestVideoFrameCallback).not.toBe("function");
    env.element.fire("seeked");
    expect(env.player.drawn(1, false)).toBe(env.element);
  });

  it("只在结论变化时调 play / pause；空闲恢复不改 currentTime", async () => {
    const env = await ready();
    const { element, player } = env;
    for (let frame = 1; frame <= IDLE_FRAMES; frame++) player.apply(frame, false);
    expect(element.calls).toEqual(["play"]);
    element.currentTime = 1.25;
    player.apply(IDLE_FRAMES + 1, false);
    player.apply(IDLE_FRAMES + 2, false);
    expect(element.calls).toEqual(["play", "pause"]);
    player.drawn(IDLE_FRAMES + 3, false);
    expect(element.calls).toEqual(["play", "pause", "play"]);
    expect(element.currentTime).toBe(1.25);
    player.apply(IDLE_FRAMES + 4, true);
    player.apply(IDLE_FRAMES + 5, true);
    expect(element.calls).toEqual(["play", "pause", "play", "pause"]);
  });

  it("play() 被拒：catch 住、warn 一次；AbortError 不记", async () => {
    const env = setup();
    env.element.playResult = () => Promise.reject(new DOMException("被打断", "AbortError"));
    env.player.apply(0, false);
    await flush();
    expect(env.warnings).toEqual([]);
    env.element.playResult = () => Promise.reject(new DOMException("不许", "NotAllowedError"));
    env.player.apply(0, true);
    env.player.apply(0, false);
    env.player.apply(0, true);
    env.player.apply(0, false);
    await flush();
    expect(env.element.count("play")).toBe(3);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toBe("场景视频播放失败：P:/p/scene.pkg");
  });

  it("rate：写入转给 defaultPlaybackRate 与 playbackRate；负数钳到 0 并 warn；元素拒收时保持原速率", async () => {
    const env = await ready();
    const { element, player } = env;
    player.rate = 2;
    expect([player.rate, element.playbackRate, element.defaultPlaybackRate]).toEqual([2, 2, 2]);
    player.rate = -1;
    expect([player.rate, element.playbackRate, element.defaultPlaybackRate]).toEqual([0, 0, 0]);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain("不能为负");
    // Chromium 只收 0 与 [0.0625, 16]
    const reject = setup();
    Object.defineProperty(reject.element, "playbackRate", {
      get: () => 1,
      set: () => {
        throw new DOMException("范围外", "NotSupportedError");
      },
    });
    reject.player.rate = 100;
    expect(reject.warnings[0][0]).toContain("保持原速率");
  });

  it("currentTime 写入：duration 未知只钳下界；已知时钳到 [0, duration − 0.005]", async () => {
    const env = await ready();
    const { element, player } = env;
    player.currentTime = -1;
    expect(element.currentTime).toBe(0);
    player.currentTime = 99;
    expect(element.currentTime).toBe(99);
    expect(player.duration).toBeNaN();
    element.loadData(2.517);
    player.currentTime = 99;
    expect(player.currentTime).toBeCloseTo(2.512, 9);
    player.currentTime = 1;
    expect(player.currentTime).toBe(1);
    player.currentTime = Number.NaN;
    expect(player.currentTime).toBe(0);
    element.duration = 0.002;
    player.currentTime = 1;
    expect(player.currentTime).toBe(0);
  });

  it("pause / play / stop：pause 立即停元素；stop 之后 isPlaying 为假、回到 0；loop 为假且已结束时 play 先回到 0", async () => {
    const env = await ready();
    const { element, player } = env;
    player.pause();
    expect(player.isPlaying()).toBe(false);
    expect(element.calls).toEqual(["play", "pause"]);
    player.play();
    expect(player.isPlaying()).toBe(true);
    expect(element.calls).toEqual(["play", "pause", "play"]);
    element.currentTime = 1.5;
    player.stop();
    expect(player.isPlaying()).toBe(false);
    expect(element.currentTime).toBe(0);
    expect(element.paused).toBe(true);
    player.loop = false;
    expect(element.loop).toBe(false);
    player.play();
    element.currentTime = 2.517;
    element.ended = true;
    expect(player.isPlaying()).toBe(false);
    player.play();
    expect(element.currentTime).toBe(0);
  });

  it("isPlaying：空闲暂停与宿主暂停期间仍为真（同 WPE）", async () => {
    const env = await ready();
    env.player.apply(IDLE_FRAMES + 1, false);
    expect(env.element.paused).toBe(true);
    expect(env.player.isPlaying()).toBe(true);
    env.player.apply(IDLE_FRAMES + 1, true);
    expect(env.player.isPlaying()).toBe(true);
  });

  it("结束回调：loop 为真时每次绕回一次，自己 seek 回退不算；第一次判定不触发", async () => {
    const env = await ready();
    const { element, player } = env;
    const log: number[] = [];
    player.addEndedCallback(() => log.push(element.currentTime));
    const step = (time: number) => {
      element.currentTime = time;
      player.detectEnd();
    };
    step(0.02);
    step(1.2);
    step(2.5);
    step(0.03); // 绕回
    step(0.05);
    step(2.51);
    step(0.01); // 绕回
    expect(log).toEqual([0.03, 0.01]);
    step(2);
    player.currentTime = 0.5; // 往回 seek：不算
    player.detectEnd();
    step(0.6);
    step(2);
    player.stop(); // stop 回到 0：不算
    player.detectEnd();
    expect(log).toEqual([0.03, 0.01]);
    // 之后正常的绕回照常触发
    step(2.5);
    step(0.02);
    expect(log).toEqual([0.03, 0.01, 0.02]);
  });

  it("结束回调：loop 为假时 ended 变真那一帧触发一次，并清 wantPlay；重新播放后再装上", async () => {
    const env = await ready();
    const { element, player } = env;
    let count = 0;
    player.addEndedCallback(() => count++);
    player.addEndedCallback(() => {
      throw new Error("回调自己的错");
    });
    player.loop = false;
    element.currentTime = 2.4;
    player.detectEnd();
    element.currentTime = 2.517;
    element.ended = true;
    player.detectEnd();
    player.detectEnd();
    expect(count).toBe(1);
    expect(player.wantPlay).toBe(false);
    expect(player.isPlaying()).toBe(false);
    expect(env.warnings.map(([message]) => message)).toEqual(["场景视频的结束回调出错：P:/p/scene.pkg"]);
    player.play();
    element.ended = false;
    player.detectEnd();
    element.ended = true;
    player.detectEnd();
    expect(count).toBe(2);
  });

  it("dispose：暂停、清 src、load、撤销对象地址、取消帧回调；之后的调用都无效", async () => {
    const env = await ready();
    const { element, player } = env;
    const log: string[] = [];
    player.addEndedCallback(() => log.push("ended"));
    expect(element.pendingFrameCallbacks).toBe(1);
    player.dispose();
    player.dispose();
    expect(element.calls).toEqual(["play", "pause", "load"]);
    expect(element.getAttribute("src")).toBeNull();
    expect(env.revoked).toEqual(["blob:1"]);
    expect(element.cancelled).toHaveLength(1);
    player.apply(100, false);
    player.play();
    player.rate = 3;
    player.currentTime = 1;
    element.fire("loadeddata");
    element.currentTime = 0;
    player.detectEnd();
    expect(player.drawn(1, false)).toBeNull();
    expect(element.calls).toEqual(["play", "pause", "load"]);
    expect(element.playbackRate).toBe(1);
    expect(log).toEqual([]);
    expect(player.isPlaying()).toBe(false);
  });

  it("读完之前就释放：不建对象地址", async () => {
    const env = setup();
    env.player.dispose();
    await flush();
    expect(env.created).toEqual([]);
    expect(env.element.getAttribute("src")).toBeNull();
  });

  it("firstFrame：loadeddata、readyState ≥ HAVE_CURRENT_DATA、失败都算完成", async () => {
    const env = await ready();
    let done = false;
    void env.player.firstFrame().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    env.element.loadData();
    await flush();
    expect(done).toBe(true);
    const other = await ready();
    other.element.readyState = 2;
    expect(other.player.hasFirstFrame).toBe(true);
    const failing = await ready();
    const waiting = failing.player.firstFrame();
    failing.element.fail();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("probe：位置、状态与播放质量（拿不到时 null）", async () => {
    const env = await ready();
    const { element, player } = env;
    element.videoWidth = 1920;
    element.videoHeight = 1080;
    element.loadData(2.517);
    expect(player.probe()).toEqual({
      path: "P:/p/scene.pkg",
      start: 100,
      end: 164,
      currentTime: 0,
      paused: false,
      wantPlay: true,
      lastDrawn: 0,
      fresh: true,
      failed: false,
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 2.517,
      totalFrames: null,
      droppedFrames: null,
      stallSeeks: 0,
      stallReloads: 0,
    });
    element.quality = { totalVideoFrames: 300, droppedVideoFrames: 4 };
    expect(player.probe()).toMatchObject({ totalFrames: 300, droppedFrames: 4 });
  });
});

/**
 * P9b 点 2：脚本 `IVideoTexture` 落点上和 WPE 对齐的四处（p9-REPORT「P9b 步骤 0 的补测」）——容器时长、结束时的时间、
 * 脚本暂停 / 停止期间不交帧、失败后的 isPlaying。
 */
describe("VideoTexturePlayer 的脚本语义（P9b）", () => {
  async function readyWith(source: SceneVideoSource, options: Parameters<typeof videoEnv>[0] = {}) {
    const env = videoEnv(options);
    const player = new VideoTexturePlayer(source, 0, { ...env.factories, report: env.report });
    const element = env.elements[0];
    await flush();
    player.apply(0, false);
    return { ...env, player, element };
  }

  it("duration：容器时长优先（元数据之前就有，元素的时长不同也不管），读不出时退回元素的", async () => {
    const env = await readyWith({ ...pkg, duration: 10.005333 });
    expect(env.player.duration).toBe(10.005333);
    env.element.loadData(9.983333);
    expect(env.player.duration).toBe(10.005333);
    const plain = await readyWith(pkg);
    expect(plain.player.duration).toBeNaN();
    plain.element.loadData(2.516667);
    expect(plain.player.duration).toBe(2.516667);
  });

  it("currentTime：结束时报容器时长（WPE 读回正好等于 duration）；没结束、或没有容器时长时照元素", async () => {
    const env = await readyWith({ ...pkg, duration: 2.55 });
    const { element, player } = env;
    element.loadData(2.516667);
    player.loop = false;
    element.currentTime = 2.516667;
    expect(player.currentTime).toBe(2.516667);
    element.ended = true;
    expect(player.currentTime).toBe(2.55);
    expect(player.currentTime).toBe(player.duration);
    // 结束之后 play() 回到 0：不再 ended，照元素
    player.play();
    element.ended = false;
    expect(player.currentTime).toBe(0);
    const plain = await readyWith(pkg);
    plain.element.loadData(2.516667);
    plain.player.loop = false;
    plain.element.currentTime = 2.516667;
    plain.element.ended = true;
    expect(plain.player.currentTime).toBe(2.516667);
  });

  it("currentTime 写入：上界按容器时长减 0.005（元数据之前也钳），不按元素的时长", async () => {
    const env = await readyWith({ ...pkg, duration: 10.005333 });
    const { element, player } = env;
    player.currentTime = 99;
    expect(element.currentTime).toBeCloseTo(10.000333, 9);
    element.loadData(9.983333);
    player.currentTime = 99;
    expect(element.currentTime).toBeCloseTo(10.000333, 9);
    player.currentTime = 9.99;
    expect(element.currentTime).toBe(9.99);
    player.currentTime = -1;
    expect(element.currentTime).toBe(0);
  });

  it("脚本暂停 / 停止期间 seek 完不交帧（标志留着、仍记 lastDrawn），play() 之后第一次画到才交", async () => {
    const env = await readyWith(pkg);
    const { element, player } = env;
    element.loadData();
    expect(player.drawn(1, false)).toBe(element);
    player.pause();
    player.currentTime = 1.8;
    element.fire("seeked");
    expect(player.drawn(2, false)).toBeNull();
    expect(player.drawn(3, false)).toBeNull();
    expect(player.fresh).toBe(true);
    expect(player.lastDrawn).toBe(3);
    // 宿主暂停期间的补画也不交
    expect(player.drawn(3, true)).toBeNull();
    player.play();
    expect(player.drawn(4, false)).toBe(element);
    expect(player.drawn(4, false)).toBeNull();
    // stop 同样：停在 stop 那一刻的帧，直到 play()
    player.stop();
    element.fire("seeked");
    element.present();
    expect(player.drawn(5, false)).toBeNull();
    player.play();
    expect(player.drawn(6, false)).toBe(element);
    // loop 为假放到结尾：wantPlay 被清，结尾之后的帧同样等 play()。stop 在 loop 下清了判定位，先过一帧没结束的判定重新装上
    player.loop = false;
    player.detectEnd();
    element.ended = true;
    player.detectEnd();
    expect(player.wantPlay).toBe(false);
    element.present();
    expect(player.drawn(7, false)).toBeNull();
  });

  it("空闲暂停（30 帧没画到）与宿主暂停期间 wantPlay 仍为真：照常交帧", async () => {
    const env = await readyWith(pkg);
    const { element, player } = env;
    for (let frame = 1; frame <= IDLE_FRAMES + 1; frame++) player.apply(frame, false);
    expect(element.paused).toBe(true);
    expect(player.wantPlay).toBe(true);
    // 空闲期间的 seek：再画到时显示新位置（读码：工作线程照常取帧）
    element.fire("seeked");
    expect(player.drawn(IDLE_FRAMES + 2, false)).toBe(element);
    element.fire("seeked");
    expect(player.drawn(IDLE_FRAMES + 3, true)).toBe(element);
  });

  it("resetScriptState：清结束回调、loop 真、rate 1、想放、判定重装，不 seek；失败的仍不想放", async () => {
    const env = await readyWith(pkg);
    const { element, player } = env;
    element.loadData();
    const ended = vi.fn();
    player.addEndedCallback(ended);
    player.loop = false;
    player.rate = 2;
    player.pause();
    element.currentTime = 1.5;
    player.resetScriptState();
    expect([player.loop, element.loop, player.rate, element.playbackRate, element.defaultPlaybackRate]).toEqual([
      true,
      true,
      1,
      1,
      1,
    ]);
    expect(player.wantPlay).toBe(true);
    expect(element.paused).toBe(false);
    expect(element.currentTime).toBe(1.5);
    // 旧回调不再调：绕回也不触发
    player.detectEnd();
    element.currentTime = 0.1;
    player.detectEnd();
    expect(ended).not.toHaveBeenCalled();
    element.fail();
    player.resetScriptState();
    expect(player.wantPlay).toBe(false);
  });

  it("失败：清 wantPlay，isPlaying 为假；脚本 play() 之后为真（WPE 探测失败同样），仍不碰元素、不交帧", async () => {
    const env = await readyWith(pkg);
    const { element, player } = env;
    expect(player.isPlaying()).toBe(true);
    element.fail();
    expect(player.wantPlay).toBe(false);
    expect(player.isPlaying()).toBe(false);
    const calls = element.calls.length;
    player.play();
    expect(player.isPlaying()).toBe(true);
    element.fire("seeked");
    expect(player.drawn(1, false)).toBeNull();
    expect(element.calls.length).toBe(calls);
    player.pause();
    expect(player.isPlaying()).toBe(false);
    // 读不到（还没挂上 src 就失败）：一样
    const reading = await readyWith(pkg, { read: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(reading.player.failed).toBe(true);
    expect(reading.player.isPlaying()).toBe(false);
    // 失败时释放元素（pause + load），之后 play() 不再碰它
    expect(reading.element.calls).toEqual(["pause", "load"]);
    reading.player.play();
    expect(reading.player.isPlaying()).toBe(true);
    expect(reading.element.calls).toEqual(["pause", "load"]);
  });
});

/**
 * P9b 步骤 3：元素挂进宿主页面、几乎看不见。看不见的视频（不挂 DOM、`opacity: 0`）由 Chromium 后台渲染驱动，暂停一两秒后恢复的第一帧
 * 要等约 255 ms；挂上且 1% 不透明时 3–21 ms（phase-9b「步骤 3」的对照）。
 */
describe("挂进页面（P9b 步骤 3）", () => {
  it("构造时挂一次；释放（dispose 或失败）时撤下一次，之后再释放不重复撤", async () => {
    const env = videoEnv();
    const attached: unknown[] = [];
    const detach = vi.fn();
    const attach = (element: HTMLVideoElement) => {
      attached.push(element);
      return detach;
    };
    const player = new VideoTexturePlayer(pkg, 0, { ...env.factories, attach, report: env.report });
    expect(attached).toEqual([env.elements[0]]);
    expect(detach).not.toHaveBeenCalled();
    await flush();
    player.dispose();
    expect(detach).toHaveBeenCalledOnce();
    player.dispose();
    expect(detach).toHaveBeenCalledOnce();

    const failing = videoEnv();
    const detachFailed = vi.fn();
    const broken = new VideoTexturePlayer(pkg, 0, {
      ...failing.factories,
      attach: () => detachFailed,
      report: failing.report,
    });
    await flush();
    failing.elements[0].fail();
    expect(detachFailed).toHaveBeenCalledOnce();
    broken.dispose();
    expect(detachFailed).toHaveBeenCalledOnce();
  });

  it("attachToDocument：左上角 2 px、1% 不透明、最上层、不接收指针，按已挂的个数错开 2 px；撤下即 remove；没有 body 时什么都不做", () => {
    const appended: { attributes: Record<string, string> }[] = [];
    vi.stubGlobal("document", {
      body: {
        appendChild: (node: { attributes: Record<string, string> }) => appended.push(node),
        querySelectorAll: (selector: string) =>
          appended.filter(
            (node) => selector === "[data-kb-video-texture]" && "data-kb-video-texture" in node.attributes,
          ),
      },
    });
    const make = () => ({
      style: {} as Record<string, string>,
      attributes: {} as Record<string, string>,
      disablePictureInPicture: false,
      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
      },
      remove: vi.fn(),
    });
    const first = make();
    const detach = attachToDocument(first as unknown as HTMLVideoElement);
    expect(first.style).toEqual({
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "2px",
      height: "2px",
      opacity: "0.01",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    expect(first.attributes).toEqual({ "data-kb-video-texture": "", "aria-hidden": "true" });
    expect(first.disablePictureInPicture).toBe(true);
    expect(appended).toEqual([first]);
    // 第二段错开 2 px，不叠在第一段上
    const second = make();
    attachToDocument(second as unknown as HTMLVideoElement);
    expect(second.style.left).toBe("2px");
    detach();
    expect(first.remove).toHaveBeenCalledOnce();

    vi.stubGlobal("document", {});
    const bare = { style: {}, remove: vi.fn() };
    attachToDocument(bare as unknown as HTMLVideoElement)();
    expect(bare.style).toEqual({});
    expect(bare.remove).not.toHaveBeenCalled();
  });
});

/**
 * P9c 步骤 1：播放卡住的兜底。Chromium 硬件解码长时间放 4K60 后静默停住（`readyState` 停在 2、时间不动、没有错误），原地跳一下即恢复
 * （phase-9c「步骤 0」）。用注入的时钟走墙钟，元素时间由测试摆布，记下每次写入（原地跳 / 设回）与每次重设 `src`（重新加载）。
 */
describe("卡住的兜底（P9c 步骤 1）", () => {
  const stallPath = pkg.path;

  async function stallSetup(start = 55.33, options: { loaded?: boolean } = {}) {
    let clock = 1000;
    const env = videoEnv();
    const player = new VideoTexturePlayer(pkg, 0, { ...env.factories, report: env.report, now: () => clock });
    const element = env.elements[0];
    await flush();
    if (options.loaded ?? true) element.loadData(141.43);
    // 元素时间：测试用 setTime 摆布，播放器的写入记进 writes
    let time = start;
    const writes: number[] = [];
    Object.defineProperty(element, "currentTime", {
      configurable: true,
      get: () => time,
      set: (value: number) => {
        writes.push(value);
        time = value;
      },
    });
    // 重设 src（重新加载）记进 srcs；读完时那一次不算
    const srcs: string[] = [];
    const srcAccessor = Object.getOwnPropertyDescriptor(FakeVideo.prototype, "src")!;
    Object.defineProperty(element, "src", {
      configurable: true,
      get: () => srcAccessor.get!.call(element),
      set: (value: string) => {
        srcs.push(value);
        srcAccessor.set!.call(element, value);
      },
    });
    let frame = 0;
    // 每个渲染帧：照 `SceneVideos` 先判结束、再画到
    const step = (ms: number, hostPaused = false) => {
      clock += ms;
      frame += 1;
      player.detectEnd();
      return player.drawn(frame, hostPaused);
    };
    step(0);
    /** 按 100 ms 一帧连续画 ms 毫秒（不足 100 的零头最后一帧补上）。 */
    const run = (ms: number, hostPaused = false) => {
      for (let left = ms; left > 0; left -= 100) step(Math.min(100, left), hostPaused);
    };
    return {
      ...env,
      player,
      element,
      writes,
      srcs,
      step,
      run,
      setTime: (value: number) => (time = value),
      /** 时钟走 ms 毫秒、帧号不动、不画（测试摆布空闲与 rAF 不跑用）。 */
      wait: (ms: number) => (clock += ms),
      get frame() {
        return frame;
      },
      messages: () => env.warnings.map(([message]) => message),
    };
  }

  /** 摆出重新加载的效果（加载算法：暂停、时间回到 0、元数据之前 readyState 0；等元数据期间照常画），之后元数据回来、仍停在 2。 */
  function finishReload(s: Awaited<ReturnType<typeof stallSetup>>) {
    s.element.paused = true;
    s.setTime(0);
    s.element.readyState = 0;
    s.run(300);
    s.element.readyState = 2;
    s.element.fire("loadedmetadata");
  }

  it("常量：2 s、原地跳 2 次再重载、最多重载 3 次", () => {
    expect([STALL_MS, STALL_SEEKS_BEFORE_RELOAD, STALL_MAX_RELOADS]).toEqual([2000, 2, 3]);
  });

  it("卡住 2 s 原地跳一次（不经 setter、不碰 play / pause），时间前进后计数不再涨；再卡住重新计时", async () => {
    const s = await stallSetup();
    const calls = [...s.element.calls];
    s.run(1900);
    s.step(99);
    expect(s.writes).toEqual([]);
    s.step(1);
    expect(s.writes).toEqual([55.33]);
    expect(s.element.calls).toEqual(calls);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 1, stallReloads: 0 });
    expect(s.warnings).toEqual([
      [`场景视频卡住 2000 ms 没前进，原地跳一下：${stallPath}`, "时间 55.33 s，readyState 2"],
    ]);
    // 跳完正常放 10 s（readyState 仍按 2 摆，只要时间在走就不算卡住）
    for (let i = 1; i <= 100; i++) {
      s.setTime(55.33 + i / 10);
      s.step(100);
    }
    expect(s.player.probe()).toMatchObject({ stallSeeks: 1, stallReloads: 0 });
    // 又停住：从停住那一刻重新计时，这次也只原地跳（新的一轮）
    s.run(1900);
    expect(s.writes).toHaveLength(1);
    s.run(100);
    expect(s.writes).toEqual([55.33, 55.33 + 100 / 10]);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 2, stallReloads: 0 });
  });

  it("连续两次原地跳无效后重新加载：同一个对象地址，等元数据期间不碰元素、不再兜底，回来后设回原时间并重新 play()", async () => {
    const s = await stallSetup();
    const ended = vi.fn();
    s.player.addEndedCallback(ended);
    s.run(2000);
    s.run(2000);
    expect(s.writes).toEqual([55.33, 55.33]);
    expect(s.srcs).toEqual([]);
    s.run(1900);
    expect(s.srcs).toEqual([]);
    s.run(100);
    expect(s.srcs).toEqual(["blob:1"]);
    expect(s.created).toEqual(["blob:1"]);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 2, stallReloads: 1 });
    expect(s.messages()[2]).toBe(`场景视频原地跳 2 次仍卡住，重新加载（第 1 次）：${stallPath}`);
    expect(s.warnings[2][1]).toBe("时间 55.33 s，readyState 2");
    // 加载算法：暂停、时间回到 0
    s.element.paused = true;
    s.setTime(0);
    s.element.readyState = 0;
    const calls = s.element.calls.length;
    s.run(5000);
    // 等元数据期间：不 play、不跳、不再重载；脚本读到的是要设回去的时间；时间回到 0 不当成绕回
    expect(s.element.calls.length).toBe(calls);
    expect(s.writes).toEqual([55.33, 55.33]);
    expect(s.srcs).toEqual(["blob:1"]);
    expect(s.player.currentTime).toBe(55.33);
    expect(ended).not.toHaveBeenCalled();
    // 脚本 pause / play 也只改意图
    s.player.pause();
    s.player.play();
    expect(s.element.calls.length).toBe(calls);
    s.element.readyState = 1;
    s.element.fire("loadedmetadata");
    expect(s.writes).toEqual([55.33, 55.33, 55.33]);
    expect(s.element.calls.slice(calls)).toEqual(["play"]);
    expect(s.element.paused).toBe(false);
    expect(s.player.currentTime).toBe(55.33);
    expect(ended).not.toHaveBeenCalled();
    // 不是重载引起的 loadedmetadata：什么都不做
    s.element.fire("loadedmetadata");
    expect(s.writes).toHaveLength(3);
    expect(s.element.calls.slice(calls)).toEqual(["play"]);
    // 回来之后正常放：结束回调照常判定，计数不再涨
    for (let i = 1; i <= 30; i++) {
      s.setTime(55.33 + i / 10);
      s.step(100);
    }
    expect(ended).not.toHaveBeenCalled();
    expect(s.player.probe()).toMatchObject({ stallSeeks: 2, stallReloads: 1 });
    expect(s.warnings).toHaveLength(3);
  });

  it("重新加载期间脚本写时间：元数据回来时设回脚本写的；释放或失败了就什么都不做", async () => {
    const seeked = await stallSetup();
    seeked.run(6000);
    expect(seeked.srcs).toHaveLength(1);
    seeked.player.currentTime = 12;
    expect(seeked.player.currentTime).toBe(12);
    seeked.element.fire("loadedmetadata");
    expect(seeked.writes.at(-1)).toBe(12);
    expect(seeked.player.currentTime).toBe(12);

    const disposed = await stallSetup();
    disposed.run(6000);
    expect(disposed.srcs).toHaveLength(1);
    disposed.player.dispose();
    const writes = disposed.writes.length;
    const calls = disposed.element.calls.length;
    disposed.element.fire("loadedmetadata");
    expect(disposed.writes).toHaveLength(writes);
    expect(disposed.element.calls).toHaveLength(calls);

    const failed = await stallSetup();
    failed.run(6000);
    expect(failed.srcs).toHaveLength(1);
    failed.element.fail();
    const failedCalls = failed.element.calls.length;
    failed.element.fire("loadedmetadata");
    expect(failed.writes).toHaveLength(2);
    expect(failed.element.calls).toHaveLength(failedCalls);
  });

  it("三次重新加载都无效后放弃，只记一条放弃的 warn；时间前进后重新装上", async () => {
    const s = await stallSetup();
    for (let reload = 1; reload <= STALL_MAX_RELOADS; reload++) {
      s.run(6000); // 原地跳、原地跳、重载
      finishReload(s);
    }
    expect(s.player.probe()).toMatchObject({ stallSeeks: 6, stallReloads: 3 });
    // 第三次重载之后又是一轮：原地跳两次，然后放弃
    s.run(4000);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 8, stallReloads: 3 });
    const before = s.writes.length;
    s.run(2000);
    expect(s.messages().at(-1)).toBe(`场景视频重新加载 3 次仍卡住，不再处理，直到时间重新前进：${stallPath}`);
    s.run(20000);
    expect(s.writes).toHaveLength(before);
    expect(s.srcs).toHaveLength(3);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 8, stallReloads: 3 });
    expect(s.messages().filter((message) => message.includes("不再处理"))).toHaveLength(1);
    expect(s.warnings).toHaveLength(8 + 3 + 1);
    // 时间前进：新的一轮，原地跳与重载次数都从头算
    s.setTime(60);
    s.step(16);
    s.run(6000);
    expect(s.player.probe()).toMatchObject({ stallSeeks: 10, stallReloads: 4 });
    expect(s.srcs).toHaveLength(4);
  });

  it("不误判：脚本暂停、宿主暂停、空闲暂停、seeking、速率 0、已结束、readyState ≥ 3", async () => {
    const paused = await stallSetup();
    paused.player.pause();
    paused.run(5000);
    paused.player.play();
    paused.run(1900);
    expect(paused.writes).toEqual([]);
    paused.run(100);
    expect(paused.writes).toEqual([55.33]);

    const host = await stallSetup();
    host.run(5000, true);
    expect(host.element.paused).toBe(true);
    // 恢复的那一帧起计时
    host.step(0);
    expect(host.element.paused).toBe(false);
    host.run(1900);
    expect(host.writes).toEqual([]);
    host.run(100);
    expect(host.writes).toEqual([55.33]);

    // 空闲：30 帧以上没画到（帧号照走），元素被暂停；再画到时恢复，从恢复那一刻计时
    const idle = await stallSetup();
    idle.run(1500);
    let frame = idle.frame;
    for (let i = 0; i <= IDLE_FRAMES; i++) {
      idle.wait(10);
      idle.player.apply(++frame, false);
    }
    expect(idle.element.paused).toBe(true);
    idle.player.drawn(++frame, false);
    expect(idle.element.paused).toBe(false);
    idle.run(1900);
    expect(idle.writes).toEqual([]);

    const seeking = await stallSetup();
    Object.assign(seeking.element, { seeking: true });
    seeking.run(5000);
    Object.assign(seeking.element, { seeking: false });
    seeking.run(1900);
    expect(seeking.writes).toEqual([]);
    seeking.run(100);
    expect(seeking.writes).toEqual([55.33]);

    const still = await stallSetup();
    still.player.rate = 0;
    still.run(5000);
    expect(still.writes).toEqual([]);

    const ended = await stallSetup(141.43);
    ended.player.loop = false;
    ended.element.ended = true;
    ended.run(5000);
    expect(ended.writes).toEqual([]);

    for (const readyState of [3, 4]) {
      const ready = await stallSetup();
      ready.element.readyState = readyState;
      ready.run(5000);
      expect(ready.writes).toEqual([]);
    }
  });

  it("不误判：第一帧之前、读完之前", async () => {
    const early = await stallSetup(0, { loaded: false });
    expect(early.player.hasFirstFrame).toBe(false);
    early.run(5000);
    expect(early.writes).toEqual([]);
    // 出了第一帧之后才开始计时
    early.element.loadData(141.43);
    early.run(1900);
    expect(early.writes).toEqual([]);
    early.run(100);
    expect(early.writes).toEqual([0]);

    let clock = 0;
    const env = videoEnv({ read: () => new Promise<Blob>(() => {}) });
    const reading = new VideoTexturePlayer(pkg, 0, { ...env.factories, report: env.report, now: () => clock });
    for (let frame = 1; frame <= 100; frame++) {
      clock += 100;
      reading.drawn(frame, false);
    }
    expect(env.elements[0].calls).toEqual([]);
    expect(env.warnings).toEqual([]);
  });

  it("不误判：1.9 s 内恢复的短暂缺帧", async () => {
    const s = await stallSetup();
    for (let i = 1; i <= 10; i++) {
      s.run(1900);
      s.setTime(55.33 + i);
      s.step(16);
    }
    expect(s.writes).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it("中间没画到（窗口被盖住、rAF 不跑）的时间不算：从再画到时重新计时", async () => {
    const s = await stallSetup();
    s.run(1000);
    s.wait(60000);
    // 再画到的那一帧起计时
    s.step(0);
    s.run(1900);
    s.step(99);
    expect(s.writes).toEqual([]);
    s.step(1);
    expect(s.writes).toEqual([55.33]);
  });

  it("原地跳不触发结束回调、不改结束判定：跳完紧接着真绕回仍触发一次", async () => {
    const s = await stallSetup(141.42);
    const ended = vi.fn();
    s.player.addEndedCallback(ended);
    s.run(2000);
    expect(s.writes).toEqual([141.42]);
    expect(ended).not.toHaveBeenCalled();
    s.setTime(0.01);
    s.step(16);
    expect(ended).toHaveBeenCalledOnce();
    s.setTime(0.03);
    s.step(16);
    expect(ended).toHaveBeenCalledOnce();
  });
});
