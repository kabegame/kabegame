/**
 * 一张场景的全部声音（P6a 步骤 1）：按 bundle 的声音表给每个声音对象建排期器（`scheduler.ts`），接到播放器（`player.ts`）上。
 * 宿主（`host.ts`）只经它推进与调音量，不直接碰排期器。不碰 DOM：播放器按接口注入，单测用假的。
 *
 * - **开始时机**：宿主收到 bundle 就 `load`，不等 GPU 资源（WPE 在对象加载时就开始放，不等第一帧，实测 `p6a-calib`）；全部声音在同一次
 *   调用里按对象顺序启动（实测 `p6a-misc` 两个声音同一个 10 ms 窗口出声）。
 * - **重编译**：同一对象的声音表没变（文件、模式、时间、`startsilent`）就保留排期器，播放不中断；变了才重建该对象的。`volume` 不比较：
 *   它由 `SceneState.sounds` 每帧交来。
 * - **全局音量**：宿主音量 h，暂停或文档隐藏时为 0（`setGlobal`）。暂停与恢复另交给播放器做淡变（`active`）。
 */
import type { SceneSound, SceneSoundFile } from "../compile/sounds";
import { SoundScheduler, type SoundBackend, type SoundSchedulerSnapshot } from "./scheduler";

/** 播放器回报给排期器的事件（一个声音对象一份）。 */
export interface SoundVoiceEvents {
  started(file: number, duration: number): void;
  failed(file: number, error: unknown): void;
}

/** 播放器（`player.ts` 的 `ScenePlayer`）：每个声音对象一个后端。 */
export interface SoundPlayer {
  voice(object: number, files: readonly SceneSoundFile[], events: SoundVoiceEvents): SoundBackend;
  /** 释放一个对象的元素与节点（对象不在了，或声音表变了要重建）。 */
  release(object: number): void;
  /** 暂停 / 恢复的淡变（WPE 的暂停系数，时间常数 1/6 s）。 */
  setActive(active: boolean): void;
  dispose(): void;
}

/** dev 探针：一个声音对象的状态。 */
export interface SceneSoundProbe extends SoundSchedulerSnapshot {
  object: number;
  files: string[];
}

/** 声音表里决定排期的部分：相同就保留排期器。 */
function soundKey(sound: SceneSound): string {
  const files = sound.files.map((file) => [file.location.path, file.location.offset, file.size]);
  return JSON.stringify([files, sound.mode, sound.mintime, sound.maxtime, sound.startSilent]);
}

interface Entry {
  key: string;
  sound: SceneSound;
  scheduler: SoundScheduler;
}

export class SceneSounds {
  private readonly entries = new Map<number, Entry>();
  private globalVolume = 0;
  private active = true;

  constructor(
    private readonly player: SoundPlayer,
    private readonly random: () => number = Math.random,
    private readonly onFailed?: (object: number, file: SceneSoundFile, error: unknown) => void,
  ) {}

  /** 换上一张 bundle 的声音表：保留没变的、重建变了的、释放不在了的，新建的按对象顺序立即开始（音量为 0 时不开始）。 */
  load(sounds: readonly SceneSound[]): void {
    const next = new Set(sounds.map((sound) => sound.object));
    for (const [object] of this.entries)
      if (!next.has(object)) {
        this.entries.delete(object);
        this.player.release(object);
      }
    for (const sound of sounds) {
      const key = soundKey(sound);
      const existing = this.entries.get(sound.object);
      if (existing && existing.key === key) {
        existing.sound = sound;
        existing.scheduler.replaceSound(sound);
        continue;
      }
      if (existing) {
        this.entries.delete(sound.object);
        this.player.release(sound.object);
      }
      // 后端的回报要找到排期器：先建事件对象，排期器建好后再接上
      const events: SoundVoiceEvents = {
        started: (file, duration) => scheduler.onStarted(file, duration),
        failed: (file, error) => {
          this.onFailed?.(sound.object, sound.files[file], error);
          scheduler.onFailed(file);
        },
      };
      const backend = this.player.voice(sound.object, sound.files, events);
      const scheduler = new SoundScheduler(sound, backend, this.random);
      this.entries.set(sound.object, { key, sound, scheduler });
      scheduler.load(this.globalVolume);
    }
  }

  /**
   * 每个实时帧（渲染器在粒子步进之后、脚本之前调，`dt` 是同一个钳过的帧时间）：音量取场景状态里的就地值，再推进排期器。
   * 补画帧不调，暂停时帧不前进，计时自然冻结。
   */
  step(dt: number, volumeOf: (object: number) => number | undefined): void {
    for (const { sound, scheduler } of this.entries.values())
      scheduler.update(dt, volumeOf(sound.object) ?? sound.volume, this.globalVolume);
  }

  /** 属性就地写之后立即应用音量（暂停时没有帧，WPE 的回调 `V` 也是当场调）。 */
  syncVolumes(volumeOf: (object: number) => number | undefined): void {
    for (const { sound, scheduler } of this.entries.values()) {
      const volume = volumeOf(sound.object);
      if (volume !== undefined) scheduler.setVolume(volume);
    }
  }

  /** 全局音量与暂停：`volume` 是排期器看到的 G（暂停时为 0），`active` 交给播放器做淡变。 */
  setGlobal(volume: number, active: boolean): void {
    if (active !== this.active) {
      this.active = active;
      this.player.setActive(active);
    }
    if (volume === this.globalVolume) return;
    this.globalVolume = volume;
    for (const { scheduler } of this.entries.values()) scheduler.setGlobalVolume(volume);
  }

  /** 按对象取排期器（步骤 2 的脚本 API 用）。 */
  scheduler(object: number): SoundScheduler | null {
    return this.entries.get(object)?.scheduler ?? null;
  }

  probe(): SceneSoundProbe[] {
    return [...this.entries.values()].map(({ sound, scheduler }) => ({
      object: sound.object,
      files: sound.files.map((file) => file.path),
      ...scheduler.snapshot(),
    }));
  }

  dispose(): void {
    this.entries.clear();
    this.player.dispose();
  }
}
