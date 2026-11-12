/**
 * 场景频谱（P4e 步骤 4）：WPE 渲染线程每帧对采集线程的原始频谱做的自适应归一化，以及由它逐级取最大得到的 64 / 32 / 16 段。依据
 * `.claude/plans/wpe-import/3-scene/phase4/rea-p4e-audio.md` 3.1、3.3（`FUN_140111085`，`0x140111654`–`0x1401131c1`，读码【确】），时序 3.5。
 *
 * 频谱分三层：最底层是采集线程的原始输出（左右各 64 段线性幅值，rea 3.2），由 Rust 的 `WpeMediaHub` 经 Channel 每 33 ms 推一份 128 个值
 * （左 64 + 右 64），宿主只存最近一份；中间层（本文件）是每帧的归一化——64 段每 8 段一组、16 组各有一个慢慢跟随的峰值，每段除以本组峰值，
 * 再一阶低通与每帧限幅，静音时整块清零；最上层是 `A64 = (L + R)/2`，32 段、16 段由相邻两段取最大逐级得到。粒子（`L16` / `R16`）、
 * 脚本的 `registerAudioBuffers` 与将来的 `g_AudioSpectrum*` uniform（P11）都读这一份。
 *
 * 一个场景一份，归渲染器所有（`render/renderer.ts`），每帧在粒子步进之前推进一次（`advance`）。输出数组就地更新、引用不变：粒子树与脚本
 * 缓冲持有的是这些数组（或从它们拷）。状态 `S1`、`S2`、`peak` 建时清零（WPE 在场景窗口构造时分配并清零，`FUN_14010db90`）。
 * 麦克风路径（标志 bit0，不归一化、原值直接进 `A` 与 32 / 16 段）不做：Hub 只开回环。
 */

/** 每声道段数（原始频谱与 64 段输出）。 */
const BANDS = 64;
/** 原始频谱的值数：左 64 + 右 64。 */
const RAW_VALUES = BANDS * 2;
/** 组数：每 8 段一组，组 0–7 是 L64，8–15 是 R64（rea 3.3）。 */
const GROUPS = 16;
const GROUP_SIZE = RAW_VALUES / GROUPS;

const f32 = Math.fround;
/** `0x1404925fc`：静音判定、峰值到位的阈值。 */
const EPSILON = f32(1e-4);
/** `0x140492698` = `0x3eaa7efa`：组峰值目标的下限是全体最大的这么多倍。 */
const FLOOR_RATIO = f32(0.333);
/** `0x140492608`：组峰值取倒数前的下限。 */
const PEAK_MIN = f32(0.001);

/** 一个分辨率的左、右、平均三段（`registerAudioBuffers` 的 left / right / average，rea 3.4【推】）。 */
export interface SpectrumBlock {
  left: Float32Array;
  right: Float32Array;
  average: Float32Array;
}

export class SceneSpectrum {
  /** `ctx+0x2c0` 块（rea 3.1）：`[L64 | R64 | A64]`。原始频谱拷进前 128 个值，在原地归一化。 */
  readonly spec64 = new Float32Array(BANDS * 3);
  /** `ctx+0x2c8` 块：`[L32 | R32 | A32]`。 */
  readonly spec32 = new Float32Array(32 * 3);
  /** `ctx+0x2d0` 块：`[L16 | R16 | A16]`，粒子与 `g_AudioSpectrum16*` 读的就是它。 */
  readonly spec16 = new Float32Array(16 * 3);
  readonly L64 = this.spec64.subarray(0, 64);
  readonly R64 = this.spec64.subarray(64, 128);
  readonly A64 = this.spec64.subarray(128, 192);
  readonly L32 = this.spec32.subarray(0, 32);
  readonly R32 = this.spec32.subarray(32, 64);
  readonly A32 = this.spec32.subarray(64, 96);
  readonly L16 = this.spec16.subarray(0, 16);
  readonly R16 = this.spec16.subarray(16, 32);
  readonly A16 = this.spec16.subarray(32, 48);
  /** 低通状态 `S1[128]`（`W+0x1a8`）。 */
  private readonly s1 = new Float32Array(RAW_VALUES);
  /** 限幅状态 `S2[128]`（`W+0x1a0`），即上一帧的输出。 */
  private readonly s2 = new Float32Array(RAW_VALUES);
  /** 16 组的峰值（`W+0x1b0`）。 */
  private readonly peak = new Float32Array(GROUPS);
  /** 本帧各组的倒数（临时）。 */
  private readonly inv = new Float32Array(GROUPS);
  private readonly target = new Float32Array(GROUPS);
  private disabled = false;

  /** 某个分辨率的三段（引用不变）。 */
  block(resolution: 16 | 32 | 64): SpectrumBlock {
    if (resolution === 64) return { left: this.L64, right: this.R64, average: this.A64 };
    if (resolution === 32) return { left: this.L32, right: this.R32, average: this.A32 };
    return { left: this.L16, right: this.R16, average: this.A16 };
  }

  /** 已关掉（`disable`）：之后 `advance` 不再改输出。 */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * 每帧一次（粒子步进之前）：`raw` 是 Hub 最近一次的 128 个原始值（左 64 + 右 64），没有时传 null（当全 0，长度不是 128 的同样当全 0）；
   * `dt` 是这一帧的帧时间（渲染器已钳到 `[0.0001, 0.25]`，同 WPE 帧函数的 `dt`，3.3 末条）。dt 不是正数（暂停、补画）时什么都不做
   * （同 WPE 整帧跳过，3.5：频谱冻结）。照 rea 3.3 逐行写，全按 float32：
   * ```
   * g[j] = max(0, buf[8j .. 8j+7])，M = max_j g[j]
   * tgt[j] = max(0.333·M, g[j])
   * peak[0] ≤ 1e-4 且 M ≥ 1e-4：peak[0..15] = 1           // 只看 peak[0]
   * st = min(dt, 1)；d = tgt[j] − peak[j]
   *   |d| > 1e-4：peak[j] = min(st, |d|)·(d > 0 ? 1 : −0.5) + peak[j]；否则 peak[j] = tgt[j]
   * inv[j] = 1 / max(peak[j], 0.001)                       // WPE 是 rcpps（相对误差 ≤ 3.7e-4），这里按精确值算
   * α = min(20·dt, 1)；up = min(40·dt, 1)；dn = max(−40·dt, −1)
   * M ≥ 1e-4：S1[i] = (buf[i]·inv[i/8] − S1[i])·α + S1[i]；d = S1[i] − S2[i]；buf[i] = (d > 0 ? min(up, d) : max(dn, d)) + S2[i]；S2 = buf
   * 否则：buf[0..127] = 0（S1、S2 不动）
   * A64 = (R64 + L64)·0.5；spec32[j] = max(spec64[2j], spec64[2j+1])；spec16[j] = max(spec32[2j], spec32[2j+1])   // 两个分支都走
   * ```
   */
  advance(raw: ArrayLike<number> | null, dt: number): void {
    if (this.disabled || !(dt > 0)) return;
    const buf = this.spec64;
    const valid = raw !== null && raw.length === RAW_VALUES;
    for (let i = 0; i < RAW_VALUES; i++) buf[i] = valid ? raw[i] : 0;
    const { peak, inv, target, s1, s2 } = this;
    const step = f32(dt);
    let m = 0;
    for (let j = 0; j < GROUPS; j++) {
      let g = 0;
      for (let i = j * GROUP_SIZE; i < (j + 1) * GROUP_SIZE; i++) if (buf[i] > g) g = buf[i];
      target[j] = g;
      if (g > m) m = g;
    }
    const floor = f32(FLOOR_RATIO * m);
    for (let j = 0; j < GROUPS; j++) if (floor > target[j]) target[j] = floor;
    if (peak[0] <= EPSILON && m >= EPSILON) peak.fill(1);
    const st = Math.min(step, 1);
    for (let j = 0; j < GROUPS; j++) {
      const d = f32(target[j] - peak[j]);
      const size = Math.abs(d);
      peak[j] = size > EPSILON ? f32(f32(Math.min(st, size) * (d > 0 ? 1 : -0.5)) + peak[j]) : target[j];
      inv[j] = f32(1 / Math.max(peak[j], PEAK_MIN));
    }
    const alpha = Math.min(f32(20 * step), 1);
    const up = Math.min(f32(40 * step), 1);
    const down = Math.max(f32(-40 * step), -1);
    if (m >= EPSILON) {
      for (let i = 0; i < RAW_VALUES; i++) {
        s1[i] = f32(f32(f32(f32(buf[i] * inv[i >> 3]) - s1[i]) * alpha) + s1[i]);
        const d = f32(s1[i] - s2[i]);
        buf[i] = f32((d > 0 ? Math.min(up, d) : Math.max(down, d)) + s2[i]);
      }
      s2.set(buf.subarray(0, RAW_VALUES));
    } else buf.fill(0, 0, RAW_VALUES);
    for (let i = 0; i < BANDS; i++) this.A64[i] = f32(f32(this.R64[i] + this.L64[i]) * 0.5);
    for (let j = 0; j < this.spec32.length; j++) this.spec32[j] = Math.max(this.spec64[2 * j], this.spec64[2 * j + 1]);
    for (let j = 0; j < this.spec16.length; j++) this.spec16[j] = Math.max(this.spec32[2 * j], this.spec32[2 * j + 1]);
  }

  /**
   * 关掉音频（没声明 `supportsaudioprocessing`、订阅被拒）：三块清零，之后 `advance` 不再改它们（同 WPE 场景窗口 bit3 为 0 时帧函数不碰
   * `ctx` 三块，rea 4.2、4.4）。
   */
  disable(): void {
    this.disabled = true;
    this.spec64.fill(0);
    this.spec32.fill(0);
    this.spec16.fill(0);
  }
}
