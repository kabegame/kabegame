/**
 * 场景宿主（只在桌面）：列出、开屏外宿主、在宿主里跑探针任务、渲染一帧取 PNG。
 *
 * 只信任「文档入口脚本 = 磁盘上 `SCENE_DIST/index.html` 的入口脚本」的新 frame（P3c 的教训：旧 frame 跑旧代码，
 * 档位选项会被悄悄忽略）。探针（`window.__kabegameSceneProbe`）只在 `--mode development` 构建的宿主里有，
 * 接口在 `apps/wpe-scene/src/dev/`，改探针时同步这里。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { CdpError, hostParams, isMain, isSceneHost, isWallpaper, wrapExpression } from "./cdp.ts";
import { DevError, badRequest } from "./errors.ts";
import { invoke, mainState, openPreview, closePreview, sleep } from "./app.ts";
import { evalValue, pageError } from "./page.ts";
import type { DevSession, HostHandle } from "./session.ts";
import type {
  HostCloseResult,
  HostSummary,
  HostTaskResult,
  OpenedHost,
  RenderMeta,
  RenderRequest,
  RenderResponse,
} from "./types.ts";

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
  options: { limitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<HostTaskResult> {
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
  return evalValue<HostTaskResult>(
    s,
    host.targetId,
    `(() => { const v = window.__kbTask[${slot}]; delete window.__kbTask[${slot}]; return v; })()`,
    60_000,
  );
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

/** 在宿主里渲染一帧（`__kabegameSceneProbe.renderFrame`），再按 chunk 取回 PNG。场景目录由 `wpe_scene_target` 按图片 id 取。 */
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
  const levels = ["disabled", "enabled", "ultra", "follow"];
  if (request.postprocess !== undefined && !levels.includes(request.postprocess)) {
    throw badRequest(`postprocess 只能是 ${levels.join(" / ")}`);
  }
  const target = await sceneTarget(s, request.imageId);
  const userProperties = request.userProperties ?? (await currentUserProperties(s, request.imageId)).userProperties;
  // 固定键：探针把每帧 PNG 存在内存里，同键覆盖才不会越跑越大
  const key = options.key ?? `kbdev-${handle}`;
  const args = {
    projectDir: target.path,
    sceneAssets: target.sceneAssets,
    postprocess: request.postprocess ?? "disabled",
    userProperties,
    time: request.time ?? 1.5,
    key,
    ...(request.pointer ? { pointer: request.pointer } : {}),
  };
  const task = await hostTask(s, handle, `__kabegameSceneProbe.renderFrame(${JSON.stringify(args)})`, {
    signal: options.signal,
  });
  if (task.status !== "done") throw new DevError(422, "host", `渲染失败：${task.error}`, { imageId: request.imageId });
  const meta = task.result as RenderMeta;
  const png = await probeBytes(s, handle, `${key}.png`);
  return {
    meta,
    png: Buffer.from(png).toString("base64"),
    pngSha256: createHash("sha256").update(png).digest("hex"),
    pngBytes: png.length,
  };
}
