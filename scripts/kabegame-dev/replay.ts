/**
 * 粒子回放、轨迹、四角的参数校验（第 4 批）：REST 路由在交给后端之前调，`scene.ts` 直接被调用时也再调一次。
 * 不合法时抛 400（`badRequest`），错误体的 `field` 说明是哪一项（例如 `particles.dts[3]`）。
 *
 * 规则对齐 dev 探针（`apps/wpe-scene/src/dev/probe.ts`、`particleCorners.ts`）：
 * - `dts` 非空、都是有限正数；`times` 与 `dts` 等长、都是有限数；`passes` 只能 1 / 2；`seed` 是整数；
 * - `random` 的键是 `objects` 下标（非负整数），值是 [0, 1) 内的数组成的数组；
 * - 轨迹的 `frames` 是 [1, dts.length] 内的整数；`cursors` 与 `dts` 等长、每项两个有限数（WPE 的指针可以超出 [0, 1]，不限范围）。
 * - 逐帧光标（P5a 收尾）：单位都是 `g_PointerPosition`（抓帧窗口归一化），渲染与四角的 `pointers` 要有 `particles`、和
 *   `particles.dts` 等长，渲染的 `pointers` 不和 `pointer` 同给；`window` 是 `[宽, 高]` 两个正数，轨迹的 `window` 要和 `cursors`
 *   一起给（只用来把光标换到场景上）。
 * - 读回画布（第 5 批）：渲染的 `canvas` 是 `[宽, 高]` 两个正整数、各不超过 `MAX_CANVAS`；探针的光标换算窗口是 `window ?? canvas`，
 *   两个都给而不相等时 400（`field` 为 `canvas`）。
 * - 脚本值（第 6 批）：渲染的 `scriptValues` 是数组、最多 `MAX_SCRIPT_VALUES` 项；每项 `object` 是非负整数或非空字符串，`field` 是
 *   图层字段之一，`value` 是 1–4 个有限数或布尔，`optional` 是布尔。P6b 1e-3 起 `field` 也可以是文本层的运行中字段（`TEXT_FIELDS`），
 *   这时 `value` 还可以是字符串（最长 `MAX_SCRIPT_TEXT` 个 UTF-16 单元）；图层字段给字符串仍是 400。
 * - 视频时刻（P9a 步骤 3）：渲染的 `videoTime` 是非负有限数（秒），或「非空字符串 → 非负有限数」的对象、最多 `MAX_VIDEO_TIMES` 项；
 *   键是不是这个场景的视频纹理要编译之后才知道，由探针判（不是时报错，回 422）。
 * - 逐 draw 轨迹（`.claude/plans/tools/scene-draw-trace.md`）：渲染的 `trace` 是 `true`，或 `{ readback?, maxVertices? }`：`readback` 是
 *   pass 下标（非负整数）或 pass / 目标纹理标签的子串（非空字符串）组成的数组、最多 `MAX_TRACE_READBACKS` 项，`maxVertices` 是
 *   1–`MAX_TRACE_VERTICES` 的整数（探针 `apps/wpe-scene/src/dev/drawTrace.ts` 的 `traceOptionsOf` 同样查）。
 * 不认识的字段一律拒绝：探针会静默忽略它们（例如把逐帧光标放进 `particles`），宁可当场报错。
 */
import { badRequest } from "./errors.ts";
import type {
  ParticleCornersRequest,
  ParticleReplay,
  ParticleTrackRequest,
  RenderTraceRequest,
  SceneLayerField,
  ScenePostprocess,
  SceneTextField,
  ScriptValue,
  VideoTime,
} from "./types.ts";

export const POSTPROCESS_LEVELS: readonly ScenePostprocess[] = ["disabled", "enabled", "ultra", "follow"];
/** 图层字段（探针 `scriptValues.ts` 的 `SCRIPT_VALUE_FIELDS`，即 `LayerField`）。 */
export const LAYER_FIELDS: readonly SceneLayerField[] = [
  "origin",
  "scale",
  "angles",
  "alpha",
  "color",
  "brightness",
  "visible",
  "parallaxDepth",
];
/**
 * 文本层的运行中字段（P6b 1e-3）：探针 `scriptValues` 也收它们，值可以是字符串。是宿主 `apps/wpe-scene/src/compile/bindings.ts` 的
 * `TEXT_RUNTIME_FIELDS` 的抄本（vite 插件不引宿主源码），改了两边一起改。
 */
export const TEXT_FIELDS: readonly SceneTextField[] = [
  "text",
  "pointsize",
  "padding",
  "spacing",
  "maxwidth",
  "maxrows",
  "limitwidth",
  "limitrows",
  "limituseellipsis",
  "blockalign",
  "horizontalalign",
  "verticalalign",
];
export const SCRIPT_VALUE_FIELDS = ["object", "field", "value", "optional"] as const;
/** 渲染一次最多给这么多项脚本值。 */
export const MAX_SCRIPT_VALUES = 64;
/** 文本字段的字符串值最长这么多个 UTF-16 单元（P6b 1e-3，探针 `dev/scriptValues.ts` 的 `MAX_SCRIPT_TEXT`，改了两边一起改）。 */
export const MAX_SCRIPT_TEXT = 4096;
/** `videoTime` 对象最多这么多项（语料一张场景最多 5 段视频）。 */
export const MAX_VIDEO_TIMES = 64;
export const TRACE_FIELDS = ["readback", "maxVertices"] as const;
/** 轨迹的 `readback` 最多这么多项。 */
export const MAX_TRACE_READBACKS = 64;
/** 每个 draw 解码的顶点数上限（探针 `render/trace.ts` 的 `MAX_TRACE_VERTICES`，改了两边一起改）。 */
export const MAX_TRACE_VERTICES = 4096;
export const REPLAY_FIELDS = ["dts", "times", "seed", "passes", "random"] as const;
export const TRACK_FIELDS = [
  "imageId",
  "dts",
  "times",
  "frames",
  "passes",
  "seed",
  "random",
  "cursors",
  "window",
  "tag",
] as const;
export const CORNERS_FIELDS = [
  "imageId",
  "particles",
  "pointers",
  "window",
  "layer",
  "limit",
  "postprocess",
  "userProperties",
  "wgsl",
] as const;

type Obj = Record<string, unknown>;

function fail(field: string, message: string): never {
  throw badRequest(`${field} ${message}`, { field });
}

const isObject = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

/** 错误信息里回显收到的值（截短）。 */
function shown(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  text ??= String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function rejectUnknown(body: Obj, allowed: readonly string[], prefix: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    const field = prefix ? `${prefix}.${unknown[0]}` : unknown[0];
    fail(field, `不认识（${prefix || "请求体"}只收 ${allowed.join(" / ")}）`);
  }
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

/** 图片 id：数字字符串或非负整数，统一成字符串。 */
export function checkImageId(value: unknown, field = "imageId"): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  fail(field, `要是图片 id（数字字符串），收到 ${shown(value)}`);
}

function numberArray(
  value: unknown,
  field: string,
  check: (item: number) => boolean,
  what: string,
  length?: number,
): number[] {
  if (!Array.isArray(value)) fail(field, `要是数组，收到 ${shown(value)}`);
  if (length !== undefined && value.length !== length)
    fail(field, `有 ${value.length} 项，应和 dts 等长（${length} 项）`);
  value.forEach((item, i) => {
    if (typeof item !== "number" || !check(item)) fail(`${field}[${i}]`, `要是${what}，收到 ${shown(item)}`);
  });
  return value as number[];
}

export function checkDts(value: unknown, field = "dts"): number[] {
  const dts = numberArray(value, field, (x) => Number.isFinite(x) && x > 0, "有限正数（秒）");
  if (!dts.length) fail(field, "不能为空");
  return dts;
}

export function checkTimes(value: unknown, field: string, length: number): number[] {
  return numberArray(value, field, Number.isFinite, "有限数（秒）", length);
}

export function checkSeed(value: unknown, field = "seed"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(field, `要是整数，收到 ${shown(value)}`);
  return value;
}

export function checkPasses(value: unknown, field = "passes"): 1 | 2 {
  if (value !== 1 && value !== 2) fail(field, `只能是 1 或 2，收到 ${shown(value)}`);
  return value;
}

export function checkRandom(value: unknown, field = "random"): Record<string, number[]> {
  if (!isObject(value)) fail(field, `要是 { <objects 下标>: [R, …] }，收到 ${shown(value)}`);
  for (const [key, list] of Object.entries(value)) {
    if (!/^\d+$/.test(key)) fail(`${field}.${key}`, "的键要是 objects 下标（非负整数）");
    numberArray(list, `${field}.${key}`, (x) => x >= 0 && x < 1, " [0, 1) 内的数");
  }
  return value as Record<string, number[]>;
}

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "number" && Number.isFinite(x));

/** 逐帧的点 `[[x, y], …]`，和 `against`（缺省 `dts`）等长。 */
export function checkCursors(value: unknown, field: string, length: number, against = "dts"): [number, number][] {
  if (!Array.isArray(value)) fail(field, `要是 [[x, y], …]，收到 ${shown(value)}`);
  if (value.length !== length) fail(field, `有 ${value.length} 项，应和 ${against} 等长（${length} 项）`);
  value.forEach((item, i) => {
    if (!isPoint(item)) fail(`${field}[${i}]`, `要是 [x, y]（两个有限数），收到 ${shown(item)}`);
  });
  return value as [number, number][];
}

/** 一个点 `[x, y]`（两个有限数）。 */
export function checkPoint(value: unknown, field: string): [number, number] {
  if (!isPoint(value)) fail(field, `要是 [x, y]（两个有限数），收到 ${shown(value)}`);
  return value;
}

/** 抓帧窗口尺寸 `[宽, 高]`（像素，两个正数）：和场景不同尺寸时探针按 `fill` 把光标换到场景上。 */
export function checkWindow(value: unknown, field = "window"): [number, number] {
  if (!isPoint(value) || !(value[0] > 0 && value[1] > 0)) {
    fail(field, `要是 [宽, 高]（两个正数，像素），收到 ${shown(value)}`);
  }
  return value;
}

/** 读回画布的边长上限（像素）：WebGPU 常见的 `maxTextureDimension2D`，设备更小时探针再报。 */
export const MAX_CANVAS = 16384;

/**
 * 读回画布尺寸 `[宽, 高]`（第 5 批）：两个正整数，各不超过 `MAX_CANVAS`。给了 `window` 时要和它相同（探针的光标换算窗口是
 * `window ?? canvas`，读回画布就是模拟的壁纸窗口）。
 */
export function checkCanvas(value: unknown, window?: [number, number], field = "canvas"): [number, number] {
  const ok =
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((x) => typeof x === "number" && Number.isInteger(x) && x > 0 && x <= MAX_CANVAS);
  if (!ok) fail(field, `要是 [宽, 高]（两个正整数，像素，各不超过 ${MAX_CANVAS}），收到 ${shown(value)}`);
  const canvas = value as [number, number];
  if (window && (window[0] !== canvas[0] || window[1] !== canvas[1])) {
    fail(
      field,
      `${canvas[0]}×${canvas[1]} 和 window ${window[0]}×${window[1]} 不同：读回画布就是模拟的窗口，光标按它换算，两者要相同（或只给一个）`,
    );
  }
  return canvas;
}

/** 渲染与四角的逐帧指针 `pointers`：要有 `particles`，和 `particles.dts` 等长。 */
function checkPointers(value: unknown, particles: ParticleReplay | undefined): [number, number][] {
  if (!particles) fail("pointers", "要和 particles 一起给（逐帧指针是回放的每一帧）");
  return checkCursors(value, "pointers", particles.dts.length, "particles.dts");
}

/** 回放的公共字段（`renderFrame` / `particleCorners` 的 `particles`，以及轨迹请求体本身）。 */
function replayFields(body: Obj, prefix: string): ParticleReplay {
  const dts = checkDts(body.dts, join(prefix, "dts"));
  const replay: ParticleReplay = { dts };
  if (body.times !== undefined) replay.times = checkTimes(body.times, join(prefix, "times"), dts.length);
  if (body.seed !== undefined) replay.seed = checkSeed(body.seed, join(prefix, "seed"));
  if (body.passes !== undefined) replay.passes = checkPasses(body.passes, join(prefix, "passes"));
  if (body.random !== undefined) replay.random = checkRandom(body.random, join(prefix, "random"));
  return replay;
}

/** 确定性粒子回放 `{ dts, times?, seed?, passes?, random? }`。 */
export function checkReplay(value: unknown, field = "particles"): ParticleReplay {
  if (!isObject(value)) fail(field, `要是 { dts, times?, seed?, passes?, random? }，收到 ${shown(value)}`);
  rejectUnknown(value, REPLAY_FIELDS, field);
  return replayFields(value, field);
}

/** `POST /hosts/:h/particle-track` 的请求体。 */
export function checkTrackRequest(body: unknown): ParticleTrackRequest {
  if (!isObject(body)) fail("body", "要是 JSON 对象");
  rejectUnknown(body, TRACK_FIELDS, "");
  const imageId = checkImageId(body.imageId);
  const replay = replayFields(body, "");
  if (body.passes === undefined) fail("passes", "必填（WPE 设置 fps 在 1–20 时 2，否则 1）");
  const frames = numberArray(
    body.frames,
    "frames",
    (x) => Number.isInteger(x) && x >= 1 && x <= replay.dts.length,
    ` [1, ${replay.dts.length}] 内的整数（帧号，不超过 dts 的长度）`,
  );
  if (!frames.length) fail("frames", "不能为空");
  const request: ParticleTrackRequest = { imageId, ...replay, frames, passes: replay.passes! };
  if (body.cursors !== undefined) request.cursors = checkCursors(body.cursors, "cursors", replay.dts.length);
  if (body.window !== undefined) {
    if (body.cursors === undefined) fail("window", "要和 cursors 一起给（只用来把逐帧光标换到场景上）");
    request.window = checkWindow(body.window);
  }
  if (body.tag !== undefined) {
    if (typeof body.tag !== "string") fail("tag", `要是字符串，收到 ${shown(body.tag)}`);
    request.tag = body.tag;
  }
  return request;
}

/** `POST /hosts/:h/particle-corners` 的请求体。 */
export function checkCornersRequest(body: unknown): ParticleCornersRequest {
  if (!isObject(body)) fail("body", "要是 JSON 对象");
  rejectUnknown(body, CORNERS_FIELDS, "");
  const request: ParticleCornersRequest = { imageId: checkImageId(body.imageId) };
  if (body.particles !== undefined) request.particles = checkReplay(body.particles, "particles");
  if (body.pointers !== undefined) request.pointers = checkPointers(body.pointers, request.particles);
  if (body.window !== undefined) request.window = checkWindow(body.window);
  if (body.layer !== undefined) {
    const layer = body.layer;
    const ok =
      (typeof layer === "number" && Number.isInteger(layer) && layer >= 0) ||
      (typeof layer === "string" && layer.length > 0);
    if (!ok) fail("layer", `要是 objects 下标（非负整数）或对象名，收到 ${shown(layer)}`);
    request.layer = layer as number | string;
  }
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 0) {
      fail("limit", `要是非负整数，收到 ${shown(body.limit)}`);
    }
    request.limit = body.limit;
  }
  if (body.postprocess !== undefined) request.postprocess = checkPostprocess(body.postprocess);
  if (body.userProperties !== undefined) {
    if (!isObject(body.userProperties)) fail("userProperties", `要是对象，收到 ${shown(body.userProperties)}`);
    request.userProperties = body.userProperties;
  }
  if (body.wgsl !== undefined) {
    if (typeof body.wgsl !== "boolean") fail("wgsl", `要是布尔值，收到 ${shown(body.wgsl)}`);
    request.wgsl = body.wgsl;
  }
  return request;
}

export function checkPostprocess(value: unknown, field = "postprocess"): ScenePostprocess {
  if (!POSTPROCESS_LEVELS.includes(value as ScenePostprocess)) {
    fail(field, `只能是 ${POSTPROCESS_LEVELS.join(" / ")}，收到 ${shown(value)}`);
  }
  return value as ScenePostprocess;
}

/**
 * 脚本值（第 6 批）：数组、最多 `MAX_SCRIPT_VALUES` 项；每项只收 `object`（非负整数或非空字符串）、`field`（图层字段或文本字段之一）、
 * `value`（1–4 个有限数或布尔；文本字段另收最长 `MAX_SCRIPT_TEXT` 个 UTF-16 单元的字符串，P6b 1e-3）、`optional`（布尔）。图层字段给
 * 字符串时 400，`field` 指到 `value`。对象找不找得到、字段有没有挂脚本、值按宿主规则写不写得进（如 `pointsize` 给了不是数的串）要编译
 * 之后才知道，由探针判（重名、缺且不 `optional`、写不进时探针报错，回 422）。
 */
export function checkScriptValues(value: unknown, field = "scriptValues"): ScriptValue[] {
  if (!Array.isArray(value)) fail(field, `要是 [{ object, field, value, optional? }, …]，收到 ${shown(value)}`);
  if (value.length > MAX_SCRIPT_VALUES) fail(field, `有 ${value.length} 项，最多 ${MAX_SCRIPT_VALUES} 项`);
  value.forEach((item, i) => {
    const at = `${field}[${i}]`;
    if (!isObject(item)) fail(at, `要是 { object, field, value, optional? }，收到 ${shown(item)}`);
    rejectUnknown(item, SCRIPT_VALUE_FIELDS, at);
    const object = item.object;
    const objectOk =
      (typeof object === "number" && Number.isInteger(object) && object >= 0) ||
      (typeof object === "string" && object.length > 0);
    if (!objectOk) fail(`${at}.object`, `要是 objects 下标（非负整数）或对象名（非空字符串），收到 ${shown(object)}`);
    const text = TEXT_FIELDS.includes(item.field as SceneTextField);
    if (!text && !LAYER_FIELDS.includes(item.field as SceneLayerField)) {
      fail(
        `${at}.field`,
        `只能是 ${LAYER_FIELDS.join(" / ")}（图层字段），或 ${TEXT_FIELDS.join(" / ")}（文本字段），收到 ${shown(item.field)}`,
      );
    }
    const v = item.value;
    if (typeof v === "string") {
      // 字符串只给文本字段（P6b 1e-3：字段脚本这一帧返回的文字）
      if (!text) {
        const hint = `${item.field} 是图层字段，字符串只给文本字段`;
        fail(`${at}.value`, `要是 1–4 个有限数，或布尔（${hint}），收到 ${shown(v)}`);
      }
      if (v.length > MAX_SCRIPT_TEXT) {
        fail(`${at}.value`, `长 ${v.length} 个 UTF-16 单元，最长 ${MAX_SCRIPT_TEXT}`);
      }
    } else if (typeof v !== "boolean") {
      if (!Array.isArray(v) || v.length < 1 || v.length > 4) {
        const expected = text
          ? `字符串（最长 ${MAX_SCRIPT_TEXT} 个 UTF-16 单元）、1–4 个有限数，或布尔`
          : "1–4 个有限数，或布尔";
        fail(`${at}.value`, `要是 ${expected}，收到 ${shown(v)}`);
      }
      numberArray(v, `${at}.value`, Number.isFinite, "有限数");
    }
    if (item.optional !== undefined && typeof item.optional !== "boolean") {
      fail(`${at}.optional`, `要是布尔值，收到 ${shown(item.optional)}`);
    }
  });
  return value as ScriptValue[];
}

/**
 * 视频时刻（P9a 步骤 3）：非负有限数（秒），或「非空字符串（bundle 纹理的 path）→ 非负有限数」的对象、最多 `MAX_VIDEO_TIMES` 项。
 * 键是不是这个场景的视频纹理由探针判（不是时报错，回 422）。
 */
export function checkVideoTime(value: unknown, field = "videoTime"): VideoTime {
  const ok = (time: unknown) => typeof time === "number" && Number.isFinite(time) && time >= 0;
  if (typeof value === "number") {
    if (!ok(value)) fail(field, `要是非负有限数（秒），收到 ${shown(value)}`);
    return value;
  }
  if (!isObject(value)) fail(field, `要是秒数，或 { <纹理路径>: 秒数 }，收到 ${shown(value)}`);
  const entries = Object.entries(value);
  if (entries.length > MAX_VIDEO_TIMES) fail(field, `有 ${entries.length} 项，最多 ${MAX_VIDEO_TIMES} 项`);
  for (const [path, time] of entries) {
    if (!path) fail(field, "的键（纹理路径）不能为空");
    if (!ok(time)) fail(`${field}.${path}`, `要是非负有限数（秒），收到 ${shown(time)}`);
  }
  return value as Record<string, number>;
}

/**
 * 逐 draw 轨迹：`true`，或 `{ readback?, maxVertices? }`。`readback` 选哪些 pass 在结束后读回颜色附件（pass 下标，或 pass / 目标纹理标签的
 * 子串）；`maxVertices` 是每个 draw 解码的顶点数（缺省 64）。不认识的字段 400。选中的 pass 读不了（格式、没提交）由探针在轨迹里写明。
 */
export function checkTrace(value: unknown, field = "trace"): RenderTraceRequest {
  if (value === true) return true;
  if (!isObject(value)) fail(field, `要是 true，或 { readback?, maxVertices? }，收到 ${shown(value)}`);
  rejectUnknown(value, TRACE_FIELDS, field);
  if (value.readback !== undefined) {
    const list = value.readback;
    if (!Array.isArray(list)) fail(`${field}.readback`, `要是数组（pass 下标或标签子串），收到 ${shown(list)}`);
    if (list.length > MAX_TRACE_READBACKS) {
      fail(`${field}.readback`, `有 ${list.length} 项，最多 ${MAX_TRACE_READBACKS} 项`);
    }
    list.forEach((item, i) => {
      const ok =
        (typeof item === "number" && Number.isInteger(item) && item >= 0) || (typeof item === "string" && item !== "");
      if (!ok) {
        fail(
          `${field}.readback[${i}]`,
          `要是 pass 下标（非负整数）或 pass / 目标纹理标签的子串（非空字符串），收到 ${shown(item)}`,
        );
      }
    });
  }
  if (value.maxVertices !== undefined) {
    const n = value.maxVertices;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_TRACE_VERTICES) {
      fail(`${field}.maxVertices`, `要是 1–${MAX_TRACE_VERTICES} 的整数，收到 ${shown(n)}`);
    }
  }
  return value as RenderTraceRequest;
}

/**
 * 渲染请求里的回放：给了 `particles` 就校验它，并拒绝同时给 `time`（探针此时忽略 `time`，读回那一帧的 `g_Time` 取
 * `particles.times` 的末项或 dt 累计值）。没给时原样返回 undefined。
 * 光标一并校验（P5a 收尾）：`pointer` 是一个点；`pointers` 要有 `particles`、和 `particles.dts` 等长、不和 `pointer` 同给；`window` 是
 * `[宽, 高]`。读回画布 `canvas`（第 5 批）是两个正整数、各不超过 `MAX_CANVAS`，和 `window` 都给时要相同。脚本值 `scriptValues`（第 6 批）
 * 见 `checkScriptValues`，不要求有 `particles`。视频时刻 `videoTime`（P9a 步骤 3）见 `checkVideoTime`，同样不要求有 `particles`。
 * 逐 draw 轨迹 `trace` 见 `checkTrace`。
 * 校验过的值原样留在请求里转给探针。
 */
export function checkRenderReplay(body: {
  particles?: unknown;
  time?: unknown;
  pointer?: unknown;
  pointers?: unknown;
  window?: unknown;
  canvas?: unknown;
  scriptValues?: unknown;
  videoTime?: unknown;
  trace?: unknown;
}): ParticleReplay | undefined {
  const particles = body.particles === undefined ? undefined : checkReplay(body.particles, "particles");
  if (particles && body.time !== undefined) {
    fail(
      "time",
      "和 particles 不能同时给：回放时读回那一帧的 g_Time 取 particles.times 的末项（没给 times 时是 dt 累计值）",
    );
  }
  if (body.pointer !== undefined) checkPoint(body.pointer, "pointer");
  if (body.pointers !== undefined) {
    if (body.pointer !== undefined) {
      fail("pointer", "和 pointers 不能同时给：逐帧给了指针就不要固定的那一个");
    }
    checkPointers(body.pointers, particles);
  }
  const window = body.window === undefined ? undefined : checkWindow(body.window);
  if (body.canvas !== undefined) checkCanvas(body.canvas, window);
  if (body.scriptValues !== undefined) checkScriptValues(body.scriptValues);
  if (body.videoTime !== undefined) checkVideoTime(body.videoTime);
  if (body.trace !== undefined) checkTrace(body.trace);
  return particles;
}
