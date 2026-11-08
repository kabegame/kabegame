/**
 * 粒子回放、轨迹、四角的参数校验（第 4 批）：REST 路由在交给后端之前调，`scene.ts` 直接被调用时也再调一次。
 * 不合法时抛 400（`badRequest`），错误体的 `field` 说明是哪一项（例如 `particles.dts[3]`）。
 *
 * 规则对齐 dev 探针（`apps/wpe-scene/src/dev/probe.ts`、`particleCorners.ts`）：
 * - `dts` 非空、都是有限正数；`times` 与 `dts` 等长、都是有限数；`passes` 只能 1 / 2；`seed` 是整数；
 * - `random` 的键是 `objects` 下标（非负整数），值是 [0, 1) 内的数组成的数组；
 * - 轨迹的 `frames` 是 [1, dts.length] 内的整数；`cursors` 与 `dts` 等长、每项两个有限数（WPE 的指针可以超出 [0, 1]，不限范围）。
 * 不认识的字段一律拒绝：探针会静默忽略它们（例如给 `renderFrame` 传逐帧光标），宁可当场报错。
 */
import { badRequest } from "./errors.ts";
import type { ParticleCornersRequest, ParticleReplay, ParticleTrackRequest, ScenePostprocess } from "./types.ts";

export const POSTPROCESS_LEVELS: readonly ScenePostprocess[] = ["disabled", "enabled", "ultra", "follow"];
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
  "tag",
] as const;
export const CORNERS_FIELDS = [
  "imageId",
  "particles",
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

export function checkCursors(value: unknown, field: string, length: number): [number, number][] {
  if (!Array.isArray(value)) fail(field, `要是 [[x, y], …]，收到 ${shown(value)}`);
  if (value.length !== length) fail(field, `有 ${value.length} 项，应和 dts 等长（${length} 项）`);
  value.forEach((item, i) => {
    if (!Array.isArray(item) || item.length !== 2 || !item.every((x) => typeof x === "number" && Number.isFinite(x))) {
      fail(`${field}[${i}]`, `要是 [x, y]（两个有限数），收到 ${shown(item)}`);
    }
  });
  return value as [number, number][];
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
 * 渲染请求里的回放：给了 `particles` 就校验它，并拒绝同时给 `time`（探针此时忽略 `time`，读回那一帧的 `g_Time` 取
 * `particles.times` 的末项或 dt 累计值）。没给时原样返回 undefined。
 */
export function checkRenderReplay(body: { particles?: unknown; time?: unknown }): ParticleReplay | undefined {
  if (body.particles === undefined) return undefined;
  const particles = checkReplay(body.particles, "particles");
  if (body.time !== undefined) {
    fail(
      "time",
      "和 particles 不能同时给：回放时读回那一帧的 g_Time 取 particles.times 的末项（没给 times 时是 dt 累计值）",
    );
  }
  return particles;
}
