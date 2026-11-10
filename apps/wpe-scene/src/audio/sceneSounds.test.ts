/**
 * 一张场景的声音（P6a 步骤 1）：开始时机、多声音同时开始、重编译保留、全局音量与暂停的淡变、每帧推进（假播放器记命令）。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneSound } from "../compile/sounds";
import type { SoundBackend } from "./scheduler";
import { SceneSounds, type SoundPlayer, type SoundVoiceEvents } from "./sceneSounds";

function sound(object: number, files: string[], over: Partial<SceneSound> = {}): SceneSound {
  return {
    object,
    files: files.map((path) => ({ path, location: { path: `P:/p/${path}`, offset: 0 }, size: null })),
    mode: "loop",
    mintime: 1,
    maxtime: 5,
    startSilent: false,
    volume: 1,
    ...over,
  };
}

function fakePlayer() {
  const log: string[] = [];
  const events = new Map<number, SoundVoiceEvents>();
  const gains = new Map<number, number>();
  const player: SoundPlayer = {
    voice(object, _files, voiceEvents) {
      log.push(`voice ${object}`);
      events.set(object, voiceEvents);
      const backend: SoundBackend = {
        start: (file, loop) => log.push(`${object} start ${file}${loop ? " loop" : ""}`),
        resume: (file, loop) => log.push(`${object} resume ${file}${loop ? " loop" : ""}`),
        pause: (file) => log.push(`${object} pause ${file}`),
        stop: (file) => log.push(`${object} stop ${file}`),
        setGain: (gain) => gains.set(object, gain),
      };
      return backend;
    },
    release: (object) => log.push(`release ${object}`),
    setActive: (active) => log.push(`active ${active}`),
    dispose: () => log.push("dispose"),
  };
  return { player, log, events, gains };
}

describe("SceneSounds", () => {
  it("宿主音量还没到（0）时不开始；到了之后按对象顺序同时开始（p6a-misc 两个声音同一个 10 ms 窗口）", () => {
    const { player, log } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.load([sound(2, ["a.wav"]), sound(5, ["b.wav"])]);
    expect(log).toEqual(["voice 2", "voice 5"]);
    sounds.setGlobal(0.5, true);
    expect(log).toEqual(["voice 2", "voice 5", "2 start 0 loop", "5 start 0 loop"]);
  });

  it("宿主音量已经是正数时，load 当场开始，不等帧", () => {
    const { player, log } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.setGlobal(1, true);
    sounds.load([sound(0, ["a.wav"]), sound(1, ["b.wav"], { startSilent: true })]);
    expect(log).toEqual(["voice 0", "0 start 0 loop", "voice 1"]);
  });

  it("重编译：声音表没变的保留（播放不中断），文件变了的重建，不在了的释放", () => {
    const { player, log } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.setGlobal(1, true);
    sounds.load([sound(0, ["a.wav"]), sound(1, ["b.wav"]), sound(2, ["c.wav"])]);
    log.length = 0;
    // 0 只有音量变了（音量由 SceneState 交来，不比较）；1 换了文件；2 没了
    sounds.load([sound(0, ["a.wav"], { volume: 0.3 }), sound(1, ["d.wav"])]);
    expect(log).toEqual(["release 2", "release 1", "voice 1", "1 start 0 loop"]);
  });

  it("每帧按场景状态的音量推进：音量从 0 变正时从头开始；没有就地值时用声音表的值", () => {
    const { player, log, gains } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.setGlobal(1, true);
    sounds.load([sound(0, ["a.wav"], { volume: 0 }), sound(1, ["b.wav"], { volume: 0.5 })]);
    expect(log).toEqual(["voice 0", "voice 1", "1 start 0 loop"]);
    const volumes = new Map([[0, 1]]);
    sounds.step(0.1, (object) => volumes.get(object));
    expect(log.at(-1)).toBe("0 start 0 loop");
    expect(gains.get(0)).toBe(1);
    expect(gains.get(1)).toBe(0.25);
  });

  it("属性就地写后 syncVolumes 当场生效（暂停时没有帧）", () => {
    const { player, gains } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.setGlobal(0.5, true);
    sounds.load([sound(0, ["a.wav"])]);
    expect(gains.get(0)).toBe(1);
    sounds.syncVolumes(() => 0.5);
    expect(gains.get(0)).toBeCloseTo(0.25);
  });

  it("暂停：先交给播放器淡变，再按全局音量 0 暂停；恢复：淡入并从原处续播", () => {
    const { player, log } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.setGlobal(0.8, true);
    sounds.load([sound(0, ["a.wav"])]);
    log.length = 0;
    sounds.setGlobal(0, false);
    expect(log).toEqual(["active false", "0 pause 0"]);
    sounds.setGlobal(0.8, true);
    expect(log).toEqual(["active false", "0 pause 0", "active true", "0 resume 0 loop"]);
    // 只改宿主音量：不碰淡变
    sounds.setGlobal(0.4, true);
    expect(log.at(-1)).toBe("0 resume 0 loop");
  });

  it("文件读不出：回报给宿主（记 warn），排期器换别的文件", () => {
    const { player, log, events } = fakePlayer();
    const failed = vi.fn();
    const sounds = new SceneSounds(player, () => 0.9, failed);
    sounds.setGlobal(1, true);
    sounds.load([sound(0, ["a.wav", "b.wav"])]);
    expect(log.at(-1)).toBe("0 start 1");
    events.get(0)!.failed(1, new Error("404"));
    expect(failed).toHaveBeenCalledWith(0, expect.objectContaining({ path: "b.wav" }), expect.any(Error));
    // 只剩一个文件：照 WPE 改成单文件 loop，让元素自己循环
    expect(log.at(-1)).toBe("0 start 0 loop");
    expect(sounds.probe()[0]).toMatchObject({ object: 0, files: ["a.wav", "b.wav"], available: [0], file: 0 });
  });

  it("dispose 释放播放器", () => {
    const { player, log } = fakePlayer();
    const sounds = new SceneSounds(player, () => 0);
    sounds.load([sound(0, ["a.wav"])]);
    sounds.dispose();
    expect(log.at(-1)).toBe("dispose");
    expect(sounds.probe()).toEqual([]);
  });
});
