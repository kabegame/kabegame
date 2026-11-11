/**
 * 场景宿主（只在桌面）：列出、开屏外宿主、在宿主里跑探针任务、渲染一帧取 PNG、粒子轨迹与四角。
 *
 * 只信任「文档入口脚本 = 磁盘上 `SCENE_DIST/index.html` 的入口脚本」的新 frame（P3c 的教训：旧 frame 跑旧代码，
 * 档位选项会被悄悄忽略）。探针（`window.__kabegameSceneProbe`）只在 `--mode development` 构建的宿主里有，
 * 接口在 `apps/wpe-scene/src/dev/`（`renderFrame` 的 `particles`、`particleTrack`、`particleCorners`、`chunk`），
 * 改探针时同步这里与 `replay.ts` 的校验。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { CdpError, hostParams, isMain, isSceneHost, isWallpaper, wrapExpression } from "./cdp.ts";
import { DevError, badRequest } from "./errors.ts";
import { invoke, mainState, openPreview, closePreview, sleep } from "./app.ts";
import { evalValue, pageError } from "./page.ts";
import { checkCornersRequest, checkPostprocess, checkRenderReplay, checkTrackRequest } from "./replay.ts";
import type { DevSession, HostHandle } from "./session.ts";
import type {
  HostCloseResult,
  HostSummary,
  HostTaskResult,
  OpenedHost,
  ParticleCornersLayer,
  ParticleCornersRequest,
  ParticleTrackRequest,
  ParticleTrackResult,
  RenderMeta,
  RenderRequest,
  RenderResponse,
} from "./types.ts";

/** 轨迹、四角这类 JSON 结果的上限（UTF-8 字节）：超过回 413，建议减少 `frames` / `limit`。 */
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
/** JSON 结果按这么多字符一块经 `Runtime.evaluate` 取回（单次 CDP 消息不宜过大，同探针 `chunk` 的 4 MB）。 */
const RESULT_CHUNK_CHARS = 4 * 1024 * 1024;

const SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock allow-forms";

/** 磁盘产物的入口脚本名（带内容哈希），例如 `index-kUygKaGd.js`。 */
export function diskEntry(sceneIndex: string): string {
  let html: string;
  try {
    html = readFileSync(sceneIndex, "utf8");
  } catch {
    throw new DevError(409, "host", `读不到宿主产物 ${sceneIndex}：先构建场景宿主（--mode development）`);
  }
  const match = html.match(/assets\/(index-[^"']+\.js)/);
  if (!match) throw new DevError(409, "host", `宿主产物里找不到入口脚本：${sceneIndex}`);
  return match[1];
}

export async function sceneHosts(s: DevSession): Promise<HostSummary[]> {
  const targets = await s.targets();
  const main = targets.find((t) => isMain(t, s.vitePort));
  const wallpaper = targets.find((t) => isWallpaper(t, s.vitePort));
  return targets.filter(isSceneHost).map((t) => {
    const { scene, instance } = hostParams(t.url);
    const handle = s.handleForInstance(instance);
    return {
      targetId: t.targetId,
      url: t.url,
      scene,
      instance,
      where: t.parentId === main?.targetId ? "main" : t.parentId === wallpaper?.targetId ? "wallpaper" : "?",
      handle,
      hidden: handle ? (s.hosts.get(handle)?.hidden ?? null) : null,
    };
  });
}

/** 库里第一张场景壁纸的 id。 */
export async function firstSceneId(s: DevSession): Promise<string> {
  const rows = await invoke<Array<{ id: string }>>(s, "pathql_fetch", {
    path: "images://gallery/media-type/x-wpe/scene/_kb_x1x/1",
  });
  const id = rows?.[0]?.id;
  if (!id) throw new DevError(409, "host", "库里没有场景壁纸（x-wpe/scene），开宿主要给一个 kbScene");
  return String(id);
}

/** 宿主 frame 的自检信息。 */
async function frameInfo(s: DevSession, targetId: string) {
  return evalValue<{ entry: string[]; vis: string; corpusHead: string | null; renderFrame: string }>(
    s,
    targetId,
    `({
      entry: [...document.scripts].map((el) => el.src.split("/").pop()).filter((name) => name.startsWith("index-")),
      vis: document.visibilityState,
      corpusHead: window.__kabegameSceneProbe?.scriptCorpus?.toString().slice(0, 120) ?? null,
      renderFrame: typeof window.__kabegameSceneProbe?.renderFrame,
    })`,
    10_000,
  );
}

/**
 * 开一个从磁盘新加载的宿主。`hidden`（缺省）在主窗口挂屏外 iframe，不碰用户的预览；否则开主窗口预览。
 * 校验入口脚本与探针，不符就关掉并报错。
 */
export async function openHost(s: DevSession, options: { hidden?: boolean; scene?: string } = {}): Promise<OpenedHost> {
  if (s.android) throw new DevError(400, "platform", "场景宿主只在桌面可用");
  const hidden = options.hidden ?? true;
  if (options.scene !== undefined && (typeof options.scene !== "string" || !/^\d+$/.test(options.scene))) {
    throw badRequest("scene 要是图片 id（数字字符串）");
  }
  const entry = diskEntry(s.paths.sceneIndex);
  const main = await s.resolveTarget("main");
  const scene = options.scene ?? (await firstSceneId(s));
  const before = await mainState(s);
  const known = new Set((await sceneHosts(s)).map((h) => h.instance));
  const handle = `h-${randomUUID().slice(0, 8)}`;
  let instance: string | null = null;
  let elementId: string | null = null;

  if (hidden) {
    const base = await invoke<string>(s, "get_wpe_scene_host_url");
    instance = randomUUID();
    elementId = `kb-dev-host-${handle}`;
    await evalValue(
      s,
      main.targetId,
      `(() => {
        const url = new URL(${JSON.stringify(base)});
        url.searchParams.set("kbScene", ${JSON.stringify(scene)});
        url.searchParams.set("kbInstance", ${JSON.stringify(instance)});
        const frame = document.createElement("iframe");
        frame.id = ${JSON.stringify(elementId)};
        frame.dataset.kbDevHost = ${JSON.stringify(handle)};
        frame.sandbox = ${JSON.stringify(SANDBOX)};
        frame.style.cssText = "position:fixed;left:-20000px;top:0;width:1920px;height:1080px;border:0;pointer-events:none";
        frame.src = url.href;
        document.body.append(frame);
        return true;
      })()`,
    );
  } else {
    if (before.preview) throw new DevError(409, "host", "主窗口已开着预览，不接管（用 hidden 宿主）", { before });
    const opened = await openPreview(s, scene);
    if (opened !== "ok") throw new DevError(422, "host", `打不开预览：${opened}`);
  }

  const removeFrame = async () => {
    if (elementId) {
      await evalValue(
        s,
        main.targetId,
        `document.getElementById(${JSON.stringify(elementId)})?.remove() ?? true`,
      ).catch(() => {});
    } else {
      await closePreview(s).catch(() => {});
    }
  };

  let targetId: string | null = null;
  for (const t0 = Date.now(); Date.now() - t0 < 20_000 && !targetId; await sleep(250)) {
    const found = (await s.targets()).find((t) => {
      if (!isSceneHost(t) || t.parentId !== main.targetId) return false;
      const params = hostParams(t.url);
      return instance ? params.instance === instance : params.scene === scene && !known.has(params.instance);
    });
    if (found) {
      targetId = found.targetId;
      instance ??= hostParams(found.url).instance;
    }
  }
  if (!targetId || !instance) {
    await removeFrame();
    throw new DevError(504, "host", "20 s 内等不到新的宿主 iframe");
  }

  // 宿主入口是模块脚本，探针在 main.ts 末尾同步安装，frame 可能先列出来
  let info: Awaited<ReturnType<typeof frameInfo>> | null = null;
  for (const t0 = Date.now(); Date.now() - t0 < 15_000; await sleep(250)) {
    info = await frameInfo(s, targetId).catch(() => null);
    if (info?.renderFrame === "function") break;
  }
  const fail = async (message: string): Promise<never> => {
    await s.detach(targetId!);
    await removeFrame();
    throw new DevError(409, "host", message, { info, diskEntry: entry });
  };
  if (info?.renderFrame !== "function") await fail("宿主里没有 dev 探针：场景宿主要用 --mode development 构建");
  if (info!.entry.length !== 1 || info!.entry[0] !== entry) {
    await fail(
      `宿主跑的不是磁盘产物（磁盘 ${entry}，frame ${info!.entry.join(",") || "无"}）：旧 frame 跑旧代码，不信任`,
    );
  }

  const record: HostHandle = {
    handle,
    instance,
    scene,
    targetId,
    hidden,
    elementId,
    entry,
    known,
    before,
    generation: s.generation,
    build: { entry, frameVisibility: info!.vis, corpusHead: (info!.corpusHead ?? "").slice(0, 80) },
  };
  s.hosts.set(handle, record);
  return { handle, instance, scene, entry, hidden, targetId, build: record.build };
}

/** 关宿主：移除屏外 iframe（或关预览），确认 iframe 不在了。 */
export async function closeHost(s: DevSession, handle: string): Promise<HostCloseResult> {
  const host = s.host(handle);
  s.hosts.delete(handle);
  await s.detach(host.targetId);
  let after;
  if (host.hidden) {
    const main = await s.resolveTarget("main");
    await evalValue(s, main.targetId, `document.getElementById(${JSON.stringify(host.elementId)})?.remove() ?? true`);
    for (const t0 = Date.now(); Date.now() - t0 < 3000; await sleep(200)) {
      if (!(await s.targets()).some((t) => t.targetId === host.targetId)) break;
    }
    await sleep(300);
    after = await mainState(s);
  } else {
    after = await closePreview(s);
  }
  const others = new Set([...s.hosts.values()].map((h) => h.instance));
  const previewHostsLeft = (await sceneHosts(s)).filter(
    (h) => !host.known.has(h.instance) && !others.has(h.instance),
  ).length;
  return { handle, before: host.before, after, previewHostsLeft };
}

/** vite 关闭时：尽力关掉全部宿主句柄。 */
export async function closeAllHosts(s: DevSession): Promise<void> {
  for (const handle of [...s.hosts.keys()]) {
    await closeHost(s, handle).catch(() => {});
  }
}

export async function hostEval(s: DevSession, handle: string, expression: string, timeoutMs = 30_000) {
  const host = s.host(handle);
  if (typeof expression !== "string" || !expression.trim()) throw badRequest("缺 expression");
  try {
    return await s.evaluateIn(host.targetId, wrapExpression(expression), timeoutMs);
  } catch (error) {
    pageError(error, `在宿主 ${handle} 求值`);
  }
}

/**
 * 在宿主里起一个 Promise 任务、轮询取结果：宿主卡住时不硬等，也不让 CDP 单次求值背超时。宿主主线程 90 s 无应答才放弃。
 * 结果放在宿主的 `window.__kbTask[<槽位>]`，取走即删。`expression` 是返回 Promise（或值）的 JS 表达式。
 */
export async function hostTask(
  s: DevSession,
  handle: string,
  expression: string,
  options: HostTaskOptions = {},
): Promise<HostTaskResult> {
  const host = s.host(handle);
  const slot = await runHostTask(s, handle, expression, options);
  return evalValue<HostTaskResult>(
    s,
    host.targetId,
    `(() => { const v = window.__kbTask[${slot}]; delete window.__kbTask[${slot}]; return v; })()`,
    60_000,
  );
}

export interface HostTaskOptions {
  limitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/** 宿主任务的 JSON 结果：`done` 时 `value` 是解析后的结果，`bytes` 是它的 UTF-8 字节数。 */
export interface HostTaskJson<T> {
  status: "done" | "rejected";
  ms: number;
  value?: T;
  bytes?: number;
  error?: string;
}

/**
 * 同 `hostTask`，但结果在宿主里先 `JSON.stringify`、量大小，再按 4 M 字符一块取回、在 vite 里解析：单次 CDP 消息不会过大，
 * 超过 `maxBytes`（缺省 32 MB）时不取、回 413。注意 JSON 的取值规则：`NaN` / `Infinity` 变成 null，`-0` 变成 0。
 */
export async function hostTaskJson<T>(
  s: DevSession,
  handle: string,
  expression: string,
  options: HostTaskOptions & { maxBytes?: number; what?: string; chunkChars?: number } = {},
): Promise<HostTaskJson<T>> {
  const host = s.host(handle);
  const maxBytes = options.maxBytes ?? MAX_RESULT_BYTES;
  const chunk = options.chunkChars ?? RESULT_CHUNK_CHARS;
  const slot = await runHostTask(s, handle, expression, options);
  const head = await evalValue<{
    status: "done" | "rejected";
    ms: number;
    error?: string;
    bytes?: number;
    chars?: number;
    tooLarge?: boolean;
  }>(
    s,
    host.targetId,
    `(() => {
      const box = window.__kbTask, v = box[${slot}];
      if (v.status !== "done") { delete box[${slot}]; return { status: v.status, ms: v.ms, error: v.error }; }
      let text;
      try { text = JSON.stringify(v.result) ?? "null"; }
      catch (e) { delete box[${slot}]; return { status: "rejected", ms: v.ms, error: "结果转不成 JSON：" + String(e) }; }
      const bytes = new Blob([text]).size;
      if (bytes > ${maxBytes}) { delete box[${slot}]; return { status: "done", ms: v.ms, bytes, tooLarge: true }; }
      box[${slot}] = { status: "fetching", text };
      return { status: "done", ms: v.ms, bytes, chars: text.length };
    })()`,
    60_000,
  );
  if (head.status !== "done") return { status: head.status, ms: head.ms, error: head.error };
  if (head.tooLarge) {
    throw new DevError(
      413,
      "host",
      `${options.what ?? "结果"}有 ${head.bytes} 字节，超过上限 ${maxBytes}：减少 frames / limit 再试`,
      { bytes: head.bytes, maxBytes },
    );
  }
  const parts: string[] = [];
  try {
    for (let start = 0; start < head.chars!; start += chunk) {
      parts.push(
        await evalValue<string>(
          s,
          host.targetId,
          `window.__kbTask[${slot}].text.slice(${start}, ${start + chunk})`,
          60_000,
        ),
      );
    }
  } finally {
    await evalValue(s, host.targetId, `(delete window.__kbTask[${slot}], true)`).catch(() => {});
  }
  const text = parts.join("");
  if (text.length !== head.chars) {
    throw new DevError(422, "host", `取回的结果不完整（${text.length} / ${head.chars} 字符）`);
  }
  return { status: "done", ms: head.ms, value: JSON.parse(text) as T, bytes: head.bytes };
}

/** 在宿主里起任务、轮询到结束（`done` / `rejected`），返回结果槽位（JSON 字面量），结果还在宿主里。 */
async function runHostTask(
  s: DevSession,
  handle: string,
  expression: string,
  options: HostTaskOptions,
): Promise<string> {
  const host = s.host(handle);
  if (typeof expression !== "string" || !expression.trim()) throw badRequest("缺 expression");
  const limitMs = options.limitMs ?? 300_000;
  const pollMs = options.pollMs ?? 250;
  const slot = JSON.stringify(`t-${randomUUID().slice(0, 8)}`);
  const kick = await evalValue(
    s,
    host.targetId,
    `(() => {
      const box = (window.__kbTask ??= {}), t0 = performance.now();
      box[${slot}] = { status: "running" };
      Promise.resolve().then(() => ${expression}).then(
        (r) => { box[${slot}] = { status: "done", ms: performance.now() - t0, result: r }; },
        (e) => { box[${slot}] = { status: "rejected", ms: performance.now() - t0, error: String((e && e.stack) || e) }; });
      return "started";
    })()`,
    10_000,
  );
  if (kick !== "started") throw new DevError(422, "host", `宿主任务启动失败：${JSON.stringify(kick)}`);
  const started = Date.now();
  let blockedSince: number | null = null;
  while (true) {
    await sleep(pollMs);
    if (options.signal?.aborted) throw new DevError(499, "host", "已取消（宿主里的 Promise 仍在跑）");
    s.host(handle);
    let status: unknown;
    try {
      status = (await s.evaluateIn(host.targetId, `window.__kbTask?.[${slot}]?.status ?? null`, 10_000)).value;
    } catch (error) {
      if (error instanceof CdpError && (error.code === "timeout" || error.code === "exception")) {
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince > 90_000) {
          throw new DevError(504, "host", `宿主主线程 90 s 无应答：${expression.slice(0, 120)}`);
        }
        continue;
      }
      throw error;
    }
    blockedSince = null;
    if (status === "done" || status === "rejected") break;
    if (status !== "running")
      throw new DevError(422, "host", `宿主任务状态丢失：${JSON.stringify(status)}（宿主重载过？）`);
    if (Date.now() - started > limitMs) {
      throw new DevError(504, "host", `宿主任务 ${limitMs} ms 未完成（仍在宿主里跑）：${expression.slice(0, 120)}`);
    }
  }
  return slot;
}

/** 取探针存下的字节（`chunk` 按 base64 分块）。 */
export async function probeBytes(s: DevSession, handle: string, key: string): Promise<Uint8Array> {
  const host = s.host(handle);
  const parts: Uint8Array[] = [];
  for (let i = 0; ; i++) {
    const part = await evalValue<string | null>(
      s,
      host.targetId,
      `window.__kabegameSceneProbe.chunk(${JSON.stringify(key)}, ${i})`,
      60_000,
    );
    if (!part) break;
    parts.push(new Uint8Array(Buffer.from(part, "base64")));
  }
  if (!parts.length) throw new DevError(422, "host", `探针里没有 ${key}`);
  return new Uint8Array(Buffer.concat(parts));
}

/** 库里这张图当前的用户属性：与后端 `scene_user_from_view` 同一取法，跳过分组 / 文本，只要有值的项。 */
export async function currentUserProperties(
  s: DevSession,
  imageId: string,
): Promise<{ metadataId: unknown; userProperties: Record<string, unknown> }> {
  const view = await invoke<{ metadataId: unknown; items: Array<{ kind: string; key: string; value: unknown }> }>(
    s,
    "get_wpe_web_properties",
    { imageId },
  );
  const userProperties = Object.fromEntries(
    (view?.items ?? [])
      .filter((item) => item.kind !== "group" && item.kind !== "text" && item.value != null)
      .map((item) => [item.key, item.value]),
  );
  return { metadataId: view?.metadataId ?? null, userProperties };
}

export interface SceneTarget {
  path: string;
  sceneAssets: string[];
}

export async function sceneTarget(s: DevSession, imageId: string): Promise<SceneTarget> {
  return invoke<SceneTarget>(s, "wpe_scene_target", { imageId });
}

/**
 * 在宿主里渲染一帧（`__kabegameSceneProbe.renderFrame`），再按 chunk 取回 PNG。场景目录由 `wpe_scene_target` 按图片 id 取。
 * 给了 `particles` 时原样交给探针做确定性回放（不收 `time`：读回那一帧的 `g_Time` 取 `times` 末项或 dt 累计值）；逐帧光标
 * `pointers` 与窗口尺寸 `window`（P5a 收尾）校验后同样原样转给探针。
 * 读回画布 `canvas`（第 5 批）校验后原样转给探针，探针按 `fill` 上屏到这么大的画布再读回；结果的 `meta.canvas` 对不上时（宿主产物
 * 不认识这一项，静默读回了场景目标）报 409。
 * 脚本值 `scriptValues`（第 6 批）校验后原样转给探针；给了而结果没有逐项的 `meta.scriptValues` 时（宿主产物不认识这一项，静默没写）
 * 同样报 409。
 */
export async function renderFrame(
  s: DevSession,
  handle: string,
  request: RenderRequest,
  options: { signal?: AbortSignal; key?: string } = {},
): Promise<RenderResponse> {
  s.host(handle);
  if (typeof request.imageId !== "string" || !/^\d+$/.test(request.imageId)) throw badRequest("imageId 要是图片 id");
  if (request.time !== undefined && (typeof request.time !== "number" || !Number.isFinite(request.time))) {
    throw badRequest("time 要是数字（秒）");
  }
  if (request.postprocess !== undefined) checkPostprocess(request.postprocess);
  const particles = checkRenderReplay(request);
  const target = await sceneTarget(s, request.imageId);
  const userProperties = request.userProperties ?? (await currentUserProperties(s, request.imageId)).userProperties;
  // 固定键：探针把每帧 PNG 存在内存里，同键覆盖才不会越跑越大
  const key = options.key ?? `kbdev-${handle}`;
  const args = {
    projectDir: target.path,
    sceneAssets: target.sceneAssets,
    postprocess: request.postprocess ?? "disabled",
    userProperties,
    ...(particles ? { particles } : { time: request.time ?? 1.5 }),
    key,
    ...(request.pointer ? { pointer: request.pointer } : {}),
    // 逐帧光标（P5a 收尾）：checkRenderReplay 已校验（要有 particles、等长、不和 pointer 同给）
    ...(request.pointers ? { pointers: request.pointers } : {}),
    ...(request.window ? { window: request.window } : {}),
    // 读回画布（第 5 批）：checkRenderReplay 已校验（两个正整数、不超过上限、和 window 相同）
    ...(request.canvas ? { canvas: request.canvas } : {}),
    // 脚本值（第 6 批）：checkRenderReplay 已校验（形状、项数）；对象与字段脚本由探针解析
    ...(request.scriptValues ? { scriptValues: request.scriptValues } : {}),
  };
  const task = await hostTask(s, handle, `__kabegameSceneProbe.renderFrame(${JSON.stringify(args)})`, {
    signal: options.signal,
  });
  if (task.status !== "done") throw new DevError(422, "host", `渲染失败：${task.error}`, { imageId: request.imageId });
  const meta = task.result as RenderMeta;
  const canvas = request.canvas;
  if (canvas && !(Array.isArray(meta.canvas) && meta.canvas[0] === canvas[0] && meta.canvas[1] === canvas[1])) {
    throw new DevError(
      409,
      "host",
      `宿主产物没有按 canvas ${canvas[0]}×${canvas[1]} 读回（结果 ${meta.width}×${meta.height}）：探针不认识 canvas，重建宿主（--mode development）`,
      {
        imageId: request.imageId,
        canvas,
        meta: { width: meta.width, height: meta.height, canvas: meta.canvas ?? null },
      },
    );
  }
  const scriptValues = request.scriptValues;
  if (scriptValues?.length && !(Array.isArray(meta.scriptValues) && meta.scriptValues.length === scriptValues.length)) {
    throw new DevError(
      409,
      "host",
      `宿主产物没有回逐项的 scriptValues（请求 ${scriptValues.length} 项）：探针不认识 scriptValues、静默没写，重建宿主（--mode development）`,
      { imageId: request.imageId, scriptValues, meta: { scriptValues: meta.scriptValues ?? null } },
    );
  }
  const png = await probeBytes(s, handle, `${key}.png`);
  return {
    meta,
    png: Buffer.from(png).toString("base64"),
    pngSha256: createHash("sha256").update(png).digest("hex"),
    pngBytes: png.length,
  };
}

/**
 * 粒子轨迹（`__kabegameSceneProbe.particleTrack`）：探针按场景目录编译（不解码纹理），按 `dts` 逐帧步进模拟器，在 `frames`
 * 输出和 RenderDoc 轨迹同格式的 JSON。结果超过 32 MB 回 413。
 */
export async function particleTrack(
  s: DevSession,
  handle: string,
  request: ParticleTrackRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ParticleTrackResult> {
  s.host(handle);
  const checked = checkTrackRequest(request);
  const target = await sceneTarget(s, checked.imageId);
  const { imageId, ...rest } = checked;
  const args = { projectDir: target.path, sceneAssets: target.sceneAssets, ...rest };
  const task = await hostTaskJson<ParticleTrackResult>(
    s,
    handle,
    `__kabegameSceneProbe.particleTrack(${JSON.stringify(args)})`,
    { signal: options.signal, what: "粒子轨迹" },
  );
  if (task.status !== "done") {
    throw new DevError(422, "host", `粒子轨迹失败：${task.error}`, { imageId });
  }
  return task.value!;
}

/**
 * 粒子四角（`__kabegameSceneProbe.particleCorners`）：探针编译、建场景、按 `particles` 回放，把每个粒子层的顶点着色器改成计算
 * 着色器跑一遍，读回每个粒子四角的裁剪坐标与像素坐标。`userProperties` 缺省取库里这张图当前的值。结果超过 32 MB 回 413。
 */
export async function particleCorners(
  s: DevSession,
  handle: string,
  request: ParticleCornersRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ParticleCornersLayer[]> {
  s.host(handle);
  const checked = checkCornersRequest(request);
  const target = await sceneTarget(s, checked.imageId);
  const userProperties = checked.userProperties ?? (await currentUserProperties(s, checked.imageId)).userProperties;
  const args = {
    projectDir: target.path,
    sceneAssets: target.sceneAssets,
    postprocess: checked.postprocess ?? "disabled",
    userProperties,
    ...(checked.particles ? { particles: checked.particles } : {}),
    ...(checked.pointers ? { pointers: checked.pointers } : {}),
    ...(checked.window ? { window: checked.window } : {}),
    ...(checked.layer !== undefined ? { layer: checked.layer } : {}),
    ...(checked.limit !== undefined ? { limit: checked.limit } : {}),
    ...(checked.wgsl ? { wgsl: true } : {}),
  };
  const task = await hostTaskJson<ParticleCornersLayer[]>(
    s,
    handle,
    `__kabegameSceneProbe.particleCorners(${JSON.stringify(args)})`,
    { signal: options.signal, what: "粒子四角" },
  );
  if (task.status !== "done") {
    throw new DevError(422, "host", `粒子四角失败：${task.error}`, { imageId: checked.imageId });
  }
  return task.value!;
}
