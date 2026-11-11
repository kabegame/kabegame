/**
 * 应用级操作：调应用命令、主窗口状态、开关预览（Vue 内部）、显示主窗口、按深链接打开图片预览、应用状态快照。
 */
import { randomUUID } from "node:crypto";
import { hostParams, isMain, isSceneHost, isWallpaper } from "./cdp.ts";
import { DevError, badRequest, errorMessage } from "./errors.ts";
import { evalValue, pageError } from "./page.ts";
import type { DevSession } from "./session.ts";
import type {
  AppState,
  MainState,
  OpenImagePreviewRequest,
  OpenImagePreviewResult,
  PreviewInfo,
  ShowWindowResult,
  WindowFrontState,
} from "./types.ts";

async function mainTargetId(s: DevSession): Promise<string> {
  return (await s.resolveTarget("main")).targetId;
}

/** 应用命令拒绝（invoke 的 Promise reject）。 */
export class AppCommandError extends DevError {
  constructor(command: string, detail: unknown) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    super(422, "app", `${command} 失败：${text}`, { command, detail });
  }
}

/**
 * 在主窗口调 `window.__TAURI_INTERNALS__.invoke`（只调用，不包装它）。
 * 命令 reject 时抛 `AppCommandError`（422，layer `app`）。
 */
export async function invoke<T = unknown>(
  s: DevSession,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  if (typeof command !== "string" || !/^[A-Za-z0-9_:|.-]+$/.test(command)) {
    throw badRequest(`command 不合法：${JSON.stringify(command)}`);
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw badRequest("args 要是对象");
  const outcome = await evalValue<{ ok: boolean; value?: unknown; error?: unknown }>(
    s,
    await mainTargetId(s),
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(
      (value) => ({ ok: true, value: value === undefined ? null : value }),
      (error) => ({ ok: false, error: error instanceof Error ? String(error.message) : error }),
    )`,
    timeoutMs,
  );
  if (!outcome?.ok) throw new AppCommandError(command, outcome?.error ?? "未知错误");
  return outcome.value as T;
}

/**
 * 页面里求当前图片预览弹窗的表达式（结果是 `PreviewInfo`）。依赖 Vue 内部（dev 构建才有 `__vueParentComponent`）：
 * - 弹窗是 `ImagePreviewDialog`：`exposed.previewVisible` 是开关的唯一真源，`props.image` 是目标（ImageInfo 或裸 id），
 *   `setupState.previewImage` 是它实际在画的那张；
 * - 桌面从 `.image-preview-dialog`（el-dialog 的根，首次打开后才渲染）往上找；安卓（PhotoSwipe）没有这个类，
 *   从网格 `.image-grid-container` 往上找到 `ImageGridCore`，再经它的 `previewRef` 取弹窗；
 * - 页码与持有的行取外层 `ImageGrid` 的 `exposed`（`jumpToPage`、`images`、`currentPage`、`pageSize`）。
 * keep-alive 缓存的视图不在文档里，找不到，也就不算。
 */
export const PREVIEW_PROBE = `(() => {
  const unref = (v) => (v && typeof v === "object" && v.__v_isRef ? v.value : v);
  const dialogs = new Set();
  for (const el of document.querySelectorAll(".image-preview-dialog")) {
    let inst = el.__vueParentComponent;
    while (inst && !(inst.exposed && "previewVisible" in inst.exposed && "close" in inst.exposed)) inst = inst.parent;
    if (inst) dialogs.add(inst);
  }
  for (const el of document.querySelectorAll(".image-grid-container")) {
    let core = el.__vueParentComponent;
    while (core && !core.setupState?.previewRef) core = core.parent;
    const inst = core?.setupState?.previewRef?.$;
    if (inst) dialogs.add(inst);
  }
  let open = null;
  for (const inst of dialogs) {
    if (!inst.isMounted || inst.isUnmounted) continue;
    if (!unref(inst.exposed?.previewVisible)) continue;
    open = inst;
    break;
  }
  if (!open) return { open: false, imageId: null, resolved: false, mode: null, inView: false, page: null, pageSize: null };
  const prop = open.props?.image;
  const single = typeof prop === "string";
  const imageId = single ? prop : (prop?.id ?? null);
  const shown = unref(open.setupState?.previewImage);
  let grid = open.parent;
  while (grid && !(grid.exposed && "jumpToPage" in grid.exposed)) grid = grid.parent;
  const rows = unref(grid?.exposed?.images) ?? [];
  const inView = imageId != null && Array.isArray(rows) && rows.some((row) => row?.id === imageId);
  const page = unref(grid?.exposed?.currentPage);
  const pageSize = unref(grid?.exposed?.pageSize);
  return {
    open: true,
    imageId: imageId == null ? null : String(imageId),
    resolved: imageId != null && shown?.id === imageId,
    mode: single ? "single" : inView ? "in-view" : "locating",
    inView,
    page: typeof page === "number" ? page : null,
    pageSize: typeof pageSize === "number" ? pageSize : null,
  };
})()`;

/** 主窗口状态：可见性、路由、预览开没开（按预览弹窗本身）与是哪张、网格持有的行（确认收尾时没有跳页）。 */
export async function mainState(s: DevSession): Promise<MainState> {
  return evalValue<MainState>(
    s,
    await mainTargetId(s),
    `(() => {
      const preview = ${PREVIEW_PROBE};
      return {
        vis: document.visibilityState,
        route: location.pathname + location.search,
        preview: preview.open,
        previewImageId: preview.open ? preview.imageId : null,
        grid: (() => {
          let inst = document.querySelector(".image-grid-container")?.__vueParentComponent;
          while (inst && !inst.props?.images) inst = inst.parent;
          const rows = inst?.props.images ?? [];
          return rows.length + ":" + (rows[0]?.id ?? "") + ".." + (rows.at(-1)?.id ?? "");
        })(),
      };
    })()`,
  );
}

/** 主窗口当前的预览弹窗。 */
export async function previewInfo(s: DevSession): Promise<PreviewInfo> {
  return evalValue<PreviewInfo>(s, await mainTargetId(s), PREVIEW_PROBE);
}

/** 开主窗口预览（依赖 Vue 内部 `openPreviewById`）。成功返回 `"ok"`，否则返回原因。 */
export async function openPreview(s: DevSession, imageId: string): Promise<string> {
  return evalValue<string>(
    s,
    await mainTargetId(s),
    `(() => {
      let inst = document.querySelector(".image-grid-container")?.__vueParentComponent;
      while (inst && !inst.exposed?.openPreviewById) inst = inst.parent;
      if (!inst) return "主窗口没有图片网格（不在画廊类页面）";
      inst.exposed.openPreviewById(${JSON.stringify(String(imageId))});
      return "ok";
    })()`,
  );
}

/** 关主窗口预览：先 Esc，没关掉再调 Vue 内部 `closePreview`。返回之后的主窗口状态。 */
export async function closePreview(s: DevSession): Promise<MainState> {
  const targetId = await mainTargetId(s);
  for (const type of ["keyDown", "keyUp"]) {
    await s.sendTo(targetId, "Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }
  await sleep(800);
  let after = await mainState(s);
  if (after.preview) {
    await evalValue(
      s,
      targetId,
      `(() => {
        let inst = document.querySelector(".image-grid-container")?.__vueParentComponent;
        while (inst && !inst.exposed?.closePreview) inst = inst.parent;
        inst?.exposed.closePreview();
        return true;
      })()`,
    );
    await sleep(800);
    after = await mainState(s);
  }
  return after;
}

// ---------------------------------------------------------------- 显示主窗口

const isFront = (state: WindowFrontState) => state.visibilityState === "visible" && state.hasFocus;

async function windowFrontState(s: DevSession, targetId: string): Promise<WindowFrontState> {
  const page = await evalValue<{ visibilityState: string; hasFocus: boolean }>(
    s,
    targetId,
    `({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })`,
    5000,
  );
  const flag = (command: string) =>
    invoke<boolean>(s, command, { label: "main" }, 5000).then(
      (value) => (typeof value === "boolean" ? value : null),
      () => null,
    );
  return {
    visibilityState: page.visibilityState,
    hasFocus: page.hasFocus,
    minimized: await flag("plugin:window|is_minimized"),
    visible: await flag("plugin:window|is_visible"),
  };
}

/** 轮询到「页面可见且有焦点」或超时，回最后一次的状态。可见性由 Chromium 的遮挡计算异步更新，要等一会儿。 */
async function waitFront(s: DevSession, targetId: string, limitMs: number): Promise<WindowFrontState> {
  const started = Date.now();
  let state = await windowFrontState(s, targetId);
  while (!isFront(state) && Date.now() - started < limitMs) {
    await sleep(150);
    state = await windowFrontState(s, targetId);
  }
  return state;
}

/**
 * 把主窗口带到前台：最小化时 `unminimize`、不可见时 `show`，再 `set_focus`（同 `startup.rs` 的 `ensure_main_window`：
 * 不无条件 unminimize / show，CEF 的 restore 会把最大化的窗口还原）。主窗口免 ACL，`main.json` 也有对应权限。
 * Windows 上后台进程调 `SetForegroundWindow` 可能只让任务栏闪烁：没到前台时退一步临时置顶、`set_focus`、
 * 再取消置顶（原本就置顶的不取消）。
 */
export async function showWindow(s: DevSession): Promise<ShowWindowResult> {
  if (s.android) throw new DevError(400, "platform", "显示主窗口只在桌面可用（当前是安卓 dev）");
  const targetId = await mainTargetId(s);
  const steps: string[] = [];
  const call = async (command: string, args: Record<string, unknown> = {}) => {
    try {
      await invoke(s, command, { label: "main", ...args }, 10_000);
      steps.push(`${command}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""}：ok`);
    } catch (error) {
      steps.push(`${command}：失败（${errorMessage(error)}）`);
    }
  };
  const before = await windowFrontState(s, targetId);
  if (before.minimized !== false) await call("plugin:window|unminimize");
  else steps.push("plugin:window|unminimize：跳过（没最小化）");
  if (before.visible !== true) await call("plugin:window|show");
  else steps.push("plugin:window|show：跳过（已可见）");
  await call("plugin:window|set_focus");
  let after = await waitFront(s, targetId, 2000);
  if (isFront(after)) return { front: true, path: "focus", before, after, steps };

  const onTop = await invoke<boolean>(s, "plugin:window|is_always_on_top", { label: "main" }, 5000).catch(() => null);
  if (onTop !== true) await call("plugin:window|set_always_on_top", { value: true });
  await call("plugin:window|set_focus");
  after = await waitFront(s, targetId, 2000);
  if (onTop !== true) {
    await call("plugin:window|set_always_on_top", { value: false });
    await sleep(300);
    after = await windowFrontState(s, targetId);
  }
  return { front: isFront(after), path: "always-on-top", before, after, steps };
}

// ---------------------------------------------------------------- 按深链接打开图片预览

/**
 * 打开图片预览：主窗口导航到 `/gallery`（保留当前 query，加 `pvwimgid=<id>`）并重载，等预览弹窗打开、确认是这张图，
 * 再把主窗口带到前台。图片网格只在挂载时读一次 URL，只改参数不会打开预览，所以要重载。
 *
 * 图在当前视图里时网格跳到它所在的页（`mode: "in-view"`）；不在时降级成单图预览（`single`）。不改筛选条件。
 * 重载会销毁主窗口里 vite 开的屏外宿主，有的话拒绝（先 `host_close`）。
 */
export async function openImagePreview(
  s: DevSession,
  request: OpenImagePreviewRequest,
): Promise<OpenImagePreviewResult> {
  const imageId = String(request.imageId ?? "");
  if (!/^\d+$/.test(imageId)) throw badRequest("imageId 要是图片 id（数字）");
  const timeoutMs = request.timeoutMs ?? 45_000;
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) throw badRequest("timeoutMs 要是正数");
  const started = Date.now();

  const owned = [...s.hosts.values()].filter((host) => host.generation === s.generation);
  if (s.connected && owned.length) {
    throw new DevError(
      409,
      "host",
      `主窗口里还有 vite 开的场景宿主（${owned.map((h) => h.handle).join("、")}）：打开预览要重载主窗口，会把它们一起销毁；先 host_close`,
      { hosts: owned.map((h) => h.handle) },
    );
  }
  const rows = await invoke<unknown[]>(s, "pathql_fetch", { path: `images://gallery/by_id/${imageId}` });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DevError(422, "app", `图片 ${imageId} 不存在（images://gallery/by_id/${imageId} 没有行）`, { imageId });
  }

  const targetId = await mainTargetId(s);
  const marker = randomUUID();
  const before = await evalValue<{ route: string; url: string; preview: PreviewInfo }>(
    s,
    targetId,
    `(() => {
      window.__kbDevNavMarker = ${JSON.stringify(marker)};
      const url = new URL(location.href);
      url.pathname = "/gallery";
      url.searchParams.set("pvwimgid", ${JSON.stringify(imageId)});
      return { route: location.pathname + location.search, url: url.href, preview: ${PREVIEW_PROBE} };
    })()`,
  );
  try {
    const nav = await s.sendTo<{ errorText?: string }>(targetId, "Page.navigate", { url: before.url }, 20_000);
    if (nav?.errorText) throw new DevError(422, "page", `主窗口导航失败：${nav.errorText}`, { url: before.url });
  } catch (error) {
    if (error instanceof DevError) throw error;
    pageError(error, "导航主窗口");
  }

  const deadline = started + timeoutMs;
  const poll = async <T>(expression: string): Promise<T | null> => {
    try {
      return await evalValue<T>(s, targetId, expression, 5000);
    } catch {
      // 导航中执行上下文会换掉，求值可能失败或超时，下一轮再试
      return null;
    }
  };
  let loaded = false;
  while (Date.now() < deadline) {
    const state = await poll<{ marker: string | null; ready: string }>(
      `({ marker: window.__kbDevNavMarker ?? null, ready: document.readyState })`,
    );
    if (state && state.marker !== marker && state.ready === "complete") {
      loaded = true;
      break;
    }
    await sleep(200);
  }
  if (!loaded) throw new DevError(504, "page", `主窗口 ${timeoutMs} ms 内没重载完`, { url: before.url });

  let last: { route: string; pvwimgid: string | null; preview: PreviewInfo } | null = null;
  while (Date.now() < deadline) {
    last = await poll(
      `({ route: location.pathname + location.search, pvwimgid: new URLSearchParams(location.search).get("pvwimgid"), preview: ${PREVIEW_PROBE} })`,
    );
    const preview = last?.preview;
    if (preview?.open && preview.imageId === imageId && preview.resolved && preview.mode !== "locating") break;
    await sleep(250);
  }
  const preview = last?.preview;
  if (!preview?.open || preview.imageId !== imageId || !preview.resolved || preview.mode === "locating") {
    const hint =
      last && last.pvwimgid !== imageId
        ? "URL 里的 pvwimgid 已不是这张（弹窗按 id 取图失败会清掉它，应用会弹提示）"
        : "网格可能还在加载或跳页";
    throw new DevError(504, "page", `${timeoutMs} ms 内预览没打开到图片 ${imageId}：${hint}`, { last });
  }

  const shown = request.show === false ? null : await showWindow(s);
  return {
    imageId,
    before: { route: before.route, preview: before.preview },
    route: last!.route,
    preview,
    window: shown,
    ms: Date.now() - started,
  };
}

/** 应用状态快照（同 `ignore/lighting/state.mjs`），外加现有场景宿主，用来核对验收前后没有留下痕迹。 */
export async function appState(s: DevSession): Promise<AppState> {
  const call = (command: string) => invoke(s, command).catch((error) => ({ error: String(error?.message ?? error) }));
  const targets = await s.targets();
  const main = targets.find((t) => isMain(t, s.vitePort));
  const wallpaper = targets.find((t) => isWallpaper(t, s.vitePort));
  const sceneHosts = targets
    .filter(isSceneHost)
    .map((t): [string, string] => [
      t.parentId === main?.targetId ? "main" : t.parentId === wallpaper?.targetId ? "wallpaper" : "?",
      hostParams(t.url).scene,
    ])
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  return {
    currentWallpaper: await call("get_current_wallpaper_image_id"),
    mode: await call("get_wallpaper_mode"),
    paused: await call("get_wallpaper_paused"),
    // 原 state.mjs 的 get_wallpaper_disabled 已不存在，「禁用」看 get_wallpaper_enabled
    enabled: await call("get_wallpaper_enabled"),
    postprocess: await call("get_wpe_scene_postprocess"),
    displayMode: await call("get_wallpaper_display_mode"),
    // 轮播路径与位置、样式、过渡、当前壁纸都挂在壁纸目标上（目标 id → 配置）
    targets: await call("get_wallpaper_targets"),
    rotationEnabled: await call("get_wallpaper_rotation_enabled"),
    route: await evalValue<string>(s, await mainTargetId(s), "location.pathname + location.search"),
    sceneHosts,
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
