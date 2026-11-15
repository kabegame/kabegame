/**
 * P11c 步骤 2：`SceneMedia`（WPE 的 `M`）：一条事件的处理顺序、封面名字与计数、previous 轮换、无封面时同样换名、init 后补发的条件。
 */
import { describe, expect, it } from "vitest";
import { SceneMedia, type MediaHandlers } from "./scene";
import { EMPTY_PROPS, NO_COLORS, type CoverData, type MediaEvent } from "./types";

const COLORS = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 11, 12],
  [13, 14, 15],
] as const;

const event = (partial: Partial<MediaEvent> & { flags: number }): MediaEvent => ({
  enabled: true,
  state: 0,
  props: { ...EMPTY_PROPS },
  position: 0,
  duration: 0,
  cover: null,
  ...partial,
});

const cover = (id: string, has = true): CoverData => ({
  image: has ? ({ id } as unknown as CoverData["image"]) : null,
  colors: has ? COLORS : NO_COLORS,
});

function recorder() {
  const log: string[] = [];
  const handlers: MediaHandlers = {
    cover: (name, image, delta) =>
      log.push(`cover ${name} ${image ? (image as unknown as { id: string }).id : "null"} ${JSON.stringify(delta)}`),
    status: (enabled) => log.push(`status ${enabled}`),
    playback: (state) => log.push(`playback ${state}`),
    properties: (props) => log.push(`properties ${props.title}`),
    thumbnail: (info) => log.push(`thumbnail ${info.hasThumbnail} ${info.colors[0].join(",")}`),
    timeline: (position, duration) => log.push(`timeline ${position}/${duration}`),
  };
  return { log, handlers };
}

describe("SceneMedia.drain（rea-p11-media 2.3）", () => {
  it("一条 0x1d 事件按 状态 → 播放 → 属性 → 时间轴 的顺序，每次回调看到这条事件自己的值", () => {
    const media = new SceneMedia();
    const { log, handlers } = recorder();
    media.push(
      event({
        flags: 0x1d,
        enabled: false,
        state: 2,
        props: { ...EMPTY_PROPS, title: "T" },
        position: 3,
        duration: 9,
      }),
    );
    media.drain(handlers);
    expect(log).toEqual(["status false", "playback 2", "properties T", "timeline 3/9"]);
    expect(media.queued).toBe(0);
  });

  it("封面事件：先换名当属性增量（交图），再调封面回调；名字 mediaThumbnail_<N>.system，计数从 1 起、每次加 1", () => {
    const media = new SceneMedia();
    const { log, handlers } = recorder();
    media.push(event({ flags: 2, cover: cover("A") }));
    media.drain(handlers);
    // 第一张没有旧名字：增量只有 $mediaThumbnail
    expect(log).toEqual([
      'cover mediaThumbnail_1.system A {"$mediaThumbnail":{"value":"mediaThumbnail_1.system"}}',
      "thumbnail true 1,2,3",
    ]);
    log.length = 0;
    media.push(event({ flags: 2, cover: cover("B") }));
    media.drain(handlers);
    // 第二张：$mediaPreviousThumbnail 是上一张的名字
    expect(log[0]).toBe(
      'cover mediaThumbnail_2.system B {"$mediaThumbnail":{"value":"mediaThumbnail_2.system"},"$mediaPreviousThumbnail":{"value":"mediaThumbnail_1.system"}}',
    );
    expect(media.snapshot()).toMatchObject({
      counter: 3,
      name: "mediaThumbnail_2.system",
      previousName: "mediaThumbnail_1.system",
    });
  });

  it("没有封面的封面事件同样换名、交 null；回调里 hasThumbnail 为假、颜色是事件带来的值（全 0）", () => {
    const media = new SceneMedia();
    const { log, handlers } = recorder();
    media.push(event({ flags: 2, cover: cover("A") }));
    media.push(event({ flags: 2, cover: cover("", false) }));
    media.drain(handlers);
    expect(log[2]).toBe(
      'cover mediaThumbnail_2.system null {"$mediaThumbnail":{"value":"mediaThumbnail_2.system"},"$mediaPreviousThumbnail":{"value":"mediaThumbnail_1.system"}}',
    );
    expect(log[3]).toBe("thumbnail false 0,0,0");
    expect(media.snapshot().cover).toEqual({ has: false, colors: NO_COLORS });
  });

  it("队列里的多条事件逐条处理、不合并（暂停积压后恢复）：封面名字逐条换", () => {
    const media = new SceneMedia();
    const { log, handlers } = recorder();
    media.push(event({ flags: 0x15, state: 1, props: { ...EMPTY_PROPS, title: "one" } }));
    media.push(event({ flags: 2, cover: cover("A") }));
    media.push(event({ flags: 0x15, state: 1, props: { ...EMPTY_PROPS, title: "two" } }));
    media.push(event({ flags: 2, cover: cover("B") }));
    expect(media.queued).toBe(4);
    media.drain(handlers);
    expect(log.filter((line) => !line.startsWith("cover"))).toEqual([
      "status true",
      "playback 1",
      "properties one",
      "thumbnail true 1,2,3",
      "status true",
      "playback 1",
      "properties two",
      "thumbnail true 1,2,3",
    ]);
    expect(log.filter((line) => line.startsWith("cover")).map((line) => line.split(" ")[1])).toEqual([
      "mediaThumbnail_1.system",
      "mediaThumbnail_2.system",
    ]);
  });

  it("没有 flags 对应位的回调不调；drain 把当前值记进状态", () => {
    const media = new SceneMedia();
    const { log, handlers } = recorder();
    media.push(event({ flags: 4, state: 1 }));
    media.drain(handlers);
    expect(log).toEqual(["playback 1"]);
    expect(media.snapshot()).toMatchObject({ state: 1, enabled: true, queued: 0 });
  });

  it("discard 清空队列", () => {
    const media = new SceneMedia();
    media.push(event({ flags: 4 }));
    media.discard();
    expect(media.queued).toBe(0);
  });
});

describe("SceneMedia.replayAfterInit（rea-p11-media 2.5）", () => {
  const callbacks = () => {
    const { log, handlers } = recorder();
    return { log, callbacks: handlers };
  };

  it("新建状态：只补发 { enabled: true }（M.enabled 初值为真）", () => {
    const media = new SceneMedia();
    const { log, callbacks: c } = callbacks();
    media.replayAfterInit(c);
    expect(log).toEqual(["status true"]);
  });

  it("按 状态 → 播放 → 属性 → 封面 → 时间轴，各自按条件：状态非 0、title 非空、有封面、duration 非 0", () => {
    const media = new SceneMedia();
    const { handlers } = recorder();
    media.push(event({ flags: 0x1d, state: 1, props: { ...EMPTY_PROPS, title: "T" }, position: 1, duration: 5 }));
    media.push(event({ flags: 2, cover: cover("A") }));
    media.drain(handlers);
    const { log, callbacks: c } = callbacks();
    media.replayAfterInit(c);
    expect(log).toEqual(["status true", "playback 1", "properties T", "thumbnail true 1,2,3", "timeline 1/5"]);
  });

  it("title 为空不补属性、没有封面不补封面、duration 为 0 不补时间轴；enabled 为假不补状态", () => {
    const media = new SceneMedia();
    const { handlers } = recorder();
    media.push(event({ flags: 0x1d, enabled: false, state: 2, props: { ...EMPTY_PROPS, artist: "x" }, position: 4 }));
    media.push(event({ flags: 2, cover: cover("", false) }));
    media.drain(handlers);
    const { log, callbacks: c } = callbacks();
    media.replayAfterInit(c);
    expect(log).toEqual(["playback 2"]);
  });
});
