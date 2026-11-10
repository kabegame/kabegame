/**
 * 播放后端（P6a 步骤 1）：用假的 AudioContext 与媒体元素核对懒建、地址（file: 与 pkg 条目的 Blob）、开始的回报、连线、淡变与释放。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneSoundFile } from "../compile/sounds";
import { FADE_TIME_CONSTANT, ScenePlayer } from "./player";
import type { SoundVoiceEvents } from "./sceneSounds";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => `file:///${path}` }));

class FakeParam {
  value: number;
  calls: string[] = [];
  constructor(value: number) {
    this.value = value;
  }
  cancelScheduledValues(t: number) {
    this.calls.push(`cancel ${t}`);
  }
  setValueAtTime(value: number, t: number) {
    this.calls.push(`set ${value} ${t}`);
  }
  setTargetAtTime(value: number, t: number, constant: number) {
    this.calls.push(`target ${value} ${t} ${constant}`);
  }
}

class FakeNode {
  outputs: unknown[] = [];
  connect(target: unknown) {
    this.outputs.push(target);
    return target;
  }
  disconnect() {
    this.outputs = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeSource extends FakeNode {
  constructor(readonly mediaElement: FakeElement) {
    super();
  }
}

class FakeContext {
  destination = new FakeNode();
  currentTime = 3;
  state = "running";
  closed = false;
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createMediaElementSource(element: FakeElement) {
    const source = new FakeSource(element);
    this.sources.push(source);
    return source;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeElement {
  preload = "";
  loop = false;
  currentTime = 7;
  duration = Number.NaN;
  readyState = 0;
  paused = true;
  ended = false;
  error: unknown = null;
  plays = 0;
  loads = 0;
  private attributes = new Map<string, string>();
  private listeners = new Map<string, (() => void)[]>();
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
  /** 元数据到了。 */
  metadata(duration: number) {
    this.duration = duration;
    this.readyState = 1;
    this.fire("loadedmetadata");
  }
  play() {
    this.plays++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads++;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const contexts: FakeContext[] = [];
  const elements: FakeElement[] = [];
  const reads: [string, number, number][] = [];
  const revoked: string[] = [];
  let blobs = 0;
  const player = new ScenePlayer({
    reader: {
      readRange: async (path, start, end) => {
        reads.push([path, start, end]);
        return new Uint8Array(end - start);
      },
    },
    createContext: () => {
      const context = new FakeContext();
      contexts.push(context);
      return context as unknown as AudioContext;
    },
    createElement: () => {
      const element = new FakeElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
    createObjectUrl: () => `blob:${++blobs}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });
  const events = () => {
    const log: string[] = [];
    const value: SoundVoiceEvents = {
      started: (file, duration) => log.push(`started ${file} ${duration}`),
      failed: (file) => log.push(`failed ${file}`),
    };
    return { log, value };
  };
  return { player, contexts, elements, reads, revoked, events };
}

const loose: SceneSoundFile = { path: "sounds/a.mp3", location: { path: "P:/p/sounds/a.mp3", offset: 0 }, size: null };
const packed: SceneSoundFile = { path: "sounds/b.FLAC", location: { path: "P:/p/scene.pkg", offset: 100 }, size: 50 };

describe("ScenePlayer", () => {
  it("开始之前不建 AudioContext、不建元素、不读文件（宿主音量为 0 时排期器不开始）", () => {
    const env = setup();
    const voice = env.player.voice(0, [loose, packed], env.events().value);
    voice.setGain(0.5);
    voice.pause(0);
    voice.stop(1);
    expect(env.contexts).toHaveLength(0);
    expect(env.elements).toHaveLength(0);
    expect(env.reads).toHaveLength(0);
  });

  it("散文件用 file: 地址；元数据到了才从头放并回报时长；连线 元素 → 本声音增益 → 淡变 → destination", async () => {
    const env = setup();
    const { log, value } = env.events();
    const voice = env.player.voice(0, [loose], value);
    voice.setGain(2);
    voice.start(0, true);
    await flush();
    const [context] = env.contexts;
    const [element] = env.elements;
    expect(element.src).toBe("file:///P:/p/sounds/a.mp3");
    expect(element.preload).toBe("auto");
    expect(element.plays).toBe(0);
    expect(log).toEqual([]);
    element.metadata(9.25);
    expect(log).toEqual(["started 0 9.25"]);
    expect(element.plays).toBe(1);
    expect(element.loop).toBe(true);
    expect(element.currentTime).toBe(0);
    // 淡变增益是第一个，本声音的增益第二个
    const [fade, gain] = context.gains;
    expect(fade.outputs).toEqual([context.destination]);
    expect(gain.gain.value).toBe(2);
    expect(gain.outputs).toEqual([fade]);
    expect(context.sources[0].outputs).toEqual([gain]);
  });

  it("pkg 条目按区间读成 Blob，同一条目只读一次（两个对象共用）", async () => {
    const env = setup();
    env.player.voice(0, [packed], env.events().value).start(0, false);
    env.player.voice(1, [packed], env.events().value).start(0, false);
    await flush();
    expect(env.reads).toEqual([["P:/p/scene.pkg", 100, 150]]);
    expect(env.elements.map((element) => element.src)).toEqual(["blob:1", "blob:1"]);
  });

  it("等元数据时被暂停：到了照样回报开始，但不放；续播才放", async () => {
    const env = setup();
    const { log, value } = env.events();
    const voice = env.player.voice(0, [loose], value);
    voice.start(0, false);
    voice.pause(0);
    await flush();
    env.elements[0].metadata(2);
    expect(log).toEqual(["started 0 2"]);
    expect(env.elements[0].plays).toBe(0);
    voice.resume(0, false);
    expect(env.elements[0].plays).toBe(1);
  });

  it("已有元数据的元素再开始：异步回报、从头放；stop 回到开头", async () => {
    const env = setup();
    const { log, value } = env.events();
    const voice = env.player.voice(0, [loose], value);
    voice.start(0, false);
    await flush();
    const [element] = env.elements;
    element.metadata(2);
    element.currentTime = 1.5;
    voice.stop(0);
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(0);
    element.currentTime = 0.4;
    voice.start(0, false);
    expect(log).toEqual(["started 0 2"]);
    await flush();
    expect(log).toEqual(["started 0 2", "started 0 2"]);
    expect(element.currentTime).toBe(0);
    expect(element.plays).toBe(2);
  });

  it("元素出错：异步回报失败，之后这个文件不再建元素", async () => {
    const env = setup();
    const { log, value } = env.events();
    const voice = env.player.voice(0, [loose], value);
    voice.start(0, false);
    await flush();
    env.elements[0].fire("error");
    expect(log).toEqual([]);
    await flush();
    expect(log).toEqual(["failed 0"]);
    voice.start(0, false);
    expect(env.elements).toHaveLength(1);
  });

  it("暂停 / 恢复的淡变：时间常数 1/6 s，从当前值出发", () => {
    const env = setup();
    env.player.voice(0, [loose], env.events().value).start(0, false);
    const fade = env.contexts[0].gains[0];
    env.player.setActive(false);
    env.player.setActive(false);
    env.player.setActive(true);
    expect(fade.gain.calls).toEqual([
      "cancel 3",
      "set 1 3",
      `target 0 3 ${FADE_TIME_CONSTANT}`,
      "cancel 3",
      "set 1 3",
      `target 1 3 ${FADE_TIME_CONSTANT}`,
    ]);
  });

  it("dispose：停掉并清空元素、撤销 Blob、关掉 AudioContext", async () => {
    const env = setup();
    env.player.voice(0, [loose, packed], env.events().value).start(1, false);
    await flush();
    env.player.dispose();
    await flush();
    const [element] = env.elements;
    expect(element.getAttribute("src")).toBeNull();
    expect(element.loads).toBe(1);
    expect(env.revoked).toEqual(["blob:1"]);
    expect(env.contexts[0].closed).toBe(true);
  });
});
