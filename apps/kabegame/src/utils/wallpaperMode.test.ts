import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setWallpaperByImageIdWithModeFallback, setWallpaperOrBackground } from "./wallpaperMode";

const invoke = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ web: false }));
/** 模拟后端：壁纸模式、显示器模式，以及哪些图要窗口模式 */
const backend = vi.hoisted(() => ({
  mode: "native",
  displayMode: "single",
  /** 切到窗口模式后显示器模式变成什么（模拟新模式不支持逐屏独立时回落） */
  displayModeAfterSwitch: "single",
  windowOnly: new Set<string>(["video"]),
  activeTargets: () => [] as string[],
}));

vi.mock("@/api/rpc", () => ({ invoke }));
vi.mock("@/env", () => ({
  get IS_WEB() {
    return env.web;
  },
}));
vi.mock("@/components/ui/messageBox", () => ({ messageBox: { confirm } }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));

const screen = (id: string, primary: boolean) => ({
  id,
  name: null,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  pixelWidth: 1920,
  pixelHeight: 1080,
  scale: 1,
  primary,
});
const screens = { value: [screen("A", true), screen("B", false)] };
vi.mock("@/composables/useWallpaperScreens", () => ({ useWallpaperScreens: () => screens }));

const store = reactive({
  values: { wallpaperDefaultScreen: null as string | null, wallpaperTargets: {} as Record<string, unknown> },
  save: vi.fn(async (key: string, value: unknown) => {
    (store.values as Record<string, unknown>)[key] = value;
  }),
});
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => store }));

/** 实际发给 `set_wallpaper_by_image_id` 的参数 */
const setCalls = () =>
  invoke.mock.calls.filter(([command]) => command === "set_wallpaper_by_image_id").map(([, a]) => a);

beforeEach(() => {
  env.web = false;
  backend.mode = "native";
  backend.displayMode = "single";
  backend.displayModeAfterSwitch = "single";
  backend.activeTargets = () => (backend.displayMode === "single" ? ["screen:A", "screen:B"] : [backend.displayMode]);
  store.values.wallpaperDefaultScreen = null;
  store.values.wallpaperTargets = {};
  store.save.mockClear();
  confirm.mockReset().mockResolvedValue("confirm");
  invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "set_wallpaper_by_image_id") {
      // 与后端 resolve_target 同规则：指定的目标必须在活跃集合里
      if (args?.target && !backend.activeTargets().includes(args.target as string)) {
        throw `壁纸目标不在当前显示器模式的活跃集合里: ${String(args.target)}`;
      }
      if (backend.windowOnly.has(args?.imageId as string) && backend.mode !== "window") throw "REQUIRES_WINDOW_MODE";
      return undefined;
    }
    if (command === "set_wallpaper_mode") {
      backend.mode = args?.mode as string;
      backend.displayMode = backend.displayModeAfterSwitch;
      return undefined;
    }
    if (command === "get_wallpaper_display_mode") return backend.displayMode;
    return undefined;
  });
});

describe("setWallpaperByImageIdWithModeFallback", () => {
  it("带上选中的目标；没给目标时不带 target，由后端落到默认目标", async () => {
    await expect(setWallpaperByImageIdWithModeFallback("img", "screen:B")).resolves.toBe("screen:B");
    await expect(setWallpaperByImageIdWithModeFallback("img")).resolves.toBeNull();
    expect(setCalls()).toEqual([{ imageId: "img", target: "screen:B" }, { imageId: "img" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("需要窗口模式：确认后切模式，目标仍活跃就还是它", async () => {
    await expect(setWallpaperByImageIdWithModeFallback("video", "screen:B")).resolves.toBe("screen:B");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_wallpaper_mode", { mode: "window" });
    expect(setCalls()).toEqual([
      { imageId: "video", target: "screen:B" },
      { imageId: "video", target: "screen:B" },
    ]);
  });

  it("切模式后显示器模式回落、原目标不再活跃：改用新的默认目标，不报错", async () => {
    backend.displayModeAfterSwitch = "multiple";
    await expect(setWallpaperByImageIdWithModeFallback("video", "screen:B")).resolves.toBeNull();
    // 第二次不带 target：落到回落后的默认目标
    expect(setCalls()).toEqual([{ imageId: "video", target: "screen:B" }, { imageId: "video" }]);
  });

  it("只有一个目标（multiple）时引导前后都是它", async () => {
    backend.displayMode = "multiple";
    backend.displayModeAfterSwitch = "multiple";
    await expect(setWallpaperByImageIdWithModeFallback("video", "multiple")).resolves.toBe("multiple");
    expect(setCalls()).toEqual([
      { imageId: "video", target: "multiple" },
      { imageId: "video", target: "multiple" },
    ]);
  });

  it("用户在确认框里取消：不切模式、不再设，原样抛出取消", async () => {
    confirm.mockRejectedValue("cancel");
    await expect(setWallpaperByImageIdWithModeFallback("video", "screen:B")).rejects.toBe("cancel");
    expect(invoke).not.toHaveBeenCalledWith("set_wallpaper_mode", expect.anything());
    expect(setCalls()).toHaveLength(1);
  });

  it("其它错误原样抛出，不引导", async () => {
    await expect(setWallpaperByImageIdWithModeFallback("img", "screen:gone")).rejects.toContain("活跃集合");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("setWallpaperOrBackground", () => {
  it("Web 版没有目标：记成应用背景，不发命令", async () => {
    env.web = true;
    await expect(setWallpaperOrBackground("img", "screen:B")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect((store.values.wallpaperTargets as Record<string, { currentImageId: string }>).multiple.currentImageId).toBe(
      "img",
    );
  });
});
