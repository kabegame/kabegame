/**
 * 视频纹理播放器（P9a 步骤 1）：用替身元素核对 Blob 的读法与失败、元素设置、新帧标志、30 帧规则的单段部分、
 * 留给 P9b 的脚本接口（rate / currentTime 钳制 / stop / 结束回调）与释放。场景级的规则在 `sceneVideos.test.ts`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, videoEnv } from "./fakeVideo";
import { IDLE_FRAMES, VideoTexturePlayer, fetchVideoBlob, videoSourceKey, type SceneVideoSource } from "./player";

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
