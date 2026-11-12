/**
 * dev 探针的视频时刻（P9a 步骤 3，`videoProbe.ts`）：
 * - 纯函数：`videoTime` 的校验、按纹理路径取时刻、循环取模与钳到 `[0, duration − SEEK_END_MARGIN]`；
 * - `ProbeVideos`：替身元素（设 src 后按脚本出第一帧、设 `currentTime` 后按脚本完成 seek）核对读法、seek 的目标、每个 draw 都交出元素、
 *   读 / 解码失败保持透明并标出、总时限超时报错、释放。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEEK_END_MARGIN, type SceneVideoSource } from "../video/player";
import {
  checkVideoTime,
  ProbeVideos,
  ProbeVideoTimeout,
  requestedVideoTime,
  videoSeekTime,
  type VideoTimeOption,
} from "./videoProbe";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

afterEach(() => {
  vi.useRealTimers();
});

describe("videoSeekTime：超过时长按循环取模，再钳到 [0, duration − 0.005]", () => {
  it("时长之内原样；等于、超过时长时取模（WPE 视频纹理缺省循环）", () => {
    expect(videoSeekTime(0, 2.5)).toBe(0);
    expect(videoSeekTime(1.25, 2.5)).toBe(1.25);
    expect(videoSeekTime(2.5, 2.5)).toBe(0);
    expect(videoSeekTime(5.5, 2)).toBe(1.5);
    expect(videoSeekTime(6, 2)).toBe(0);
    expect(videoSeekTime(7.25, 2.5)).toBeCloseTo(2.25, 12);
  });

  it("落在最后 0.005 s 里（取模前后都算）钳到 duration − 0.005，同产品播放器写 currentTime", () => {
    expect(SEEK_END_MARGIN).toBe(0.005);
    expect(videoSeekTime(2.499, 2.5)).toBeCloseTo(2.495, 12);
    expect(videoSeekTime(2.495, 2.5)).toBeCloseTo(2.495, 12);
    expect(videoSeekTime(2.494, 2.5)).toBe(2.494);
    expect(videoSeekTime(2 * 2.5 - 0.001, 2.5)).toBeCloseTo(2.495, 12);
    // 比余量还短的视频：上界取 0
    expect(videoSeekTime(0.003, 0.004)).toBe(0);
  });

  it("时长未知（NaN、Infinity、0）只钳下界；负数钳到 0", () => {
    expect(videoSeekTime(3, Number.NaN)).toBe(3);
    expect(videoSeekTime(3, Number.POSITIVE_INFINITY)).toBe(3);
    expect(videoSeekTime(3, 0)).toBe(3);
    expect(videoSeekTime(-1, 2.5)).toBe(0);
  });
});

describe("requestedVideoTime / checkVideoTime", () => {
  it("缺省 0；数字对全部生效；对象按 path 取，没给的 0（不认原型上的键）", () => {
    expect(requestedVideoTime(undefined, "materials/v.tex")).toBe(0);
    expect(requestedVideoTime(1.5, "materials/v.tex")).toBe(1.5);
    const byPath = { "materials/a.tex": 2, "materials/b.tex": 0 };
    expect(requestedVideoTime(byPath, "materials/a.tex")).toBe(2);
    expect(requestedVideoTime(byPath, "materials/b.tex")).toBe(0);
    expect(requestedVideoTime(byPath, "materials/c.tex")).toBe(0);
    expect(requestedVideoTime(byPath, "toString")).toBe(0);
  });

  it("非负有限数，或「字符串 → 非负有限数」的对象；其余抛 RangeError", () => {
    expect(checkVideoTime(undefined)).toBeUndefined();
    expect(checkVideoTime(0)).toBe(0);
    expect(checkVideoTime(12.5)).toBe(12.5);
    expect(checkVideoTime({ "materials/a.tex": 3 })).toEqual({ "materials/a.tex": 3 });
    expect(checkVideoTime({})).toEqual({});
    for (const bad of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
      [1],
      null,
      true,
      { a: -1 },
      { a: "1" },
      { a: null },
    ])
      expect(() => checkVideoTime(bad), JSON.stringify(bad)).toThrow(RangeError);
  });
});

// ———— ProbeVideos ————

type Behavior = "event" | "silent" | "never" | "error";

interface VideoBehavior {
  load: Behavior;
  seek: Behavior;
  duration: number;
  size: [number, number];
}

/**
 * 替身 `<video>`：设 src 时按地址找到它是哪段视频（`behaviorOf`），再按 `load` 出第一帧（`loadeddata`）、报错或不动；设 `currentTime` 时
 * `seeking` 同步变真，再按 `seek` 完成（`event` 发 `seeked`、`silent` 不发事件只放下 `seeking`）。事件在微任务里发，模拟异步。
 */
class SeekVideo {
  muted = false;
  playsInline = false;
  preload = "";
  readyState = 0;
  seeking = false;
  duration = Number.NaN;
  videoWidth = 0;
  videoHeight = 0;
  error: { code: number; message: string } | null = null;
  /** 这个元素放的是哪张纹理、挂的对象地址（设 src 时才知道；清 src 之后仍留着）。 */
  path: string | null = null;
  url: string | null = null;
  calls: string[] = [];
  seeks: number[] = [];
  private behavior: VideoBehavior | null = null;
  private time = 0;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly behaviorOf: (url: string) => { path: string; behavior: VideoBehavior }) {}

  set src(value: string) {
    this.attributes.set("src", value);
    this.url = value;
    const { path, behavior } = this.behaviorOf(value);
    this.path = path;
    this.behavior = behavior;
    queueMicrotask(() => {
      if (behavior.load === "error") this.fail();
      else if (behavior.load !== "never") {
        this.duration = behavior.duration;
        [this.videoWidth, this.videoHeight] = behavior.size;
        this.readyState = 2;
        if (behavior.load === "event") this.fire("loadeddata");
      }
    });
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    this.calls.push(`remove ${name}`);
  }
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.seeks.push(value);
    this.time = value;
    this.seeking = true;
    this.readyState = 1;
    const seek = this.behavior!.seek;
    queueMicrotask(() => {
      if (seek === "error") return this.fail();
      if (seek === "never") return;
      this.seeking = false;
      this.readyState = 2;
      if (seek === "event") this.fire("seeked");
    });
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  fail() {
    this.error = { code: 4, message: "DEMUXER_ERROR_COULD_NOT_OPEN" };
    this.fire("error");
  }
  pause() {
    this.calls.push("pause");
  }
  load() {
    this.calls.push("load");
  }
  play() {
    this.calls.push("play");
    return Promise.resolve();
  }
}

const source = (path: string, start = 91, length = 1000): SceneVideoSource => ({
  path: `P:/p/${path}`,
  start,
  end: start + length,
});

/** 纹理表：0、2 是普通纹理，1 是散文件视频，3 是 scene.pkg 里的视频。 */
const TEXTURES = [
  { path: "materials/a.tex" },
  { path: "materials/v1.tex", video: source("materials/v1.tex") },
  { path: "materials/b.tex" },
  { path: "materials/v3.tex", video: source("scene.pkg", 5000, 2000) },
];

type EnvBehavior = Partial<VideoBehavior> & { read?: "ok" | "fail" | "short" };

/** 注入替身的 `ProbeVideos`：按纹理路径给每段视频的行为；记下读、建与撤销的对象地址。 */
function env(option: VideoTimeOption | undefined, behaviors: Record<string, EnvBehavior> = {}) {
  const elements: SeekVideo[] = [];
  const reads: string[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const pathOfBlob = new WeakMap<Blob, string>();
  const pathOfUrl = new Map<string, string>();
  const behaviorOf = (url: string) => {
    const path = pathOfUrl.get(url)!;
    return {
      path,
      behavior: { load: "event", seek: "event", duration: 2.5, size: [1280, 720], ...behaviors[path] } as VideoBehavior,
    };
  };
  const videos = new ProbeVideos(TEXTURES, option, {
    readBlob: async (video) => {
      reads.push(`${video.path} ${video.start} ${video.end}`);
      const path = TEXTURES.find((texture) => texture.video === video)!.path;
      const mode = behaviors[path]?.read ?? "ok";
      if (mode === "fail") throw new TypeError("Failed to fetch");
      const blob = new Blob([new Uint8Array(mode === "short" ? 10 : video.end - video.start)]);
      pathOfBlob.set(blob, path);
      return blob;
    },
    createElement: () => {
      const element = new SeekVideo(behaviorOf);
      elements.push(element);
      return element as unknown as HTMLVideoElement;
    },
    createObjectUrl: (blob) => {
      const url = `blob:${created.length + 1}`;
      created.push(url);
      pathOfUrl.set(url, pathOfBlob.get(blob)!);
      return url;
    },
    revokeObjectUrl: (url) => void revoked.push(url),
  });
  const elementOf = (path: string) => elements.find((element) => element.path === path)!;
  return { videos, elements, elementOf, reads, created, revoked };
}

/** 让读、建元素、设 src 这一串微任务走完（假定时器下也一样）。 */
async function microtasks() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("ProbeVideos", () => {
  it("读每段视频的区间、建静音不挂 DOM 的元素，seek 到取模后的时刻；每个 draw 都交出元素", async () => {
    const { videos, elements, elementOf, reads } = env(3.25);
    await videos.prepare();
    expect(reads).toEqual(["P:/p/materials/v1.tex 91 1091", "P:/p/scene.pkg 5000 7000"]);
    expect(elements).toHaveLength(2);
    for (const element of elements) {
      expect([element.muted, element.playsInline, element.preload]).toEqual([true, true, "auto"]);
      // 3.25 超过时长 2.5：循环取模到 0.75
      expect(element.seeks).toEqual([0.75]);
      // 不播放：探针按固定时刻取帧
      expect(element.calls).not.toContain("play");
      // 等待结束后事件都撤掉了
      expect(element.listenerCount).toBe(0);
    }
    expect(videos.results()).toEqual([
      { path: "materials/v1.tex", time: 0.75, duration: 2.5, width: 1280, height: 720, failed: false },
      { path: "materials/v3.tex", time: 0.75, duration: 2.5, width: 1280, height: 720, failed: false },
    ]);
    // 确定性优先：同一张纹理每次被画到都交出元素（每个 draw 都拷）；不是视频的下标不交
    videos.beginFrame();
    const v1 = elementOf("materials/v1.tex") as unknown as HTMLVideoElement;
    expect(videos.drawn(1)).toBe(v1);
    expect(videos.drawn(1)).toBe(v1);
    expect(videos.drawn(3)).toBe(elementOf("materials/v3.tex"));
    expect(videos.drawn(0)).toBeNull();
    expect(videos.drawn(2)).toBeNull();
    videos.dispose();
  });

  it("按纹理路径分别给时刻，没给的取 0；缺省全部 0；落在最后 0.005 s 里钳到 duration − 0.005", async () => {
    const byPath = env({ "materials/v1.tex": 2.499 }, { "materials/v3.tex": { duration: 4 } });
    await byPath.videos.prepare();
    expect(byPath.videos.results().map((r) => [r.path, r.time, r.duration])).toEqual([
      ["materials/v1.tex", 2.495, 2.5],
      ["materials/v3.tex", 0, 4],
    ]);
    byPath.videos.dispose();
    const plain = env(undefined);
    await plain.videos.prepare();
    expect(plain.elements.map((element) => element.seeks)).toEqual([[0], [0]]);
    plain.videos.dispose();
  });

  it("videoTime 对象里不是视频纹理的键：建的时候就抛错并列出有哪些；没有视频纹理的场景给数字照常", async () => {
    expect(() => env({ "materials/v1.tex": 1, "materials/a.tex": 2, "v9.tex": 0 })).toThrow(
      /"materials\/a\.tex"、"v9\.tex" 不是这个场景的视频纹理（有："materials\/v1\.tex"、"materials\/v3\.tex"）/,
    );
    expect(() => new ProbeVideos([{ path: "materials/a.tex" }], { "materials/a.tex": 1 })).toThrow(/没有视频纹理/);
    const none = new ProbeVideos([{ path: "materials/a.tex" }], 5);
    await none.prepare();
    expect(none.results()).toEqual([]);
    expect(none.drawn(0)).toBeNull();
    none.dispose();
  });

  it("seek 完不发 seeked：短轮询看到 seeking 落下也算完成", async () => {
    const { videos, elementOf } = env(1, { "materials/v1.tex": { seek: "silent" } });
    await videos.prepare();
    expect(elementOf("materials/v1.tex").seeks).toEqual([1]);
    expect(videos.results()[0]).toMatchObject({ time: 1, failed: false });
    videos.dispose();
  });

  it("读不到、长度不符、解码出错（第一帧前或 seek 时）：这段标为失败、不交出元素（透明），别的照常", async () => {
    const cases = [
      ["read", { read: "fail" }, /Failed to fetch/],
      ["short", { read: "short" }, /长度不符：读到 10 字节，应为 1000/],
      ["load", { load: "error" }, /解码失败：MediaError 4：DEMUXER_ERROR_COULD_NOT_OPEN/],
      ["seek", { seek: "error" }, /解码失败：MediaError 4/],
    ] as const;
    for (const [name, behavior, message] of cases) {
      const { videos, elementOf, revoked } = env(1, { "materials/v1.tex": behavior });
      await videos.prepare();
      const [broken, fine] = videos.results();
      expect(broken, name).toMatchObject({
        path: "materials/v1.tex",
        failed: true,
        width: 0,
        height: 0,
        duration: null,
      });
      expect(broken.error, name).toMatch(message);
      // 失败时的 time 是请求的时刻
      expect(broken.time, name).toBe(1);
      expect(fine, name).toMatchObject({ path: "materials/v3.tex", failed: false, time: 1 });
      expect(videos.drawn(1), name).toBeNull();
      expect(videos.drawn(3), name).not.toBeNull();
      // 建过元素的失败视频立即释放：撤销对象地址、清 src
      if (name === "load" || name === "seek") {
        const element = elementOf("materials/v1.tex");
        expect(revoked, name).toEqual([element.url]);
        expect(element.getAttribute("src"), name).toBeNull();
        expect(element.calls, name).toEqual(["pause", "remove src", "load"]);
      }
      videos.dispose();
    }
  });

  it("超过总时限：prepare 抛 ProbeVideoTimeout（不当成透明），消息带路径、阶段与时限", async () => {
    vi.useFakeTimers();
    const first = env(1, { "materials/v3.tex": { load: "never" } });
    const loading = expect(first.videos.prepare(1000)).rejects.toThrow(
      /等 materials\/v3\.tex \[5000, 7000\) 的第一帧（loadeddata）：超过总时限 1 s/,
    );
    await microtasks();
    await vi.advanceTimersByTimeAsync(1000);
    await loading;
    first.videos.dispose();

    const second = env(1, { "materials/v1.tex": { seek: "never" } });
    const seeking = second.videos.prepare(500);
    const settled = seeking.then(
      () => null,
      (error: unknown) => error,
    );
    await microtasks();
    await vi.advanceTimersByTimeAsync(500);
    const error = await settled;
    expect(error).toBeInstanceOf(ProbeVideoTimeout);
    expect((error as Error).message).toMatch(/等 materials\/v1\.tex \[91, 1091\) seek 到 1 s：超过总时限 0\.5 s/);
    second.videos.dispose();
  });

  it("读本身超过总时限也报错，不建元素", async () => {
    vi.useFakeTimers();
    const videos = new ProbeVideos(TEXTURES.slice(0, 2), 0, {
      readBlob: () => new Promise<Blob>(() => {}),
      createElement: () => {
        throw new Error("不该建元素");
      },
    });
    const reading = expect(videos.prepare(2000)).rejects.toThrow(/读 materials\/v1\.tex .*：超过总时限 2 s/);
    await vi.advanceTimersByTimeAsync(2000);
    await reading;
    videos.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose：停元素、清 src、撤销对象地址，之后不再交出元素；还在等的 prepare 以「已释放」失败、定时器清掉", async () => {
    const done = env(0);
    await done.videos.prepare();
    done.videos.dispose();
    expect(done.revoked).toEqual(done.created);
    for (const element of done.elements) {
      expect(element.calls).toEqual(["pause", "remove src", "load"]);
      expect(element.getAttribute("src")).toBeNull();
    }
    expect(done.videos.drawn(1)).toBeNull();
    // 重复释放无害
    done.videos.dispose();
    expect(done.revoked).toHaveLength(2);

    vi.useFakeTimers();
    const pending = env(0, { "materials/v1.tex": { load: "never" }, "materials/v3.tex": { load: "never" } });
    const waiting = expect(pending.videos.prepare()).rejects.toThrow("视频探针已释放");
    // 读完、元素建好、开始等第一帧
    await microtasks();
    expect(pending.elements).toHaveLength(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    pending.videos.dispose();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.revoked).toEqual(pending.created);
    for (const element of pending.elements) expect(element.listenerCount).toBe(0);
  });
});
