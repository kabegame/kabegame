/**
 * 粒子的音频系数（P4e 步骤 4）。依据 `.claude/plans/wpe-import/3-scene/phase4/rea-p4e-audio.md`（WPE 2.8.42 读码【确】），实测核对见
 * `p4-particles-REPORT.md`「P4e 语义的实测核对」的「音频」小节。
 *
 * 音频对粒子只是一个系数 `f ∈ [0, 1]`：由无状态的取值函数（`audioCoefficient`，第 1 节）从**这一帧的 16 段归一化频谱**算出，乘在五类
 * 模块的某个量上（第 5 节：发射器的 `rate`、`turbulentvelocityrandom` 的相位范围、`turbulence` / `vortex` / `vortex_v2` 的两个速度）。
 * 各处都是 `audioprocessingmode ≠ 0` 才取（`cmp dword [结构], 0; je`），mode 为 0 时不乘（`moduleAudio` 返回 null）。
 *
 * 频谱是场景的一份状态（`audio/spectrum.ts` 的 `SceneSpectrum`，渲染器每帧在粒子步进之前推进一次），模拟器只拿一个全树共用的只读
 * 引用（`ParticleAudio`）。没有音频（没声明 `supportsaudioprocessing`、订阅被拒、还没收到数据、非 Windows）时两个数组全 0，语料参数
 * 下 `f(0) = 0`（4.4）。预热在加载期，那时频谱也是 0（3.5【推】）。
 */
import type { SceneParticle } from "../compile/particles";
import { f32 } from "./f32";
import type { ParticleFields } from "./modules";

/** 频谱的段数：粒子读 16 段（`ctx+0x2d0`，rea 3.1）。 */
export const AUDIO_BANDS = 16;

/**
 * 一帧的 16 段归一化频谱（`ctx+0x2d0` 块的 `L16`、`R16`，rea 3.1；就是 `g_AudioSpectrum16Left/Right`，3.4），全场景各系统共用、只读；
 * 全 0 表示没有音频。渲染器给的是 `SceneSpectrum` 的 `L16` / `R16`（就地更新、引用不变），回放与 dev 探针直接往里写抓帧读到的值。
 */
export interface ParticleAudio {
  left: Float32Array;
  right: Float32Array;
}

/** 一份全 0 的频谱（新数组）。 */
export function silentParticleAudio(): ParticleAudio {
  return { left: new Float32Array(AUDIO_BANDS), right: new Float32Array(AUDIO_BANDS) };
}

/**
 * 模拟器的缺省频谱（全 0，`ParticleSystem` 构造时用，渲染器建树时换成场景的那份，`setAudio`）。全模块共用一份，**只读**：要往频谱里写
 * 的（回放、探针）一律用自己的数组（`silentParticleAudio`）再 `setAudio`。
 */
export const SILENT_PARTICLE_AUDIO: ParticleAudio = silentParticleAudio();

/**
 * 回放 / dev 探针给的一帧频谱（抓帧里读到的 `g_AudioSpectrum16Left/Right`），各 16 个。32 / 64 段可选（P11a），只进读回那一帧的
 * 音频 uniform（`dev/particleCorners.ts` 的 `replaySpectrum`），粒子照旧只读 16 段。
 */
export interface ParticleAudioFrame {
  left: ArrayLike<number>;
  right: ArrayLike<number>;
  left32?: ArrayLike<number>;
  right32?: ArrayLike<number>;
  left64?: ArrayLike<number>;
  right64?: ArrayLike<number>;
}

/** 把一帧频谱原样（舍入成 float32）写进 `target`，不经归一化；数组引用不变。不是 16 个时抛错。 */
export function writeParticleAudio(target: ParticleAudio, frame: ParticleAudioFrame): void {
  if (frame.left?.length !== AUDIO_BANDS || frame.right?.length !== AUDIO_BANDS)
    throw new Error(`频谱帧的 left / right 应各 ${AUDIO_BANDS} 个`);
  for (let i = 0; i < AUDIO_BANDS; i++) {
    target.left[i] = frame.left[i];
    target.right[i] = frame.right[i];
  }
}

/**
 * 音频字段解析后的形态（`FUN_1401c1e20`，rea 第 2 节【确】；24 字节结构 `a`：`mode` +0、`exponent` +4、`lo` +8、`hi` +0xc、`s` +0x10、
 * `e` +0x14）。`lo` / `hi` 来自 `audioprocessingbounds`（`parseAudioBounds`，第二个数缺省 0），`start` / `end` 按无符号钳到 ≤ 15、
 * `end < start` 时已交换（`modules.ts` 的 `normalizeAudio`）。数值都已舍入成 float32（模拟用的字段）。
 */
export interface AudioParams {
  mode: number;
  exponent: number;
  lo: number;
  hi: number;
  start: number;
  end: number;
}

/** 模拟用的字段 → `AudioParams`，按字段对象缓存（字段对象建系统时、`setInstance` 重乘时才换）。 */
const paramsCache = new WeakMap<ParticleFields, AudioParams>();

export function audioParams(fields: ParticleFields): AudioParams {
  let params = paramsCache.get(fields);
  if (!params) {
    const [lo, hi] = fields.audioprocessingbounds as number[];
    // WPE 存成 float（`atof` / `asFloat` 之后转 float，rea 第 2 节）：`"0.8 1.0"` 这类不是 float32 精确数的值要先舍入，阈值附近才和
    // `subss` 逐位相同（Claude 验收补）
    params = {
      mode: fields.audioprocessingmode as number,
      exponent: f32(fields.audioprocessingexponent as number),
      lo: f32(lo),
      hi: f32(hi),
      start: fields.audioprocessingfrequencystart as number,
      end: fields.audioprocessingfrequencyend as number,
    };
    paramsCache.set(fields, params);
  }
  return params;
}

/** mode 3 的乘数（`0x1404926c0` = `0x3f000000`）。 */
const HALF = 0.5;

/**
 * 取值函数（`FUN_14022a8a0`，`0x14022a8a0`–`0x14022ab28`，rea 第 1 节【确】），全按 float32：
 * ```
 * mode 1：v = max(L16[s..e])；mode 2：v = max(R16[s..e])；mode 3：v = max_i(R16[i] + L16[i])·0.5（不读 A16）；其它（4 及以上、负数）v = 0
 * t = (v − lo) / (hi − lo)                      // subss、subss、divss
 * t = !(t < 1) ? 1 : (t < 0 ? 0 : t)            // NaN 当 1（double 里钳，进出都是 float，结果同 float 里钳）
 * x = (3 − (t + t))·(t·t)                       // smoothstep
 * r = powf(x, exponent)
 * return !(r < 1) ? 1 : (r < 0 ? 0 : r)         // NaN 当 1
 * ```
 * - 区间两端都含（`jbe`），`v` 初值 0；频谱值总 ≥ 0，`maxss` 与 mode 3 的 `comiss` / `jbe` 写法没有差别。
 * - `hi = lo`：`v > lo` 得 +inf → 1，`v = lo` 得 NaN → 1，`v < lo` 得 −inf → 0；`exponent = 0` 恒为 1；`exponent < 0` 且 `x = 0` 得 inf → 1。
 * - `powf` 是 CRT 实现（`FUN_14041e350`，没读），这里 double 的 `Math.pow` 再舍入，可能差 1 ulp【推】。
 * - 没有状态：只读频谱与 `params`。
 */
export function audioCoefficient(audio: ParticleAudio, params: AudioParams): number {
  const { left, right } = audio;
  const { mode, start, end } = params;
  let v = 0;
  if (mode === 1) {
    for (let i = start; i <= end; i++) if (left[i] > v) v = left[i];
  } else if (mode === 2) {
    for (let i = start; i <= end; i++) if (right[i] > v) v = right[i];
  } else if (mode === 3) {
    for (let i = start; i <= end; i++) {
      const sum = f32(right[i] + left[i]);
      if (sum > v) v = sum;
    }
    v = f32(v * HALF);
  }
  let t = f32(f32(v - params.lo) / f32(params.hi - params.lo));
  t = !(t < 1) ? 1 : t < 0 ? 0 : t;
  const x = f32(f32(3 - f32(t + t)) * f32(t * t));
  const r = f32(Math.pow(x, params.exponent));
  return !(r < 1) ? 1 : r < 0 ? 0 : r;
}

/**
 * 一个模块这一次的音频系数：`audioprocessingmode` 为 0（或字段表里没有它，手写的单测字段）时 null，调用方不乘（WPE 不调取值函数，
 * 相当于系数 1）；否则按 `audio`（缺省全 0）取值。
 */
export function moduleAudio(fields: ParticleFields, audio: ParticleAudio | undefined): number | null {
  if (!fields.audioprocessingmode) return null;
  return audioCoefficient(audio ?? SILENT_PARTICLE_AUDIO, audioParams(fields));
}

/**
 * C 的 `atof`：跳过前导空白（`isspace`），读最长的十进制浮点前缀（含 `inf` / `infinity` / `nan`，不分大小写），读不出时 0。
 * 十六进制浮点（`0x…`）语料里没有，这里只读到 `0`【推】。
 */
function atof(text: string): number {
  const match = /^[ \t\n\v\f\r]*([+-]?)(?:(inf(?:inity)?)|(nan)|((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))/i.exec(text);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  if (match[2]) return sign * Infinity;
  if (match[3]) return Number.NaN;
  return sign * Number(match[4]);
}

/**
 * `audioprocessingbounds` 的解析（rea 第 2 节【确】）：只认字符串——第一个 `atof` 得 `lo`；再跳到第一个空格（`' '`）、跳过连续空格，
 * 第二个 `atof` 得 `hi`；没有空格时 `hi = atof("") = 0`（`"1"` 解析成 `(1, 0)`）。不是字符串时 WPE 按 `asCString` 的原始指针读：数字 0
 * 得 `(0, 0)`；其它（非零数字【推】崩溃或读到垃圾、布尔、数组、对象）返回 undefined，能力表照报 `…:audioprocessingbounds`。
 */
export function parseAudioBounds(raw: unknown): [number, number] | undefined {
  if (typeof raw === "number") return raw === 0 ? [0, 0] : undefined;
  if (typeof raw !== "string") return undefined;
  const lo = atof(raw);
  let i = raw.indexOf(" ");
  if (i < 0) return [lo, 0];
  while (raw[i] === " ") i++;
  return [lo, atof(raw.slice(i))];
}

/**
 * 一棵粒子系统树（含子系统）里有没有 `audioprocessingmode ≠ 0` 的模块（编译期统计「场景用音频」位，`SceneBundle.audio`）。只有读音频的
 * 六个模块登记了这个字段，其它模块的字段表里没有它。
 */
export function particleUsesAudio(
  def: Pick<SceneParticle, "emitters" | "initializers" | "operators" | "children">,
): boolean {
  for (const modules of [def.emitters, def.initializers, def.operators])
    if (modules.some((module) => !!module.fields.audioprocessingmode)) return true;
  return (def.children ?? []).some((child) => particleUsesAudio(child.system));
}
