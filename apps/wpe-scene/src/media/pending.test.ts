/**
 * P11c 步骤 2：`MediaPending`（WPE `A.pending` 的合并与 `FlushMedia` 的切法）。封面解码用假的（按 base64 串给一个带 `close` 的假位图，可控完成顺序）。
 */
import { describe, expect, it } from "vitest";
import type { UserTextureImage } from "../usertex/sources";
import { MediaPending, toColors } from "./pending";
import { FLAG_PLAYBACK, FLAG_PROPERTIES, FLAG_STATUS, FLAG_THUMBNAIL, FLAG_TIMELINE } from "./types";

const color = (v: number): [number, number, number] => [v, v, v];
const five = (v: number) => [color(v), color(v + 1), color(v + 2), color(v + 3), color(v + 4)];

interface FakeImage extends UserTextureImage {
  closed: boolean;
}

/** 假解码：每次调用记下 resolve / reject 句柄，测试按需要的顺序完成。 */
function harness() {
  const jobs: { png: string; resolve(): void; reject(error: Error): void; image: FakeImage }[] = [];
  const logs: string[] = [];
  const pending = new MediaPending({
    decode: (png) =>
      new Promise<UserTextureImage>((resolve, reject) => {
        const image = {
          width: 2,
          height: 2,
          gamma: null,
          closed: false,
          source: {
            close() {
              image.closed = true;
            },
          } as unknown as ImageBitmap,
        } as FakeImage;
        jobs.push({ png, image, resolve: () => resolve(image), reject });
      }),
    log: (message) => logs.push(message),
  });
  return { pending, jobs, logs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MediaPending（rea-p11-media 1.5）", () => {
  it("同类只留最后一条，flags 按位或；一次刷新把 0x1d 合成一个事件，值取各类最后一条", () => {
    const { pending } = harness();
    pending.push({ type: "status", enabled: true });
    pending.push({ type: "playback", state: 2 });
    pending.push({ type: "playback", state: 1 });
    pending.push({
      type: "properties",
      title: "a",
      artist: "",
      albumArtist: "",
      albumTitle: "",
      subTitle: "",
      genres: "",
      contentType: "",
    });
    pending.push({
      type: "properties",
      title: "b",
      artist: "x",
      albumArtist: "",
      albumTitle: "",
      subTitle: "",
      genres: "g1,g2",
      contentType: "music",
    });
    pending.push({ type: "timeline", position: 3.9, duration: 200 });
    expect(pending.pendingFlags).toBe(FLAG_STATUS | FLAG_PLAYBACK | FLAG_PROPERTIES | FLAG_TIMELINE);
    const events = pending.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      flags: 0x1d,
      enabled: true,
      state: 1,
      position: 3,
      duration: 200,
      cover: null,
    });
    expect(events[0].props).toMatchObject({ title: "b", artist: "x", genres: "g1,g2", contentType: "music" });
    // 没有新消息：再刷新什么都没有；值留着，下一次只有变的位
    expect(pending.flush()).toEqual([]);
    pending.push({ type: "playback", state: 2 });
    const next = pending.flush();
    expect(next).toHaveLength(1);
    expect(next[0].flags).toBe(FLAG_PLAYBACK);
    // 值是缓存：播放事件里还带着上次的标题与时间轴
    expect(next[0]).toMatchObject({ state: 2, position: 3, duration: 200 });
    expect(next[0].props.title).toBe("b");
  });

  it("封面解完才并入；一次刷新先 0x1d 一个、再封面一个（flags 2）", async () => {
    const { pending, jobs } = harness();
    pending.push({ type: "playback", state: 1 });
    pending.push({ type: "sceneThumbnail", png: "AAAA", colors: five(10) });
    // 还没解完：不并入，flags 里没有封面位
    expect(pending.pendingFlags).toBe(FLAG_PLAYBACK);
    jobs[0].resolve();
    await pending.settled();
    expect(pending.pendingFlags).toBe(FLAG_PLAYBACK | FLAG_THUMBNAIL);
    const events = pending.flush();
    expect(events.map((event) => event.flags)).toEqual([FLAG_PLAYBACK, FLAG_THUMBNAIL]);
    expect(events[1].cover?.image).toBe(jobs[0].image);
    expect(events[1].cover?.colors).toEqual(five(10));
    // 位图随事件交出，pending 不再持有：之后取代它不会关掉已交出的位图
    pending.push({ type: "sceneThumbnail", png: "BBBB", colors: five(20) });
    jobs[1].resolve();
    await pending.settled();
    expect(jobs[0].image.closed).toBe(false);
  });

  it("后收到的封面胜出：晚到的旧结果关掉位图；先到的旧封面被取代时关掉位图", async () => {
    const { pending, jobs } = harness();
    pending.push({ type: "sceneThumbnail", png: "AAAA", colors: five(1) });
    pending.push({ type: "sceneThumbnail", png: "BBBB", colors: five(2) });
    // B 先解完，A 晚到：A 的结果被丢掉并关位图
    jobs[1].resolve();
    jobs[0].resolve();
    await pending.settled();
    expect(jobs[0].image.closed).toBe(true);
    expect(jobs[1].image.closed).toBe(false);
    const [event] = pending.flush();
    expect(event.cover?.image).toBe(jobs[1].image);
    expect(event.cover?.colors).toEqual(five(2));

    // 先后顺序正常，但第一张还没发出就被第二张取代：第一张的位图关掉
    pending.push({ type: "sceneThumbnail", png: "CCCC", colors: five(3) });
    jobs[2].resolve();
    await pending.settled();
    pending.push({ type: "sceneThumbnail", png: "DDDD", colors: five(4) });
    jobs[3].resolve();
    await pending.settled();
    expect(jobs[2].image.closed).toBe(true);
    expect(pending.flush()[0].cover?.image).toBe(jobs[3].image);
  });

  it("png 为空 = 没有封面：不解码、当场并入（image 为 null、颜色全 0），并让在途的旧封面作废", async () => {
    const { pending, jobs } = harness();
    pending.push({ type: "sceneThumbnail", png: "AAAA", colors: five(1) });
    pending.push({ type: "sceneThumbnail", png: "", colors: five(9) });
    expect(jobs).toHaveLength(1);
    expect(pending.pendingFlags).toBe(FLAG_THUMBNAIL);
    jobs[0].resolve();
    await pending.settled();
    expect(jobs[0].image.closed).toBe(true);
    const [event] = pending.flush();
    expect(event.cover?.image).toBeNull();
    expect(event.cover?.colors).toEqual(toColors([]));
  });

  it("解码失败：记一条日志，当作没有封面（颜色保留消息里的值），事件仍发", async () => {
    const { pending, jobs, logs } = harness();
    pending.push({ type: "sceneThumbnail", png: "AAAA", colors: five(5) });
    jobs[0].reject(new Error("坏图"));
    await pending.settled();
    expect(logs.join("\n")).toContain("坏图");
    const [event] = pending.flush();
    expect(event.flags).toBe(FLAG_THUMBNAIL);
    expect(event.cover?.image).toBeNull();
    expect(event.cover?.colors).toEqual(five(5));
  });

  it("dispose：还没发出的封面位图关掉，在途的解完也关掉，之后的消息不收", async () => {
    const { pending, jobs } = harness();
    pending.push({ type: "sceneThumbnail", png: "AAAA", colors: five(1) });
    jobs[0].resolve();
    await pending.settled();
    pending.push({ type: "sceneThumbnail", png: "BBBB", colors: five(2) });
    pending.dispose();
    jobs[1].resolve();
    await tick();
    expect(jobs[0].image.closed).toBe(true);
    expect(jobs[1].image.closed).toBe(true);
    pending.push({ type: "playback", state: 1 });
    expect(pending.flush()).toEqual([]);
  });

  it("不认识的 type 忽略；字段缺失或类型不对按空串 / 0", () => {
    const { pending } = harness();
    pending.push({ type: "thumbnail", thumbnail: "x" });
    expect(pending.pendingFlags).toBe(0);
    pending.push({ type: "properties", title: 5 });
    pending.push({ type: "timeline", position: "x", duration: Number.NaN });
    const [event] = pending.flush();
    expect(event.props.title).toBe("");
    expect([event.position, event.duration]).toEqual([0, 0]);
  });
});
