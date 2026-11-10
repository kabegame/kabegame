/**
 * 排期器（P6a 步骤 1）：假后端记命令序列，逐条对照 `p6-REPORT.md`「P6a 声音语义的实测核对」的表与 `rea-p6a-sound.md`。
 * 帧时间取 1/8 s（二进制精确，累加不漂），实测的 20 fps 只影响切换落在哪一帧。
 */
import { describe, expect, it } from "vitest";
import type { SceneSound, SoundMode } from "../compile/sounds";
import { soundGain, SoundScheduler, type SoundBackend } from "./scheduler";

const DT = 0.125;

function soundOf(over: Partial<SceneSound> & { count?: number } = {}): SceneSound {
  const count = over.count ?? 1;
  return {
    object: 0,
    files: Array.from({ length: count }, (_, i) => ({
      path: `sounds/${i}.wav`,
      location: { path: `P:/p/sounds/${i}.wav`, offset: 0 },
      size: null,
    })),
    mode: "loop" as SoundMode,
    mintime: 1,
    maxtime: 5,
    startSilent: false,
    volume: 1,
    ...over,
  };
}

/**
 * 场景：排期器 + 假后端。后端的开始在「下一次 flush」时回报（模拟元数据到达），每次 `load` / `frame` / API 调用之后都 flush，
 * 相当于元数据在下一帧之前到。`log` 是带时刻的命令。
 */
function setup(
  over: Partial<SceneSound> & { count?: number } = {},
  options: { durations?: number[]; random?: number[]; global?: number } = {},
) {
  const sound = soundOf(over);
  const durations = options.durations ?? sound.files.map(() => 2);
  const randoms = [...(options.random ?? [])];
  let now = 0;
  const log: string[] = [];
  const timed: { t: number; command: string }[] = [];
  const queue: number[] = [];
  let gain = Number.NaN;
  const record = (command: string) => {
    log.push(command);
    timed.push({ t: now, command });
  };
  const backend: SoundBackend = {
    start: (file, loop) => {
      record(`start ${file}${loop ? " loop" : ""}`);
      queue.push(file);
    },
    resume: (file, loop) => record(`resume ${file}${loop ? " loop" : ""}`),
    pause: (file) => record(`pause ${file}`),
    stop: (file) => record(`stop ${file}`),
    setGain: (value) => {
      gain = value;
    },
  };
  const random = () => {
    // 没给序列时恒取 0（单文件只有一个可选）；给了就按序取，用完说明多开始了一次
    if (!options.random) return 0;
    if (!randoms.length) throw new Error("随机数用完了");
    return randoms.shift()!;
  };
  const scheduler = new SoundScheduler(sound, backend, random);
  let volume = sound.volume;
  let global = options.global ?? 1;
  const flush = () => {
    while (queue.length) {
      const file = queue.shift()!;
      scheduler.onStarted(file, durations[file]);
    }
  };
  const env = {
    scheduler,
    log,
    timed,
    get gain() {
      return gain;
    },
    get now() {
      return now;
    },
    load() {
      scheduler.load(global);
      flush();
    },
    frame(dt = DT) {
      now += dt;
      scheduler.update(dt, volume, global);
      flush();
    },
    /** 跑到 `until` 秒，返回每帧之后的 isPlaying。 */
    run(until: number) {
      const playing: boolean[] = [];
      while (now < until - 1e-9) {
        env.frame();
        playing.push(scheduler.isPlaying());
      }
      return playing;
    },
    setVolume(value: number) {
      volume = value;
    },
    setGlobal(value: number) {
      global = value;
      scheduler.setGlobalVolume(value);
      flush();
    },
    call(fn: () => void) {
      fn();
      flush();
    },
    /** 自某时刻起的开始命令的时刻。 */
    starts() {
      return timed.filter((item) => item.command.startsWith("start")).map((item) => item.t);
    },
  };
  return env;
}

describe("排期器：开始与 loop", () => {
  it("加载时就开始放，不等第一帧（p6a-calib）", () => {
    const env = setup();
    env.load();
    expect(env.log).toEqual(["start 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("单文件 loop：元素自己循环，排期器不再发命令（p6a-calib 无缝循环）", () => {
    const env = setup({}, { durations: [9.25] });
    env.load();
    env.run(40);
    expect(env.log).toEqual(["start 0 loop"]);
    expect(env.scheduler.snapshot().T).toBe(0);
  });

  it("loop 多文件：每个放一遍、到时长紧接着带放回随机换下一个，可以连选同一个（p6a-loopmulti）", () => {
    // 选文件：0、0、1、2、1（`floor(r · 3)`）
    const env = setup({ count: 3 }, { durations: [1, 1.5, 2], random: [0.1, 0.2, 0.5, 0.9, 0.4] });
    env.load();
    env.run(6.5);
    expect(env.log).toEqual([
      "start 0",
      "stop 0",
      "start 0",
      "stop 0",
      "start 1",
      "stop 1",
      "start 2",
      "stop 2",
      "start 1",
    ]);
    // 段与段之间不留空：下一段的开始 = 上一段的开始 + 它的时长
    expect(env.starts()).toEqual([0, 1, 2, 3.5, 5.5]);
    // 不循环：多文件时实例不设 loop
    expect(env.log.some((command) => command.endsWith("loop"))).toBe(false);
  });
});

describe("排期器：random", () => {
  it("开始到开始 = 时长 + U(mintime, maxtime)，min = max = 1、1 s 文件时恰好 2 s（p6a-random 的 Q）", () => {
    const env = setup(
      { mode: "random", mintime: 1, maxtime: 1 },
      { durations: [1], random: [0, 0.3, 0, 0.7, 0, 0.1, 0, 0] },
    );
    env.load();
    env.run(6.5);
    expect(env.starts()).toEqual([0, 2, 4, 6]);
    expect(env.log.every((command) => !command.endsWith("loop"))).toBe(true);
  });

  it("间隔按 u ∈ [0, 1) 均匀落在 [mintime, maxtime)，从开始播放算起（p6a-random 的 R）", () => {
    // 三个 1 s 文件、0.5 / 3：每次开始先选文件、再抽 u
    const us = [0, 0.5, 0.96];
    const env = setup(
      { mode: "random", count: 3, mintime: 0.5, maxtime: 3 },
      { durations: [1, 1, 1], random: [0.2, us[0], 0.5, us[1], 0.9, us[2], 0.1, 0] },
    );
    env.load();
    env.run(9.5);
    const starts = env.starts();
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    // T = u · (3 − 0.5) + 0.5 + 1，按 1/8 s 的帧向上取整
    expect(gaps).toEqual(us.map((u) => Math.ceil((u * 2.5 + 1.5) / DT) * DT));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(1.5);
      expect(gap).toBeLessThan(4 + DT);
    }
  });

  it("isPlaying 在两段之间的等待里仍为真（p6a-random 两个对象 1065 帧全是真）", () => {
    const env = setup({ mode: "random", mintime: 1, maxtime: 1 }, { durations: [1], random: [0, 0, 0, 0, 0, 0, 0, 0] });
    env.load();
    expect(env.run(6).every(Boolean)).toBe(true);
  });

  it("等待中 play() 什么都不做；stop() 后 play() 立即重新开始", () => {
    const env = setup({ mode: "random", mintime: 1, maxtime: 1 }, { durations: [1], random: [0, 0, 0, 0] });
    env.load();
    env.run(1.5);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0"]);
    env.call(() => env.scheduler.stop());
    expect(env.scheduler.isPlaying()).toBe(false);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0", "stop 0", "start 0"]);
  });
});

describe("排期器：single", () => {
  it("放一遍：时长内 isPlaying 为真，之后为假，不再自动重放（p6a-single）", () => {
    const env = setup({ mode: "single" }, { durations: [2], random: [0] });
    env.load();
    const playing = env.run(6);
    // 第 k 帧之后 Rm = 2 − k/8：前 15 帧为真，第 16 帧（2.0 s）起为假
    expect(playing.slice(0, 15).every(Boolean)).toBe(true);
    expect(playing.slice(15).some(Boolean)).toBe(false);
    expect(env.log).toEqual(["start 0"]);
  });

  it("陷阱：放完之后 pause 再 play 会从头重放一遍，isPlaying 调前调后都是假；再 play 才为真（p6a-single 7 s / 12 s）", () => {
    const env = setup({ mode: "single" }, { durations: [2], random: [0, 0] });
    env.load();
    env.run(7);
    env.call(() => env.scheduler.pause());
    expect(env.scheduler.isPlaying()).toBe(false);
    env.call(() => env.scheduler.play());
    // 续播已放完的实例：后端从头放（SFML 对已停止的流 play()），排期器不重设 Rm
    expect(env.log).toEqual(["start 0", "pause 0", "resume 0"]);
    expect(env.scheduler.isPlaying()).toBe(false);
    env.run(12);
    env.call(() => env.scheduler.play());
    expect(env.log.slice(3)).toEqual(["stop 0", "start 0"]);
    const playing = env.run(15);
    expect(playing.slice(0, 15).every(Boolean)).toBe(true);
    expect(playing.slice(16).some(Boolean)).toBe(false);
  });

  it("等后端回报时长的那一下，play() 之后 isPlaying 已经为真（WPE 同步拿到时长）", () => {
    const sound = soundOf({ mode: "single" });
    const backend: SoundBackend = { start() {}, resume() {}, pause() {}, stop() {}, setGain() {} };
    const scheduler = new SoundScheduler(sound, backend, () => 0);
    scheduler.load(1);
    expect(scheduler.snapshot().pending).toBe(true);
    expect(scheduler.isPlaying()).toBe(true);
    // 回报之前不计时
    scheduler.update(1, 1, 1);
    scheduler.onStarted(0, 2);
    expect(scheduler.snapshot().Rm).toBe(2);
  });
});

describe("排期器：脚本的 play / pause / stop / isPlaying（步骤 2 接到脚本上）", () => {
  it("在放的时候 play()：停掉、从头放（p6a-play 5.0 s）", () => {
    const env = setup();
    env.load();
    env.run(1);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0 loop", "stop 0", "start 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("pause → play：从原处续播；pause 后为假，play 后为真（p6a-play 9.7 s / 10.7 s）", () => {
    const env = setup();
    env.load();
    env.run(1);
    env.call(() => env.scheduler.pause());
    expect(env.scheduler.isPlaying()).toBe(false);
    env.run(2);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0 loop", "pause 0", "resume 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("stop → play：从头放；stop 后为假（p6a-play 14.9 s / 15.9 s）", () => {
    const env = setup();
    env.load();
    env.run(1);
    env.call(() => env.scheduler.stop());
    expect(env.scheduler.isPlaying()).toBe(false);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0 loop", "stop 0", "start 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("重复 pause 无害；停止之后 pause 什么都不做", () => {
    const env = setup();
    env.load();
    env.call(() => env.scheduler.pause());
    env.call(() => env.scheduler.pause());
    expect(env.log).toEqual(["start 0 loop", "pause 0"]);
    env.call(() => env.scheduler.stop());
    env.call(() => env.scheduler.pause());
    expect(env.log).toEqual(["start 0 loop", "pause 0", "stop 0"]);
    expect(env.scheduler.snapshot().scriptPaused).toBe(false);
  });

  it("被脚本暂停时计时冻结：loop 多文件不换文件", () => {
    const env = setup({ count: 2 }, { durations: [1, 1], random: [0, 0.9] });
    env.load();
    env.run(0.5);
    env.call(() => env.scheduler.pause());
    env.run(5);
    expect(env.log).toEqual(["start 0", "pause 0"]);
    env.call(() => env.scheduler.play());
    env.run(5.5);
    expect(env.log).toEqual(["start 0", "pause 0", "resume 0", "stop 0", "start 1"]);
  });
});

describe("排期器：startsilent 与音量 0 起步", () => {
  it("startsilent：不放、isPlaying 为假，直到 play()（p6a-silent 的 T）", () => {
    const env = setup({ startSilent: true });
    env.load();
    expect(env.run(4).some(Boolean)).toBe(false);
    expect(env.log).toEqual([]);
    env.call(() => env.scheduler.play());
    expect(env.log).toEqual(["start 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("startsilent 不随音量变化自动开始", () => {
    const env = setup({ startSilent: true, volume: 0 });
    env.load();
    env.setVolume(1);
    env.run(2);
    expect(env.log).toEqual([]);
  });

  it("音量为 0 时不开始；变成正数时才从文件开头放（p6a-silent 的 Z）", () => {
    const env = setup({ volume: 0 });
    env.load();
    expect(env.run(3).some(Boolean)).toBe(false);
    expect(env.log).toEqual([]);
    env.setVolume(1);
    env.frame();
    expect(env.log).toEqual(["start 0 loop"]);
    expect(env.gain).toBe(1);
    expect(env.scheduler.isPlaying()).toBe(true);
  });

  it("single 音量从 0 变正不自动开始（WPE 的 V 跳过 single）", () => {
    const env = setup({ mode: "single", volume: 0 });
    env.load();
    env.setVolume(1);
    env.run(2);
    expect(env.log).toEqual([]);
  });

  it("在放的声音音量改成 0：只把增益设成 0、不暂停，isPlaying 仍为真；改回来没有渐变", () => {
    const env = setup();
    env.load();
    env.setVolume(0);
    env.frame();
    expect(env.gain).toBe(0);
    expect(env.log).toEqual(["start 0 loop"]);
    expect(env.scheduler.isPlaying()).toBe(true);
    env.setVolume(0.5);
    env.frame();
    expect(env.gain).toBe(0.25);
  });
});

describe("排期器：全局音量（宿主音量 h，暂停时为 0）", () => {
  it("全局音量 0 时加载不开始；变成正数时从头开始", () => {
    const env = setup({}, { global: 0 });
    env.load();
    env.run(1);
    expect(env.log).toEqual([]);
    env.setGlobal(0.6);
    expect(env.log).toEqual(["start 0 loop"]);
  });

  it("降到 0：暂停在放的，isPlaying 仍为真；恢复：从原处续播", () => {
    const env = setup({ count: 2 }, { durations: [2, 2], random: [0, 0.9] });
    env.load();
    env.run(1);
    env.setGlobal(0);
    expect(env.log).toEqual(["start 0", "pause 0"]);
    expect(env.scheduler.isPlaying()).toBe(true);
    // 计时冻结（T 要求 volume²·G > 0）：多久都不换文件
    env.run(10);
    expect(env.log).toEqual(["start 0", "pause 0"]);
    env.setGlobal(0.5);
    // 续播的 loop 参数照 WPE 传「模式是 loop」，不看文件数
    expect(env.log).toEqual(["start 0", "pause 0", "resume 0 loop"]);
    env.run(11);
    expect(env.log).toEqual(["start 0", "pause 0", "resume 0 loop", "stop 0", "start 1"]);
  });

  it("single 放完之后降到 0：暂停并停掉；恢复后不重放", () => {
    const env = setup({ mode: "single" }, { durations: [1], random: [0] });
    env.load();
    env.run(2);
    env.setGlobal(0);
    expect(env.log).toEqual(["start 0", "pause 0", "stop 0"]);
    env.setGlobal(1);
    env.run(4);
    expect(env.log).toEqual(["start 0", "pause 0", "stop 0"]);
  });

  it("random 在等待里降到 0：停掉已放完的、等待计时冻结；恢复后接着等", () => {
    const env = setup({ mode: "random", mintime: 1, maxtime: 1 }, { durations: [1], random: [0, 0, 0, 0] });
    env.load();
    env.run(1.5);
    env.setGlobal(0);
    expect(env.log).toEqual(["start 0", "pause 0", "stop 0"]);
    env.run(10);
    env.setGlobal(1);
    // 恢复时 T 还剩 0.5 s：不立即开始
    expect(env.log).toEqual(["start 0", "pause 0", "stop 0"]);
    env.run(10.5);
    expect(env.log).toEqual(["start 0", "pause 0", "stop 0", "start 0"]);
  });

  it("被脚本暂停的声音，全局音量恢复时不续播", () => {
    const env = setup();
    env.load();
    env.call(() => env.scheduler.pause());
    env.setGlobal(0);
    env.setGlobal(1);
    expect(env.log).toEqual(["start 0 loop", "pause 0"]);
  });

  it("运行中改全局音量立即生效（apply_properties({volume: 25})）", () => {
    const env = setup({ volume: 0.5 }, { global: 0.5 });
    env.load();
    expect(env.gain * 0.5).toBeCloseTo(0.125);
    env.setGlobal(0.25);
    expect(env.gain * 0.25).toBeCloseTo(0.0625);
  });
});

describe("排期器：增益 min(1, volume² · G)（p6a-vol2）", () => {
  // 实际输出 = 交给后端的增益 × 垫片主增益的 h
  const output = (volume: number, global: number) => soundGain(volume, global) * global;

  it("对象音量取平方：volume 0.5 对 1 是 1/4", () => {
    expect(output(0.5, 0.5) / output(1, 0.5)).toBeCloseTo(0.25);
    expect(soundGain(0.5, 1)).toBe(0.25);
  });

  it("钳制在乘积上：volume 3 在 G = 0.5 时是 1 的 2 倍，在 G = 0.25 时是 4 倍", () => {
    expect(output(3, 0.5) / output(1, 0.5)).toBeCloseTo(2);
    expect(output(3, 0.25) / output(1, 0.25)).toBeCloseTo(4);
  });

  it("volume 2：G ≥ 0.25 时和 1 一样钳到 1，G 更小时才更响（min(1, v²·h) / h）", () => {
    expect(soundGain(2, 0.5)).toBe(2);
    expect(output(2, 0.5)).toBe(1);
    expect(output(2, 0.25)).toBe(1);
    expect(soundGain(2, 0.2)).toBeCloseTo(4);
    expect(output(2, 0.2)).toBeCloseTo(0.8);
  });

  it("宿主音量为 0 时增益为 0；负的 volume 平方后为正", () => {
    expect(soundGain(1, 0)).toBe(0);
    expect(soundGain(-0.5, 1)).toBe(0.25);
  });
});

describe("排期器：文件读不出", () => {
  it("开始时失败：从列表里删掉，用剩下的重新选；全删光就不放、isPlaying 为假", () => {
    const sound = soundOf({ count: 2, mode: "single" });
    const log: string[] = [];
    const backend: SoundBackend = {
      start: (file) => log.push(`start ${file}`),
      resume() {},
      pause() {},
      stop: (file) => log.push(`stop ${file}`),
      setGain() {},
    };
    const randoms = [0.9, 0.1];
    const scheduler = new SoundScheduler(sound, backend, () => randoms.shift() ?? 0);
    scheduler.load(1);
    scheduler.onFailed(1);
    expect(log).toEqual(["start 1", "start 0"]);
    expect(scheduler.snapshot().available).toEqual([0]);
    scheduler.onFailed(0);
    expect(scheduler.snapshot().available).toEqual([]);
    expect(scheduler.isPlaying()).toBe(false);
    scheduler.play();
    expect(log).toEqual(["start 1", "start 0"]);
  });

  it("过期的开始回报不理（已被停掉、换了文件）", () => {
    const env = setup({ count: 2 }, { durations: [1, 1], random: [0, 0.9] });
    env.scheduler.load(1);
    env.scheduler.stop();
    env.scheduler.onStarted(0, 1);
    expect(env.scheduler.snapshot().T).toBe(0);
    expect(env.scheduler.snapshot().pending).toBe(false);
  });
});
