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
 * - 逐帧光标：`cursors: "track"` 时抓到的帧取轨迹的 `pointer`（没有就退回 `cursor`），其余帧取 `cursor`（缺省场景中心
 *   `[0.5, 0.5]`）；也可以直接给整串（长度 = frame）；只给 `cursor` 时每帧都是它。光标是「光标下的场景纹理坐标」，抓帧窗口和
 *   场景同尺寸时等于 `g_PointerPosition`，不同尺寸时由调用方换算（P4c 步骤 2）。
 *
 * 日志里只读 `[kbp] 帧号,帧时间,累计时间` 条目，要求两列都是 6 位小数（少了多半是行被截断）、帧号递增不重复（同一个文件里有
 * 两次运行就报错，截出一次的）。轨迹是 Python 写的 JSON，可能带 `NaN` / `Infinity`（`rd-p4c-sprite-fps60.json` 的 corners），
 * 解析前换成 null。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export type Point = [number, number];

export interface TimelineSource {
  /** WPE 日志文件（`ignore/p4/out/<标签>-log.txt`），只读里面的 `[kbp]` 行。 */
  log: string;
  /** RenderDoc 轨迹文件（`ignore/p4/tracks/rd-<标签>.json`），可选：给了时抓到的帧用它的 dt、g_Time、pointer。 */
  track?: string;
  /** 回放到这一帧（WPE 脚本帧号，从 1 起），即读回的那一帧；缺省为轨迹里最后一帧。 */
  frame?: number;
  /** 日志与轨迹都缺的帧：缺省报错；"split" 按下一个已知 g_Time 平分。 */
  gap?: "error" | "split";
  /** 逐帧光标："track" 抓到的帧取轨迹 pointer、其余取 cursor；或直接给整串（长度 = frame）。 */
  cursors?: "track" | Point[];
  cursor?: Point;
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
  /** 标签：轨迹的 `tag`，没有轨迹时取日志文件名（去掉 `-log.txt`）。 */
  tag: string | null;
  /** 从标签里的 `fps<N>` 推出的 operator 遍数（1–20 两遍），推不出为 null。 */
  passes: { passes: 1 | 2; tag: string; fps: number } | null;
  /** 日志覆盖的帧号范围与轨迹的帧号。 */
  log: { file: string | null; first: number; last: number };
  track: { file: string | null; frames: number[] } | null;
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

/** WPE 日志里的 `[kbp]` 条目：帧号 → 累计时间（秒）。 */
export function parseKbpLog(text: string): Map<number, number> {
  const runtime = new Map<number, number>();
  let previous = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    const at = line.indexOf("[kbp]");
    if (at < 0) return;
    for (const token of line
      .slice(at + 5)
      .trim()
      .split(/\s+/)
      .filter(Boolean)) {
      const match = /^(\d+),(\d+\.\d{6}),(\d+\.\d{6})$/.exec(token);
      if (!match) {
        throw new TimelineError(
          `日志第 ${index + 1} 行有读不懂的条目 ${JSON.stringify(token)}：应为「帧号,帧时间,累计时间」，两列都是 6 位小数（少了多半是行被截断）`,
        );
      }
      const frame = Number(match[1]);
      if (runtime.has(frame) || frame <= previous) {
        throw new TimelineError(
          `日志第 ${index + 1} 行第 ${frame} 帧${runtime.has(frame) ? "重复" : "帧号倒退"}（前一条是第 ${previous} 帧）：文件里像是有两次运行，只截出一次的 [kbp] 行`,
        );
      }
      previous = frame;
      runtime.set(frame, Number(match[3]));
    }
  });
  if (!runtime.size) throw new TimelineError("日志里没有 [kbp] 条目");
  return runtime;
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

export interface TimelineInput {
  /** `[kbp]` 日志的文本，或已解析的帧号 → 累计时间。 */
  log: string | Map<number, number>;
  track?: TrackTiming | null;
  /** 没有轨迹 tag 时用的标签（通常是日志文件名去掉 `-log.txt`）。 */
  logTag?: string | null;
  logFile?: string | null;
  trackFile?: string | null;
}

/** 纯函数版：已读出的日志与轨迹 → 时间线。 */
export function timelineFrom(input: TimelineInput, options: Omit<TimelineSource, "log" | "track"> = {}): Timeline {
  const log = typeof input.log === "string" ? parseKbpLog(input.log) : input.log;
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
    } else if (log.has(f) && (f === 1 || log.has(f - 1))) {
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

  let cursors: Point[] | undefined;
  const cursorsFromTrack: number[] = [];
  if (options.cursor !== undefined && !isPoint(options.cursor)) {
    throw new TimelineError(`cursor 要是 [x, y]（两个有限数），收到 ${JSON.stringify(options.cursor)}`);
  }
  const fallback: Point = options.cursor ?? [0.5, 0.5];
  if (options.cursors === "track") {
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
  } else if (options.cursors !== undefined) {
    throw new TimelineError(`cursors 只能是 "track" 或 [[x, y], …]，收到 ${JSON.stringify(options.cursors)}`);
  } else if (options.cursor !== undefined) {
    cursors = Array.from({ length: frame }, () => [fallback[0], fallback[1]] as Point);
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
    tag,
    passes,
    log: { file: input.logFile ?? null, first: logFirst, last: logLast },
    track: track ? { file: input.trackFile ?? null, frames: [...captured.keys()].sort((x, y) => x - y) } : null,
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
  let log: Map<number, number>;
  try {
    log = parseKbpLog(logText);
  } catch (error) {
    throw new TimelineError(`${logFile}：${(error as Error).message}`);
  }
  const logTag = path
    .basename(logFile)
    .replace(/-log\.txt$/i, "")
    .replace(/\.txt$/i, "");
  const { log: _log, track: _track, ...rest } = source;
  return timelineFrom({ log, track, logTag, logFile, trackFile }, rest);
}

/** 时间线的一行说明（工具结果里用）。 */
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
  if (timeline.cursors) {
    parts.push(
      timeline.cursorsFromTrack.length
        ? `逐帧光标：${timeline.cursorsFromTrack.length} 帧取轨迹 pointer，其余 ${JSON.stringify(timeline.cursors.find((_, i) => !timeline.cursorsFromTrack.includes(i + 1)) ?? null)}`
        : "逐帧光标：已给",
    );
  }
  return `时间线：${parts.join("；")}`;
}
