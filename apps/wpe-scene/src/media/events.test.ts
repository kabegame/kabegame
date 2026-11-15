/**
 * P11c 步骤 2：事件对象（rea-p11-media 第 3 节）：键的插入顺序、类型、`Vec3` 原型，以及 `ScriptRuntime.mediaEvent` 的派发规则
 * （全部已 init 且导出该回调的脚本、按记录顺序、不写回、出错只禁用这个回调、每个接收者各一个新对象）。假 realm 同 `cursorEvent.test.ts`。
 */
import type { ScriptModule } from "../script/moduleFactory";
import { fakeModule } from "../script/testing/fakeModule";
import { describe, expect, it } from "vitest";
import type { SceneScript } from "../compile/scripts";
import { ScriptRuntime, type ScriptRealm } from "../script/runtime";
import { scriptMediaCallbacks, thumbnailEvent, timelineEvent } from "./events";
import { EMPTY_PROPS } from "./types";

class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object };
  prototypes = { Vec2: Vec3.prototype, Vec3: Vec3.prototype, Vec4: Vec3.prototype, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown> | Error>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(_source: string, label: string): Promise<ScriptModule> {
    const result = this.modules.get(label);
    if (result instanceof Error) throw result;
    return fakeModule(result ?? {});
  }
  dispose() {}
}

const script = (id: string, object = 0): SceneScript => ({
  id,
  source: "",
  target: { kind: "layer", object, field: "alpha" } as SceneScript["target"],
  valueType: "float",
  initial: 1,
  owner: { kind: "layer", object },
  layer: object,
  scriptProperties: null,
  imports: [],
  errors: [],
});

function harness() {
  const realm = new FakeRealm();
  const warnings: string[] = [];
  const written: unknown[] = [];
  const runtime = new ScriptRuntime(realm, {
    report: {
      ready() {},
      fallback() {},
      debug() {},
      info() {},
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void warnings.push(message),
    },
    read: () => [0.5],
    write: (_target, value) => {
      written.push(value);
      return true;
    },
  });
  return { realm, runtime, warnings, written };
}

describe("事件对象", () => {
  const realm = new FakeRealm();

  it("属性事件：键序 title, artist, albumArtist, albumTitle, subTitle, genres, contentType；普通对象", () => {
    const calls: unknown[] = [];
    const callbacks = scriptMediaCallbacks({ mediaEvent: (_name, make) => calls.push(make(realm)) });
    callbacks.properties({ ...EMPTY_PROPS, title: "t", genres: "a,b" });
    const event = calls[0] as Record<string, unknown>;
    expect(Object.keys(event)).toEqual([
      "title",
      "artist",
      "albumArtist",
      "albumTitle",
      "subTitle",
      "genres",
      "contentType",
    ]);
    expect(Object.getPrototypeOf(event)).toBe(Object.prototype);
    expect(event.title).toBe("t");
    expect(event.genres).toBe("a,b");
    expect(event.subTitle).toBe("");
  });

  it("封面事件：键序 hasThumbnail, primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor；颜色是 Vec3，分量 fround(c / 255)", () => {
    const event = thumbnailEvent(realm, {
      hasThumbnail: true,
      colors: [
        [200, 39, 39],
        [0, 255, 128],
        [1, 2, 3],
        [10, 20, 30],
        [255, 255, 255],
      ],
    }) as Record<string, unknown>;
    expect(Object.keys(event)).toEqual([
      "hasThumbnail",
      "primaryColor",
      "secondaryColor",
      "tertiaryColor",
      "textColor",
      "highContrastColor",
    ]);
    expect(event.hasThumbnail).toBe(true);
    const primary = event.primaryColor as Vec3;
    expect(primary).toBeInstanceOf(Vec3);
    expect([primary.x, primary.y, primary.z]).toEqual([
      Math.fround(200 / 255),
      Math.fround(39 / 255),
      Math.fround(39 / 255),
    ]);
    // 乘 255 取整回到整数（p11-REPORT：颜色是 0–255 整数除以 255）
    expect(Math.round(primary.x * 255)).toBe(200);
    const text = event.textColor as Vec3;
    expect([text.x, text.y, text.z]).toEqual([Math.fround(10 / 255), Math.fround(20 / 255), Math.fround(30 / 255)]);
    expect((event.highContrastColor as Vec3).x).toBe(1);
  });

  it("时间轴事件：position / duration 是单精度（整秒值不变，大数取 f32）；播放与状态事件的类型", () => {
    const event = timelineEvent(realm, 37, 200) as Record<string, number>;
    expect(Object.keys(event)).toEqual(["position", "duration"]);
    expect([event.position, event.duration]).toEqual([37, 200]);
    expect(timelineEvent(realm, 16777217, 0)).toMatchObject({ position: 16777216 });
    const calls: Record<string, unknown>[] = [];
    const callbacks = scriptMediaCallbacks({ mediaEvent: (_name, make) => calls.push(make(realm) as never) });
    callbacks.status(true);
    callbacks.playback(2);
    expect(calls).toEqual([{ enabled: true }, { state: 2 }]);
  });

  it("没有运行时：回调全是空操作", () => {
    const callbacks = scriptMediaCallbacks(null);
    expect(() => {
      callbacks.status(true);
      callbacks.timeline(1, 2);
    }).not.toThrow();
  });
});

describe("ScriptRuntime.mediaEvent（rea-p11-media 2.3、2.8）", () => {
  it("发给全部已 init、导出该回调的脚本，按记录顺序（不分对象），没导出的、导出不是函数的、求值失败的跳过", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("a", { mediaStatusChanged: () => void calls.push("a") });
    h.realm.modules.set("b", { update: () => {} });
    h.realm.modules.set("c", {
      mediaStatusChanged: () => void calls.push("c"),
      mediaPlaybackChanged: () => void calls.push("c-play"),
    });
    h.realm.modules.set("d", { mediaStatusChanged: 5 });
    h.realm.modules.set("e", new Error("求值失败"));
    h.realm.modules.set("f", { mediaStatusChanged: () => void calls.push("f") });
    await h.runtime.load({
      list: ["a", "b", "c", "d", "e"].map((id, index) => script(id, index)).concat(script("f", 9)),
    });
    h.runtime.mediaEvent("mediaStatusChanged", () => ({}));
    expect(calls).toEqual(["a", "c", "f"]);
    h.runtime.mediaEvent("mediaPlaybackChanged", () => ({}));
    expect(calls).toEqual(["a", "c", "f", "c-play"]);
  });

  it("每个接收者各建一个事件对象；回调的返回值丢弃，不写回目标", async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.realm.modules.set("a", { mediaTimelineChanged: (event: unknown) => (seen.push(event), 0.25) });
    h.realm.modules.set("b", { mediaTimelineChanged: (event: unknown) => (seen.push(event), 0.75) });
    await h.runtime.load({ list: [script("a"), script("b", 1)] });
    h.written.length = 0;
    let made = 0;
    h.runtime.mediaEvent("mediaTimelineChanged", () => ({ n: ++made }));
    expect(made).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(seen[0]).not.toBe(seen[1]);
    expect(h.written).toEqual([]);
  });

  it("回调出错：只禁用这个脚本的这个回调，别的回调与别的脚本照常", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("a", {
      mediaStatusChanged: () => {
        calls.push("a-status");
        throw new Error("炸了");
      },
      mediaPlaybackChanged: () => void calls.push("a-play"),
    });
    h.realm.modules.set("b", { mediaStatusChanged: () => void calls.push("b-status") });
    await h.runtime.load({ list: [script("a"), script("b", 1)] });
    h.runtime.mediaEvent("mediaStatusChanged", () => ({}));
    h.runtime.mediaEvent("mediaStatusChanged", () => ({}));
    h.runtime.mediaEvent("mediaPlaybackChanged", () => ({}));
    expect(calls).toEqual(["a-status", "b-status", "b-status", "a-play"]);
    expect(h.warnings.join("\n")).toContain("炸了");
  });

  it("load 的 afterInit 在全部脚本 init 之后、可以补发给刚 init 的脚本；脚本没 init 完之前不收", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("a", {
      init: () => void calls.push("a-init"),
      mediaStatusChanged: (event: { enabled: boolean }) => void calls.push(`a-status ${event.enabled}`),
    });
    h.realm.modules.set("b", { init: () => void calls.push("b-init") });
    await h.runtime.load({ list: [script("a"), script("b", 1)] }, () =>
      h.runtime.mediaEvent("mediaStatusChanged", () => ({ enabled: true })),
    );
    expect(calls).toEqual(["a-init", "b-init", "a-status true"]);
  });
});
