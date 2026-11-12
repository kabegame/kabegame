/**
 * 场景的视频纹理（P9a 步骤 1）：用替身元素核对 30 帧规则、加载时就没被画到的视频、宿主暂停与恢复、新帧只交出一次、
 * 跨 load 复用与释放、失败、等第一帧、结束回调的时机与探针。WPE 依据见 p9-REPORT 与 rea-p9-video 第 3、4、6 节。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush, videoEnv } from "./fakeVideo";
import type { SceneVideoSource } from "./player";
import { SceneVideos } from "./sceneVideos";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => `file:///${path}` }));

const a: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 164 };
const b: SceneVideoSource = { path: "P:/p/materials/b.tex", start: 40, end: 72 };

function setup(options: Parameters<typeof videoEnv>[0] = {}) {
  const env = videoEnv(options);
  const videos = new SceneVideos(env.report, env.factories);
  return { ...env, videos };
}

/** 推进 n 个实时帧；`draw` 给出每帧画到的纹理下标。 */
function frames(videos: SceneVideos, n: number, draw: number[] = []) {
  for (let i = 0; i < n; i++) {
    videos.beginFrame();
    for (const index of draw) videos.drawn(index);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SceneVideos", () => {
  it("30 帧规则：一直没画到时第 30 帧还在放、第 31 帧暂停；再画到时立即恢复，currentTime 不跳；期间 isPlaying 为真", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    const [element] = env.elements;
    expect(element.calls).toEqual(["play"]);
    frames(env.videos, 30);
    expect(element.paused).toBe(false);
    element.currentTime = 0.5;
    frames(env.videos, 1);
    expect(element.paused).toBe(true);
    expect(element.calls).toEqual(["play", "pause"]);
    frames(env.videos, 20);
    expect(element.calls).toEqual(["play", "pause"]);
    expect(env.videos.player(1)!.isPlaying()).toBe(true);
    env.videos.beginFrame();
    env.videos.drawn(1);
    expect(element.calls).toEqual(["play", "pause", "play"]);
    expect(element.currentTime).toBe(0.5);
  });

  it("画到就一直放；最后一次画到之后第 31 帧暂停", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    const [element] = env.elements;
    frames(env.videos, 100, [0]);
    expect(element.calls).toEqual(["play"]);
    frames(env.videos, 30);
    expect(element.paused).toBe(false);
    frames(env.videos, 1);
    expect(element.paused).toBe(true);
    expect(env.videos.probe()[0]).toMatchObject({ frame: 131, lastDrawn: 100, paused: true, wantPlay: true });
  });

  it("加载时就没被画到的视频先播 30 帧（lastDrawn 取建好时的帧号，不是 0）", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    frames(env.videos, 50, [0]);
    // 第 50 帧才出现的视频：从这一帧算 30 帧
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const second = env.elements[1];
    expect(env.videos.probe()[1]).toMatchObject({ path: b.path, lastDrawn: 50 });
    frames(env.videos, 30, [0]);
    expect(second.paused).toBe(false);
    frames(env.videos, 1, [0]);
    expect(second.paused).toBe(true);
  });

  it("宿主暂停：全部暂停、帧号与空闲不受影响；恢复时连脚本暂停过的也放（照 WPE）", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const [first, second] = env.elements;
    frames(env.videos, 5, [0, 1]);
    // 脚本暂停了第二段（P9b 的 pause）
    env.videos.player(1)!.pause();
    expect(second.paused).toBe(true);
    env.videos.setPaused(true);
    env.videos.setPaused(true);
    expect([first.paused, second.paused]).toEqual([true, true]);
    expect(first.calls).toEqual(["play", "pause"]);
    expect(second.calls).toEqual(["play", "pause"]);
    // 暂停期间渲染器不调 beginFrame，帧号不走；isPlaying 照报（第一段真，第二段被脚本暂停为假）
    expect(env.videos.probe()[0].frame).toBe(5);
    expect([env.videos.player(0)!.isPlaying(), env.videos.player(1)!.isPlaying()]).toEqual([true, false]);
    env.videos.setPaused(false);
    expect([first.paused, second.paused]).toEqual([false, false]);
    expect(env.videos.probe().map((video) => video.wantPlay)).toEqual([true, true]);
    expect(first.calls).toEqual(["play", "pause", "play"]);
    expect(second.calls).toEqual(["play", "pause", "play"]);
  });

  it("宿主暂停期间画到也不放；恢复后照 30 帧规则", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    const [element] = env.elements;
    env.videos.setPaused(true);
    env.videos.drawn(0);
    expect(element.paused).toBe(true);
    env.videos.setPaused(false);
    expect(element.paused).toBe(false);
  });

  it("新帧只交出一次：同一帧被两个 draw 画到只拷一次；没有新帧时返回 null；没有视频的下标返回 null", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    const [element] = env.elements;
    env.videos.beginFrame();
    expect(env.videos.drawn(1)).toBeNull();
    element.loadData();
    expect(env.videos.drawn(1)).toBe(element);
    expect(env.videos.drawn(1)).toBeNull();
    env.videos.beginFrame();
    expect(env.videos.drawn(1)).toBeNull();
    element.present();
    expect(env.videos.drawn(1)).toBe(element);
    expect(env.videos.drawn(1)).toBeNull();
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.videos.drawn(7)).toBeNull();
  });

  it("跨 load 复用：同区间同一个元素、不重读、不打断；下标表重建；用不到的释放并撤销对象地址", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const [first, second] = env.elements;
    frames(env.videos, 10, [0, 1]);
    first.present();
    // 重编译：下标换了位置，a 的区间不变（新对象，同值）
    env.videos.load([{}, { video: { ...a } }]);
    await flush();
    expect(env.elements).toHaveLength(2);
    expect(env.reads).toEqual([`${a.path} 100 164`, `${b.path} 40 72`]);
    expect(first.calls).toEqual(["play"]);
    expect(env.videos.drawn(1)).toBe(first);
    expect(env.videos.drawn(0)).toBeNull();
    // b 不在了：释放
    expect(second.getAttribute("src")).toBeNull();
    expect(second.calls).toEqual(["play", "pause", "load"]);
    expect(env.revoked).toEqual(["blob:2"]);
    // 换场景：全部换掉
    env.videos.load([{ video: { ...a, end: 200 } }]);
    await flush();
    expect(env.elements).toHaveLength(3);
    expect(env.revoked).toEqual(["blob:2", "blob:1"]);
    expect(env.videos.probe().map((video) => video.end)).toEqual([200]);
  });

  it("两个下标同一区间：共用一个播放器", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: { ...a } }]);
    await flush();
    expect(env.elements).toHaveLength(1);
    expect(env.videos.probe()[0].textures).toEqual([0, 1]);
  });

  it("读失败、元素 error：不再交出元素，各记一条 warn；不影响别的视频", async () => {
    const env = setup({
      read: (path) =>
        path === b.path
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(new Blob([new Uint8Array(64)])),
    });
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    const [first, second] = env.elements;
    second.present();
    env.videos.beginFrame();
    expect(env.videos.drawn(1)).toBeNull();
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0][0]).toContain(b.path);
    first.loadData();
    first.fail();
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.warnings).toHaveLength(2);
    expect(env.warnings[1][0]).toContain(a.path);
    expect(env.videos.probe().map((video) => video.failed)).toEqual([true, true]);
  });

  it("firstFrames：都出了第一帧才 resolve；失败的立即算完成；没有视频的下标不等", async () => {
    const env = setup({
      read: (path) =>
        path === b.path ? Promise.reject(new Error("坏")) : Promise.resolve(new Blob([new Uint8Array(64)])),
    });
    env.videos.load([{ video: a }, { video: b }, {}]);
    await flush();
    let done = false;
    void env.videos.firstFrames([0, 1, 2, 9], 2000).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    env.elements[0].loadData();
    await flush();
    expect(done).toBe(true);
    await expect(env.videos.firstFrames([0, 1], 2000)).resolves.toBeUndefined();
    await expect(env.videos.firstFrames([], 2000)).resolves.toBeUndefined();
  });

  it("firstFrames：超时也 resolve，不 reject", async () => {
    vi.useFakeTimers();
    const env = setup();
    env.videos.load([{ video: a }]);
    let done = false;
    void env.videos.firstFrames([0], 2000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("firstFrames：readyState 已到 HAVE_CURRENT_DATA 时立即完成", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    env.elements[0].readyState = 2;
    await expect(env.videos.firstFrames([0], 60_000)).resolves.toBeUndefined();
  });

  it("beginFrame 先判定绕回 / 结束再 apply：loop 为假的结束清 wantPlay，元素随之暂停", async () => {
    const env = setup();
    env.videos.load([{ video: a }]);
    await flush();
    const [element] = env.elements;
    const player = env.videos.player(0)!;
    const log: number[] = [];
    player.addEndedCallback(() => log.push(env.videos.probe()[0].frame));
    player.loop = false;
    frames(env.videos, 3, [0]);
    element.ended = true;
    element.paused = true; // 元素自己停在结尾
    frames(env.videos, 3, [0]);
    expect(log).toEqual([4]);
    expect(player.isPlaying()).toBe(false);
    expect(element.calls).toEqual(["play", "pause"]);
  });

  it("probe：每段一项，带帧号与下标", async () => {
    const env = setup();
    env.videos.load([{}, { video: a }]);
    await flush();
    env.elements[0].quality = { totalVideoFrames: 12, droppedVideoFrames: 1 };
    frames(env.videos, 2, [1]);
    expect(env.videos.probe()).toEqual([
      {
        path: a.path,
        start: 100,
        end: 164,
        currentTime: 0,
        paused: false,
        wantPlay: true,
        lastDrawn: 2,
        frame: 2,
        fresh: false,
        failed: false,
        videoWidth: 0,
        videoHeight: 0,
        duration: Number.NaN,
        totalFrames: 12,
        droppedFrames: 1,
        textures: [1],
      },
    ]);
  });

  it("dispose：释放全部，之后的调用都无效", async () => {
    const env = setup();
    env.videos.load([{ video: a }, { video: b }]);
    await flush();
    env.videos.dispose();
    expect(env.revoked).toEqual(["blob:1", "blob:2"]);
    expect(env.elements.map((element) => element.getAttribute("src"))).toEqual([null, null]);
    env.videos.load([{ video: a }]);
    env.videos.beginFrame();
    env.videos.setPaused(true);
    expect(env.videos.drawn(0)).toBeNull();
    expect(env.elements).toHaveLength(2);
    expect(env.videos.probe()).toEqual([]);
  });
});
