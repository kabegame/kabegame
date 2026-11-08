/**
 * 页面级操作：列目标、求值、截图、点击、取文本、收集控制台。目标写法见 `DevSession.resolveTarget`。
 */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { CdpError, hostParams, wrapExpression } from "./cdp.ts";
import { DevError, badRequest, staleHandle } from "./errors.ts";
import type { DevSession, ResolvedTarget } from "./session.ts";
import type {
  ClickResponse,
  ClipRect,
  ConsoleBatch,
  ConsoleEntry,
  ConsoleStartResponse,
  ConsoleStopResponse,
  EvalResponse,
  ScreenshotRequest,
  TargetSummary,
} from "./types.ts";

export async function listTargets(s: DevSession): Promise<TargetSummary[]> {
  const targets = await s.targets();
  return targets
    .filter((t) => t.type === "page" || t.type === "iframe")
    .map((t) => {
      const role = s.role(t);
      const summary: TargetSummary = {
        targetId: t.targetId,
        type: t.type,
        url: t.url,
        title: t.title,
        parentId: t.parentId ?? null,
        role,
      };
      if (role === "scene-host") {
        const { scene, instance } = hostParams(t.url);
        summary.scene = scene;
        summary.instance = instance;
        summary.handle = s.handleForInstance(instance);
      }
      return summary;
    });
}

/** 把求值失败转成 REST 错误：页面抛错 422，超时 504，其余交给上层。 */
export function pageError(error: unknown, what: string): never {
  if (error instanceof CdpError) {
    if (error.code === "exception") throw new DevError(422, "page", `${what}：页面里抛错：${error.message}`);
    if (error.code === "timeout") throw new DevError(504, "page", `${what}：${error.message}`);
    if (error.code === "closed") throw new DevError(503, "cdp", `${what}：${error.message}`);
    throw new DevError(422, "page", `${what}：${error.message}`);
  }
  throw error;
}

/** 在目标里求值任意 JS（表达式或语句块都行，可 `await`）。 */
export async function evaluate(
  s: DevSession,
  target: string,
  expression: string,
  timeoutMs = 30_000,
): Promise<EvalResponse> {
  if (typeof expression !== "string" || !expression.trim()) throw badRequest("缺 expression");
  const resolved = await s.resolveTarget(target);
  try {
    return await s.evaluateIn(resolved.targetId, wrapExpression(expression), timeoutMs);
  } catch (error) {
    pageError(error, `在 ${target} 求值`);
  }
}

/** 在目标里跑一段内部写好的表达式，取值。 */
export async function evalValue<T>(
  s: DevSession,
  targetId: string,
  expression: string,
  timeoutMs = 15_000,
): Promise<T> {
  try {
    return (await s.evaluateIn(targetId, expression, timeoutMs)).value as T;
  } catch (error) {
    pageError(error, "求值");
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 选择器命中的第一个元素：滚进视口后的矩形（目标页面视口坐标）。 */
async function elementBox(
  s: DevSession,
  targetId: string,
  selector: string,
): Promise<{ box: Box; tag: string; inner: { w: number; h: number } }> {
  const result = await evalValue<{ box: Box; tag: string; inner: { w: number; h: number } } | null>(
    s,
    targetId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, tag: el.tagName.toLowerCase(), inner: { w: innerWidth, h: innerHeight } };
    })()`,
  );
  if (!result) throw new DevError(422, "page", `没有元素匹配选择器 ${selector}`, { selector });
  return result;
}

/**
 * 场景宿主 iframe 在父页面视口里的位置：内容区左上角、内容区对布局像素的缩放（祖先 transform）、
 * 是否在视口内。
 */
async function hostFrameRect(
  s: DevSession,
  resolved: ResolvedTarget,
): Promise<{
  parentId: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  box: Box;
  viewport: { w: number; h: number };
}> {
  const parentId = resolved.info.parentId;
  if (!parentId) throw new DevError(422, "target", "场景宿主没有父目标");
  const instance = resolved.host?.instance ?? hostParams(resolved.info.url).instance;
  const rect = await evalValue<{
    x: number;
    y: number;
    sx: number;
    sy: number;
    box: Box;
    viewport: { w: number; h: number };
  } | null>(
    s,
    parentId,
    `(() => {
      const frame = [...document.querySelectorAll("iframe")].find((f) => {
        try { return new URL(f.src, location.href).searchParams.get("kbInstance") === ${JSON.stringify(instance)}; } catch { return false; }
      });
      if (!frame) return null;
      const r = frame.getBoundingClientRect();
      const sx = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
      const sy = frame.offsetHeight ? r.height / frame.offsetHeight : 1;
      const style = getComputedStyle(frame);
      const left = frame.clientLeft + parseFloat(style.paddingLeft || "0");
      const top = frame.clientTop + parseFloat(style.paddingTop || "0");
      return {
        x: r.x + left * sx, y: r.y + top * sy, sx, sy,
        box: { x: r.x + left * sx, y: r.y + top * sy, width: frame.clientWidth * sx, height: frame.clientHeight * sy },
        viewport: { w: innerWidth, h: innerHeight },
      };
    })()`,
  );
  if (!rect) throw new DevError(422, "target", `父页面里找不到 kbInstance=${instance} 的 iframe`);
  return { parentId, ...rect };
}

function intersect(box: Box, viewport: { w: number; h: number }): Box | null {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(viewport.w, box.x + box.width);
  const y1 = Math.min(viewport.h, box.y + box.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function validClip(clip: unknown): ClipRect {
  const c = clip as Partial<ClipRect>;
  const nums = [c?.x, c?.y, c?.width, c?.height];
  if (!c || nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw badRequest("clip 要是 { x, y, width, height, scale? }（CSS 像素）");
  }
  if (c.width! <= 0 || c.height! <= 0) throw badRequest("clip 的 width / height 要大于 0");
  if (c.scale !== undefined && (typeof c.scale !== "number" || !(c.scale > 0))) throw badRequest("clip.scale 要大于 0");
  return { x: c.x!, y: c.y!, width: c.width!, height: c.height!, scale: c.scale ?? 1 };
}

async function capture(
  s: DevSession,
  pageTargetId: string,
  clip: (Box & { scale?: number }) | null,
  beyondViewport: boolean,
): Promise<Uint8Array> {
  const params: Record<string, unknown> = { format: "png", captureBeyondViewport: beyondViewport };
  if (clip) {
    // Page.captureScreenshot 的 clip 是文档坐标：视口坐标加上可视视口的滚动偏移
    const metrics = await s.sendTo<{ cssVisualViewport: { pageX: number; pageY: number } }>(
      pageTargetId,
      "Page.getLayoutMetrics",
    );
    params.clip = {
      x: clip.x + metrics.cssVisualViewport.pageX,
      y: clip.y + metrics.cssVisualViewport.pageY,
      width: clip.width,
      height: clip.height,
      scale: clip.scale ?? 1,
    };
  }
  try {
    const result = await s.sendTo<{ data: string }>(pageTargetId, "Page.captureScreenshot", params, 20_000);
    return new Uint8Array(Buffer.from(result.data, "base64"));
  } catch (error) {
    if (error instanceof CdpError && error.code === "timeout") {
      throw new DevError(504, "page", "截图等帧超时（Windows 上挂到 WorkerW 的壁纸窗口截不到图，改用 eval 读 DOM）");
    }
    pageError(error, "截图");
  }
}

/**
 * 截图：`selector`、`clip`、`fullPage` 三选一（都不给就是视口）。`clip` 是 CSS 像素、相对目标页面视口。
 * 目标是场景宿主时按 iframe 在父页面里的位置换算后从父页面截（宿主是跨进程 iframe，不能单独截）。
 */
export async function screenshot(s: DevSession, request: ScreenshotRequest): Promise<Uint8Array> {
  const modes = [request.selector !== undefined, request.clip !== undefined, request.fullPage === true];
  if (modes.filter(Boolean).length > 1) throw badRequest("selector、clip、fullPage 只能给一个");
  if (request.selector !== undefined && (typeof request.selector !== "string" || !request.selector)) {
    throw badRequest("selector 要是非空字符串");
  }
  const clip = request.clip !== undefined ? validClip(request.clip) : null;
  const resolved = await s.resolveTarget(request.target);

  if (resolved.role !== "scene-host") {
    if (request.fullPage) {
      const metrics = await s.sendTo<{ cssContentSize: { width: number; height: number } }>(
        resolved.targetId,
        "Page.getLayoutMetrics",
      );
      const { width, height } = metrics.cssContentSize;
      return capture(s, resolved.targetId, { x: 0, y: 0, width, height, scale: 1 }, true);
    }
    if (request.selector) {
      const { box } = await elementBox(s, resolved.targetId, request.selector);
      if (box.width < 1 || box.height < 1) throw new DevError(422, "page", `元素 ${request.selector} 没有尺寸`);
      return capture(s, resolved.targetId, { ...box, scale: 1 }, true);
    }
    return capture(s, resolved.targetId, clip, false);
  }

  if (request.fullPage) throw badRequest("场景宿主不支持 fullPage（截的是父页面里 iframe 那一块）");
  const frame = await hostFrameRect(s, resolved);
  let box: Box = frame.box;
  let scale = 1;
  if (request.selector) {
    const inner = await elementBox(s, resolved.targetId, request.selector);
    box = {
      x: frame.x + inner.box.x * frame.sx,
      y: frame.y + inner.box.y * frame.sy,
      width: inner.box.width * frame.sx,
      height: inner.box.height * frame.sy,
    };
  } else if (clip) {
    box = {
      x: frame.x + clip.x * frame.sx,
      y: frame.y + clip.y * frame.sy,
      width: clip.width * frame.sx,
      height: clip.height * frame.sy,
    };
    scale = clip.scale ?? 1;
  }
  const visible = intersect(box, frame.viewport);
  if (!visible) {
    throw new DevError(422, "host", "场景宿主不在父页面的可见区域里（屏外宿主截不到），取画面用 /hosts/:h/render");
  }
  return capture(s, frame.parentId, { ...visible, scale }, false);
}

/** 取元素中心派发鼠标事件，不等可操作性（相当于原 playwright 的 `force: true`）。 */
export async function click(s: DevSession, target: string, selector: string): Promise<ClickResponse> {
  if (typeof selector !== "string" || !selector) throw badRequest("缺 selector");
  const resolved = await s.resolveTarget(target);
  const { box, tag } = await elementBox(s, resolved.targetId, selector);
  let pageId = resolved.targetId;
  let x = box.x + box.width / 2;
  let y = box.y + box.height / 2;
  if (resolved.role === "scene-host") {
    const frame = await hostFrameRect(s, resolved);
    pageId = frame.parentId;
    x = frame.x + x * frame.sx;
    y = frame.y + y * frame.sy;
  }
  try {
    const base = { x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" };
    await s.sendTo(pageId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
    await s.sendTo(pageId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
    await s.sendTo(pageId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  } catch (error) {
    pageError(error, "点击");
  }
  return { clicked: true, x, y, tag };
}

export async function text(s: DevSession, target: string, selector: string): Promise<string> {
  if (typeof selector !== "string" || !selector) throw badRequest("缺 selector");
  const resolved = await s.resolveTarget(target);
  const value = await evalValue<string | null>(
    s,
    resolved.targetId,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText ?? el.textContent ?? "") : null; })()`,
  );
  if (value === null) throw new DevError(422, "page", `没有元素匹配选择器 ${selector}`, { selector });
  return value;
}

// ---------------------------------------------------------------- 控制台

const CONSOLE_LIMIT = 2000;

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: {
    subtype?: string;
    overflow?: boolean;
    properties?: Array<{ name: string; type: string; value?: string }>;
  };
}

/** 控制台参数转文本：对象用 V8 给的预览（`{a: 1}`、`[1, 2]`），没有预览才退回描述。 */
export function remoteText(arg: RemoteObject): string {
  if (arg.type === "string") return String(arg.value);
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.preview?.properties) {
    const props = arg.preview.properties.map((p) => {
      const value = p.type === "string" ? JSON.stringify(p.value ?? "") : (p.value ?? p.type);
      return arg.preview!.subtype === "array" ? value : `${p.name}: ${value}`;
    });
    if (arg.preview.overflow) props.push("…");
    return arg.preview.subtype === "array" ? `[${props.join(", ")}]` : `{${props.join(", ")}}`;
  }
  return arg.unserializableValue ?? arg.description ?? arg.type ?? "";
}

/**
 * 开始收集目标的控制台：单独 attach 一个 session 并 `Runtime.enable`（与求值用的 session 分开，停的时候不影响别的）。
 * `Runtime.enable` 会回放页面里之前的消息，按时间戳只留开始之后的。
 */
export async function startConsole(s: DevSession, target: string): Promise<ConsoleStartResponse> {
  const resolved = await s.resolveTarget(target);
  const conn = await s.connection();
  const sessionId = await conn.attach(resolved.targetId);
  const id = `c-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const stream = {
    id,
    target,
    targetId: resolved.targetId,
    sessionId,
    startedAt,
    generation: s.generation,
    entries: [] as ConsoleEntry[],
    seq: 0,
    dropped: 0,
    ended: null as string | null,
    off: () => {},
  };
  const push = (entry: Omit<ConsoleEntry, "seq">) => {
    if (entry.ts < startedAt) return;
    stream.entries.push({ seq: ++stream.seq, ...entry });
    if (stream.entries.length > CONSOLE_LIMIT) {
      stream.entries.splice(0, stream.entries.length - CONSOLE_LIMIT);
      stream.dropped++;
    }
  };
  stream.off = conn.on((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Runtime.consoleAPICalled") {
      const frame = event.params.stackTrace?.callFrames?.[0];
      push({
        ts: event.params.timestamp,
        type: event.params.type,
        text: (event.params.args as RemoteObject[]).map(remoteText).join(" "),
        url: frame?.url || undefined,
        line: typeof frame?.lineNumber === "number" ? frame.lineNumber + 1 : undefined,
      });
    } else if (event.method === "Runtime.exceptionThrown") {
      const details = event.params.exceptionDetails;
      push({
        ts: event.params.timestamp,
        type: "exception",
        text: details?.exception?.description ?? details?.text ?? "未捕获异常",
        url: details?.url || undefined,
        line: typeof details?.lineNumber === "number" ? details.lineNumber + 1 : undefined,
      });
    }
  });
  s.consoles.set(id, stream);
  try {
    await conn.send("Runtime.enable", {}, { sessionId });
  } catch (error) {
    stream.off();
    s.consoles.delete(id);
    await conn.detach(sessionId).catch(() => {});
    pageError(error, "开启控制台收集");
  }
  return { id, target, targetId: resolved.targetId, startedAt: new Date(startedAt).toISOString() };
}

function consoleStream(s: DevSession, id: string) {
  const stream = s.consoles.get(id);
  if (!stream) throw staleHandle("控制台流", id);
  return stream;
}

export function readConsole(s: DevSession, id: string, since = 0): ConsoleBatch {
  const stream = consoleStream(s, id);
  const entries = stream.entries.filter((entry) => entry.seq > since);
  return { id, entries, next: stream.seq, ended: stream.ended, dropped: stream.dropped };
}

export async function stopConsole(s: DevSession, id: string): Promise<ConsoleStopResponse> {
  const stream = consoleStream(s, id);
  s.consoles.delete(id);
  stream.off();
  if (s.connected && stream.generation === s.generation && !stream.ended) {
    const conn = await s.connection();
    await conn.send("Runtime.disable", {}, { sessionId: stream.sessionId }).catch(() => {});
    await conn.detach(stream.sessionId).catch(() => {});
  }
  return { id, stopped: true, total: stream.seq };
}
