/**
 * 单测用的 `<video>` 替身（P9a 步骤 1）：时间、时长、`ended`、`readyState` 手动设，事件与帧回调手动触发，记下 play / pause / load。
 * 只给 `src/video/*.test.ts` 用，产品代码不引用。
 */
export class FakeVideo {
  muted = false;
  playsInline = false;
  loop = false;
  preload = "";
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  readyState = 0;
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  videoWidth = 0;
  videoHeight = 0;
  error: { code: number; message: string } | null = null;
  quality: { totalVideoFrames: number; droppedVideoFrames: number } | null = null;
  /** 按顺序记下 play / pause / load。 */
  calls: string[] = [];
  /** play() 的结果，缺省成功。 */
  playResult: () => Promise<void> = () => Promise.resolve();
  cancelled: number[] = [];
  private nextHandle = 1;
  private readonly frameCallbacks = new Map<number, () => void>();
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(frameCallbacks = true) {
    if (!frameCallbacks) {
      // 没有这个方法的环境：实例上遮掉原型方法
      Object.defineProperty(this, "requestVideoFrameCallback", { value: undefined });
    }
  }

  set src(value: string) {
    this.attributes.set("src", value);
  }
  get src() {
    return this.attributes.get("src") ?? "";
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)!).push(fn);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play() {
    this.calls.push("play");
    this.paused = false;
    return this.playResult();
  }
  pause() {
    this.calls.push("pause");
    this.paused = true;
  }
  load() {
    this.calls.push("load");
  }
  requestVideoFrameCallback(callback: () => void) {
    const handle = this.nextHandle++;
    this.frameCallbacks.set(handle, callback);
    return handle;
  }
  cancelVideoFrameCallback(handle: number) {
    this.frameCallbacks.delete(handle);
    this.cancelled.push(handle);
  }
  /** 合成器拿到一帧：调当前登记的全部帧回调（回调里会重新登记）。 */
  present() {
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const callback of callbacks) callback();
  }
  get pendingFrameCallbacks() {
    return this.frameCallbacks.size;
  }
  getVideoPlaybackQuality() {
    if (!this.quality) throw new Error("没有");
    return this.quality;
  }
  /** 第一帧到了。 */
  loadData(duration = 2.517) {
    this.duration = duration;
    this.readyState = 2;
    this.fire("loadeddata");
  }
  /** 元素报错。 */
  fail(code = 4, message = "DEMUXER_ERROR_COULD_NOT_OPEN") {
    this.error = { code, message };
    this.fire("error");
  }
  /** play / pause 调用次数。 */
  count(kind: "play" | "pause" | "load") {
    return this.calls.filter((call) => call === kind).length;
  }
}

/** 一组注入的工厂：记下建的元素、读取、建与撤销的对象地址。 */
export function videoEnv(options: { frameCallbacks?: boolean; read?: (path: string) => Promise<Blob> } = {}) {
  const elements: FakeVideo[] = [];
  const reads: string[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const warnings: [string, unknown][] = [];
  let urls = 0;
  const factories = {
    createElement: () => {
      const element = new FakeVideo(options.frameCallbacks ?? true);
      elements.push(element);
      return element as unknown as HTMLVideoElement;
    },
    readBlob: (source: { path: string; start: number; end: number }) => {
      reads.push(`${source.path} ${source.start} ${source.end}`);
      return options.read
        ? options.read(source.path)
        : Promise.resolve(new Blob([new Uint8Array(source.end - source.start)]));
    },
    createObjectUrl: () => {
      const url = `blob:${++urls}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl: (url: string) => {
      revoked.push(url);
    },
  };
  const report = { warn: (message: string, detail?: unknown) => void warnings.push([message, detail]) };
  return { factories, report, elements, reads, created, revoked, warnings };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
