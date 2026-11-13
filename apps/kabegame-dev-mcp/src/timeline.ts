/**
 * 粒子回放的时间线（第 4 批）：按 WPE 日志与 RenderDoc 轨迹组出 dev 探针要的 `dts`、`times`、逐帧光标。MCP 的
 * `render_scene` / `host_render` / `particle_track` / `particle_corners` 用它，脚本也能 import。
 *
 * 规则照 P4 各步的回放脚本（`ignore/p4/b5v/real.mjs` 的 `logDts`、`b3/replay.test.ts` 的 `dtsWithGap`、`b4/replay.test.ts`
 * 的场景时间）：
 * - 第 f 帧的 dt = 日志里第 f 帧的累计时间减第 f − 1 帧的（第 1 帧就是它自己的累计时间），四舍五入到 6 位小数（同 b3 / b4 /
 *   c1；日志两列都是 6 位小数，差分是精确的 6 位小数，舍入只去掉浮点减法的尾巴）。b5v、step4 的 `logDts` 没舍入：2026-11-09
 *   在 p4b-refract f907 / f910、s60 f718 / f725、p4c-cp f927 上逐帧核对，进模拟器的 `f32(dt)` 与 drag 的 `f32(0.025 / dt)` 两种
 *   写法全部相同（`ignore/p4/dev4/check-timeline.ts`）。不用 frametime 列：差分不累积舍入。`g_Time` 取日志的累计时间（b5v、
 *   step4 没传 `times`，探针按 dt 累加；p4b-refract f907 两者的 float32 逐帧相同，s60 f725 有 2 帧不同）。
 * - 抓到的帧（轨迹里有的）dt 换成轨迹的 float32 原值，`g_Time` 也取轨迹的值。
 * - 日志和轨迹都没有的帧（fps 低时日志每 50 帧才刷一次，尾巴会缺）缺省报错并列出缺哪些帧。`gap: "split"` 时把缺的那一段
 *   按「后一个已知帧的 g_Time − 它的 dt」（即缺的那段结束时刻）减「前一帧的 g_Time」平分，dt 同样舍入到 6 位小数，
 *   `g_Time` 按 dt 累加（b4）；结果里写明哪些帧是平分出来的。缺的那段后面没有已知帧时没法平分，照样报错。
 * - 逐帧光标：单位一律是 WPE 的 `g_PointerPosition`（壁纸窗口归一化、原点左上、y 朝下、不钳制），换到场景上由 dev 探针按
 *   `fill` 铺放做（`sceneCursor`，窗口尺寸用 `Timeline.window`），调用方不自己换算（P5a 收尾：回放逐帧光标）。
 *   - `cursors: "log"`：第 f 帧取日志第 f 帧的屏幕光标除以窗口尺寸再取 float32（`p5a-cur` / `p5a-cur3` 实测 `g_PointerPosition`
 *     逐位等于它；脚本第 f 帧记下的光标就是粒子第 f 帧用的，错一帧回放差 340 像素）。日志缺的帧（没刷出来、或那一帧是 `nan`）
 *     沿用前一个已知帧，开头缺就用后一个，`cursorsFilled` 列出这些帧。抓到的帧上和轨迹的 `pointer` 逐帧核对（`cursorCheck`）。
 *   - `cursors: "track"`：抓到的帧取轨迹的 `pointer`（没有就退回 `cursor`），其余帧取 `cursor`（缺省 `[0.5, 0.5]`）；
 *   - 直接给整串（长度 = frame）；只给 `cursor` 时每帧都是它。
 * - 窗口尺寸：`window` 参数，没给就从轨迹的 tag、再从日志的标签读末尾的 `-<宽>x<高>`，都推不出为 null（`"log"` 时报错）。
 *
 * 日志里只读 `[kbp]` 条目，三列 `帧号,帧时间,累计时间` 或五列 `帧号,帧时间,累计时间,屏幕x,屏幕y`（`write_project(…, cursor=True)`
 * 的 FR_CURSOR），同一个文件里不能混用；两列时间都要是 6 位小数（少了多半是行被截断），光标两列是有限数或 `nan`（脚本读光标失败）；
 * 帧号递增不重复（同一个文件里有两次运行就报错，截出一次的）。
 * 精确日志（P10a 走查）：FR 脚本把两列时间按 `String()` 原样写、每行 `[kbp]` 之后带标记 `@f64`。这种日志的第 f 帧 dt 直接取帧时间列、
 * `g_Time` 取累计时间列，不差分、不舍入：WPE 的动画时钟与视差平滑按 float32 帧时间逐帧累加，6 位小数差分回放几百帧后差 1 个尾数
 * （`2251857160-iso-frost` 第 331、332 帧的 `mask` 缩放、`g_ParallaxPosition`）。一个文件里带标记与不带的行不能混用。轨迹是 Python 写的 JSON，可能带 `NaN` / `Infinity`
 * （`rd-p4c-sprite-fps60.json` 的 corners），解析前换成 null。
 *
 * 频谱（P11a，`audio`）：录制文件是 `kbp rdc consts` 的输出（每张抓帧一行，`draws[].vs / ps` 里是这次绘制读到的常量），或 `kbp rdc track`
 * 的轨迹（`frames[].audio`，生成工程的 CLK 读到的数组）。每个录到的帧取 `g_AudioSpectrum{16,32,64}{Left,Right}`：同一帧各绘制的同名数组
 * 要相同（WPE 每帧只写一份），没读到的段按 WPE 的取法往下推（32 段 = 64 段两两取大、16 段 = 32 段两两取大，P11 步骤 0 实测逐位成立），
 * 推不出的（比如只读了 16 段时的 32、64 段）不给、探针写 0。对齐成和 `dts` 等长的逐帧频谱：录到的帧是这一帧的值，其余 null（探针沿用
 * 前一帧）；读回那一帧必须录到，否则报错。
 *
 * FR 帧号块的颜色（kabegame-chromium 第 6 批，`frColor`）：kbp 测试工程第一个对象 FR 的颜色由字段脚本每帧写，只取决于 WPE 脚本帧号，
 * 回放到第 N 帧时 MCP 按它把 FR 涂成那一帧的颜色交给探针（探针不跑脚本）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { SpectrumFrame } from "../../../scripts/kabegame-dev/types.ts";

export type Point = [number, number];

/**
 * kbp 测试工程 FR 帧号块在第 `frame` 帧（WPE 脚本帧号，从 1 起）的颜色：`((N % 256) / 255, (⌊N / 256⌋ % 256) / 255, 1)`。
 * 这是第二份：唯一属主是 `.claude/skills/kbp-tools/py/gen.py` 的 `FR_COLOR` / `FR_CURSOR`（`update` 里的 `value.x` / `.y` / `.z`），
 * 改了要两边一起改。写法照脚本（先取模再除以 255），值和 WPE 里脚本算出的双精度相同，进 uniform 时同样取 float32。
 */
export function frColor(frame: number): [number, number, number] {
  return [(frame % 256) / 255, (Math.floor(frame / 256) % 256) / 255, 1];
}

export interface TimelineSource {
  /** WPE 日志文件（`ignore/p4/out/<标签>-log.txt`），只读里面的 `[kbp]` 行。 */
  log: string;
  /** RenderDoc 轨迹文件（`ignore/p4/tracks/rd-<标签>.json`），可选：给了时抓到的帧用它的 dt、g_Time、pointer。 */
  track?: string;
  /** 回放到这一帧（WPE 脚本帧号，从 1 起），即读回的那一帧；缺省为轨迹里最后一帧。 */
  frame?: number;
  /** 日志与轨迹都缺的帧：缺省报错；"split" 按下一个已知 g_Time 平分。 */
  gap?: "error" | "split";
  /**
   * 逐帧光标（`g_PointerPosition`，窗口归一化）："log" 取日志的屏幕光标 ÷ 窗口尺寸（float32），缺的帧沿用相邻帧；
   * "track" 抓到的帧取轨迹 pointer、其余取 cursor；或直接给整串（长度 = frame）。
   */
  cursors?: "log" | "track" | Point[];
  /** `cursors` 为 "track" 时其余帧的光标（缺省 `[0.5, 0.5]`）；不给 `cursors` 时每帧都是它。和 "log" 不同给。 */
  cursor?: Point;
  /** 抓帧窗口尺寸 `[宽, 高]`（像素）；缺省从轨迹 tag、再从日志标签末尾的 `-<宽>x<高>` 读。 */
  window?: Point;
  /** 频谱的录制文件（P11a）：`kbp rdc consts` 的输出，或带 `frames[].audio` 的 `kbp rdc track` 轨迹。 */
  audio?: string;
}

/** 一段频谱从哪来：抓帧里读到的、按 WPE 的取法推出来的、没有（探针写 0）。 */
export type SpectrumSource = "recorded" | "derived" | "missing";

/** 时间线的频谱（P11a）。 */
export interface TimelineAudio {
  file: string | null;
  /** 和 `dts` 等长：录到的帧是这一帧的频谱，其余 null（探针沿用前一帧）。 */
  frames: (SpectrumFrame | null)[];
  /** 录到频谱的帧号（不超过读回帧）。 */
  recorded: number[];
  /** 读回那一帧 16 / 32 / 64 段各自的来源（左右总是一起读）。 */
  readback: Record<"16" | "32" | "64", SpectrumSource>;
}

/** 平分出来的一段。 */
export interface TimelineGap {
  from: number;
  to: number;
  /** 这一段的总时长（秒，没舍入）。 */
  total: number;
  /** 每帧的 dt（舍入到 6 位小数）。 */
  dt: number;
}

export interface Timeline {
  dts: number[];
  times: number[];
  cursors?: Point[];
  /** 轨迹里抓到的帧号（不超过 frame）。 */
  captured: number[];
  /** 平分出来的帧号。 */
  split: number[];
  /** 回放到的帧（= dts.length）。 */
  frame: number;
  gaps: TimelineGap[];
  /** `cursors: "track"` 时用了轨迹 pointer 的帧号。 */
  cursorsFromTrack: number[];
  /** 逐帧光标从哪来：日志（"log"）、轨迹（"track"）、整串（"list"）、只给了 `cursor`（"cursor"）；没有逐帧光标为 null。 */
  cursorsFrom: "log" | "track" | "list" | "cursor" | null;
  /** `cursors: "log"` 时日志里没有这一帧的光标（没刷出来或是 `nan`）、沿用相邻已知帧的帧号。 */
  cursorsFilled: number[];
  /**
   * `cursors: "log"` 时抓到的帧上日志光标（换算后）与轨迹 `pointer` 的核对：比了哪几帧（两边都有值的）、最大差（两个分量取大），
   * 以及不相等的帧。不是 "log" 时为 null。
   */
  cursorCheck: { frames: number[]; maxDiff: number; mismatched: number[] } | null;
  /** 日志条目带光标列（五列）。 */
  logCursors: boolean;
  /** 精确日志（`@f64`）：dt 取日志的帧时间列；否则由累计时间差分、舍入到 6 位小数。 */
  logExact: boolean;
  /** 抓帧窗口尺寸 `[宽, 高]`：参数给的，或从标签推出；推不出为 null。 */
  window: Point | null;
  /** 窗口尺寸从哪来：参数（"param"）、轨迹 tag（"track"）、日志标签（"log"）。 */
  windowFrom: "param" | "track" | "log" | null;
  /** 标签：轨迹的 `tag`，没有轨迹时取日志文件名（去掉 `-log.txt`）。 */
  tag: string | null;
  /** 从标签里的 `fps<N>` 推出的 operator 遍数（1–20 两遍），推不出为 null。 */
  passes: { passes: 1 | 2; tag: string; fps: number } | null;
  /** 日志覆盖的帧号范围与轨迹的帧号。 */
  log: { file: string | null; first: number; last: number };
  track: { file: string | null; frames: number[] } | null;
  /** 频谱（P11a）：给了 `audio` 才有。 */
  audio?: TimelineAudio;
}

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineError";
  }
}

/** 轨迹里时间线用到的部分。 */
export interface TrackTimingFrame {
  frame: number;
  dt: number;
  time?: number;
  pointer?: Point | null;
}

export interface TrackTiming {
  tag?: string;
  frames: TrackTimingFrame[];
}

const round6 = (value: number) => Number(value.toFixed(6));
const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "number" && Number.isFinite(x));

/** 读出的 `[kbp]` 日志。 */
export interface KbpLog {
  /** 帧号 → 累计时间（秒）。 */
  runtime: Map<number, number>;
  /**
   * 五列时：帧号 → 屏幕光标（`input.cursorScreenPosition`，壁纸窗口内的像素，原点左上、y 朝下，窗口外为负或超出尺寸）；
   * 这一帧写的是 `nan`（脚本读光标失败）时为 null。三列时整个为 null。
   */
  cursors: Map<number, Point | null> | null;
  /** 条目的列数。 */
  columns: 3 | 5;
  /** 精确日志（每行带 `@f64`）时：帧号 → 帧时间（秒，`String()` 原样）；老日志（6 位小数）为 null，dt 由累计时间差分。 */
  frametime: Map<number, number> | null;
}

const TIME = String.raw`\d+\.\d{6}`;
// `String()` 写出的数：整数、小数、指数（`1e-7`、`1e+21`），或 `nan`（脚本读光标失败；`String(NaN)` 的 `NaN` 同样当缺）
const COORD = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[nN]a[nN]`;
const THREE_COLUMNS = new RegExp(String.raw`^(\d+),(${TIME}),(${TIME})$`);
const FIVE_COLUMNS = new RegExp(String.raw`^(\d+),(${TIME}),(${TIME}),(${COORD}),(${COORD})$`);
// 精确日志（`@f64`）的两列时间：`String()` 写出的非负数（整数、小数、指数）
const EXACT_TIME = String.raw`\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const EXACT_THREE = new RegExp(String.raw`^(\d+),(${EXACT_TIME}),(${EXACT_TIME})$`);
const EXACT_FIVE = new RegExp(String.raw`^(\d+),(${EXACT_TIME}),(${EXACT_TIME}),(${COORD}),(${COORD})$`);
/** 精确日志每行 `[kbp]` 之后的标记。 */
export const EXACT_LOG_MARK = "@f64";

/** 光标列的一项：`nan` 为 null。 */
const coord = (text: string): number | null => (/^nan$/i.test(text) ? null : Number(text));

/**
 * WPE 日志里的 `[kbp]` 条目：三列（帧号,帧时间,累计时间）或五列（另加屏幕x,屏幕y），同一个文件里不能混用。
 * 回帧号 → 累计时间，五列时另回帧号 → 屏幕光标；精确日志（每行 `[kbp] @f64`）另回帧号 → 帧时间，带标记与不带的行不能混用。
 */
export function readKbpLog(text: string): KbpLog {
  const runtime = new Map<number, number>();
  const frametime = new Map<number, number>();
  const cursors = new Map<number, Point | null>();
  let columns: 3 | 5 | null = null;
  let exact: boolean | null = null;
  let previous = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const at = line.indexOf("[kbp]");
    if (at < 0) continue;
    const tokens = line
      .slice(at + 5)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const marked = tokens[0] === EXACT_LOG_MARK;
    if (exact !== null && exact !== marked) {
      throw new TimelineError(
        `日志第 ${index + 1} 行${marked ? "带" : "不带"} ${EXACT_LOG_MARK}，前面的行${exact ? "带" : "不带"}：` +
          "同一个文件里精确日志和 6 位小数的老日志不能混用（多半是两个工程的日志拼在一起），只截出一次的 [kbp] 行",
      );
    }
    exact = marked;
    for (const token of marked ? tokens.slice(1) : tokens) {
      const three = (marked ? EXACT_THREE : THREE_COLUMNS).exec(token);
      const five = three ? null : (marked ? EXACT_FIVE : FIVE_COLUMNS).exec(token);
      const match = three ?? five;
      if (!match && marked) {
        throw new TimelineError(
          `日志第 ${index + 1} 行有读不懂的条目 ${JSON.stringify(token)}：精确日志（${EXACT_LOG_MARK}）应为「帧号,帧时间,累计时间」或另加「,屏幕x,屏幕y」，` +
            "两列时间是 String() 写出的非负数、光标两列是有限数或 nan（少了多半是行被截断）",
        );
      }
      if (!match) {
        // 已经是五列的文件，或第一条就像五列（逗号分出 4 段以上）时按五列说；其余照三列的老文案
        const asFive = columns === 5 || (columns === null && token.split(",").length >= 4);
        throw new TimelineError(
          asFive
            ? `日志第 ${index + 1} 行有读不懂的条目 ${JSON.stringify(token)}：应为「帧号,帧时间,累计时间,屏幕x,屏幕y」，两列时间都是 6 位小数、光标两列是有限数或 nan（少了多半是行被截断）`
            : `日志第 ${index + 1} 行有读不懂的条目 ${JSON.stringify(token)}：应为「帧号,帧时间,累计时间」，两列都是 6 位小数（少了多半是行被截断）`,
        );
      }
      const width = three ? 3 : 5;
      const frame = Number(match[1]);
      if (columns !== null && columns !== width) {
        throw new TimelineError(
          `日志第 ${index + 1} 行第 ${frame} 帧是${width === 5 ? "五" : "三"}列，前面的条目是${columns === 5 ? "五" : "三"}列：` +
            "同一个文件里三列和五列不能混用（多半是两次运行或两个工程的日志拼在一起），只截出一次的 [kbp] 行",
        );
      }
      columns = width;
      if (runtime.has(frame) || frame <= previous) {
        throw new TimelineError(
          `日志第 ${index + 1} 行第 ${frame} 帧${runtime.has(frame) ? "重复" : "帧号倒退"}（前一条是第 ${previous} 帧）：文件里像是有两次运行，只截出一次的 [kbp] 行`,
        );
      }
      previous = frame;
      runtime.set(frame, Number(match[3]));
      if (marked) frametime.set(frame, Number(match[2]));
      if (five) {
        const x = coord(five[4]);
        const y = coord(five[5]);
        cursors.set(frame, x === null || y === null ? null : [x, y]);
      }
    }
  }
  if (!runtime.size) throw new TimelineError("日志里没有 [kbp] 条目");
  return {
    runtime,
    cursors: columns === 5 ? cursors : null,
    columns: columns ?? 3,
    frametime: exact ? frametime : null,
  };
}

/** WPE 日志里的 `[kbp]` 条目：帧号 → 累计时间（秒）。三列、五列都收（光标列见 `readKbpLog`）。 */
export function parseKbpLog(text: string): Map<number, number> {
  return readKbpLog(text).runtime;
}

/** 解析 RenderDoc 轨迹 JSON（容忍 Python 写出的 `NaN` / `Infinity`），校验时间线要用的字段。 */
export function parseTrackJson(text: string): TrackTiming {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/([[,:]\s*)-?(?:NaN|Infinity)(?=\s*[,\]}])/g, "$1null"));
  } catch (error) {
    throw new TimelineError(`轨迹不是 JSON：${(error as Error).message}`);
  }
  const frames = (data as { frames?: unknown })?.frames;
  if (!Array.isArray(frames)) throw new TimelineError("轨迹里没有 frames 数组");
  const seen = new Set<number>();
  const out: TrackTimingFrame[] = frames.map((item, i) => {
    const { frame, dt, time, pointer } = (item ?? {}) as Record<string, unknown>;
    if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1) {
      throw new TimelineError(`轨迹 frames[${i}].frame 要是正整数，收到 ${JSON.stringify(frame)}`);
    }
    if (seen.has(frame)) throw new TimelineError(`轨迹里第 ${frame} 帧出现两次`);
    seen.add(frame);
    if (typeof dt !== "number" || !Number.isFinite(dt) || dt <= 0) {
      throw new TimelineError(`轨迹第 ${frame} 帧的 dt 要是有限正数，收到 ${JSON.stringify(dt)}`);
    }
    if (time !== undefined && (typeof time !== "number" || !Number.isFinite(time))) {
      throw new TimelineError(`轨迹第 ${frame} 帧的 time 要是有限数，收到 ${JSON.stringify(time)}`);
    }
    return {
      frame,
      dt,
      ...(time !== undefined ? { time: time as number } : {}),
      pointer: isPoint(pointer) ? pointer : null,
    };
  });
  const tag = (data as { tag?: unknown }).tag;
  return { ...(typeof tag === "string" ? { tag } : {}), frames: out };
}

/** 标签里的 `fps<N>`（`p4b-fps10`、`2418800402-fps60-1024x575`、`fps10`）推 operator 遍数：N 在 1–20 时两遍，否则一遍。 */
export function passesFromTag(tag: string | null | undefined): { passes: 1 | 2; tag: string; fps: number } | null {
  if (!tag) return null;
  const match = /(?:^|[-_])fps(\d+)(?=$|[-_])/i.exec(tag);
  if (!match) return null;
  const fps = Number(match[1]);
  return { passes: fps >= 1 && fps <= 20 ? 2 : 1, tag, fps };
}

/** 帧号列表写成「1–3、7」。 */
export function frameRanges(frames: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    let j = i;
    while (j + 1 < frames.length && frames[j + 1] === frames[j] + 1) j++;
    parts.push(i === j ? `${frames[i]}` : `${frames[i]}–${frames[j]}`);
    i = j;
  }
  return parts.join("、");
}

/** 标签末尾的 `-<宽>x<高>`（抓帧窗口尺寸，同 kbp replay 的取法），没有为 null。 */
export function windowFromTag(tag: string | null | undefined): Point | null {
  const match = tag ? /-(\d+)x(\d+)$/.exec(tag) : null;
  if (!match) return null;
  const size: Point = [Number(match[1]), Number(match[2])];
  return size[0] > 0 && size[1] > 0 ? size : null;
}

/**
 * 屏幕光标（窗口内像素）→ `g_PointerPosition`：除以窗口尺寸再取 float32（WPE 的 uniform 是 float32；`p5a-cur` 8 帧、`p5a-cur3`
 * 4 帧逐位相等）。
 */
export function pointerFromScreen(screen: Point, window: Point): Point {
  return [Math.fround(screen[0] / window[0]), Math.fround(screen[1] / window[1])];
}

export interface TimelineInput {
  /** `[kbp]` 日志的文本、已读出的 `KbpLog`，或已解析的帧号 → 累计时间（没有光标列）。 */
  log: string | Map<number, number> | KbpLog;
  track?: TrackTiming | null;
  /** 没有轨迹 tag 时用的标签（通常是日志文件名去掉 `-log.txt`）。 */
  logTag?: string | null;
  logFile?: string | null;
  trackFile?: string | null;
}

/** 纯函数版：已读出的日志与轨迹 → 时间线。 */
export function timelineFrom(input: TimelineInput, options: Omit<TimelineSource, "log" | "track"> = {}): Timeline {
  const read: KbpLog =
    typeof input.log === "string"
      ? readKbpLog(input.log)
      : input.log instanceof Map
        ? { runtime: input.log, cursors: null, columns: 3, frametime: null }
        : input.log;
  const log = read.runtime;
  const exact = read.frametime;
  const track = input.track ?? null;
  const captured = new Map((track?.frames ?? []).map((f) => [f.frame, f]));
  const logFrames = [...log.keys()];
  const logFirst = Math.min(...logFrames);
  const logLast = Math.max(...logFrames);
  const trackLast = captured.size ? Math.max(...captured.keys()) : 0;

  if (options.frame !== undefined && (!Number.isInteger(options.frame) || options.frame < 1)) {
    throw new TimelineError(`frame 要是正整数，收到 ${JSON.stringify(options.frame)}`);
  }
  const frame = options.frame ?? trackLast;
  if (!frame) throw new TimelineError("没有轨迹时要给 frame（回放到第几帧）");
  if (frame > Math.max(logLast, trackLast)) {
    throw new TimelineError(
      `frame ${frame} 超出日志与轨迹：日志到第 ${logLast} 帧，轨迹${trackLast ? `到第 ${trackLast} 帧` : "没给"}`,
    );
  }

  const dts: (number | undefined)[] = new Array(frame).fill(undefined);
  const times: (number | undefined)[] = new Array(frame).fill(undefined);
  for (let f = 1; f <= frame; f++) {
    const shot = captured.get(f);
    if (shot) {
      const time = shot.time ?? log.get(f);
      if (time === undefined) throw new TimelineError(`轨迹第 ${f} 帧没有 time，日志里也没有这一帧`);
      dts[f - 1] = shot.dt;
      times[f - 1] = time;
    } else if (exact?.has(f)) {
      // 精确日志：帧时间、累计时间都是 WPE 的原值，不差分、不舍入
      dts[f - 1] = exact.get(f)!;
      times[f - 1] = log.get(f)!;
    } else if (!exact && log.has(f) && (f === 1 || log.has(f - 1))) {
      dts[f - 1] = round6(log.get(f)! - (f === 1 ? 0 : log.get(f - 1)!));
      times[f - 1] = log.get(f)!;
    }
  }

  // 日志与轨迹都缺的帧，按连续段处理
  const runs: [number, number][] = [];
  for (let f = 1; f <= frame; f++) {
    if (dts[f - 1] !== undefined) continue;
    let to = f;
    while (to + 1 <= frame && dts[to] === undefined) to++;
    runs.push([f, to]);
    f = to;
  }
  const gaps: TimelineGap[] = [];
  const split: number[] = [];
  if (runs.length) {
    const missing = runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join("、");
    const where = `日志第 ${logFirst}–${logLast} 帧，轨迹${trackLast ? `第 ${frameRanges([...captured.keys()].sort((x, y) => x - y))} 帧` : "没给"}`;
    if (options.gap !== "split") {
      throw new TimelineError(
        `第 ${missing} 帧日志与轨迹都没有（${where}；fps 低时日志每 50 帧才刷一次，尾巴会缺）。` +
          `传 gap: "split" 按后一个已知帧的 g_Time 平分`,
      );
    }
    for (const [a, b] of runs) {
      if (b === frame) {
        throw new TimelineError(
          `第 ${a === b ? a : `${a}–${b}`} 帧日志与轨迹都没有，后面也没有已知的帧，没法平分（${where}）：把 frame 改到已知的帧`,
        );
      }
      const start = a === 1 ? 0 : times[a - 2]!;
      const end = times[b]! - dts[b]!;
      const total = end - start;
      const count = b - a + 1;
      if (!(total > 0)) {
        throw new TimelineError(
          `第 ${a === b ? a : `${a}–${b}`} 帧要平分的时长不是正数（${total}）：日志与轨迹的时钟对不上`,
        );
      }
      const dt = round6(total / count);
      let time = start;
      for (let f = a; f <= b; f++) {
        time += dt;
        dts[f - 1] = dt;
        times[f - 1] = time;
        split.push(f);
      }
      gaps.push({ from: a, to: b, total, dt });
    }
  }

  // 窗口尺寸：参数给的优先，其次轨迹 tag、日志标签末尾的 -<宽>x<高>
  if (options.window !== undefined && !(isPoint(options.window) && options.window[0] > 0 && options.window[1] > 0)) {
    throw new TimelineError(`window 要是 [宽, 高]（两个正数，像素），收到 ${JSON.stringify(options.window)}`);
  }
  const trackWindow = windowFromTag(track?.tag);
  const logWindow = windowFromTag(input.logTag);
  const window: Point | null = options.window ? [options.window[0], options.window[1]] : (trackWindow ?? logWindow);
  const windowFrom = options.window ? "param" : trackWindow ? "track" : logWindow ? "log" : null;

  let cursors: Point[] | undefined;
  const cursorsFromTrack: number[] = [];
  const cursorsFilled: number[] = [];
  let cursorCheck: Timeline["cursorCheck"] = null;
  let cursorsFrom: Timeline["cursorsFrom"] = null;
  if (options.cursor !== undefined && !isPoint(options.cursor)) {
    throw new TimelineError(`cursor 要是 [x, y]（两个有限数），收到 ${JSON.stringify(options.cursor)}`);
  }
  const fallback: Point = options.cursor ?? [0.5, 0.5];
  if (options.cursors === "log") {
    if (options.cursor !== undefined) {
      throw new TimelineError('cursors 为 "log" 时不收 cursor：日志缺光标的帧沿用相邻的已知帧');
    }
    const screens = read.cursors;
    if (!screens) {
      throw new TimelineError(
        'cursors: "log" 要日志带光标列（五列「帧号,帧时间,累计时间,屏幕x,屏幕y」），这份日志是三列：生成工程时用 write_project(…, cursor=True)',
      );
    }
    if (!window) {
      throw new TimelineError(
        `cursors: "log" 要知道抓帧窗口尺寸：标签（轨迹 ${JSON.stringify(track?.tag ?? null)}、日志 ${JSON.stringify(input.logTag ?? null)}）` +
          "末尾没有 -<宽>x<高>，传 window: [宽, 高]",
      );
    }
    // 缺的帧沿用前一个已知帧；开头缺（前面还没有已知帧）就用日志里第一个有光标的帧，它一定在后面
    const first = [...screens.values()].find((p): p is Point => p !== null);
    if (!first) throw new TimelineError('cursors: "log"：日志里的光标全是 nan，没有可用的逐帧光标');
    cursors = [];
    let previous: Point | null = null;
    for (let f = 1; f <= frame; f++) {
      const own = screens.get(f);
      if (own) previous = own;
      else cursorsFilled.push(f);
      cursors.push(pointerFromScreen(own ?? previous ?? first, window));
    }
    // 抓到的帧上和轨迹 pointer 逐帧比（只比日志真有光标的帧）
    const frames: number[] = [];
    const mismatched: number[] = [];
    let maxDiff = 0;
    for (const f of [...captured.keys()].filter((f) => f <= frame).sort((a, b) => a - b)) {
      const pointer = captured.get(f)?.pointer;
      const own = screens.get(f);
      if (!pointer || !own) continue;
      const mine = pointerFromScreen(own, window);
      const diff = Math.max(Math.abs(mine[0] - pointer[0]), Math.abs(mine[1] - pointer[1]));
      frames.push(f);
      if (diff !== 0) mismatched.push(f);
      maxDiff = Math.max(maxDiff, diff);
    }
    cursorCheck = { frames, maxDiff, mismatched };
    cursorsFrom = "log";
  } else if (options.cursors === "track") {
    cursorsFrom = "track";
    cursors = [];
    for (let f = 1; f <= frame; f++) {
      const pointer = captured.get(f)?.pointer;
      if (pointer) cursorsFromTrack.push(f);
      cursors.push(pointer ? [pointer[0], pointer[1]] : [fallback[0], fallback[1]]);
    }
  } else if (Array.isArray(options.cursors)) {
    if (options.cursor !== undefined) throw new TimelineError("cursors 给了整串时不收 cursor");
    if (options.cursors.length !== frame) {
      throw new TimelineError(`cursors 有 ${options.cursors.length} 项，应和回放的帧数相同（${frame}）`);
    }
    options.cursors.forEach((item, i) => {
      if (!isPoint(item))
        throw new TimelineError(`cursors[${i}] 要是 [x, y]（两个有限数），收到 ${JSON.stringify(item)}`);
    });
    cursors = options.cursors.map(([x, y]) => [x, y]);
    cursorsFrom = "list";
  } else if (options.cursors !== undefined) {
    throw new TimelineError(`cursors 只能是 "log"、"track" 或 [[x, y], …]，收到 ${JSON.stringify(options.cursors)}`);
  } else if (options.cursor !== undefined) {
    cursors = Array.from({ length: frame }, () => [fallback[0], fallback[1]] as Point);
    cursorsFrom = "cursor";
  }

  const tag = track?.tag ?? input.logTag ?? null;
  const passes = passesFromTag(track?.tag) ?? passesFromTag(input.logTag);
  return {
    dts: dts as number[],
    times: times as number[],
    ...(cursors ? { cursors } : {}),
    captured: [...captured.keys()].filter((f) => f <= frame).sort((x, y) => x - y),
    split,
    frame,
    gaps,
    cursorsFromTrack,
    cursorsFrom,
    cursorsFilled,
    cursorCheck,
    logCursors: read.columns === 5,
    logExact: !!exact,
    window,
    windowFrom,
    tag,
    passes,
    log: { file: input.logFile ?? null, first: logFirst, last: logLast },
    track: track ? { file: input.trackFile ?? null, frames: [...captured.keys()].sort((x, y) => x - y) } : null,
  };
}

const SPECTRUM_NAME = /^g_AudioSpectrum(16|32|64)(Left|Right)$/;
type Bands = "16" | "32" | "64";
/** 一帧录到的频谱：`<段数><Left|Right>` → 数组，以及各段的来源。 */
interface RecordedSpectrum {
  arrays: Partial<Record<`${Bands}${"Left" | "Right"}`, number[]>>;
  sources: Record<Bands, SpectrumSource>;
}

/** 两两取大：WPE 的 32 段 = 64 段相邻两项的较大值，16 段同理（P11 步骤 0 实测逐位成立）。 */
export function poolSpectrum(values: readonly number[]): number[] {
  return Array.from({ length: values.length / 2 }, (_, i) => Math.max(values[2 * i], values[2 * i + 1]));
}

/**
 * 解析频谱的录制文件（纯函数）：`kbp rdc consts` 的输出（数组，每项 `{ frame, draws: [{ event, vs?, ps? }] }`），或带 `frames[].audio`
 * 的 `kbp rdc track` 轨迹。返回帧号 → 这一帧的频谱（没读到任何频谱的帧不收）。同一帧两次绘制的同名数组不同、或个数不对时报错。
 */
export function parseSpectrumRecording(text: string): Map<number, RecordedSpectrum> {
  let data: unknown;
  try {
    // 轨迹是 Python 写的 JSON，可能带 NaN / Infinity（同 parseTrackJson）
    data = JSON.parse(text.replace(/\bNaN\b|-?\bInfinity\b/g, "null"));
  } catch (error) {
    throw new TimelineError(`频谱录制不是 JSON：${(error as Error).message}`);
  }
  type Row = { frame?: unknown; draws?: unknown; audio?: unknown };
  const rows: Row[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { frames?: unknown }).frames)
      ? (data as { frames: Row[] }).frames
      : [];
  if (!rows.length) throw new TimelineError("频谱录制要是 kbp rdc consts 的输出（数组）或带 frames 的轨迹，里面没有帧");
  const out = new Map<number, RecordedSpectrum>();
  for (const row of rows) {
    const frame = row?.frame;
    if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1)
      throw new TimelineError(`频谱录制里有一行的 frame 不是正整数：${JSON.stringify(frame)}`);
    if (out.has(frame)) throw new TimelineError(`频谱录制里第 ${frame} 帧出现两次（同一个文件里有两次运行？）`);
    // 这一帧读到的数组：consts 每次绘制的顶点 / 像素阶段，轨迹的 audio
    const groups: Record<string, unknown>[] = [];
    if (Array.isArray(row.draws)) {
      for (const draw of row.draws as { vs?: Record<string, unknown>; ps?: Record<string, unknown> }[])
        for (const stage of [draw?.vs, draw?.ps]) if (stage && typeof stage === "object") groups.push(stage);
    }
    if (row.audio && typeof row.audio === "object") groups.push(row.audio as Record<string, unknown>);
    const arrays: RecordedSpectrum["arrays"] = {};
    for (const group of groups) {
      for (const [name, value] of Object.entries(group)) {
        const match = SPECTRUM_NAME.exec(name);
        if (!match) continue;
        const count = Number(match[1]);
        const ok =
          Array.isArray(value) &&
          value.length === count &&
          value.every((x) => typeof x === "number" && Number.isFinite(x));
        if (!ok)
          throw new TimelineError(
            `第 ${frame} 帧的 ${name} 要是 ${count} 个有限数，收到 ${JSON.stringify(value)?.slice(0, 80)}`,
          );
        const key = `${match[1]}${match[2]}` as keyof RecordedSpectrum["arrays"];
        const seen = arrays[key];
        if (seen && seen.some((x, i) => x !== (value as number[])[i]))
          throw new TimelineError(`第 ${frame} 帧的 ${name} 在两次绘制里不同（WPE 每帧只写一份，录制有问题）`);
        arrays[key] = value as number[];
      }
    }
    if (!Object.keys(arrays).length) continue;
    const sources = {} as Record<Bands, SpectrumSource>;
    for (const [bands, from] of [
      ["64", null],
      ["32", "64"],
      ["16", "32"],
    ] as const) {
      const left = arrays[`${bands}Left`];
      const right = arrays[`${bands}Right`];
      if (left && right) sources[bands] = "recorded";
      else if (left || right)
        throw new TimelineError(`第 ${frame} 帧只读到 g_AudioSpectrum${bands} 的一边（左右应一起读）`);
      else if (from && sources[from] !== "missing") {
        arrays[`${bands}Left`] = poolSpectrum(arrays[`${from}Left`]!);
        arrays[`${bands}Right`] = poolSpectrum(arrays[`${from}Right`]!);
        sources[bands] = "derived";
      } else sources[bands] = "missing";
    }
    out.set(frame, { arrays, sources });
  }
  return out;
}

/** 录到的频谱对齐到第 1…`frame` 帧（纯函数）。读回那一帧（`frame`）没录到时报错。 */
export function alignSpectrum(
  recorded: Map<number, RecordedSpectrum>,
  frame: number,
  file: string | null = null,
): TimelineAudio {
  const last = recorded.get(frame);
  if (!last) {
    const have = [...recorded.keys()].sort((x, y) => x - y);
    throw new TimelineError(
      `读回的第 ${frame} 帧没录到频谱（录到的帧 ${have.length ? frameRanges(have) : "无"}）：回放到录到的帧，或换一份录制`,
    );
  }
  const frames = Array.from({ length: frame }, (_, i): SpectrumFrame | null => {
    const at = recorded.get(i + 1);
    if (!at) return null;
    const { arrays } = at;
    return {
      left: arrays["16Left"]!,
      right: arrays["16Right"]!,
      ...(arrays["32Left"] ? { left32: arrays["32Left"], right32: arrays["32Right"]! } : {}),
      ...(arrays["64Left"] ? { left64: arrays["64Left"], right64: arrays["64Right"]! } : {}),
    };
  });
  return {
    file,
    frames,
    recorded: [...recorded.keys()].filter((f) => f <= frame).sort((x, y) => x - y),
    readback: last.sources,
  };
}

/** 读文件版：相对路径按 `root`（缺省当前目录）解析。 */
export function buildTimeline(source: TimelineSource, options: { root?: string } = {}): Timeline {
  const root = options.root ?? process.cwd();
  if (typeof source?.log !== "string" || !source.log) throw new TimelineError("timeline 要给 log（WPE 日志文件）");
  const logFile = path.resolve(root, source.log);
  let logText: string;
  try {
    logText = readFileSync(logFile, "utf8");
  } catch (error) {
    throw new TimelineError(`读不了日志 ${logFile}：${(error as Error).message}`);
  }
  let track: TrackTiming | null = null;
  let trackFile: string | null = null;
  if (source.track !== undefined) {
    trackFile = path.resolve(root, source.track);
    let trackText: string;
    try {
      trackText = readFileSync(trackFile, "utf8");
    } catch (error) {
      throw new TimelineError(`读不了轨迹 ${trackFile}：${(error as Error).message}`);
    }
    try {
      track = parseTrackJson(trackText);
    } catch (error) {
      throw new TimelineError(`${trackFile}：${(error as Error).message}`);
    }
  }
  let log: KbpLog;
  try {
    log = readKbpLog(logText);
  } catch (error) {
    throw new TimelineError(`${logFile}：${(error as Error).message}`);
  }
  const logTag = path
    .basename(logFile)
    .replace(/-log\.txt$/i, "")
    .replace(/\.txt$/i, "");
  const { log: _log, track: _track, audio: audioSource, ...rest } = source;
  const timeline = timelineFrom({ log, track, logTag, logFile, trackFile }, rest);
  if (audioSource === undefined) return timeline;
  // 频谱（P11a）：录制文件按帧号对齐到这条时间线
  const audioFile = path.resolve(root, audioSource);
  let audioText: string;
  try {
    audioText = readFileSync(audioFile, "utf8");
  } catch (error) {
    throw new TimelineError(`读不了频谱录制 ${audioFile}：${(error as Error).message}`);
  }
  try {
    return { ...timeline, audio: alignSpectrum(parseSpectrumRecording(audioText), timeline.frame, audioFile) };
  } catch (error) {
    throw new TimelineError(`${audioFile}：${(error as Error).message}`);
  }
}

const WINDOW_FROM = { param: "参数给的", track: "轨迹标签", log: "日志标签" } as const;

/** 摘要里的小数：3 位有效数字。 */
const shortNumber = (value: number) => String(Number(value.toPrecision(3)));

/**
 * 时间线的一行说明（工具结果里用）。逐帧光标写清从哪来（日志 / 轨迹 / 沿用）与窗口尺寸；`cursors: "log"` 时抓到的帧上日志光标
 * 和轨迹 `pointer` 不同，另起一行写警告（不报错）；日志带光标列、却没要逐帧光标时提示一句。
 */
export function describeTimeline(timeline: Timeline): string {
  const parts = [`回放 ${timeline.frame} 帧（第 1–${timeline.frame} 帧）`];
  parts.push(
    timeline.captured.length
      ? `抓到的帧 ${frameRanges(timeline.captured)}（dt、g_Time 取轨迹的）`
      : timeline.track
        ? "轨迹里没有不超过这一帧的抓帧"
        : "没给轨迹",
  );
  parts.push(
    timeline.gaps.length
      ? `平分的帧 ${timeline.gaps.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`}（合计 ${g.total.toFixed(6)} s，每帧 ${g.dt}）`).join("、")}`
      : "没有平分的帧",
  );
  // 精确日志（P10a 走查）才说一句；老日志的说明逐字不变
  if (timeline.logExact) parts.push(`日志是精确的（${EXACT_LOG_MARK}）：dt 取帧时间列、g_Time 取累计时间列`);
  const warnings: string[] = [];
  const window = timeline.window
    ? `窗口 ${timeline.window[0]}×${timeline.window[1]}（${WINDOW_FROM[timeline.windowFrom ?? "param"]}）`
    : null;
  if (timeline.cursors && timeline.cursorsFrom === "log") {
    const filled = timeline.cursorsFilled;
    parts.push(
      `逐帧光标：取日志（屏幕光标 ÷ ${window}，float32）` +
        (filled.length ? `，日志缺光标、沿用相邻帧的 ${frameRanges(filled)}` : "，每一帧日志都有"),
    );
    const check = timeline.cursorCheck;
    if (check?.frames.length) {
      parts.push(`抓到的帧上和轨迹 pointer 核对 ${check.frames.length} 帧，最大差 ${shortNumber(check.maxDiff)}`);
      if (check.mismatched.length) {
        warnings.push(
          `警告：第 ${frameRanges(check.mismatched)} 帧日志光标和轨迹 pointer 不同（最大差 ${shortNumber(check.maxDiff)}）：` +
            "窗口尺寸不对，或日志和轨迹不是同一次运行",
        );
      }
    } else parts.push("抓到的帧上没有可核对的 pointer");
  } else if (timeline.cursors) {
    parts.push(
      timeline.cursorsFromTrack.length
        ? `逐帧光标：${timeline.cursorsFromTrack.length} 帧取轨迹 pointer，其余 ${JSON.stringify(timeline.cursors.find((_, i) => !timeline.cursorsFromTrack.includes(i + 1)) ?? null)}`
        : "逐帧光标：已给",
    );
    if (window) parts.push(`${window}，探针按 fill 换到场景上`);
  } else if (timeline.logCursors) {
    parts.push('日志带光标列，要按每一帧的光标回放传 cursors: "log"');
  }
  if (timeline.audio) {
    const { readback, recorded } = timeline.audio;
    const name = { recorded: "录到", derived: "推出", missing: "没有（写 0）" } as const;
    parts.push(
      `频谱：录到的帧 ${frameRanges(recorded)}，其余帧沿用前一帧；读回帧 16 段${name[readback["16"]]}、32 段${name[readback["32"]]}、` +
        `64 段${name[readback["64"]]}`,
    );
  }
  return [`时间线：${parts.join("；")}`, ...warnings].join("\n");
}
