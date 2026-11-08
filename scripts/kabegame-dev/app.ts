/**
 * 应用级操作：调应用命令、主窗口状态、开关预览（Vue 内部）、应用状态快照。
 */
import { hostParams, isMain, isSceneHost, isWallpaper } from "./cdp.ts";
import { DevError, badRequest } from "./errors.ts";
import { evalValue } from "./page.ts";
import type { DevSession } from "./session.ts";
import type { AppState, MainState } from "./types.ts";

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

/** 主窗口状态：可见性、路由、预览是否开着、网格持有的行（确认收尾时没有跳页）。同 `ignore/p3c/step3/lib.mjs`。 */
export async function mainState(s: DevSession): Promise<MainState> {
  return evalValue<MainState>(
    s,
    await mainTargetId(s),
    `({
      vis: document.visibilityState,
      route: location.pathname + location.search,
      preview: !!document.querySelector(".preview-wallpaper-wrapper"),
      grid: (() => {
        let inst = document.querySelector(".image-grid-container")?.__vueParentComponent;
        while (inst && !inst.props?.images) inst = inst.parent;
        const rows = inst?.props.images ?? [];
        return rows.length + ":" + (rows[0]?.id ?? "") + ".." + (rows.at(-1)?.id ?? "");
      })(),
    })`,
  );
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
    transition: await call("get_wallpaper_rotation_transition"),
    transitionByMode: await call("get_wallpaper_transition_by_mode"),
    styleByMode: await call("get_wallpaper_style_by_mode"),
    rotationEnabled: await call("get_wallpaper_rotation_enabled"),
    route: await evalValue<string>(s, await mainTargetId(s), "location.pathname + location.search"),
    sceneHosts,
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
