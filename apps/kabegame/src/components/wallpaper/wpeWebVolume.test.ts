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
import { WPE_STATE_MESSAGE, fullStateMessage, readyStateMessage, stateDelta, type WpeWebState } from "./wpeWebState";

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
    expect(wpeVolumeMessage(0.3, true)).toEqual({
      type: WPE_VOLUME_MESSAGE,
      volume: 0.3,
      paused: true,
      interactive: false,
    });
    expect(wpeVolumeMessage(1, false, true).interactive).toBe(true);
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
    suspendCalls = 0;
    resumeCalls = 0;
    createMediaElementSource(mediaElement: unknown) {
      return new FakeSourceNode(this, { mediaElement });
    }
    suspend() {
      this.suspendCalls += 1;
      this.state = "suspended";
      return Promise.resolve();
    }
    resume() {
      this.resumeCalls += 1;
      this.state = "running";
      return Promise.resolve();
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

/** 手动推进的计时器（id 是数字，同浏览器）：`advance` 按到点先后逐个触发，interval 到点后排下一次。 */
function createClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const add = (fn: () => void, delay: unknown, repeat: boolean) => {
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(++nextId, { at: now + ms, every: repeat ? Math.max(1, ms) : null, fn });
    return nextId;
  };
  return {
    setTimeout: (fn: () => void, delay?: unknown) => add(fn, delay, false),
    setInterval: (fn: () => void, delay?: unknown) => add(fn, delay, true),
    clearTimeout: (id: number) => void timers.delete(id),
    clearInterval: (id: number) => void timers.delete(id),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; every: number | null; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.fn();
      }
      now = end;
    },
  };
}
type Clock = ReturnType<typeof createClock>;

function createShimEnv(search = "", clock?: Clock) {
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
      // 属性由父页面推送，垫片不再拉；这里只剩 ping、鼠标登记、媒体订阅
      invoke: vi.fn(() => Promise.resolve(null)),
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
    // 垫片在页面脚本之前包装 History 的 pushState / replaceState（installHistory），这里给一个最小的原型
    History: class {
      pushState() {}
      replaceState() {}
    },
    DOMException,
    setTimeout: clock?.setTimeout ?? setTimeout,
    clearTimeout: clock?.clearTimeout ?? clearTimeout,
    setInterval: clock?.setInterval ?? setInterval,
    clearInterval: clock?.clearInterval ?? clearInterval,
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
    setTimeout(handler: unknown, delay?: number, ...args: unknown[]): number;
    clearTimeout(id: number): void;
    setInterval(handler: unknown, delay?: number, ...args: unknown[]): number;
    clearInterval(id: number): void;
    AudioContext: new () => InstanceType<Fakes["FakeAudioContext"]>;
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
const EMPTY_STATE: WpeWebState = { imageId: "1", user: {}, general: { language: "en-us", fps: 30 }, directories: {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("wpe_shim 音量接管", () => {
  it("暂停消息在首次全量属性交付后补调，此后只在变化时调用", () => {
    const env = createShimEnv();
    const setPaused = vi.fn();
    const applyUserProperties = vi.fn();
    env.sandbox.wallpaperPropertyListener = { setPaused, applyUserProperties };
    env.sendFromHost(wpeVolumeMessage(0, true));
    expect(setPaused).not.toHaveBeenCalled();
    env.sendFromHost(fullStateMessage(EMPTY_STATE));
    expect(applyUserProperties).toHaveBeenCalledOnce();
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(setPaused).toHaveBeenCalledWith(true);
    env.sendFromHost(wpeVolumeMessage(0, true));
    expect(setPaused).toHaveBeenCalledTimes(1);
    env.sendFromHost({ type: WPE_VOLUME_MESSAGE, volume: 1 });
    expect(setPaused).toHaveBeenLastCalledWith(false);
  });
  it("宿主音量放进只读的 __kabegameHostVolume，每条宿主消息派发一次 kabegame-host-volume（场景声音用）", () => {
    const env = createShimEnv();
    const events: string[] = [];
    env.sandbox.dispatchEvent = (event: { type: string }) => {
      events.push(event.type);
      return true;
    };
    env.sandbox.CustomEvent = class {
      constructor(readonly type: string) {}
    };
    // 收到父页面回复之前按静音
    expect(env.sandbox.__kabegameHostVolume).toBe(0);
    env.sendFromHost(wpeVolumeMessage(0.4, false));
    expect(env.sandbox.__kabegameHostVolume).toBe(0.4);
    expect(events).toEqual(["kabegame-host-volume"]);
    env.sendFromHost({ type: WPE_VOLUME_MESSAGE, volume: 3 });
    expect(env.sandbox.__kabegameHostVolume).toBe(1);
    // 只读、不可重定义；伪造的消息不改值、不派发
    const descriptor = Object.getOwnPropertyDescriptor(env.sandbox, "__kabegameHostVolume");
    expect(descriptor?.set).toBeUndefined();
    expect(descriptor?.configurable).toBe(false);
    env.sendFromHost(wpeVolumeMessage(0.2, false), { isTrusted: false });
    expect(env.sandbox.__kabegameHostVolume).toBe(1);
    expect(events).toHaveLength(2);
    expect(env.consoleSpy.warn).not.toHaveBeenCalled();
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
  function loaded(search = "", clock?: Clock) {
    const env = createShimEnv(search, clock);
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

  it("暂停与恢复时照旧调页面的 setPaused", () => {
    const env = createShimEnv();
    const setPaused = vi.fn();
    env.sandbox.wallpaperPropertyListener = { setPaused, applyUserProperties: vi.fn() };
    env.sendFromHost(fullStateMessage(EMPTY_STATE));
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

  it("暂停期间 interval 到点就跳过，恢复后接着走（Unity 停了 rAF 后靠它每秒出一帧）", () => {
    const clock = createClock();
    const env = loaded("", clock);
    const tickFn = vi.fn();
    env.page.setInterval(tickFn, 1000);
    clock.advance(1000);
    expect(tickFn).toHaveBeenCalledTimes(1);
    pause(env);
    clock.advance(5000);
    expect(tickFn).toHaveBeenCalledTimes(1);
    resume(env);
    clock.advance(1000);
    expect(tickFn).toHaveBeenCalledTimes(2);
  });

  it("冻结期间排的 timeout 压住，恢复后按到点先后补跑；暂停前排的照常到点；参数、this 与字符串照原生", () => {
    const clock = createClock();
    const env = loaded("", clock);
    const order: string[] = [];
    const before = vi.fn(() => order.push("before"));
    env.page.setTimeout(before, 300);
    pause(env);
    const late = vi.fn(function (this: unknown, ...args: unknown[]) {
      order.push("late");
      return [this, args];
    });
    env.page.setTimeout(late, 100, 1, 2);
    env.page.setTimeout(() => order.push("early"), 50);
    env.page.setTimeout("window.evaluated = (window.evaluated || 0) + 1", 10);
    clock.advance(1000);
    // 暂停前排的照 WPE 到点；冻结期间排的都压着
    expect(order).toEqual(["before"]);
    expect(env.sandbox.evaluated).toBeUndefined();

    resume(env);
    expect(order).toEqual(["before"]);
    clock.advance(0);
    expect(order).toEqual(["before", "early", "late"]);
    expect(env.sandbox.evaluated).toBe(1);
    // vm 里页面看到的 window 是上下文化后的全局对象，不是外面的 sandbox
    expect(late.mock.contexts[0]).toBe(vm.runInContext("window", env.sandbox));
    expect(late.mock.calls[0]).toEqual([1, 2]);
    clock.advance(1000);
    expect(late).toHaveBeenCalledOnce();
  });

  it("压住的 timeout 用 clearTimeout / clearInterval 都能取消；补跑之前又暂停就留到下次恢复", () => {
    const clock = createClock();
    const env = loaded("", clock);
    pause(env);
    const cancelled = vi.fn();
    const kept = vi.fn();
    const id = env.page.setTimeout(cancelled, 10);
    env.page.setTimeout(kept, 10);
    clock.advance(20);
    env.page.clearInterval(id);
    resume(env);
    pause(env);
    clock.advance(10);
    expect(kept).not.toHaveBeenCalled();
    resume(env);
    clock.advance(0);
    expect(kept).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("暂停时 suspend 在跑的 AudioContext，恢复时只 resume 这些；暂停期间新建的也 suspend", () => {
    const env = loaded();
    const AudioContext = env.page.AudioContext;
    expect(AudioContext).not.toBe(env.FakeAudioContext);
    expect(AudioContext.prototype.constructor).toBe(AudioContext);
    expect(() => (AudioContext as unknown as () => unknown)()).toThrow(TypeError);
    // 页面自己的子类照样能建
    class PageContext extends AudioContext {}
    const running = new PageContext();
    expect(running).toBeInstanceOf(PageContext);
    expect(running).toBeInstanceOf(env.FakeAudioContext);
    const suspendedByPage = new AudioContext();
    suspendedByPage.state = "suspended";

    pause(env);
    expect(running.state).toBe("suspended");
    expect(suspendedByPage.suspendCalls).toBe(0);
    const createdWhilePaused = new AudioContext();
    expect(createdWhilePaused.state).toBe("suspended");

    resume(env);
    expect(running.state).toBe("running");
    expect(createdWhilePaused.state).toBe("running");
    expect(suspendedByPage.state).toBe("suspended");
    expect(suspendedByPage.resumeCalls).toBe(0);
    expect(env.consoleSpy.warn).not.toHaveBeenCalled();
  });

  it("照 WPE：页面的 setPaused(true) 在冻结之前、setPaused(false) 在解冻之后调", () => {
    const env = createShimEnv();
    const seen: [boolean, boolean][] = [];
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    env.sandbox.wallpaperPropertyListener = {
      setPaused: (paused: boolean) => seen.push([paused, media.paused]),
      applyUserProperties: vi.fn(),
    };
    env.sendFromHost(fullStateMessage(EMPTY_STATE));
    pause(env);
    resume(env);
    expect(seen).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  /** 页面的 rAF 动画循环。 */
  function rafLoop(env: ReturnType<typeof createShimEnv>) {
    const state = { frames: 0 };
    const loop = () => {
      state.frames++;
      env.page.requestAnimationFrame(loop);
    };
    env.page.requestAnimationFrame(loop);
    return state;
  }

  it("暂停中打开：画面组在 load 后两帧冻，脚本组从页面 load 后的第一帧起跑满 3 秒再冻", () => {
    const clock = createClock();
    const env = createShimEnv("", clock);
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    const ctx = new env.page.AudioContext();
    pause(env);
    const beforeLoad = vi.fn();
    env.page.requestAnimationFrame(beforeLoad);
    env.runFrame();
    expect(beforeLoad).toHaveBeenCalledOnce();
    expect(media.paused).toBe(false);
    const tickFn = vi.fn();
    env.page.setInterval(tickFn, 1000); // 到点在 1000、2000……；预热从 500 起，错开同一时刻
    clock.advance(500);

    env.dispatch("load", {});
    // 页面在 load 回调里排的第一帧照常画，从这一帧开始预热
    const loop = rafLoop(env);
    env.runFrame();
    expect(loop.frames).toBe(1);
    env.runFrame();
    expect(media.paused).toBe(true);
    // 预热期间脚本照跑
    clock.advance(2999);
    env.runFrame();
    expect(loop.frames).toBe(3);
    expect(tickFn).toHaveBeenCalledTimes(3);
    expect(ctx.state).toBe("running");

    clock.advance(1);
    const frozenAt = loop.frames;
    env.runFrame();
    clock.advance(5000);
    expect(loop.frames).toBe(frozenAt);
    expect(tickFn).toHaveBeenCalledTimes(3);
    expect(ctx.state).toBe("suspended");

    resume(env);
    expect(media.paused).toBe(false);
    env.runFrame();
    expect(loop.frames).toBe(frozenAt + 1);
    clock.advance(1000);
    expect(tickFn).toHaveBeenCalledTimes(4);
    expect(ctx.state).toBe("running");
  });

  it("暂停中打开、加载期间只用计时器的页面（Unity）：等它主循环的第一帧起预热 3 秒再冻", () => {
    const clock = createClock();
    const env = createShimEnv("", clock);
    pause(env);
    env.dispatch("load", {});
    const tickFn = vi.fn();
    env.page.setInterval(tickFn, 1000);
    env.runFrame();
    env.runFrame();
    clock.advance(10_500);
    expect(tickFn).toHaveBeenCalledTimes(10);
    // 主循环起来了：从它的第一帧起预热
    const loop = rafLoop(env);
    env.runFrame();
    clock.advance(2999);
    env.runFrame();
    expect(loop.frames).toBe(2);
    expect(tickFn).toHaveBeenCalledTimes(13);
    clock.advance(1);
    env.runFrame();
    clock.advance(5000);
    expect(loop.frames).toBe(2);
    expect(tickFn).toHaveBeenCalledTimes(13);
  });

  it("暂停中打开、从不用 rAF 的页面：这次暂停不冻脚本组，恢复后再暂停就冻", () => {
    const clock = createClock();
    const env = createShimEnv("", clock);
    pause(env);
    env.dispatch("load", {});
    const tickFn = vi.fn();
    env.page.setInterval(tickFn, 1000);
    env.runFrame();
    env.runFrame();
    clock.advance(10_500);
    expect(tickFn).toHaveBeenCalledTimes(10);
    resume(env);
    pause(env);
    clock.advance(5000);
    expect(tickFn).toHaveBeenCalledTimes(10);
  });

  it("预热期间恢复：不再按预热冻结，之后的暂停立刻冻", () => {
    const clock = createClock();
    const env = createShimEnv("", clock);
    const media = fakeMedia(false);
    env.mediaElements.push(media);
    pause(env);
    env.dispatch("load", {});
    const loop = rafLoop(env);
    env.runFrame();
    resume(env);
    clock.advance(3000);
    env.runFrame();
    env.runFrame();
    expect(loop.frames).toBe(3);
    expect(media.paused).toBe(false);

    pause(env);
    env.runFrame();
    expect(loop.frames).toBe(3);
    expect(media.paused).toBe(true);
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

describe("wpe_shim 原生鼠标登记", () => {
  const ATTACH = "plugin:cursor|attach_frame";
  const DETACH = "plugin:cursor|detach_frame";
  function cursorCalls(env: ReturnType<typeof createShimEnv>): string[] {
    const invoke = (env.sandbox.__TAURI_INTERNALS__ as { invoke: ReturnType<typeof vi.fn> }).invoke;
    return invoke.mock.calls.map((call) => call[0] as string).filter((command) => command.startsWith("plugin:cursor|"));
  }

  it("可交互且没暂停时登记，暂停或不交互时解除，只在变化时调", async () => {
    const env = createShimEnv();
    // 应用背景：不交互，不登记
    env.sendFromHost(wpeVolumeMessage(1, false, false));
    await tick();
    expect(cursorCalls(env)).toEqual([]);
    env.sendFromHost(wpeVolumeMessage(1, false, true));
    // 只是音量变了：不重复登记
    env.sendFromHost(wpeVolumeMessage(0.5, false, true));
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH]);
    // 暂停：解除；恢复：再登记
    env.sendFromHost(wpeVolumeMessage(0.5, true, true));
    env.sendFromHost(wpeVolumeMessage(0.5, false, true));
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH, DETACH, ATTACH]);
    // 伪造的消息不改登记；缺 interactive 按不交互
    env.sendFromHost(wpeVolumeMessage(1, false, false), { isTrusted: false });
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH, DETACH, ATTACH]);
    env.sendFromHost({ type: WPE_VOLUME_MESSAGE, volume: 1, paused: false });
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH, DETACH, ATTACH, DETACH]);
  });

  it("前一次调用返回之前不发下一次，失败只警告", async () => {
    const env = createShimEnv();
    const invoke = (env.sandbox.__TAURI_INTERNALS__ as { invoke: ReturnType<typeof vi.fn> }).invoke;
    let finishAttach: (value: unknown) => void = () => {};
    invoke.mockImplementation((command: string) =>
      command === ATTACH ? new Promise((resolve) => (finishAttach = resolve)) : Promise.reject(new Error("denied")),
    );
    env.sendFromHost(wpeVolumeMessage(1, false, true));
    env.sendFromHost(wpeVolumeMessage(1, true, true));
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH]);
    finishAttach(true);
    await tick();
    expect(cursorCalls(env)).toEqual([ATTACH, DETACH]);
    expect(env.consoleSpy.warn).toHaveBeenCalledWith("[kb-wpe] pointer", expect.any(Error));
  });
});

describe("wpe_shim 右键转发", () => {
  it("垫片的字面量与 wpeContextMenu.ts 一致", () => {
    expect(SHIM_SOURCE).toContain(`CONTEXT_MENU = "${WPE_CONTEXT_MENU}"`);
  });

  it("可信的右键发给父页面（坐标是本视口），页面停止冒泡也照发；合成事件不发", () => {
    const env = createShimEnv();
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

describe("wpe_shim 属性推送（父页面推、垫片只交给页面）", () => {
  const STATE: WpeWebState = {
    imageId: "1",
    user: { zeta: { type: "slider", value: 1 }, alpha: { type: "bool", value: true } },
    general: { language: "zh-chs", fps: 30 },
    directories: {
      pics: { mode: "fetchall", files: ["a.jpg", "b.jpg"] },
      lazy: { mode: "ondemand", files: ["x.jpg"] },
    },
  };
  function listenerOf(env: ReturnType<typeof createShimEnv>) {
    const calls: [string, unknown[]][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, plain(args)]);
    env.sandbox.wallpaperPropertyListener = {
      applyUserProperties: record("user"),
      applyGeneralProperties: record("general"),
      userDirectoryFilesAddedOrChanged: record("added"),
      userDirectoryFilesRemoved: record("removed"),
      setPaused: record("paused"),
    };
    return calls;
  }

  it("垫片的字面量与 wpeWebState.ts 一致", () => {
    expect(SHIM_SOURCE).toContain(`STATE_MESSAGE = "${WPE_STATE_MESSAGE}"`);
  });

  it("整份：用户属性与通用属性按键排序交给页面，fetchall 目录的文件全部当新增，ondemand 不派发", () => {
    const env = createShimEnv();
    const calls = listenerOf(env);
    const event = env.sendFromHost(fullStateMessage(STATE));
    expect(calls).toEqual([
      ["user", [{ alpha: { type: "bool", value: true }, zeta: { type: "slider", value: 1 } }]],
      ["general", [{ fps: 30, language: "zh-chs" }]],
      ["added", ["pics", ["a.jpg", "b.jpg"]]],
    ]);
    expect(Object.keys((calls[0][1] as Record<string, unknown>[])[0])).toEqual(["alpha", "zeta"]);
    // 宿主消息不交给页面
    expect(event.stopped).toBe(true);
    expect(env.pageMessages).toHaveLength(0);
  });

  it("增量：只交给页面变了的部分，目录按增删回调", () => {
    const env = createShimEnv();
    env.sendFromHost(fullStateMessage(STATE));
    const calls = listenerOf(env);
    const next: WpeWebState = {
      ...STATE,
      user: { ...STATE.user, zeta: { type: "slider", value: 2 } },
      directories: { ...STATE.directories, pics: { mode: "fetchall", files: ["b.jpg", "c.jpg"] } },
    };
    env.sendFromHost(stateDelta(STATE, next));
    expect(calls).toEqual([
      ["user", [{ zeta: { type: "slider", value: 2 } }]],
      ["removed", ["pics", ["a.jpg"]]],
      ["added", ["pics", ["c.jpg"]]],
    ]);
  });

  it("就绪（页面自己 reload 出来的文档）：不调任何属性回调，暂停中补一次 setPaused(true)", () => {
    const env = createShimEnv();
    const calls = listenerOf(env);
    env.sendFromHost(wpeVolumeMessage(0, true));
    expect(calls).toEqual([]);
    env.sendFromHost(readyStateMessage(STATE.directories));
    expect(calls).toEqual([["paused", [true]]]);
    // 之后的暂停变化照调
    env.sendFromHost(wpeVolumeMessage(1, false));
    expect(calls.at(-1)).toEqual(["paused", [false]]);
  });

  it("只认父窗口的可信消息：别的来源、不可信的一律不理", () => {
    const env = createShimEnv();
    const calls = listenerOf(env);
    env.sendFromHost(fullStateMessage(STATE), { source: {} });
    env.sendFromHost(fullStateMessage(STATE), { isTrusted: false });
    expect(calls).toEqual([]);
  });

  it("换 listener：收过整份之后补投（含之后的增量）；只收到就绪的文档不补投", async () => {
    const env = createShimEnv();
    env.sendFromHost(fullStateMessage(STATE));
    const next: WpeWebState = { ...STATE, user: { ...STATE.user, alpha: { type: "bool", value: false } } };
    env.sendFromHost(stateDelta(STATE, next));
    const calls = listenerOf(env);
    await tick();
    expect(calls[0]).toEqual(["user", [{ alpha: { type: "bool", value: false }, zeta: { type: "slider", value: 1 } }]]);

    const reloaded = createShimEnv();
    reloaded.sendFromHost(readyStateMessage({}));
    const none = listenerOf(reloaded);
    await tick();
    expect(none).toEqual([]);
  });

  it("随机文件：第一条属性消息之前排队，之后按最新目录回答", async () => {
    const env = createShimEnv();
    const answers: unknown[] = [];
    (env.sandbox.wallpaperRequestRandomFileForProperty as (key: string, cb: (...args: unknown[]) => void) => void)(
      "lazy",
      (...args) => answers.push(args),
    );
    await tick();
    expect(answers).toEqual([]);
    env.sendFromHost(readyStateMessage(STATE.directories));
    await tick();
    expect(answers).toEqual([["lazy", "x.jpg"]]);
  });

  it("不再自己拉状态，也不再监听设置与图片事件（只剩 ping）", async () => {
    const env = createShimEnv();
    await tick();
    const invoke = (env.sandbox.__TAURI_INTERNALS__ as { invoke: ReturnType<typeof vi.fn> }).invoke;
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain("wpe_web_pull_state");
    const events = invoke.mock.calls
      .filter((call) => call[0] === "plugin:event|listen")
      .map((call) => (call[1] as { event: string }).event);
    expect(events).toEqual(["wallpaper-ping"]);
    expect(SHIM_SOURCE).not.toContain("wpe_web_pull_state");
  });
});
