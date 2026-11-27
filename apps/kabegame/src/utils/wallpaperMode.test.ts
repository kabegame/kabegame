import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePluginMode, setWallpaperByImageIdWithModeFallback, setWallpaperOrBackground } from "./wallpaperMode";

const invoke = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ web: false, linux: false }));
/** 模拟后端：壁纸模式、显示器模式，以及哪些图要窗口模式 */
const backend = vi.hoisted(() => ({
  mode: "native",
  displayMode: "single",
  /** 切到窗口模式后显示器模式变成什么（模拟新模式不支持逐屏独立时回落） */
  displayModeAfterSwitch: "single",
  windowOnly: new Set<string>(["video"]),
  /** Linux 上只有插件模式能显示的图（WPE） */
  pluginOnly: new Set<string>(["wpe"]),
  /** `get_plugin_mode_readiness` 的返回值 */
  readiness: { status: "ready", gnome: false } as Record<string, unknown>,
  /** `install_gnome_shell_extension` 的返回值；为字符串时抛出它 */
  install: { userExtensionsDisabled: false } as unknown,
  activeTargets: () => [] as string[],
}));

vi.mock("@/api/rpc", () => ({ invoke }));
vi.mock("@/env", () => ({
  get IS_WEB() {
    return env.web;
  },
  get IS_LINUX() {
    return env.linux;
  },
}));
vi.mock("@/components/ui/messageBox", () => ({ messageBox: { confirm, alert } }));
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
  env.linux = false;
  backend.readiness = { status: "ready", gnome: false };
  backend.install = { userExtensionsDisabled: false };
  alert.mockReset().mockResolvedValue("confirm");
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
      if (backend.pluginOnly.has(args?.imageId as string) && backend.mode !== "plasma-plugin")
        throw "REQUIRES_PLUGIN_MODE";
      return undefined;
    }
    if (command === "set_wallpaper_mode") {
      backend.mode = args?.mode as string;
      backend.displayMode = backend.displayModeAfterSwitch;
      return undefined;
    }
    if (command === "get_wallpaper_display_mode") return backend.displayMode;
    if (command === "get_plugin_mode_readiness") return backend.readiness;
    if (command === "install_gnome_shell_extension") {
      if (typeof backend.install === "string") throw backend.install;
      return backend.install;
    }
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

describe("preparePluginMode", () => {
  const installed = () => invoke.mock.calls.some(([command]) => command === "install_gnome_shell_extension");

  it("不是 Linux：不问后端，直接可以切", async () => {
    await expect(preparePluginMode()).resolves.toEqual({ gnome: false, layerShell: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("已就绪：带回是不是 GNOME", async () => {
    env.linux = true;
    backend.readiness = { status: "ready", gnome: true };
    await expect(preparePluginMode()).resolves.toEqual({ gnome: true, layerShell: false });
    expect(alert).not.toHaveBeenCalled();
  });

  it("通用 Wayland layer-shell 就绪：弹出窗口模式提示并切到插件模式", async () => {
    env.linux = true;
    backend.readiness = { status: "ready", gnome: false, layerShell: true };
    await expect(setWallpaperByImageIdWithModeFallback("wpe")).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      "settings.wallpaperModeLayerShellConfirmMessage",
      "settings.wallpaperModeConfirmTitle",
      expect.anything(),
    );
    expect(invoke).toHaveBeenCalledWith("set_wallpaper_mode", { mode: "plasma-plugin" });
  });

  it("通用 Wayland layer-shell 就绪但用户取消确认：不切模式也不重试设壁纸", async () => {
    env.linux = true;
    backend.readiness = { status: "ready", gnome: false, layerShell: true };
    confirm.mockRejectedValue("cancel");
    await expect(setWallpaperByImageIdWithModeFallback("wpe")).rejects.toBe("cancel");
    expect(invoke).not.toHaveBeenCalledWith("set_wallpaper_mode", expect.anything());
    expect(setCalls()).toHaveLength(1);
  });

  it("通用 Wayland layer-shell 切模式失败：透传错误，不再重试设壁纸", async () => {
    env.linux = true;
    backend.readiness = { status: "ready", gnome: false, layerShell: true };
    const baseImpl = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "set_wallpaper_mode") throw "switch failed";
      return baseImpl(command, args);
    });
    await expect(setWallpaperByImageIdWithModeFallback("wpe")).rejects.toBe("switch failed");
    expect(setCalls()).toHaveLength(1);
  });

  it("GNOME 太旧：提示升级系统，不装扩展", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeShellUnsupported", version: "41.5", min: 42, max: 51 };
    await expect(preparePluginMode()).resolves.toBeNull();
    expect(alert).toHaveBeenCalledWith("settings.gnomeShellTooOld", "settings.gnomeExtensionTitle", {
      type: "warning",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(installed()).toBe(false);
  });

  it("GNOME 比支持的还新：提示等 Kabegame 更新", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeShellUnsupported", version: "52.0", min: 42, max: 51 };
    await expect(preparePluginMode()).resolves.toBeNull();
    expect(alert).toHaveBeenCalledWith("settings.gnomeShellTooNew", "settings.gnomeExtensionTitle", {
      type: "warning",
    });
  });

  it("扩展不在线：确认后安装并提示重新登录，这次不切", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeExtensionMissing", version: "42.9" };
    await expect(preparePluginMode()).resolves.toBeNull();
    expect(installed()).toBe(true);
    expect(alert).toHaveBeenCalledWith("settings.gnomeExtensionInstalled", "settings.gnomeExtensionTitle", {
      type: "success",
    });
  });

  it("扩展总开关关着：安装后的提示里一并说明", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeExtensionMissing", version: "42.9" };
    backend.install = { userExtensionsDisabled: true };
    await preparePluginMode();
    expect(alert).toHaveBeenCalledWith(
      "settings.gnomeExtensionInstalled settings.gnomeExtensionsSwitchedOff",
      "settings.gnomeExtensionTitle",
      { type: "success" },
    );
  });

  it("用户不装：不调安装", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeExtensionMissing", version: "42.9" };
    confirm.mockRejectedValue("cancel");
    await expect(preparePluginMode()).resolves.toBeNull();
    expect(installed()).toBe(false);
  });

  it("安装失败：提示原因", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeExtensionMissing", version: "42.9" };
    backend.install = "gsettings 失败";
    await expect(preparePluginMode()).resolves.toBeNull();
    expect(alert).toHaveBeenCalledWith("settings.gnomeExtensionInstallFailed", "settings.gnomeExtensionTitle", {
      type: "error",
    });
  });

  it("设壁纸要插件模式、但扩展不在线：引导装扩展，不切模式、按取消抛出", async () => {
    env.linux = true;
    backend.readiness = { status: "gnomeExtensionMissing", version: "50.1" };
    await expect(setWallpaperByImageIdWithModeFallback("wpe")).rejects.toBe("cancel");
    expect(installed()).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("set_wallpaper_mode", expect.anything());
  });

  it("设壁纸要插件模式且已就绪：确认后切到插件模式再设", async () => {
    env.linux = true;
    backend.readiness = { status: "ready", gnome: true };
    await expect(setWallpaperByImageIdWithModeFallback("wpe")).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      "settings.wallpaperModePluginConfirmMessageGnome",
      "settings.wallpaperModeConfirmTitle",
      expect.anything(),
    );
    expect(invoke).toHaveBeenCalledWith("set_wallpaper_mode", { mode: "plasma-plugin" });
  });
});
