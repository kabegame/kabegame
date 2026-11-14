/**
 * 用户纹理来源表的 GIF 与视频（P11b 步骤 4，rea-p11b 第 2、3 节，p11-REPORT M5、M6）：
 * - `mediaKind`（扩展名转小写）；
 * - GIF：注入假的 `openGif`——ready / failed、第一个纹理名用初始解码器、后来的另开、`drawn` 每帧最多推进一次、不画不推进、`current` 是当前画布、
 *   换值丢弃旧状态、再选回来从头开始、同值共用与引用计数释放；
 * - 视频：用 `video/fakeVideo.ts` 的替身工厂——等第一帧才 ready、失败回缺省、尺寸取 `videoWidth/Height`、每个纹理名一个播放器、
 *   `beginFrame` 的 30 帧规则、`setPaused`、换值 `dispose`；
 * - dev 用的 `advanceGifs` 与 `seekVideos`。
 */
import { describe, expect, it } from "vitest";
import { flush, videoEnv, type FakeVideo } from "../video/fakeVideo";
import { cropRect } from "./crop";
import { fileExtension, mediaKind, UserTextureSources, type GifSource, type UserTextureDeps } from "./sources";

/** 假 GIF：画布第 0 字节记换过几次帧；`advance` 记下收到的 dt，`changes` 决定这次换不换帧。 */
class FakeGif implements GifSource {
  readonly canvas: Uint8Array;
  readonly advances: number[] = [];
  changes = true;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly path: string,
  ) {
    this.canvas = new Uint8Array(width * height * 4);
  }
  advance(dt: number): boolean {
    this.advances.push(dt);
    if (!this.changes) return false;
    this.canvas[0]++;
    return true;
  }
}

/** GIF 与视频的尺寸表：路径 → 尺寸。 */
const GIFS: Record<string, [number, number]> = { "a.gif": [100, 80], "b.GIF": [64, 64] };

function setup() {
  const reads: string[] = [];
  const blobReads: string[] = [];
  const opened: FakeGif[] = [];
  const logs: string[] = [];
  const failing = new Set<string>();
  const env = videoEnv();
  const deps: Partial<UserTextureDeps> = {
    async read(path) {
      reads.push(path);
      if (failing.has(path)) throw new Error("读不出");
      return new TextEncoder().encode(path);
    },
    openGif(bytes) {
      const path = new TextDecoder().decode(bytes);
      const size = GIFS[path];
      if (!size) throw new Error("不是 GIF");
      const gif = new FakeGif(size[0], size[1], path);
      opened.push(gif);
      return gif;
    },
    async readBlob(path) {
      blobReads.push(path);
      if (failing.has(path)) throw new Error("读不出");
      return new Blob([new Uint8Array(10)]);
    },
    videoFactories: env.factories,
    report: env.report,
    now: () => 0,
    log: (message) => logs.push(message),
  };
  const sources = new UserTextureSources(async () => new Uint8Array(), deps);
  const ready: string[] = [];
  sources.onReady = (name) => ready.push(name);
  return { sources, ready, reads, blobReads, opened, logs, failing, env };
}

/** 设一个视频值并让它出第一帧（`videoWidth` × `videoHeight`），返回那个元素。 */
async function readyVideo(
  fixture: ReturnType<typeof setup>,
  name: string,
  value: string,
  size: [number, number] = [320, 240],
): Promise<FakeVideo> {
  fixture.sources.setValue(name, value);
  await flush();
  const element = fixture.env.elements.at(-1)!;
  element.videoWidth = size[0];
  element.videoHeight = size[1];
  element.loadData();
  await fixture.sources.settled();
  return element;
}

const SLOT = { width: 3, height: 2 };

describe("mediaKind", () => {
  it("扩展名转小写再判断：gif 是 GIF，七种视频扩展名是视频，其余交给 createImageBitmap", () => {
    expect(fileExtension("D:/a/B.GIF")).toBe("gif");
    expect(fileExtension("D:/a.b/noext")).toBe("");
    expect(mediaKind("D:/a/B.GIF")).toBe("gif");
    for (const value of ["D:/a/v.Mp4", "x.mkv", "x.wmv", "x.avi", "x.m4v", "x.mov", "x.WEBM"])
      expect(mediaKind(value)).toBe("video");
    for (const value of ["x.png", "x.jpg", "x.bmp", "x.ico", "x", "x.gifx", "a.gif/b"])
      expect(mediaKind(value)).toBe("image");
  });
});

describe("UserTextureSources：GIF", () => {
  it("读字节、打开、解出第 0 帧后 ready：尺寸取逻辑屏幕尺寸，crop 给帧来源（没有静态图）与裁切矩形", async () => {
    const { sources, ready, reads } = setup();
    sources.setValue("ut", "a.gif");
    expect(sources.status("ut")).toBe("loading");
    expect(sources.crop("ut", SLOT)).toBeNull();
    await sources.settled();
    expect(ready).toEqual(["ut"]);
    expect(reads).toEqual(["a.gif"]);
    expect(sources.status("ut")).toBe("ready");
    const crop = sources.crop("ut", SLOT)!;
    expect(crop.image).toBeNull();
    expect(crop.animation!.kind).toBe("gif");
    expect(crop.key).toBe("a.gifx15");
    // 同静态图的 cropRect：100×80 在 3:2 的槽里取 100×66、起始行 7
    expect(crop.rect).toEqual(cropRect(100, 80, 1.5));
    expect(crop.rect).toEqual({ x: 0, y: 7, width: 100, height: 66 });
    expect(sources.probe()[0]).toMatchObject({
      kind: "gif",
      status: "ready",
      width: 100,
      height: 80,
      keys: ["a.gifx15"],
    });
  });

  it("打不开（不是 GIF）或读不出：failed、记日志、槽用缺省纹理，仍通知 onReady", async () => {
    const { sources, ready, logs, failing } = setup();
    sources.setValue("ut", "bad.gif");
    await sources.settled();
    expect(sources.status("ut")).toBe("failed");
    expect(sources.crop("ut", null)).toBeNull();
    expect(logs.join("\n")).toContain("bad.gif");
    failing.add("a.gif");
    sources.setValue("ut", "a.gif");
    await sources.settled();
    expect(sources.status("ut")).toBe("failed");
    expect(ready).toEqual(["ut", "ut"]);
  });

  it("第一个纹理名用初始解出的解码器，后来的纹理名各自再开一份（同一份字节）；同名同对象", async () => {
    const { sources, opened, reads } = setup();
    await sources.prime([["ut", "a.gif"]]);
    expect(opened).toHaveLength(1);
    const first = sources.crop("ut", SLOT)!;
    expect(first.animation!.current()).toMatchObject({ kind: "pixels", data: opened[0].canvas });
    const second = sources.crop("ut", { width: 1, height: 1 })!;
    expect(second.key).toBe("a.gifx10");
    expect(second.animation).not.toBe(first.animation);
    expect(opened).toHaveLength(2);
    // 字节只读一次
    expect(reads).toEqual(["a.gif"]);
    expect(sources.crop("ut", SLOT)!.animation).toBe(first.animation);
    expect(opened).toHaveLength(2);
  });

  it("current() 是当前画布（同一个 Uint8Array，随换帧原地变）：给 GPU 纹理建出时的初始内容", async () => {
    const { sources, opened } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const animation = sources.crop("ut", SLOT)!.animation!;
    const frame = animation.current();
    expect(frame).toEqual({ kind: "pixels", data: opened[0].canvas, width: 100, height: 80 });
    opened[0].canvas[0] = 9;
    expect((animation.current() as { data: Uint8Array }).data[0]).toBe(9);
  });

  it("drawn() 每个渲染帧最多推进一次（带本帧的 frametime），换了帧交出画布、没换交出 null", async () => {
    const { sources, opened } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const animation = sources.crop("ut", SLOT)!.animation!;
    // 帧号 0：第一次画到、frametime 0
    expect(animation.drawn()).toMatchObject({ kind: "pixels", width: 100, height: 80 });
    expect(opened[0].advances).toEqual([0]);
    // 同一帧再画到不再推进、也不再交出
    expect(animation.drawn()).toBeNull();
    expect(opened[0].advances).toEqual([0]);
    sources.beginFrame(0.25);
    expect(animation.drawn()).not.toBeNull();
    expect(animation.drawn()).toBeNull();
    expect(opened[0].advances).toEqual([0, 0.25]);
    // 这一帧没换帧：推进了但交出 null
    opened[0].changes = false;
    sources.beginFrame(0.5);
    expect(animation.drawn()).toBeNull();
    expect(opened[0].advances).toEqual([0, 0.25, 0.5]);
  });

  it("不画不推进：没有 drawn 时 beginFrame 再多次也不碰解码器；再画到只推进一次、不补时间", async () => {
    const { sources, opened } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const animation = sources.crop("ut", SLOT)!.animation!;
    for (let i = 0; i < 5; i++) sources.beginFrame(0.1);
    expect(opened[0].advances).toEqual([]);
    animation.drawn();
    expect(opened[0].advances).toEqual([0.1]);
  });

  it("换值：旧状态丢弃，新值是新对象；再选回原来的值从头开始（动图不进按值的缓存）", async () => {
    const { sources, opened, reads } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const first = sources.crop("ut", SLOT)!.animation!;
    first.drawn();
    sources.beginFrame(0.1);
    first.drawn();
    expect(opened[0].canvas[0]).toBe(2);
    await sources.prime([["ut", "b.GIF"]]);
    expect(sources.crop("ut", SLOT)!.animation).not.toBe(first);
    await sources.prime([["ut", "a.gif"]]);
    const again = sources.crop("ut", SLOT)!.animation!;
    expect(again).not.toBe(first);
    // 重新读、重新打开，画布回到第 0 帧
    expect(reads).toEqual(["a.gif", "b.GIF", "a.gif"]);
    expect(opened).toHaveLength(3);
    expect(opened[2].canvas[0]).toBe(0);
    expect((again.current() as { data: Uint8Array }).data[0]).toBe(0);
  });

  it("换成静态图 / 清空：GIF 状态放掉；换值过程中旧加载的结果丢弃", async () => {
    const { sources, ready } = setup();
    sources.setValue("ut", "a.gif");
    sources.setValue("ut", "");
    await sources.settled();
    expect(sources.status("ut")).toBe("empty");
    expect(sources.crop("ut", null)).toBeNull();
    // 只有「清空」那一次通知：旧加载（已被取代）不再通知
    expect(ready).toEqual(["ut"]);
  });

  it("两个属性选了同一个值共用一次读取、一份初始解码器；引用计数放光才释放，之后再选是新的", async () => {
    const { sources, opened, reads } = setup();
    await sources.prime([
      ["x", "a.gif"],
      ["y", "a.gif"],
    ]);
    expect(reads).toEqual(["a.gif"]);
    const x = sources.crop("x", SLOT)!.animation!;
    // 同值同纹理名：同一个对象（WPE 的纹理缓存按名字共享）
    expect(sources.crop("y", SLOT)!.animation).toBe(x);
    // x 换走：y 还在用，状态保留
    await sources.prime([["x", "b.GIF"]]);
    expect(sources.crop("y", SLOT)!.animation).toBe(x);
    // y 也换走：放光，之后重新选是新的
    await sources.prime([["y", "b.GIF"]]);
    await sources.prime([["x", "a.gif"]]);
    expect(sources.crop("x", SLOT)!.animation).not.toBe(x);
    expect(reads.filter((path) => path === "a.gif")).toHaveLength(2);
    expect(opened.filter((gif) => gif.path === "a.gif")).toHaveLength(2);
  });

  it("共用的值已加载好时，后来设它的来源当场 ready（同步通知），不再读文件", async () => {
    const { sources, ready, reads } = setup();
    await sources.prime([["x", "a.gif"]]);
    ready.length = 0;
    sources.setValue("y", "a.gif");
    expect(sources.status("y")).toBe("ready");
    expect(ready).toEqual(["y"]);
    expect(reads).toEqual(["a.gif"]);
  });

  it("加载在途时两个来源共用同一次读取；其中一个换走，另一个照常完成", async () => {
    const { sources, reads, ready } = setup();
    sources.setValue("x", "a.gif");
    sources.setValue("y", "a.gif");
    sources.setValue("x", "b.GIF");
    await sources.settled();
    expect(reads.filter((path) => path === "a.gif")).toHaveLength(1);
    expect(sources.status("y")).toBe("ready");
    expect(sources.status("x")).toBe("ready");
    expect(ready.sort()).toEqual(["x", "y"]);
  });

  it("再开一份 GIF 失败（第二个纹理名）：这个纹理名没有图，记日志，不影响第一个", async () => {
    const { sources, logs } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const first = sources.crop("ut", SLOT)!;
    // 初始解码器已被第一个纹理名取走；让之后的 openGif 失败：换掉字节表里的尺寸
    delete GIFS["a.gif"];
    try {
      expect(sources.crop("ut", { width: 1, height: 1 })).toBeNull();
    } finally {
      GIFS["a.gif"] = [100, 80];
    }
    expect(logs.join("\n")).toContain("再开一份 GIF 失败");
    expect(sources.crop("ut", SLOT)!.animation).toBe(first.animation);
  });

  it("advanceGifs：对全部 GIF 纹理做一次推进（每个帧号至多一次）、不清 dirty，之后 drawn 交出这一次的结果", async () => {
    const { sources, opened } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const animation = sources.crop("ut", SLOT)!.animation!;
    sources.beginFrame(0.1);
    sources.advanceGifs();
    sources.advanceGifs();
    expect(opened[0].advances).toEqual([0.1]);
    // 同一帧真正画到：不再推进，但交出已经推进出来的变化
    expect(animation.drawn()).not.toBeNull();
    expect(opened[0].advances).toEqual([0.1]);
    expect(animation.drawn()).toBeNull();
  });

  it("探针：每个纹理名换过几次帧与最近推进的帧号", async () => {
    const { sources } = setup();
    await sources.prime([["ut", "a.gif"]]);
    const animation = sources.crop("ut", SLOT)!.animation!;
    animation.drawn();
    sources.beginFrame(0.1);
    animation.drawn();
    expect(sources.probe()[0].gifs).toEqual([{ key: "a.gifx15", frames: 2, lastFrame: 1 }]);
  });

  it("销毁后不再响应", async () => {
    const { sources, ready } = setup();
    sources.setValue("ut", "a.gif");
    sources.dispose();
    await sources.settled();
    expect(ready).toEqual([]);
    sources.setValue("ut", "b.GIF");
    expect(sources.status("ut")).toBe("none");
  });
});

describe("UserTextureSources：视频", () => {
  it("第一帧到了才 ready：之前是 loading、crop 为空；尺寸取 videoWidth × videoHeight，裁切同静态图", async () => {
    const fixture = setup();
    const { sources, ready, blobReads } = fixture;
    sources.setValue("ut", "D:/v/clip.MP4");
    expect(sources.status("ut")).toBe("loading");
    await flush();
    await flush();
    expect(ready).toEqual([]);
    expect(sources.status("ut")).toBe("loading");
    expect(sources.crop("ut", SLOT)).toBeNull();
    const element = fixture.env.elements[0];
    element.videoWidth = 320;
    element.videoHeight = 240;
    element.loadData();
    await sources.settled();
    expect(ready).toEqual(["ut"]);
    expect(blobReads).toEqual(["D:/v/clip.MP4"]);
    const crop = sources.crop("ut", SLOT)!;
    expect(crop.image).toBeNull();
    expect(crop.animation!.kind).toBe("video");
    // 320×240 在 3:2 的槽里：高裁成 trunc(320/1.5) = 213，起始行 13
    expect(crop.rect).toEqual({ x: 0, y: 13, width: 320, height: 213 });
    expect(sources.probe()[0]).toMatchObject({ kind: "video", status: "ready", width: 320, height: 240 });
    // 视频的初值全 0：current 为空，等第一次 drawn 交帧
    expect(crop.animation!.current()).toBeNull();
  });

  it("读不出、解码出错、没有画面尺寸都是 failed（槽用缺省纹理），失败的播放器被释放", async () => {
    const fixture = setup();
    const { sources, failing, env } = fixture;
    failing.add("bad.mp4");
    sources.setValue("a", "bad.mp4");
    await sources.settled();
    expect(sources.status("a")).toBe("failed");

    // 解码出错
    sources.setValue("b", "err.mp4");
    await flush();
    env.elements.at(-1)!.fail();
    await sources.settled();
    expect(sources.status("b")).toBe("failed");
    expect(sources.crop("b", null)).toBeNull();
    expect(env.warnings.length).toBeGreaterThan(0);

    // 出了第一帧但 videoWidth 为 0（纯音频等）
    sources.setValue("c", "audio.mp4");
    await flush();
    const element = env.elements.at(-1)!;
    element.loadData();
    await sources.settled();
    expect(sources.status("c")).toBe("failed");
    expect(element.count("load")).toBeGreaterThan(0);
    expect(env.revoked).toHaveLength(env.created.length);
  });

  it("每个纹理名一个播放器（同一个 Blob）：第一个拿初始播放器，后来的另建", async () => {
    const fixture = setup();
    const { sources, blobReads, env } = fixture;
    await readyVideo(fixture, "ut", "v.mp4");
    expect(env.elements).toHaveLength(1);
    const first = sources.crop("ut", SLOT)!;
    expect(env.elements).toHaveLength(1);
    const second = sources.crop("ut", { width: 1, height: 1 })!;
    expect(env.elements).toHaveLength(2);
    expect(second.animation).not.toBe(first.animation);
    expect(sources.crop("ut", SLOT)!.animation).toBe(first.animation);
    // Blob 只读一次
    expect(blobReads).toEqual(["v.mp4"]);
    expect(sources.probe()[0].videos!.map((item) => item.key)).toEqual(["v.mp4x15", "v.mp4x10"]);
  });

  it("drawn() 有新帧交出元素（交出即清标志），没有新帧 null", async () => {
    const fixture = setup();
    const element = await readyVideo(fixture, "ut", "v.mp4");
    const animation = fixture.sources.crop("ut", SLOT)!.animation!;
    expect(animation.drawn()).toEqual({ kind: "element", element });
    expect(animation.drawn()).toBeNull();
    element.present();
    expect(animation.drawn()).toEqual({ kind: "element", element });
  });

  it("beginFrame 的 30 帧规则：连续 30 帧没画到就暂停，再画到时立即恢复", async () => {
    const fixture = setup();
    const { sources } = fixture;
    const element = await readyVideo(fixture, "ut", "v.mp4");
    const animation = sources.crop("ut", SLOT)!.animation!;
    expect(element.paused).toBe(false);
    for (let i = 0; i < 30; i++) sources.beginFrame(1 / 60);
    expect(element.paused).toBe(false);
    sources.beginFrame(1 / 60);
    expect(element.paused).toBe(true);
    animation.drawn();
    expect(element.paused).toBe(false);
  });

  it("setPaused：暂停时全部 pause；恢复时 wantPlay 置真再放（连脚本不会置的失败 / 暂停过的也放）", async () => {
    const fixture = setup();
    const { sources } = fixture;
    const element = await readyVideo(fixture, "ut", "v.mp4");
    sources.crop("ut", SLOT);
    sources.setPaused(true);
    expect(element.paused).toBe(true);
    // 暂停期间新建的播放器（第二个纹理名）不放
    sources.crop("ut", { width: 1, height: 1 });
    sources.setPaused(false);
    expect(element.paused).toBe(false);
    // 同样的状态再设不重复
    const plays = element.count("play");
    sources.setPaused(false);
    expect(element.count("play")).toBe(plays);
  });

  it("换值 / 放光引用：播放器 dispose（元素清 src、对象地址撤销）；再选回来是新的播放器", async () => {
    const fixture = setup();
    const { sources, env } = fixture;
    const element = await readyVideo(fixture, "ut", "v.mp4");
    const first = sources.crop("ut", SLOT)!.animation!;
    sources.setValue("ut", "");
    expect(element.getAttribute("src")).toBeNull();
    expect(element.count("load")).toBeGreaterThan(0);
    expect(env.revoked).toEqual(["blob:1"]);
    const second = await readyVideo(fixture, "ut", "v.mp4");
    expect(second).not.toBe(element);
    expect(sources.crop("ut", SLOT)!.animation).not.toBe(first);
  });

  it("两个属性同值共用一个 Blob 与初始播放器；一个换走另一个还在，放光才 dispose", async () => {
    const fixture = setup();
    const { sources, blobReads } = fixture;
    const element = await readyVideo(fixture, "x", "v.mp4");
    fixture.sources.setValue("y", "v.mp4");
    expect(sources.status("y")).toBe("ready");
    expect(blobReads).toEqual(["v.mp4"]);
    const x = sources.crop("x", SLOT)!.animation!;
    expect(sources.crop("y", SLOT)!.animation).toBe(x);
    sources.setValue("x", "");
    expect(element.getAttribute("src")).not.toBeNull();
    sources.setValue("y", "");
    expect(element.getAttribute("src")).toBeNull();
  });

  it("加载在途时换值：旧播放器释放，不会变成 ready", async () => {
    const fixture = setup();
    const { sources, ready, env } = fixture;
    sources.setValue("ut", "v.mp4");
    await flush();
    const element = env.elements[0];
    sources.setValue("ut", "");
    expect(element.count("load")).toBeGreaterThan(0);
    element.videoWidth = 10;
    element.videoHeight = 10;
    element.loadData();
    await sources.settled();
    expect(ready).toEqual(["ut"]);
    expect(sources.status("ut")).toBe("empty");
  });

  it("seekVideos：按值给时刻，循环取模并钳到 duration − 0.005，等 seeked，之后 drawn 交出那一帧；没给时刻的不动", async () => {
    const fixture = setup();
    const { sources } = fixture;
    const element = await readyVideo(fixture, "ut", "v.mp4");
    const other = await readyVideo(fixture, "o", "w.mp4");
    const animation = sources.crop("ut", SLOT)!.animation!;
    animation.drawn();
    const seeking = sources.seekVideos((value) => (value === "v.mp4" ? 1.5 : undefined));
    element.fire("seeked");
    await seeking;
    expect(element.currentTime).toBe(1.5);
    expect(other.currentTime).toBe(0);
    expect(animation.drawn()).toEqual({ kind: "element", element });

    // 超过时长按循环取模（2.517 的时长：5 % 2.517 = 2.483），接近末尾时钳到 duration − 0.005
    const wrapped = sources.seekVideos(() => 5);
    element.fire("seeked");
    other.fire("seeked");
    await wrapped;
    expect(element.currentTime).toBeCloseTo(5 % 2.517, 6);
    const clamped = sources.seekVideos(() => 2.516);
    element.fire("seeked");
    other.fire("seeked");
    await clamped;
    expect(element.currentTime).toBeCloseTo(2.517 - 0.005, 6);
  });

  it("探针：每个纹理名的播放器状态", async () => {
    const fixture = setup();
    await readyVideo(fixture, "ut", "v.mp4", [320, 240]);
    fixture.sources.crop("ut", SLOT);
    const probe = fixture.sources.probe()[0];
    expect(probe.videos).toHaveLength(1);
    expect(probe.videos![0]).toMatchObject({
      key: "v.mp4x15",
      player: { videoWidth: 320, videoHeight: 240, failed: false },
    });
  });
});
