/**
 * 声音对象的排期器（P6a 步骤 1）：一个声音对象一个，照 WPE 2.8.42 的状态机逐项复刻，只对抽象的「播放后端」发命令。
 * 不碰 DOM，在 Node 里能单测，也能直接对着实测序列核对。浏览器侧的后端是 `player.ts`。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase6/rea-p6a-sound.md`（读码，第 2、4、5、7 节）与 `p6-REPORT.md`
 * 「P6a 声音语义的实测核对」（实测，冲突时以它为准；读码的结论实测全部成立）。命名照读码：
 * - `P`（`FUN_1401f5980`）开始播放 / 续播：`start()`，脚本的 `play()` 就是它；
 * - `U`（`FUN_1401f4f50`）每帧：`tick()`；
 * - `V`（`FUN_1401f4c20`）音量回调，全局音量变化（`FUN_1401816d0`）对每个声音走同一段逻辑：`applyVolume()`；
 * - `X`（`FUN_1401f58e0`）停掉全部：`stopAll()`，脚本的 `stop()` 就是它。
 *
 * 状态对应 WPE 声音对象的字段：标志 `F` 的 bit1（`startsilent`，兼作「还没自动开始过」）→ `silent`、bit30（被脚本暂停）→ `scriptPaused`、
 * bit31（已停止，初值置位）→ `stopped`；等待计时 `T`（`+0x2fc`）、剩余时长 `Rm`（`+0x300`）；每个文件一个实例，状态是 WPE 包装层
 * 自己记的 0 停止 / 1 暂停 / 2 播放，**自然放完不会变**（rea 第 7 节）。
 *
 * 和 WPE 的差别：
 * - **开始是异步的。** WPE 在 `P` 里同步读完整个文件、拿到时长；我们的后端要等媒体元素拿到元数据，经 `onStarted(file, duration)` 回报。
 *   `T` / `Rm` 从回报的时刻起算（`pending` 期间不计时）；`pending` 期间 `isPlaying` 按 WPE 当场的值（真），`random` 不会重复开始。
 * - **文件的失败在开始时才知道。** WPE 第一次 `P` 读全部文件、读不出的删掉；我们在某个文件开始失败时（`onFailed`）把它删掉，
 *   正在等它开始的就重新走一次 `P`（重新随机选）。
 * - **随机源**：选文件 WPE 用 CRT `rand()`、`random` 的等待用和粒子共用的 mt19937；这里两者都取构造时给的 `random`，序列本来对不上，
 *   只照规则（带放回均匀选、`U(mintime, maxtime)`）。
 *
 * 全局音量 `G`：WPE 是设置里的音量 × 暂停 / 静音的淡变系数；我们是宿主音量 h（垫片交来，桌面与预览是壁纸音量，应用背景与暂停为 0）。
 * 增益照 WPE 是 `min(1, volume² · G)`（实测：平方、钳在乘积上），垫片的主增益再乘 h，所以交给后端的是 `min(1, volume²·h) / h`。
 */
import type { SceneSound, SoundMode } from "../compile/sounds";

/** 播放后端：一个声音对象一个（`player.ts` 的 `SoundVoice`，单测用假的记命令）。`file` 是 `SceneSound.files` 的下标。 */
export interface SoundBackend {
  /** 从头放第 `file` 个文件；真正开始后经排期器的 `onStarted(file, duration)` 回报，失败经 `onFailed(file)`。 */
  start(file: number, loop: boolean): void;
  /** 从原处续播（已自然放完的从头放，同 SFML 对已停止的流 `play()`）。 */
  resume(file: number, loop: boolean): void;
  pause(file: number): void;
  /** 停并回到开头。 */
  stop(file: number): void;
  /** 本声音的增益，已含 `min(1, volume²·h) / h`；没有渐变（rea 5.2）。 */
  setGain(gain: number): void;
}

/** 实例状态：WPE 包装层自己记的，只在 `play` / `pause` / `stop` 时改。 */
export type SoundInstanceState = "stopped" | "paused" | "playing";

/** 一次开始在等后端回报时长：按模式在回报时设 `T` / `Rm`。 */
interface PendingStart {
  file: number;
  mode: SoundMode;
  /** loop：开始时的文件数大于 1（WPE `T` = 时长，否则 0）。 */
  multi: boolean;
  /** random：开始时抽好的 `U(mintime, maxtime)`。 */
  wait: number;
}

/** dev 探针与单测读的快照。 */
export interface SoundSchedulerSnapshot {
  mode: SoundMode;
  /** 当前（最近开始的）文件，`SceneSound.files` 下标；还没开始过为 null。 */
  file: number | null;
  /** 还能用的文件（读不出的已删掉）。 */
  available: number[];
  instances: SoundInstanceState[];
  silent: boolean;
  scriptPaused: boolean;
  stopped: boolean;
  pending: boolean;
  T: number;
  Rm: number;
  volume: number;
  globalVolume: number;
  gain: number;
  isPlaying: boolean;
}

/** 交给后端的增益：WPE 的 `min(1, volume²·G)` 除以垫片主增益乘的 h（= G）；G 为 0 时不出声。 */
export function soundGain(volume: number, globalVolume: number): number {
  return globalVolume > 0 ? Math.min(1, volume * volume * globalVolume) / globalVolume : 0;
}

export class SoundScheduler {
  private sound: SceneSound;
  /** 还能用的文件下标（WPE 读不出的从列表删掉）。 */
  private available: number[];
  private readonly instances: SoundInstanceState[];
  private volume: number;
  private globalVolume = 0;
  private silent: boolean;
  private scriptPaused = false;
  /** bit31：初值置位，`U` 在第一次 `P` 之前直接跳过。 */
  private stopped = true;
  private T = 0;
  private Rm = 0;
  private pending: PendingStart | null = null;
  private current: number | null = null;

  constructor(
    sound: SceneSound,
    private readonly backend: SoundBackend,
    private readonly random: () => number,
  ) {
    this.sound = sound;
    this.available = sound.files.map((_, index) => index);
    this.instances = sound.files.map(() => "stopped");
    this.volume = sound.volume;
    this.silent = sound.startSilent;
  }

  /** 对应的对象（`objects` 下标）。 */
  get object(): number {
    return this.sound.object;
  }

  /** 重编译后同一个对象的新声音表（文件表相同，见 `sceneSounds.ts`）：只换字段，播放状态不动。 */
  replaceSound(sound: SceneSound): void {
    this.sound = sound;
  }

  /** WPE 的加载虚函数（+0x40，`FUN_1401f4f20`）：不是 `startsilent` 就 `P`；音量为 0 时 `P` 什么都不放（rea 第 3 节）。 */
  load(globalVolume: number): void {
    this.globalVolume = globalVolume;
    if (!this.silent) this.start();
  }

  /** 每帧：音量变了走 `V`，全局音量变了走全局规则，再走 `U`。`dt` 是钳过的帧时间（秒）。 */
  update(dt: number, volume: number, globalVolume: number): void {
    if (volume !== this.volume) this.setVolume(volume);
    if (globalVolume !== this.globalVolume) this.setGlobalVolume(globalVolume);
    this.tick(dt);
  }

  /** 对象 `volume` 变了（属性就地写、脚本写）：WPE 的回调 `V`，立即生效、没有渐变。 */
  setVolume(volume: number): void {
    if (volume === this.volume) return;
    this.volume = volume;
    this.applyVolume();
  }

  /** 全局音量变了（`FUN_1401816d0`：值变了才写，再对每个声音走 `V` 的逻辑）。 */
  setGlobalVolume(globalVolume: number): void {
    if (globalVolume === this.globalVolume) return;
    this.globalVolume = globalVolume;
    this.applyVolume();
  }

  /** 后端回报：`file` 真正开始了，时长 `duration` 秒。按开始时的模式设 `T` / `Rm`；过期的回报（已被停掉、换了文件）不理。 */
  onStarted(file: number, duration: number): void {
    const pending = this.pending;
    if (!pending || pending.file !== file) return;
    this.pending = null;
    const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (pending.mode === "loop") this.T = pending.multi ? length : 0;
    else if (pending.mode === "random") {
      this.Rm = length;
      this.T = pending.wait + length;
    } else this.Rm = length;
  }

  /**
   * 后端回报：`file` 读不出或解码失败。照 WPE 从文件列表里删掉、不报错（rea 1.3）；正在等它开始的，用剩下的文件重新走一次 `P`。
   */
  onFailed(file: number): void {
    const index = this.available.indexOf(file);
    if (index >= 0) this.available.splice(index, 1);
    this.instances[file] = "stopped";
    if (this.pending?.file !== file) return;
    this.pending = null;
    if (this.available.length) this.start();
  }

  // ---- 脚本 API（ISoundLayer，步骤 2 接到脚本上） ----

  /** `play()`：就是 `P`（rea 第 7 节，`0x1401f6e50` 直接跳到 `P`）。 */
  play(): void {
    this.start();
  }

  /** `stop()`：就是 `X`：停掉全部、回到开头，`T` 清零，`Rm` 不清（rea 第 7 节）。 */
  stop(): void {
    this.stopAll();
  }

  /** `pause()`：没被暂停、也没停止时，置脚本暂停位并暂停在放的实例；重复调用无害（rea 第 7 节，实测）。 */
  pause(): void {
    if (this.scriptPaused || this.stopped) return;
    this.scriptPaused = true;
    this.instances.forEach((state, file) => {
      if (state !== "playing") return;
      this.backend.pause(file);
      this.instances[file] = "paused";
    });
  }

  /**
   * `isPlaying()`（`0x1401f6fb0`）：`single` 看 `Rm`，`random` 看 `T`，其余看「有实例不是停止、且没被脚本暂停」。所以 `random`
   * 在两段之间的等待里为真；WPE 自身暂停（全局音量 0，实例变暂停）时仍为真；`single` 放完后为假（实测）。
   * 等后端回报开始的那一下按 WPE 当场的值算（WPE 同步拿到时长）。
   */
  isPlaying(): boolean {
    const { mode } = this.sound;
    if (mode === "single" && this.Rm <= 0 && !this.pending) return false;
    if (mode === "random" && this.T <= 0 && !this.pending) return false;
    return !this.scriptPaused && this.instances.some((state) => state !== "stopped");
  }

  snapshot(): SoundSchedulerSnapshot {
    return {
      mode: this.sound.mode,
      file: this.current,
      available: [...this.available],
      instances: [...this.instances],
      silent: this.silent,
      scriptPaused: this.scriptPaused,
      stopped: this.stopped,
      pending: this.pending !== null,
      T: this.T,
      Rm: this.Rm,
      volume: this.volume,
      globalVolume: this.globalVolume,
      gain: soundGain(this.volume, this.globalVolume),
      isPlaying: this.isPlaying(),
    };
  }

  // ---- WPE 的四个函数 ----

  /** `volume² · G`：开始与计时的门槛（`P` 第 1 步、`U`）。 */
  private get audible(): boolean {
    return this.volume * this.volume * this.globalVolume > 0;
  }

  /** `P`（rea 2.1）。 */
  private start(): void {
    const { mode } = this.sound;
    // 1. 音量为 0：什么都不读、不放，只清停止位、脚本暂停位与 startsilent 位（之后音量变正时由 `V` 再调 `P`）
    if (!this.audible) {
      this.stopped = false;
      this.scriptPaused = false;
      this.silent = false;
      return;
    }
    // 2. 文件全部读不出：各模式的分支都要求列表非空，什么都不放（第 7 步照样清位）
    const n = this.available.length;
    if (!n) {
      this.stopped = false;
      this.silent = false;
      return;
    }
    // 4. 单文件 loop 才让实例自己循环；多文件、single、random 由 `T` 换文件
    const loop = n < 2 && mode === "loop";
    // 5. 被脚本暂停：续播第一个暂停的实例，从原处接着放（同一个文件），返回
    if (this.scriptPaused) {
      this.scriptPaused = false;
      const file = this.instances.indexOf("paused");
      if (file >= 0) {
        this.backend.resume(file, loop);
        this.instances[file] = "playing";
      }
      return;
    }
    // 6. 按模式：都是停掉、带放回随机选一个、设音量、从头放
    if (mode === "loop") this.begin({ file: this.pick(), mode, multi: n > 1, wait: 0 }, loop);
    else if (mode === "random") {
      // 只在等待计时归零时动作；在放、在等（含等后端回报）时什么都不做
      if (this.T === 0 && !this.pending) {
        const file = this.pick();
        const wait = this.random() * (this.sound.maxtime - this.sound.mintime) + this.sound.mintime;
        this.begin({ file, mode, multi: false, wait }, false);
      }
    } else this.begin({ file: this.pick(), mode, multi: false, wait: 0 }, false);
    // 7. 清停止位与 startsilent 位
    this.stopped = false;
    this.silent = false;
  }

  /** `P` 第 6 步的共同部分：`X`、设音量、从头放；`T` / `Rm` 等后端回报。 */
  private begin(pending: PendingStart, loop: boolean): void {
    this.stopAll();
    this.backend.setGain(soundGain(this.volume, this.globalVolume));
    this.pending = pending;
    this.current = pending.file;
    this.instances[pending.file] = "playing";
    this.backend.start(pending.file, loop);
  }

  /** 带放回均匀选（rea 2.2：`min(int(rand() / 32767 · n), n − 1)`，可以连选同一个）。 */
  private pick(): number {
    const n = this.available.length;
    return this.available[Math.min(Math.max(Math.floor(this.random() * n), 0), n - 1)];
  }

  /** `X`（`FUN_1401f58e0`）：清脚本暂停位、置停止位、`T` = 0，停掉状态不是停止的实例。 */
  private stopAll(): void {
    this.scriptPaused = false;
    this.stopped = true;
    this.T = 0;
    this.pending = null;
    this.instances.forEach((state, file) => {
      if (state === "stopped") return;
      this.backend.stop(file);
      this.instances[file] = "stopped";
    });
  }

  /** `U`（rea 2.3）：被脚本暂停或已停止时整个跳过；等后端回报开始时不计时（见文件头）。 */
  private tick(dt: number): void {
    if (this.scriptPaused || this.stopped || this.pending) return;
    if (this.audible && this.T > 0) {
      this.T -= dt;
      if (this.T <= 0) {
        this.T = 0;
        this.start();
      }
    }
    if (this.globalVolume > 0 && this.Rm > 0) this.Rm -= dt;
  }

  /** `V`（rea 5.2）；全局音量变化对每个声音走同一段（4.1）。 */
  private applyVolume(): void {
    const { mode } = this.sound;
    // 1. 不是 single：没有实例在用（random 还要等待计时归零）、且三个位都没置时，从头开始。音量从 0 变正、全局音量从 0 变正
    //    而之前从没开始过的就是这样开始的（实测 `p6a-silent`）
    if (mode !== "single") {
      const busy = (mode !== "random" || this.T > 0) && this.instances.some((state) => state !== "stopped");
      if (!busy && !this.scriptPaused && !this.silent && !this.stopped) this.start();
    }
    // 2. 设增益，立即生效
    this.backend.setGain(soundGain(this.volume, this.globalVolume));
    if (this.globalVolume > 0) {
      // 续播第一个暂停的实例（没被脚本暂停时）；`loop` 参数照 WPE 传「模式是 loop」，不看文件数
      if (this.scriptPaused) return;
      const file = this.instances.indexOf("paused");
      if (file < 0) return;
      this.backend.resume(file, mode === "loop");
      this.instances[file] = "playing";
      return;
    }
    // G 为 0：暂停在放的；single / random 已放完的（`Rm ≤ 0`）停掉
    this.instances.forEach((state, file) => {
      if (state !== "playing") return;
      this.backend.pause(file);
      this.instances[file] = "paused";
    });
    if (mode !== "loop" && this.Rm <= 0 && !this.pending)
      this.instances.forEach((state, file) => {
        if (state === "stopped") return;
        this.backend.stop(file);
        this.instances[file] = "stopped";
      });
  }
}
