/**
 * 网页壁纸音量：协议纯函数，以及垫片 `wpe_shim.js` 本身（在 node:vm 里配一套假的 DOM / Web Audio 跑原文件，
 * 消息类型用 `wpeWebVolume.ts` 的常量——两边字面量不一致这里就失败）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  WPE_VOLUME_MESSAGE,
  WPE_VOLUME_REQUEST,
  clampWallpaperVolume,
  isWpeVolumeRequest,
  webHostVolume,
  wpeVolumeMessage,
} from "./wpeWebVolume";
import { WPE_CONTEXT_MENU } from "./wpeContextMenu";

const SHIM_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../../../src-tauri/kabegame/src/webview_js/wpe_shim.js", import.meta.url)),
  "utf8",
);

describe("wpeWebVolume 协议", () => {
  it("请求识别只认固定类型", () => {
    expect(isWpeVolumeRequest({ type: WPE_VOLUME_REQUEST })).toBe(true);
    expect(isWpeVolumeRequest({ type: WPE_VOLUME_MESSAGE, volume: 1 })).toBe(false);
    expect(isWpeVolumeRequest("kabegame:wpe-volume-request")).toBe(false);
    expect(isWpeVolumeRequest(null)).toBe(false);
  });

  it("宿主音量：钳到 0…1，非有限值按 1，paused 为 0", () => {
    expect(clampWallpaperVolume(0.4)).toBe(0.4);
    expect(clampWallpaperVolume(-1)).toBe(0);
    expect(clampWallpaperVolume(3)).toBe(1);
    expect(clampWallpaperVolume(Number.NaN)).toBe(1);
    expect(webHostVolume(0.6, false)).toBe(0.6);
    expect(webHostVolume(0.6, true)).toBe(0);
    expect(wpeVolumeMessage(0.3, true)).toEqual({ type: WPE_VOLUME_MESSAGE, volume: 0.3, paused: true });
  });
});

// ---- 垫片的运行环境：只实现垫片与测试用到的部分。垫片会改这些类的原型，所以每个用例新建一套 ----

function createFakes() {
  function brand(value: unknown) {
    if (!(value instanceof FakeMediaElement)) throw new TypeError("Illegal invocation");
  }

  class FakeMediaElement {
    nativeVolume = 1;
    nativeMuted = false;
    playCalls = 0;
    dispatched: string[] = [];
    tagName = "AUDIO";
    id = "";
    isConnected = false;
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    }
    dispatchEvent(event: { type: string }) {
      this.dispatched.push(event.type);
      return true;
    }
  }
  Object.defineProperties(FakeMediaElement.prototype, {
    volume: {
      configurable: true,
      enumerable: true,
      get(this: FakeMediaElement) {
        brand(this);
        return this.nativeVolume;
      },
      set(this: FakeMediaElement, value: number) {
        brand(this);
        this.nativeVolume = value;
      },
    },
    muted: {
      configurable: true,
      enumerable: true,
      get(this: FakeMediaElement) {
        brand(this);
        return this.nativeMuted;
      },
      set(this: FakeMediaElement, value: boolean) {
        brand(this);
        this.nativeMuted = value;
      },
    },
  });

  class FakeAudioNode {
    outputs: { node: unknown; output: number }[] = [];
    constructor(public context: FakeBaseContext) {}
    connect(destination: FakeAudioNode, output = 0, input = 0) {
      if (input !== 0) throw new DOMException("input out of range", "IndexSizeError");
      if (destination.context !== this.context) throw new DOMException("different context", "InvalidAccessError");
      this.outputs.push({ node: destination, output });
      return destination;
    }
    disconnect(destination?: FakeAudioNode) {
      if (arguments.length === 0) {
        this.outputs = [];
        return;
      }
      if (!this.outputs.some((o) => o.node === destination)) {
        throw new DOMException("not connected", "InvalidAccessError");
      }
      this.outputs = this.outputs.filter((o) => o.node !== destination);
    }
  }
  class FakeDestination extends FakeAudioNode {}
  class FakeGain extends FakeAudioNode {
    gain = { value: 1 };
  }
  class FakeWorkletNode extends FakeAudioNode {}
  class FakeSourceNode extends FakeAudioNode {
    mediaElement: unknown;
    constructor(context: FakeBaseContext, options: { mediaElement: unknown }) {
      super(context);
      this.mediaElement = options.mediaElement;
    }
  }
  class FakeBaseContext {
    state = "running";
    sampleRate = 48_000;
    destination: FakeDestination;
    constructor() {
      this.destination = new FakeDestination(this);
    }
    createGain() {
      return new FakeGain(this);
    }
    createNode() {
      return new FakeAudioNode(this);
    }
  }
  class FakeAudioContext extends FakeBaseContext {
    createMediaElementSource(mediaElement: unknown) {
      return new FakeSourceNode(this, { mediaElement });
    }
  }
  class FakeOfflineContext extends FakeBaseContext {}

  class FakeEvent {
    constructor(public type: string) {}
  }
  class FakeMessageEvent {
    declare readonly isTrusted: boolean;
    stopped = false;
    private readonly _source: unknown;
    private readonly _data: unknown;
    constructor(init: { source: unknown; data: unknown; isTrusted?: boolean }) {
      Object.defineProperty(this, "isTrusted", { value: init.isTrusted ?? true, enumerable: true });
      this._source = init.source;
      this._data = init.data;
    }
    get source() {
      return this._source;
    }
    get data() {
      return this._data;
    }
    stopImmediatePropagation() {
      this.stopped = true;
    }
  }
  return {
    FakeMediaElement,
    FakeAudioNode,
    FakeDestination,
    FakeGain,
    FakeWorkletNode,
    FakeSourceNode,
    FakeBaseContext,
    FakeAudioContext,
    FakeOfflineContext,
    FakeEvent,
    FakeMessageEvent,
  };
}

type Fakes = ReturnType<typeof createFakes>;
/** 页面眼里的媒体元素：volume / muted 走垫片装的访问器（假类型上没有声明这两个属性）。 */
type PageMedia = InstanceType<Fakes["FakeMediaElement"]> & { volume: number; muted: boolean };

/** 页面里的动画与媒体元素（垫片的冻结只用到这几个成员）。 */
function fakeAnimation(playState: string) {
  return {
    playState,
    pause() {
      this.playState = "paused";
    },
    play() {
      this.playState = "running";
    },
  };
}
function fakeMedia(paused: boolean) {
  return {
    paused,
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
  };
}

function createShimEnv(initialState: unknown = null, search = "") {
  const fakes = createFakes();
  const {
    FakeMediaElement,
    FakeAudioNode,
    FakeDestination,
    FakeBaseContext,
    FakeAudioContext,
    FakeOfflineContext,
    FakeSourceNode,
    FakeMessageEvent,
    FakeEvent,
  } = fakes;
  const listeners: Record<string, { fn: (event: unknown) => void; capture: boolean }[]> = {};
  const hostPosts: { data: unknown; origin: string }[] = [];
  const host = { postMessage: (data: unknown, origin: string) => hostPosts.push({ data, origin }) };
  const consoleSpy = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  // 原生 rAF：id 故意和垫片发的错开；取消同一帧里还没轮到的回调也生效（同规范）
  const frames = new Map<number, (time: number) => void>();
  let nativeFrame = 1000;
  const nativeRequest = (callback: (time: number) => void) => {
    frames.set(++nativeFrame, callback);
    return nativeFrame;
  };
  const nativeCancel = (id: number) => void frames.delete(id);
  function runFrame(time = 0) {
    for (const id of [...frames.keys()]) {
      const callback = frames.get(id);
      if (!callback) continue;
      frames.delete(id);
      callback(time);
    }
  }
  const animations: ReturnType<typeof fakeAnimation>[] = [];
  const mediaElements: ReturnType<typeof fakeMedia>[] = [];
  const sandbox: Record<string, unknown> = {
    top: host,
    parent: host,
    location: { protocol: "file:", search },
    requestAnimationFrame: nativeRequest,
    cancelAnimationFrame: nativeCancel,
    document: { getAnimations: () => animations, querySelectorAll: () => mediaElements },
    URLSearchParams,
    __TAURI_INTERNALS__: {
      invoke: vi.fn((command: string) => Promise.resolve(command === "wpe_web_pull_state" ? initialState : null)),
      transformCallback: () => 1,
      metadata: { currentWebview: { label: "wallpaper" } },
    },
    addEventListener(type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }) {
      (listeners[type] ??= []).push({ fn, capture: options === true || !!(options && options.capture) });
    },
    HTMLMediaElement: FakeMediaElement,
    AudioNode: FakeAudioNode,
    AudioDestinationNode: FakeDestination,
    BaseAudioContext: FakeBaseContext,
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineContext,
    MediaElementAudioSourceNode: FakeSourceNode,
    MessageEvent: FakeMessageEvent,
    Event: FakeEvent,
    DOMException,
    setTimeout,
    queueMicrotask,
    console: consoleSpy,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);
  // 页面自己登记的 message 监听（晚于垫片、冒泡阶段）
  const pageMessages: unknown[] = [];
  (sandbox.addEventListener as (type: string, fn: (event: unknown) => void) => void)("message", (event) =>
    pageMessages.push(event),
  );

  function dispatch(type: string, event: { stopped?: boolean }) {
    const list = [...(listeners[type] ?? [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const listener of list) {
      listener.fn(event);
      if (event.stopped) break;
    }
  }
  function sendFromHost(data: unknown, init: { source?: unknown; isTrusted?: boolean } = {}) {
    const event = new FakeMessageEvent({
      source: "source" in init ? init.source : host,
      data,
      isTrusted: init.isTrusted,
    });
    dispatch("message", event);
    return event;
  }
  const page = sandbox as unknown as {
    requestAnimationFrame(callback: (time: number) => void): number;
    cancelAnimationFrame(id: number): void;
  };
  return {
    ...fakes,
    sandbox,
    host,
    hostPosts,
    consoleSpy,
    pageMessages,
    dispatch,
    sendFromHost,
    frames,
    runFrame,
    nativeRequest,
    animations,
    mediaElements,
    page,
  };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("wpe_shim 音量接管", () => {
  it("暂停消息在首次全量属性交付后补调，此后只在变化时调用", async () => {
    const env = createShimEnv({ imageId: "scene", user: {}, general: {}, directories: {} });
    const setPaused = vi.fn();
    const applyUserProperties = vi.fn();
    env.sandbox.wallpaperPropertyListener = { setPaused, applyUserProperties };
    env.sendFromHost(wpeVolumeMessage(0, true));
    expect(setPaused).not.toHaveBeenCalled();
    env.dispatch("load", {});
    await tick();
    expect(applyUserProperties).toHaveBeenCalledOnce();
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(setPaused).toHaveBeenCalledWith(true);
    env.sendFromHost(wpeVolumeMessage(0, true));
    expect(setPaused).toHaveBeenCalledTimes(1);
    env.sendFromHost({ type: WPE_VOLUME_MESSAGE, volume: 1 });
    expect(setPaused).toHaveBeenLastCalledWith(false);
  });
  it("启动即向父页面请求音量，安装过程不报错", () => {
    const env = createShimEnv();
    expect(env.hostPosts.map((post) => [plain(post.data), post.origin])).toEqual([[{ type: WPE_VOLUME_REQUEST }, "*"]]);
    expect(isWpeVolumeRequest(env.hostPosts[0].data)).toBe(true);
    expect(env.consoleSpy.warn).not.toHaveBeenCalled();
  });

  it("媒体元素：回复前静音，回复后生效值 = 页面值 × 宿主音量，页面读到自己设的值", () => {
    const env = createShimEnv();
    const el = new env.FakeMediaElement() as PageMedia;
    expect(el.volume).toBe(1);
    expect(el.muted).toBe(false);
    expect([el.nativeVolume, el.nativeMuted]).toEqual([0, true]);

    env.sendFromHost(wpeVolumeMessage(0.5, false));
    expect([el.nativeVolume, el.nativeMuted]).toEqual([0.5, false]);

    el.volume = 0.4;
    expect(el.volume).toBe(0.4);
    expect(el.nativeVolume).toBeCloseTo(0.2);

    el.muted = true;
    expect(el.muted).toBe(true);
    expect(el.nativeMuted).toBe(true);
    el.muted = false;
    expect(el.nativeMuted).toBe(false);

    // 宿主推 0（应用背景 / 暂停）：原生静音，页面值不变
    env.sendFromHost(wpeVolumeMessage(0, false));
    expect([el.nativeVolume, el.nativeMuted]).toEqual([0, true]);
    expect([el.volume, el.muted]).toEqual([0.4, false]);
  });

  it("页面先在原生上设好的值（HTML muted 属性等）第一次接管时当作页面值保留", () => {
    const env = createShimEnv();
    env.sendFromHost(wpeVolumeMessage(0.8, false));
    const el = new env.FakeMediaElement() as PageMedia;
    el.nativeVolume = 0.5;
    el.nativeMuted = true;
    expect(el.muted).toBe(true);
    expect(el.volume).toBe(0.5);
    expect(el.nativeVolume).toBeCloseTo(0.4);
    expect(el.nativeMuted).toBe(true);
  });

  it("play() 与捕获阶段的 loadstart 都会接管元素", () => {
    const env = createShimEnv();
    const played = new env.FakeMediaElement();
    void (played as PageMedia).play();
    expect(played.playCalls).toBe(1);
    expect([played.nativeVolume, played.nativeMuted]).toEqual([0, true]);

    const autoplay = new env.FakeMediaElement();
    env.dispatch("loadstart", { target: autoplay } as never);
    expect([autoplay.nativeVolume, autoplay.nativeMuted]).toEqual([0, true]);
  });

  it("volume 照原生校验；页面改值而原生没变时补一个 volumechange", async () => {
    const env = createShimEnv();
    const el = new env.FakeMediaElement() as PageMedia;
    expect(() => {
      el.volume = 2;
    }).toThrow(/outside the range/);
    expect(() => {
      el.volume = Number.NaN;
    }).toThrow(/non-finite/);
    // 宿主音量为 0：原生值不变
    el.volume = 0.3;
    expect(el.volume).toBe(0.3);
    expect(el.nativeVolume).toBe(0);
    await tick();
    expect(el.dispatched).toEqual(["volumechange"]);
  });

  it("伪造的消息一律不理，宿主消息不交给页面", () => {
    const env = createShimEnv();
    const el = new env.FakeMediaElement() as PageMedia;
    void el.volume;
    env.sendFromHost(wpeVolumeMessage(1, false), { isTrusted: false });
    env.sendFromHost(wpeVolumeMessage(1, false), { source: env.sandbox });
    env.sendFromHost({ type: "other", volume: 1 });
    env.sendFromHost({ type: WPE_VOLUME_MESSAGE, volume: "1" });
    expect(el.nativeVolume).toBe(0);
    expect(env.pageMessages).toHaveLength(4);

    const event = env.sendFromHost(wpeVolumeMessage(1, false));
    expect(el.nativeVolume).toBe(1);
    expect(event.stopped).toBe(true);
    expect(env.pageMessages).toHaveLength(4);
  });

  it("Web Audio：连到实时 destination 的改接到主增益，gain 跟宿主音量；离线 context 不接管", () => {
    const env = createShimEnv();
    const ctx = new env.FakeAudioContext();
    const source = ctx.createNode();
    expect(source.connect(ctx.destination)).toBe(ctx.destination);
    const gain = source.outputs[0].node as InstanceType<Fakes["FakeGain"]>;
    expect(gain).toBeInstanceOf(env.FakeGain);
    expect(gain.outputs.map((o) => o.node)).toEqual([ctx.destination]);
    expect(gain.gain.value).toBe(0);

    env.sendFromHost(wpeVolumeMessage(0.7, false));
    expect(gain.gain.value).toBe(0.7);

    // AudioWorklet 等节点同走 AudioNode.prototype.connect，共用同一个主增益
    const worklet = new env.FakeWorkletNode(ctx);
    worklet.connect(ctx.destination, 0);
    expect(worklet.outputs).toEqual([{ node: gain, output: 0 }]);

    // 指定别的 input：照原生报错
    expect(() => source.connect(ctx.destination, 0, 1)).toThrow(/out of range/);

    source.disconnect(ctx.destination);
    expect(source.outputs).toEqual([]);
    expect(() => source.disconnect(ctx.destination)).toThrow(/not connected/);

    const offline = new env.FakeOfflineContext();
    const offlineNode = offline.createNode();
    offlineNode.connect(offline.destination);
    expect(offlineNode.outputs[0].node).toBe(offline.destination);

    // 从没连过 destination 的 context：disconnect 照原生报错
    const other = new env.FakeAudioContext();
    expect(() => other.createNode().disconnect(other.destination)).toThrow(/not connected/);
  });

  it("接进实时 context 的媒体元素不再乘宿主音量（由主增益乘一次）", () => {
    const env = createShimEnv();
    env.sendFromHost(wpeVolumeMessage(0.5, false));
    const ctx = new env.FakeAudioContext();

    const viaFactory = new env.FakeMediaElement() as PageMedia;
    viaFactory.volume = 0.6;
    expect(viaFactory.nativeVolume).toBeCloseTo(0.3);
    ctx.createMediaElementSource(viaFactory);
    expect(viaFactory.nativeVolume).toBe(0.6);

    const viaConstructor = new env.FakeMediaElement() as PageMedia;
    void viaConstructor.volume;
    const Source = env.sandbox.MediaElementAudioSourceNode as Fakes["FakeSourceNode"];
    expect(Source).not.toBe(env.FakeSourceNode);
    const node = new Source(ctx, { mediaElement: viaConstructor });
    expect(node).toBeInstanceOf(env.FakeSourceNode);
    expect(viaConstructor.nativeVolume).toBe(1);

    env.sendFromHost(wpeVolumeMessage(0, false));
    expect([viaFactory.nativeVolume, viaFactory.nativeMuted]).toEqual([0.6, false]);
  });
});

describe("wpe_shim 暂停冻结", () => {
  /** 页面已加载完：之后的暂停立即冻结。 */
  function loaded(search = "") {
    const env = createShimEnv(null, search);
    env.dispatch("load", {});
    return env;
  }
  const pause = (env: ReturnType<typeof createShimEnv>) => env.sendFromHost(wpeVolumeMessage(0, true));
  const resume = (env: ReturnType<typeof createShimEnv>) => env.sendFromHost(wpeVolumeMessage(1, false));

  it("暂停期间 rAF 不回调，恢复后回调；暂停之前排的也一样", () => {
    const env = loaded();
    const before = vi.fn();
    const during = vi.fn();
    env.page.requestAnimationFrame(before);
    pause(env);
    env.page.requestAnimationFrame(during);
    expect(env.frames.size).toBe(0);
    env.runFrame();
    expect(before).not.toHaveBeenCalled();
    expect(during).not.toHaveBeenCalled();

    resume(env);
    expect(before).not.toHaveBeenCalled();
    env.runFrame(16);
    expect(before).toHaveBeenCalledExactlyOnceWith(16);
    expect(during).toHaveBeenCalledExactlyOnceWith(16);
    env.runFrame(32);
    expect(before).toHaveBeenCalledOnce();
  });

  it("页面的动画循环暂停时停住，恢复后接着转", () => {
    const env = loaded();
    let frames = 0;
    const loop = () => {
      frames++;
      env.page.requestAnimationFrame(loop);
    };
    env.page.requestAnimationFrame(loop);
    env.runFrame();
    env.runFrame();
    expect(frames).toBe(2);
    pause(env);
    env.runFrame();
    env.runFrame();
    expect(frames).toBe(2);
    resume(env);
    env.runFrame();
    env.runFrame();
    expect(frames).toBe(4);
  });

  it("暂停时取消 rAF 有效，不管是暂停之前还是暂停期间排的", () => {
    const env = loaded();
    const before = vi.fn();
    const during = vi.fn();
    const beforeId = env.page.requestAnimationFrame(before);
    pause(env);
    const duringId = env.page.requestAnimationFrame(during);
    env.page.cancelAnimationFrame(beforeId);
    env.page.cancelAnimationFrame(duringId);
    resume(env);
    env.runFrame();
    expect(before).not.toHaveBeenCalled();
    expect(during).not.toHaveBeenCalled();
    expect(env.consoleSpy.warn).not.toHaveBeenCalled();
  });

  it("不暂停时取消照常生效；取消没排过的 id 什么都不做", () => {
    const env = loaded();
    const callback = vi.fn();
    const other = vi.fn();
    const id = env.page.requestAnimationFrame(callback);
    env.page.requestAnimationFrame(other);
    env.page.cancelAnimationFrame(id);
    env.page.cancelAnimationFrame(999_999);
    env.runFrame();
    expect(callback).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledOnce();
  });

  it("恢复只恢复暂停前在播的媒体与动画", () => {
    const env = loaded();
    const running = fakeAnimation("running");
    const finished = fakeAnimation("finished");
    const pausedByPage = fakeAnimation("paused");
    const playing = fakeMedia(false);
    const idle = fakeMedia(true);
    env.animations.push(running, finished, pausedByPage);
    env.mediaElements.push(playing, idle);
    pause(env);
    expect(running.playState).toBe("paused");
    expect(playing.paused).toBe(true);
    resume(env);
    expect(running.playState).toBe("running");
    expect(playing.paused).toBe(false);
    expect(finished.playState).toBe("finished");
    expect(pausedByPage.playState).toBe("paused");
    expect(idle.paused).toBe(true);
  });

  it("暂停期间页面自己取消的动画、自己放起来的媒体，恢复时不动", () => {
    const env = loaded();
    const animation = fakeAnimation("running");
    const media = fakeMedia(false);
    const play = vi.spyOn(media, "play");
    env.animations.push(animation);
    env.mediaElements.push(media);
    pause(env);
    animation.playState = "idle";
    media.paused = false;
    resume(env);
    expect(animation.playState).toBe("idle");
    expect(play).not.toHaveBeenCalled();
  });

  it("暂停与恢复时照旧调页面的 setPaused", async () => {
    const env = createShimEnv({ imageId: "web", user: {}, general: {}, directories: {} });
    const setPaused = vi.fn();
    env.sandbox.wallpaperPropertyListener = { setPaused, applyUserProperties: vi.fn() };
    env.dispatch("load", {});
    await tick();
    pause(env);
    resume(env);
    expect(setPaused.mock.calls).toEqual([[true], [false]]);
  });

  it("带 kbScene（场景宿主）时不冻结", () => {
    const env = loaded("?kbScene=7&kbInstance=1");
    expect(env.page.requestAnimationFrame).toBe(env.nativeRequest);
    const callback = vi.fn();
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    pause(env);
    env.page.requestAnimationFrame(callback);
    env.runFrame();
    expect(callback).toHaveBeenCalledOnce();
    expect(media.paused).toBe(false);
  });

  it("load 之前收到暂停：页面先画出第一帧，load 后再过一帧才冻结", () => {
    const env = createShimEnv();
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    pause(env);
    const beforeLoad = vi.fn();
    env.page.requestAnimationFrame(beforeLoad);
    env.runFrame();
    expect(beforeLoad).toHaveBeenCalledOnce();
    expect(media.paused).toBe(false);

    env.dispatch("load", {});
    // 页面在 load 回调里排的第一帧照常画
    let frames = 0;
    const loop = () => {
      frames++;
      env.page.requestAnimationFrame(loop);
    };
    env.page.requestAnimationFrame(loop);
    env.runFrame();
    expect(frames).toBe(1);
    env.runFrame();
    expect(media.paused).toBe(true);
    const frozenAt = frames;
    env.runFrame();
    expect(frames).toBe(frozenAt);

    resume(env);
    expect(media.paused).toBe(false);
    env.runFrame();
    expect(frames).toBe(frozenAt + 1);
  });

  it("load 之后等冻结的那一帧里已经恢复：不冻结", () => {
    const env = createShimEnv();
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    pause(env);
    env.dispatch("load", {});
    resume(env);
    env.runFrame();
    env.runFrame();
    expect(media.paused).toBe(false);
  });
});

describe("wpe_shim 右键转发", () => {
  it("垫片的字面量与 wpeContextMenu.ts 一致", () => {
    expect(SHIM_SOURCE).toContain(`CONTEXT_MENU = "${WPE_CONTEXT_MENU}"`);
  });

  it("可信的右键发给父页面（坐标是本视口），页面停止冒泡也照发；合成事件不发", () => {
    const env = createShimEnv(null);
    // 页面自己的监听：冒泡阶段取消并停止传播（垫片在捕获阶段，先于它）
    (env.sandbox.addEventListener as (type: string, fn: (event: { stopped?: boolean }) => void) => void)(
      "contextmenu",
      (event) => {
        event.stopped = true;
      },
    );
    const posts = () => env.hostPosts.filter((post) => (post.data as { type?: unknown }).type === WPE_CONTEXT_MENU);
    env.dispatch("contextmenu", { isTrusted: true, clientX: 120, clientY: 45 } as never);
    expect(plain(posts())).toEqual([{ data: { type: WPE_CONTEXT_MENU, x: 120, y: 45 }, origin: "*" }]);
    env.dispatch("contextmenu", { isTrusted: false, clientX: 1, clientY: 1 } as never);
    expect(posts()).toHaveLength(1);
  });
});
