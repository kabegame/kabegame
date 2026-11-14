/**
 * 一份录制按帧批量渲染我们这边（最终走查的工具 2，`.claude/plans/wpe-import/3-scene/FINAL_CHECK.md`「工具」）。
 *
 * ```text
 * deno run -A apps/kabegame-dev-mcp/src/renderFrames.ts --image <id> --frames 241,242,250-255 --out <目录>
 *   [--timeline-log <日志> [--timeline-track <轨迹>] [--cursors log|track] [--cursor x,y] [--window WxH] [--gap error|split]
 *    [--audio <录制>] [--seed N] [--passes 1|2] [--no-fr]]
 *   [--fps N | --time 秒]                           不给日志时：每帧 g_Time = 帧号 / fps（名义时间），或每帧同一个时刻
 *   [--canvas WxH [--style fill|fit|stretch|center] [--render-mode target|scene]] [--postprocess disabled|enabled|ultra|follow] [--pointer x,y] [--video-time 秒|JSON] [--gif-dts 秒,秒…|JSON]
 *   [--user-properties <JSON 文件或 JSON 串>] [--scripts [--clock 毫秒] [--script-seed N]]
 *   [--trace-frames 250 [--trace-readback 0,"text glyphs"] [--trace-max-vertices N]]
 *   [--reuse-host] [--timeout 秒] [--overwrite]
 * ```
 *
 * 每帧调一次 `render_scene` 的同一份实现：本进程里 `createDevMcpServer()`（和 stdio MCP 同一个工厂、同一组依赖）经 MCP SDK 的
 * `InMemoryTransport` 连一个客户端，按帧 `callTool("render_scene", …)`。时间线、canvas 与窗口的校验、FR 涂色、逐 draw 轨迹的落盘都在
 * 工具里，行为和会话里调 MCP 逐字相同；这里不另写时间线逻辑，只拼参数、收结果。
 * - 回放模式（给 `--timeline-log`）：第 f 帧传 `replay: { timeline: { log, track?, frame: f, … } }`，其余参数原样；
 * - 时刻模式（不给日志）：第 f 帧传 `time: f / fps`（或 `--time` 的固定值），粒子是预热后的状态（同 render_scene 不给 replay）。
 * - 跑场景脚本（kabegame-chromium 第 7 批，`--scripts`）：每一帧的 `render_scene` 都带 `scripts`（`true`，或给了 `--clock` / `--script-seed`
 *   时 `{ clock?, seed? }`），探针照宿主跑场景脚本、外部值来自请求；回放时 FR 由脚本自己画（工具不再涂色，不能和 FR 涂色同时要）。两种模式都收。
 * - 输出：`<out>/ours-f<帧>.png`（`save`，原尺寸，`inline: false`：图片不回到任何会话）、`<out>/frames.json`（每帧的元数据、
 *   PNG 文件 sha256、工具结果里的说明行、错误）；`--trace-frames` 的帧另把逐 draw 轨迹写到 `<out>/trace-f<帧>/`。stdout 一行 JSON 摘要。
 * - 前提：用户自己跑着 `deno task dev -c kabegame`；本工具不启动、不重启任何进程。vite / CDP 不在（`[vite]` / `[cdp]`）时剩下的帧不再试。
 * - 相对路径按当前目录解析，交给工具的一律是绝对路径。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
// 进程内客户端：同 `testdata/sdkClient.ts`，用 `@ts-types` 绕开 Deno 对 SDK 子路径的类型解析问题（见 `sdk.ts`）
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevMcpServer, defaultDeps } from "./main.ts";
import type { DevMcpDeps } from "./tools.ts";

export type Point = [number, number];

export interface RenderFramesOptions {
  image: string;
  /** 要渲染的帧（WPE 脚本帧号，回放模式下即 `timeline.frame`），按给的顺序。 */
  frames: number[];
  /** 输出目录（绝对路径）。 */
  out: string;
  /** 回放：时间线来源（文件都是绝对路径），`frame` 按帧填。 */
  timeline?: {
    log: string;
    track?: string;
    gap?: "error" | "split";
    cursors?: "log" | "track";
    cursor?: Point;
    window?: Point;
    audio?: string;
  };
  seed?: number;
  passes?: 1 | 2;
  /** `replay.fr`；缺省不传（工具缺省 true）。 */
  fr?: boolean;
  /** 时刻模式：g_Time = 帧号 / fps。 */
  fps?: number;
  /** 时刻模式：每帧同一个 g_Time。 */
  time?: number;
  canvas?: Point;
  /** 壁纸样式（只在按指定尺寸画时有效，要和 `canvas` 一起给）；不给时不传（工具缺省 fill）。 */
  style?: "fill" | "fit" | "stretch" | "center";
  /** 给了 `canvas` 时怎么画：`target`（缺省）或 `scene`（旧的读回画布）；不给时不传。 */
  renderMode?: "target" | "scene";
  postprocess?: "disabled" | "enabled" | "ultra" | "follow";
  pointer?: Point;
  videoTime?: number | Record<string, number>;
  /** 用户 GIF 的逐帧 g_Frametime（秒）：每一帧 `render_scene` 都带同一份；不给时不传。 */
  gifDts?: number[];
  userProperties?: Record<string, unknown>;
  /** 跑场景脚本（第 7 批）：原样作每一帧 `render_scene` 的 `scripts`；不给时不传。 */
  scripts?: true | { clock?: number; seed?: number };
  trace?: { frames: number[]; readback?: Array<number | string>; maxVertices?: number };
  /** 开一个屏外宿主给全部帧用（`host_open` / `host_close` 工具），缺省每帧由 render_scene 自己开关。 */
  reuseHost?: boolean;
  /** 每次工具调用的超时（毫秒）。 */
  timeoutMs: number;
  overwrite: boolean;
}

/** MCP 工具结果（只用到文本与 isError）。 */
export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

/** 调工具的会话：生产是进程内的 MCP 客户端，单测可以换。 */
export interface ToolSession {
  call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult>;
}

export class ArgError extends Error {}

/** `241,242,250-255` → [241, 242, 250, …, 255]（去重、保持顺序；同 kbp 的 `parse_frames`）。 */
export function parseFrames(text: string): number[] {
  const out: number[] = [];
  for (const part of text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new ArgError(`帧列表的写法是 241,242,250-255：${JSON.stringify(part)}`);
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (hi < lo) throw new ArgError(`帧区间倒了：${part}`);
    if (lo < 1) throw new ArgError(`帧号从 1 起：${part}`);
    for (let f = lo; f <= hi; f++) out.push(f);
  }
  if (!out.length) throw new ArgError("帧列表是空的");
  return [...new Set(out)];
}

function parseSize(text: string, what: string): Point {
  const m = /^(\d+)x(\d+)$/i.exec(text.trim());
  if (!m || !Number(m[1]) || !Number(m[2])) throw new ArgError(`${what} 的写法是 <宽>x<高>（正整数）：${text}`);
  return [Number(m[1]), Number(m[2])];
}

function parsePoint(text: string, what: string): Point {
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) throw new ArgError(`${what} 的写法是 x,y：${text}`);
  return [parts[0], parts[1]];
}

function parseNumber(text: string, what: string, check: (v: number) => boolean = Number.isFinite): number {
  const v = Number(text);
  if (text.trim() === "" || !check(v)) throw new ArgError(`${what} 不是合适的数：${text}`);
  return v;
}

/** JSON 串，或指向 JSON 文件的路径。 */
function jsonArg(text: string, cwd: string, what: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(
      trimmed.startsWith("{") || trimmed.startsWith("[") ? trimmed : readFileSync(path.resolve(cwd, trimmed), "utf8"),
    );
  } catch (error) {
    throw new ArgError(`${what} 读不了（JSON 串或 JSON 文件）：${(error as Error).message}`);
  }
}

/** 命令行 → 选项。参数错抛 `ArgError`。 */
export function parseCli(argv: string[], cwd = process.cwd()): RenderFramesOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        image: { type: "string" },
        frames: { type: "string" },
        out: { type: "string" },
        "timeline-log": { type: "string" },
        "timeline-track": { type: "string" },
        cursors: { type: "string" },
        cursor: { type: "string" },
        window: { type: "string" },
        gap: { type: "string" },
        audio: { type: "string" },
        seed: { type: "string" },
        passes: { type: "string" },
        "no-fr": { type: "boolean" },
        fps: { type: "string" },
        time: { type: "string" },
        canvas: { type: "string" },
        style: { type: "string" },
        "render-mode": { type: "string" },
        postprocess: { type: "string" },
        pointer: { type: "string" },
        "video-time": { type: "string" },
        "gif-dts": { type: "string" },
        "user-properties": { type: "string" },
        scripts: { type: "boolean" },
        clock: { type: "string" },
        "script-seed": { type: "string" },
        "trace-frames": { type: "string" },
        "trace-readback": { type: "string" },
        "trace-max-vertices": { type: "string" },
        "reuse-host": { type: "boolean" },
        timeout: { type: "string" },
        overwrite: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new ArgError((error as Error).message);
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  const str = (key: string) => v[key] as string | undefined;
  const image = str("image");
  if (!image || !/^\d+$/.test(image)) throw new ArgError("--image 要给图片 id（数字）");
  if (!str("frames")) throw new ArgError("--frames 要给（如 241,242,250-255）");
  if (!str("out")) throw new ArgError("--out 要给输出目录");
  const options: RenderFramesOptions = {
    image,
    frames: parseFrames(str("frames")!),
    out: path.resolve(cwd, str("out")!),
    timeoutMs: str("timeout") ? parseNumber(str("timeout")!, "--timeout", (x) => x > 0) * 1000 : 600_000,
    overwrite: !!v.overwrite,
  };
  const log = str("timeline-log");
  const timelineOnly = ["timeline-track", "cursors", "cursor", "window", "gap", "audio", "seed", "passes", "no-fr"];
  if (log) {
    if (str("fps") !== undefined || str("time") !== undefined) {
      throw new ArgError("--timeline-log（回放）与 --fps / --time（时刻模式）不能同给");
    }
    const timeline: NonNullable<RenderFramesOptions["timeline"]> = { log: path.resolve(cwd, log) };
    if (str("timeline-track")) timeline.track = path.resolve(cwd, str("timeline-track")!);
    if (str("audio")) timeline.audio = path.resolve(cwd, str("audio")!);
    const gap = str("gap");
    if (gap !== undefined) {
      if (gap !== "error" && gap !== "split") throw new ArgError(`--gap 只收 error / split：${gap}`);
      timeline.gap = gap;
    }
    const cursors = str("cursors");
    if (cursors !== undefined) {
      if (cursors !== "log" && cursors !== "track") throw new ArgError(`--cursors 只收 log / track：${cursors}`);
      timeline.cursors = cursors;
    }
    if (str("cursor")) timeline.cursor = parsePoint(str("cursor")!, "--cursor");
    if (str("window")) timeline.window = parseSize(str("window")!, "--window");
    options.timeline = timeline;
    if (str("seed") !== undefined) options.seed = parseNumber(str("seed")!, "--seed", Number.isInteger);
    if (str("passes") !== undefined) {
      const passes = parseNumber(str("passes")!, "--passes");
      if (passes !== 1 && passes !== 2) throw new ArgError(`--passes 只收 1 / 2：${passes}`);
      options.passes = passes as 1 | 2;
    }
    if (v["no-fr"]) options.fr = false;
  } else {
    const given = timelineOnly.filter((key) => v[key] !== undefined);
    if (given.length) throw new ArgError(`${given.map((k) => `--${k}`).join("、")} 只在回放（--timeline-log）时收`);
    if ((str("fps") === undefined) === (str("time") === undefined)) {
      throw new ArgError("不给 --timeline-log 时要给 --fps（g_Time = 帧号 / fps）或 --time（固定时刻）之一");
    }
    if (str("fps") !== undefined) options.fps = parseNumber(str("fps")!, "--fps", (x) => x > 0);
    if (str("time") !== undefined) options.time = parseNumber(str("time")!, "--time");
  }
  if (str("canvas")) options.canvas = parseSize(str("canvas")!, "--canvas");
  // 样式与画法（phase-render-size）：形状与和 --canvas 的关系先查，参数错不开宿主
  const style = str("style");
  if (style !== undefined) {
    if (style === "tile")
      throw new ArgError("--style 不收 tile：WPE 的对齐方式只有 fill / fit / stretch / center 四种能对上");
    if (!["fill", "fit", "stretch", "center"].includes(style)) {
      throw new ArgError(`--style 只收 fill / fit / stretch / center：${style}`);
    }
    if (!options.canvas)
      throw new ArgError("--style 要和 --canvas 一起给（样式做进投影的裁切边距，没有窗口尺寸就没有裁切）");
    options.style = style as RenderFramesOptions["style"];
  }
  const renderMode = str("render-mode");
  if (renderMode !== undefined) {
    if (renderMode !== "target" && renderMode !== "scene")
      throw new ArgError(`--render-mode 只收 target / scene：${renderMode}`);
    if (renderMode === "target" && !options.canvas)
      throw new ArgError("--render-mode target 要和 --canvas 一起给（按它的尺寸画）");
    if (renderMode === "scene" && options.style !== undefined && options.style !== "fill") {
      throw new ArgError(`--render-mode scene 读回固定按 fill 铺放，不能同时指定 --style ${options.style}`);
    }
    options.renderMode = renderMode;
  }
  const postprocess = str("postprocess");
  if (postprocess !== undefined) {
    if (!["disabled", "enabled", "ultra", "follow"].includes(postprocess)) {
      throw new ArgError(`--postprocess 只收 disabled / enabled / ultra / follow：${postprocess}`);
    }
    options.postprocess = postprocess as RenderFramesOptions["postprocess"];
  }
  if (str("pointer")) options.pointer = parsePoint(str("pointer")!, "--pointer");
  const videoTime = str("video-time");
  if (videoTime !== undefined) {
    options.videoTime = /^[\s\d.eE+-]+$/.test(videoTime)
      ? parseNumber(videoTime, "--video-time", (x) => Number.isFinite(x) && x >= 0)
      : (jsonArg(videoTime, cwd, "--video-time") as Record<string, number>);
  }
  const gifDts = str("gif-dts");
  if (gifDts !== undefined) {
    // 逗号分隔的数，或 JSON 数组 / JSON 文件
    const list = /^[\s\d.eE+,-]*$/.test(gifDts)
      ? gifDts.trim() === ""
        ? []
        : gifDts.split(",").map((x) => parseNumber(x, "--gif-dts", (v) => Number.isFinite(v) && v >= 0))
      : jsonArg(gifDts, cwd, "--gif-dts");
    if (!Array.isArray(list) || list.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0)) {
      throw new ArgError("--gif-dts 要是非负数（秒）的数组");
    }
    options.gifDts = list as number[];
  }
  if (str("user-properties")) {
    const props = jsonArg(str("user-properties")!, cwd, "--user-properties");
    if (!props || typeof props !== "object" || Array.isArray(props))
      throw new ArgError("--user-properties 要是 JSON 对象");
    options.userProperties = props as Record<string, unknown>;
  }
  // 跑场景脚本（第 7 批）：`--clock` / `--script-seed` 只跟着 `--scripts`；范围同 render_scene 的 `scripts`（时间戳在 Date 能表示的范围、
  // 种子是 32 位无符号整数），这里先查，参数错不开宿主
  const clock = str("clock");
  const scriptSeed = str("script-seed");
  if (v.scripts) {
    const scripts: { clock?: number; seed?: number } = {};
    if (clock !== undefined)
      scripts.clock = parseNumber(clock, "--clock", (x) => Number.isFinite(x) && Math.abs(x) <= 8.64e15);
    if (scriptSeed !== undefined)
      scripts.seed = parseNumber(scriptSeed, "--script-seed", (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff);
    options.scripts = Object.keys(scripts).length ? scripts : true;
  } else if (clock !== undefined || scriptSeed !== undefined) {
    throw new ArgError("--clock / --script-seed 要和 --scripts 一起给");
  }
  const traceFrames = str("trace-frames");
  if (traceFrames !== undefined) {
    const frames = parseFrames(traceFrames);
    const outside = frames.filter((f) => !options.frames.includes(f));
    if (outside.length) throw new ArgError(`--trace-frames 的帧要在 --frames 里：${outside.join(",")}`);
    options.trace = { frames };
    const readback = str("trace-readback");
    if (readback !== undefined) {
      options.trace.readback = readback
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    }
    if (str("trace-max-vertices") !== undefined) {
      options.trace.maxVertices = parseNumber(str("trace-max-vertices")!, "--trace-max-vertices", Number.isInteger);
    }
  } else if (str("trace-readback") !== undefined || str("trace-max-vertices") !== undefined) {
    throw new ArgError("--trace-readback / --trace-max-vertices 要和 --trace-frames 一起给");
  }
  if (v["reuse-host"]) options.reuseHost = true;
  return options;
}

export const pngName = (frame: number) => `ours-f${frame}.png`;
export const traceDirName = (frame: number) => `trace-f${frame}`;

/** 第 `frame` 帧的 render_scene 参数（`host` 给了时用已开的宿主）。 */
export function renderArgs(options: RenderFramesOptions, frame: number, host?: string): Record<string, unknown> {
  const args: Record<string, unknown> = { imageId: options.image };
  if (options.timeline) {
    args.replay = {
      timeline: { ...options.timeline, frame },
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.passes !== undefined ? { passes: options.passes } : {}),
      ...(options.fr !== undefined ? { fr: options.fr } : {}),
    };
  } else {
    args.time = options.time ?? frame / options.fps!;
  }
  if (options.canvas) args.canvas = options.canvas;
  if (options.style !== undefined) args.style = options.style;
  if (options.renderMode !== undefined) args.renderMode = options.renderMode;
  if (options.postprocess) args.postprocess = options.postprocess;
  if (options.pointer) args.pointer = options.pointer;
  if (options.videoTime !== undefined) args.videoTime = options.videoTime;
  if (options.gifDts !== undefined) args.gifDts = options.gifDts;
  if (options.userProperties) args.userProperties = options.userProperties;
  if (options.scripts !== undefined) args.scripts = options.scripts;
  if (options.trace?.frames.includes(frame)) {
    args.trace = {
      save: path.join(options.out, traceDirName(frame)),
      ...(options.trace.readback ? { readback: options.trace.readback } : {}),
      ...(options.trace.maxVertices !== undefined ? { maxVertices: options.trace.maxVertices } : {}),
    };
  }
  if (host) args.host = host;
  args.save = path.join(options.out, pngName(frame));
  args.inline = false;
  return args;
}

const textOf = (result: ToolResult) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

/** render_scene 的结果文本 → 说明行与元数据（末尾整段是 `JSON.stringify(meta, null, 2)`，顶层的 `{` 独占一行）。 */
export function splitRenderText(text: string): { lines: string[]; meta: Record<string, unknown> | null } {
  const all = text.split("\n");
  const at = all.indexOf("{");
  if (at < 0) return { lines: all, meta: null };
  try {
    return { lines: all.slice(0, at), meta: JSON.parse(all.slice(at).join("\n")) };
  } catch {
    return { lines: all, meta: null };
  }
}

export interface FrameRecord {
  frame: number;
  png?: string;
  /** PNG 文件本身的 sha256（同 render_scene 的「原图 PNG 文件 sha256」）。 */
  pngSha256?: string;
  meta?: Record<string, unknown> | null;
  /** 工具结果里元数据之前的说明行（宿主、时间线、读回、FR、视频、像素摘要……）。 */
  lines?: string[];
  trace?: string;
  ms?: number;
  error?: string;
  /** vite / CDP 不在之后没再试的帧。 */
  skipped?: boolean;
}

export interface RenderFramesSummary {
  ok: boolean;
  out: string;
  framesJson: string;
  rendered: number;
  failed: number[];
  skipped: number[];
  seconds: number;
  host?: string;
}

/** 已有输出时拒绝（不覆盖）：frames.json、要写的 ours-f*.png、轨迹目录。 */
export function checkOutput(options: RenderFramesOptions): void {
  if (options.overwrite) return;
  const taken = [
    "frames.json",
    ...options.frames.map(pngName),
    ...(options.trace?.frames ?? []).map(traceDirName),
  ].filter((name) => existsSync(path.join(options.out, name)));
  if (taken.length) {
    throw new ArgError(
      `${options.out} 里已有输出（${taken.slice(0, 5).join("、")}${taken.length > 5 ? " …" : ""}）：换目录或加 --overwrite`,
    );
  }
}

const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** 按帧调 render_scene，写 frames.json，回摘要。`log` 写进度（stderr）。 */
export async function renderFrames(
  options: RenderFramesOptions,
  session: ToolSession,
  log: (message: string) => void = () => {},
): Promise<RenderFramesSummary> {
  checkOutput(options);
  mkdirSync(options.out, { recursive: true });
  const started = Date.now();
  const records: FrameRecord[] = [];
  let host: string | undefined;
  let hostNote: string | null = null;
  let hostEntry: string | null = null;
  let abort: string | null = null;
  try {
    if (options.reuseHost) {
      const opened = await session.call("host_open", { hidden: true, scene: options.image }, options.timeoutMs);
      const text = textOf(opened);
      if (opened.isError) throw new Error(`开宿主失败：${text}`);
      const parsed = JSON.parse(text) as { handle: string; entry?: string };
      host = parsed.handle;
      // 宿主产物（`entry`）记下来：render_scene 给 host 时说明行里只写「已开的宿主」，产物被别的会话重建过时查不到用的是哪一份
      // （P10a 走查：复用宿主跑出过和单开宿主不同、事后又复现不了的一批结果）
      hostEntry = parsed.entry ?? null;
      log(`开了屏外宿主 ${host}（宿主产物 ${hostEntry ?? "未知"}），全部帧共用`);
    }
    for (const frame of options.frames) {
      if (abort) {
        records.push({ frame, skipped: true, error: `没试：前面的帧报 ${abort}` });
        continue;
      }
      const t0 = Date.now();
      const record: FrameRecord = { frame };
      try {
        const result = await session.call("render_scene", renderArgs(options, frame, host), options.timeoutMs);
        const text = textOf(result);
        if (result.isError) {
          record.error = text;
          const layer = /^\[(\w+)\]/.exec(text)?.[1];
          if (layer === "vite" || layer === "cdp") abort = `[${layer}]`;
        } else {
          const { lines, meta } = splitRenderText(text);
          const png = path.join(options.out, pngName(frame));
          record.lines = lines;
          record.meta = meta;
          if (existsSync(png)) {
            record.png = png;
            record.pngSha256 = sha256File(png);
          } else {
            record.error = `工具没报错，但 ${png} 不在`;
          }
          if (options.trace?.frames.includes(frame)) record.trace = path.join(options.out, traceDirName(frame));
        }
      } catch (error) {
        // MCP 客户端层的错误（超时等）
        record.error = `[local] ${error instanceof Error ? error.message : String(error)}`;
      }
      record.ms = Date.now() - t0;
      records.push(record);
      log(
        `第 ${frame} 帧：${record.error ? `失败 ${record.error.split("\n")[0]}` : `ok ${(record.ms / 1000).toFixed(1)} s`}`,
      );
    }
  } finally {
    if (host) {
      const closed = await session.call("host_close", { handle: host }, options.timeoutMs).catch((error) => ({
        isError: true,
        content: [{ type: "text", text: String(error) }],
      }));
      hostNote = closed.isError ? `关宿主 ${host} 失败：${textOf(closed)}` : `已关宿主 ${host}`;
      log(hostNote);
    }
  }
  const failed = records.filter((r) => r.error && !r.skipped).map((r) => r.frame);
  const skipped = records.filter((r) => r.skipped).map((r) => r.frame);
  const firstOk = records.find((r) => !r.error);
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  const framesJson = path.join(options.out, "frames.json");
  writeFileSync(
    framesJson,
    `${JSON.stringify(
      {
        tool: "renderFrames",
        image: options.image,
        options,
        started: new Date(started).toISOString(),
        seconds,
        ok: !failed.length && !skipped.length,
        // 时间线（或时刻模式）说明：第一个成功帧的说明行（逐帧的在 frames[].lines）
        notes: firstOk?.lines ?? [],
        host: hostNote,
        // 复用宿主时这份宿主的产物（`host_open` 回的 `entry`）；单开时每帧的说明行里有
        hostEntry,
        failed,
        skipped,
        frames: records,
      },
      null,
      1,
    )}\n`,
  );
  return {
    ok: !failed.length && !skipped.length,
    out: options.out,
    framesJson,
    rendered: records.filter((r) => !r.error).length,
    failed,
    skipped,
    seconds,
    ...(hostNote ? { host: hostNote } : {}),
  };
}

/** 进程内连 `createDevMcpServer(deps)`：和 stdio MCP 同一个工厂，工具逻辑一份。 */
export async function openSession(deps: DevMcpDeps): Promise<ToolSession & { close(): Promise<void> }> {
  const server = createDevMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "renderFrames", version: "0" });
  await client.connect(clientTransport);
  return {
    call: async (name, args, timeoutMs) =>
      (await client.callTool({ name, arguments: args }, undefined, {
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
      })) as ToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function main(): Promise<number> {
  let options: RenderFramesOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    const message = `[local] ${(error as Error).message}`;
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return 2;
  }
  const log = (message: string) => process.stderr.write(`[renderFrames] ${message}\n`);
  const session = await openSession(defaultDeps());
  try {
    const summary = await renderFrames(options, session, log);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof ArgError ? `[local] ${error.message}` : `[local] ${(error as Error).message}`;
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    return error instanceof ArgError ? 2 : 1;
  } finally {
    await session.close();
  }
}

// `import.meta.main`：同 main.ts 的收窄
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[local] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
