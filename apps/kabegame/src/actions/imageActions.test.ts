import { describe, expect, it, vi } from "vitest";
import { Monitor, Pause, Play } from "@lucide/vue";
import type { ImageInfo } from "@/types/image";
import { createImageActions, type ImageActionContext } from "./imageActions";
import { resolveActionIcon } from "./types";

vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ isCompact: false }) }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock("@/env", () => ({ IS_ANDROID: false, IS_WEB: false }));

const PREVIEW_ONLY = ["pauseWallpaper", "setCover", "clearStorage"];

function context(type: string, wallpaperPreview?: ImageActionContext["wallpaperPreview"]): ImageActionContext {
  const target = { id: "7", type } as ImageInfo;
  return { target, selectedIds: new Set(["7"]), selectedCount: 1, wallpaperPreview };
}
const live = { live: true, paused: false, coverBusy: false };

function visibleKeys(ctx: ImageActionContext): string[] {
  return createImageActions()
    .filter((action) => action.visible === undefined || action.visible(ctx))
    .map((action) => action.key);
}
function action(key: string) {
  const found = createImageActions().find((item) => item.key === key);
  if (!found) throw new Error(`no action ${key}`);
  return found;
}
const resolve = <T>(value: T | ((ctx: ImageActionContext) => T), ctx: ImageActionContext) =>
  typeof value === "function" ? (value as (ctx: ImageActionContext) => T)(ctx) : value;

describe("预览壁纸专属的菜单项", () => {
  it("画廊的菜单没有实例状态，三项都不显示", () => {
    for (const type of ["x-wpe/scene", "x-wpe/web"]) {
      const keys = visibleKeys(context(type));
      for (const key of PREVIEW_ONLY) expect(keys).not.toContain(key);
    }
  });

  it("预览场景时三项都在，暂停排第一", () => {
    const keys = visibleKeys(context("x-wpe/scene", live));
    expect(keys[0]).toBe("pauseWallpaper");
    for (const key of PREVIEW_ONLY) expect(keys).toContain(key);
    expect(keys.indexOf("setCover")).toBeGreaterThan(keys.indexOf("wallpaper"));
  });

  it("网页壁纸没有清空脚本存储", () => {
    const keys = visibleKeys(context("x-wpe/web", live));
    expect(keys).toContain("pauseWallpaper");
    expect(keys).toContain("setCover");
    expect(keys).not.toContain("clearStorage");
  });

  it("多选时不显示", () => {
    const ctx = { ...context("x-wpe/scene", live), selectedIds: new Set(["7", "8"]), selectedCount: 2 };
    for (const key of PREVIEW_ONLY) expect(visibleKeys(ctx)).not.toContain(key);
  });

  it("画面出来之前暂停与设为封面置灰，清空不受影响", () => {
    const loading = context("x-wpe/scene", { ...live, live: false });
    expect(resolve(action("pauseWallpaper").disabled, loading)).toBe(true);
    expect(resolve(action("setCover").disabled, loading)).toBe(true);
    expect(resolve(action("clearStorage").disabled ?? false, loading)).toBe(false);
    const ready = context("x-wpe/scene", live);
    expect(resolve(action("pauseWallpaper").disabled, ready)).toBe(false);
    expect(resolve(action("setCover").disabled, ready)).toBe(false);
  });

  it("设为封面进行中置灰", () => {
    expect(resolve(action("setCover").disabled, context("x-wpe/web", { ...live, coverBusy: true }))).toBe(true);
  });

  it("暂停的文案与图标跟着状态切换", () => {
    const pause = action("pauseWallpaper");
    const playing = context("x-wpe/scene", live);
    const paused = context("x-wpe/scene", { ...live, paused: true });
    expect(resolve(pause.label, playing)).toBe("gallery.wpePause");
    expect(resolveActionIcon(pause.icon, playing)).toBe(Pause);
    expect(resolve(pause.label, paused)).toBe("gallery.wpeResume");
    expect(resolveActionIcon(pause.icon, paused)).toBe(Play);
  });

  it("hide 可以隐藏", () => {
    const actions = createImageActions({ hide: PREVIEW_ONLY });
    const ctx = context("x-wpe/scene", live);
    const keys = actions.filter((item) => item.visible === undefined || item.visible(ctx)).map((item) => item.key);
    for (const key of PREVIEW_ONLY) expect(keys).not.toContain(key);
  });
});

describe("设为壁纸", () => {
  it("桌面用显示器图标", () => {
    expect(action("wallpaper").icon).toBe(Monitor);
  });
});

describe("图标解析", () => {
  it("lucide 图标是函数式组件，不能被当成解析器调用", () => {
    expect(typeof Monitor).toBe("function");
    expect(resolveActionIcon(action("wallpaper").icon, context("image/png"))).toBe(Monitor);
  });
});
