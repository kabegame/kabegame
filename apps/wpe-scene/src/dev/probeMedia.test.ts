/**
 * P11c 步骤 2：dev 探针的媒体回放（`renderFrame` 的 `media`）：校验、按帧序预先并入 / 解码 / 切成事件、第 `frame` 帧之前入队并取空、
 * 封面增量的落点（来源表 `provide`、用户纹理绑定目标写进状态、脚本 `applyUserProperties`），以及 `init` 之后的补发。
 */
import { describe, expect, it } from "vitest";
import type { UserProperty } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { MediaCallbacks } from "../media/scene";
import type { SceneState } from "../render/state";
import type { UserTextureImage, UserTextureSources } from "../usertex/sources";
import { checkProbeMedia, createProbeMedia } from "./probeMedia";

describe("checkProbeMedia", () => {
  it("缺省返回 undefined；形状不对抛 RangeError 并指出哪一项", () => {
    expect(checkProbeMedia(undefined)).toBeUndefined();
    expect(checkProbeMedia([{ frame: 1, messages: [{ type: "status", enabled: true }] }])).toHaveLength(1);
    expect(() => checkProbeMedia({})).toThrow(RangeError);
    expect(() => checkProbeMedia([{ frame: 0, messages: [] }])).toThrow(/media\[0\]\.frame/);
    expect(() => checkProbeMedia([{ frame: 1.5, messages: [] }])).toThrow(/frame/);
    expect(() => checkProbeMedia([{ frame: 1, messages: [{ nope: 1 }] }])).toThrow(/messages/);
    expect(() => checkProbeMedia([{ frame: 1 }])).toThrow(/messages/);
  });
});

const image = (): UserTextureImage & { closed: boolean } => {
  const fake = {
    width: 4,
    height: 4,
    gamma: null,
    closed: false,
    source: {
      close() {
        fake.closed = true;
      },
    } as unknown as ImageBitmap,
  };
  return fake;
};

function harness(withScripts: boolean) {
  const calls: string[] = [];
  const provided: [string, unknown][] = [];
  const written: [string, unknown][] = [];
  const applied: unknown[] = [];
  const sources = {
    onReady: null as ((name: string) => void) | null,
    provide: (name: string, img: unknown) => void provided.push([name, img]),
    setValue: (name: string, value: string) => void calls.push(`setValue ${name} ${value}`),
  } as unknown as UserTextureSources;
  const state = {
    onUserTexture: null as ((name: string, value: string) => void) | null,
    touchUserTexture: () => {},
    write: (binding: { property: string }, value: unknown) => {
      written.push([binding.property, value]);
      state.onUserTexture?.(binding.property, String(value));
    },
  } as unknown as SceneState;
  const bundle = {
    bindings: [
      { property: "$mediaThumbnail", target: { kind: "user-texture", name: "$mediaThumbnail" } },
      { property: "$mediaPreviousThumbnail", target: { kind: "user-texture", name: "$mediaPreviousThumbnail" } },
    ],
  } as unknown as SceneBundle;
  const callbacks: MediaCallbacks = {
    status: (enabled) => void calls.push(`status ${enabled}`),
    playback: (state) => void calls.push(`playback ${state}`),
    properties: (props) => void calls.push(`properties ${props.title}`),
    thumbnail: (info) => void calls.push(`thumbnail ${info.hasThumbnail}`),
    timeline: (position, duration) => void calls.push(`timeline ${position}/${duration}`),
  };
  const properties = new Map<string, UserProperty>();
  const images: ReturnType<typeof image>[] = [];
  return {
    calls,
    provided,
    written,
    applied,
    sources,
    state,
    bundle,
    properties,
    images,
    options: {
      bundle,
      state,
      sources,
      properties,
      scripts: () =>
        withScripts
          ? {
              mediaCallbacks: () => callbacks,
              applyProperties: (delta: Record<string, UserProperty>) => void applied.push(delta),
            }
          : null,
      pending: {
        decode: async () => {
          const img = image();
          images.push(img);
          return img;
        },
      },
    },
  };
}

const props = {
  type: "properties",
  title: "Song",
  artist: "",
  albumArtist: "",
  albumTitle: "",
  subTitle: "",
  genres: "",
  contentType: "",
};

describe("createProbeMedia", () => {
  it("第 frame 帧之前入队并取空：之前的帧什么都不调；同一帧的两步合并；封面先换名（交图、写绑定目标、脚本收到没有 type 的增量）再封面回调", async () => {
    const h = harness(true);
    const media = await createProbeMedia({
      ...h.options,
      steps: [
        { frame: 3, messages: [{ type: "sceneThumbnail", png: "AAAA", colors: [] }] },
        { frame: 2, messages: [{ type: "playback", state: 1 }, props] },
        { frame: 2, messages: [{ type: "timeline", position: 3, duration: 9 }] },
      ],
    });
    media.beforeFrame(1);
    expect(h.calls).toEqual([]);
    media.beforeFrame(2);
    expect(h.calls).toEqual(["playback 1", "properties Song", "timeline 3/9"]);
    h.calls.length = 0;
    media.beforeFrame(3);
    // 封面：位图交来源表、绑定目标写进状态（状态的监听再交给来源表设值）、脚本的增量只有 value
    expect(h.provided).toHaveLength(1);
    expect(h.provided[0][0]).toBe("mediaThumbnail_1.system");
    expect(h.written).toEqual([["$mediaThumbnail", "mediaThumbnail_1.system"]]);
    expect(h.applied).toEqual([{ $mediaThumbnail: { type: undefined, value: "mediaThumbnail_1.system" } }]);
    expect(h.calls).toEqual(["setValue $mediaThumbnail mediaThumbnail_1.system", "thumbnail true"]);
    expect(media.result()).toMatchObject({
      steps: 3,
      events: 2,
      drained: [
        { frame: 2, flags: 13 },
        { frame: 3, flags: 2 },
      ],
    });
  });

  it("没有脚本：回调是空操作，封面照常交图、写绑定目标；没有来源表时位图直接关掉", async () => {
    const h = harness(false);
    const media = await createProbeMedia({
      ...h.options,
      steps: [{ frame: 1, messages: [props, { type: "sceneThumbnail", png: "AAAA", colors: [] }] }],
    });
    media.beforeFrame(1);
    expect(h.calls).toEqual(["setValue $mediaThumbnail mediaThumbnail_1.system"]);
    expect(h.written).toHaveLength(1);

    const bare = harness(false);
    const noSources = await createProbeMedia({
      ...bare.options,
      sources: undefined,
      steps: [{ frame: 1, messages: [{ type: "sceneThumbnail", png: "AAAA", colors: [] }] }],
    });
    noSources.beforeFrame(1);
    expect(bare.images[0].closed).toBe(true);
  });

  it("replayAfterInit 读场景媒体状态：新建时只补 { enabled: true }", async () => {
    const h = harness(true);
    const media = await createProbeMedia({ ...h.options, steps: [] });
    const log: string[] = [];
    media.replayAfterInit({
      status: (enabled) => void log.push(`status ${enabled}`),
      playback: () => void log.push("playback"),
      properties: () => void log.push("properties"),
      thumbnail: () => void log.push("thumbnail"),
      timeline: () => void log.push("timeline"),
    });
    expect(log).toEqual(["status true"]);
  });

  it("dispose 关掉还没派发的封面位图", async () => {
    const h = harness(true);
    const media = await createProbeMedia({
      ...h.options,
      steps: [{ frame: 5, messages: [{ type: "sceneThumbnail", png: "AAAA", colors: [] }] }],
    });
    media.dispose();
    expect(h.images[0].closed).toBe(true);
  });
});
