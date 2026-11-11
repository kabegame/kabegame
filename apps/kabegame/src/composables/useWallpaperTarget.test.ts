import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeWallpaperRotationPaths,
  activeWallpaperTargets,
  setWallpaperRotationPath,
  useActiveWallpaperImageIds,
  useActiveWallpaperRotationPaths,
  useActiveWallpaperTargets,
  useWallpaperRotationSources,
  useWallpaperTarget,
  wallpaperTargetScreenName,
} from "./useWallpaperTarget";
import type { DisplayModeCapability, WallpaperTargetConfig, WallpaperTargets } from "@/utils/wallpaperTargets";

const invoke = vi.hoisted(() => vi.fn());
/** 事件名 → 处理函数：测试里直接调用来模拟后端事件 */
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const guardDesktopOnly = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ web: false }));

vi.mock("@/api/rpc", () => ({
  invoke,
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  },
}));
vi.mock("@/env", () => ({
  get IS_WEB() {
    return env.web;
  },
}));
vi.mock("@/utils/desktopOnlyGuard", () => ({ guardDesktopOnly }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@kabegame/i18n", () => ({
  i18n: { global: { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params)}` } },
}));

const option = (value: string) => ({ value, label: {}, desc: {} });
const combo = (
  value: DisplayModeCapability["value"],
  styles: string[],
  transitions: string[],
  unavailable: Record<string, string> | null = null,
): DisplayModeCapability => ({
  value,
  label: {},
  desc: {},
  unavailable,
  styles: styles.map(option),
  transitions: transitions.map(option),
  sharedStyle: false,
});

// 两块屏（B 是主屏）；原生模式三种显示器模式都列出、span 不可用，窗口模式只有 multiple 可用。
// 屏幕与能力表是模块级状态：能力表只读一次，屏幕首次读一次、之后跟 wallpaper-screens-change。
// 整份测试共用这一套，靠设置值切换场景；改了在线屏的用例由 beforeEach 用事件还原。
const screen = (id: string, primary: boolean, x: number, width: number, height: number) => ({
  id,
  name: null,
  x,
  y: 0,
  width,
  height,
  pixelWidth: width,
  pixelHeight: height,
  scale: 1,
  primary,
});
const SCREENS = [screen("A", false, 0, 1920, 1080), screen("B", true, 1920, 2560, 1440)];
/** 模拟后端发来的在线屏变化 */
const emitScreens = (screens: unknown[]) => listeners.get("wallpaper-screens-change")?.({ payload: { screens } });
const CAPABILITIES = {
  modes: [option("native"), option("window")],
  displayModes: {
    native: [
      combo("multiple", ["fill", "fit", "center"], ["none"]),
      combo("span", ["fill"], ["none"], { default: "系统没有跨屏铺放" }),
      combo("single", ["fill", "fit"], ["none"]),
    ],
    window: [
      combo("multiple", ["fill", "fit", "stretch", "center", "tile"], ["none", "fade", "slide", "zoom"]),
      combo("single", ["fill"], ["none"], { default: "后续支持" }),
    ],
  },
};

function target(overrides: Partial<WallpaperTargetConfig> = {}): WallpaperTargetConfig {
  return { rotationPath: null, rotationPosition: 0, style: {}, transition: {}, currentImageId: null, ...overrides };
}

const store = reactive({
  values: {
    wallpaperMode: "native" as string,
    wallpaperDisplayMode: "multiple" as string,
    wallpaperDefaultScreen: null as string | null,
    wallpaperTargets: {} as WallpaperTargets,
  },
  loading: false,
  isLoading: (key: string) => key === "wallpaperTargets" && store.loading,
});
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => store }));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 第一次使用会去读屏幕与能力表：等它们落地。 */
async function ready() {
  useActiveWallpaperTargets();
  await flush();
}

beforeEach(async () => {
  env.web = false;
  guardDesktopOnly.mockReset();
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_wallpaper_screens") return SCREENS;
    if (command === "get_wallpaper_capabilities") return CAPABILITIES;
    return undefined;
  });
  store.loading = false;
  Object.assign(store.values, {
    wallpaperMode: "native",
    wallpaperDisplayMode: "multiple",
    wallpaperDefaultScreen: null,
    wallpaperTargets: {
      multiple: target({
        rotationPath: "images://gallery/hide/album/a1/sort/by-album-order",
        style: { native: "center", window: "tile" },
        transition: { window: "slide" },
        currentImageId: "10",
      }),
      span: target({ rotationPath: "images://gallery/hide/all", currentImageId: "99" }),
      "screen:A": target({ rotationPath: "images://gallery/hide/sort/random-1", currentImageId: "20" }),
      "screen:B": target({ style: { native: "fit" }, currentImageId: "30" }),
      "screen:已拔掉": target({ rotationPath: "images://gallery/hide/album/gone", currentImageId: "40" }),
    },
  });
  await ready();
  emitScreens(SCREENS);
  invoke.mockClear();
});

describe("活跃目标与默认目标", () => {
  it("multiple：只有一个目标，默认目标就是它", () => {
    expect(useActiveWallpaperTargets().value).toEqual(["multiple"]);
    expect(useWallpaperTarget().id.value).toBe("multiple");
  });

  it("single：每块在线屏一个目标，默认目标是主屏；指定在线的默认屏后换成它", () => {
    store.values.wallpaperDisplayMode = "single";
    const ids = useActiveWallpaperTargets();
    const def = useWallpaperTarget();
    expect(ids.value).toEqual(["screen:B", "screen:A"]);
    expect(def.id.value).toBe("screen:B");
    store.values.wallpaperDefaultScreen = "A";
    expect(ids.value).toEqual(["screen:A", "screen:B"]);
    expect(def.id.value).toBe("screen:A");
    store.values.wallpaperDefaultScreen = "已拔掉";
    expect(def.id.value).toBe("screen:B");
  });

  it("设置里的显示器模式在当前壁纸模式下不可用：按 multiple", () => {
    store.values.wallpaperDisplayMode = "span";
    expect(useActiveWallpaperTargets().value).toEqual(["multiple"]);
    // single 在原生可用、在窗口模式不可用：切壁纸模式后回落
    store.values.wallpaperDisplayMode = "single";
    const ids = useActiveWallpaperTargets();
    expect(ids.value).toEqual(["screen:B", "screen:A"]);
    store.values.wallpaperMode = "window";
    expect(ids.value).toEqual(["multiple"]);
  });
});

describe("在线屏变化", () => {
  it("拔掉一块屏：它的目标退出活跃集合，默认屏不在线时默认目标回到主屏；接回来恢复", () => {
    store.values.wallpaperDisplayMode = "single";
    store.values.wallpaperDefaultScreen = "A";
    const ids = useActiveWallpaperTargets();
    const def = useWallpaperTarget();
    const images = useActiveWallpaperImageIds();
    expect(ids.value).toEqual(["screen:A", "screen:B"]);

    emitScreens([SCREENS[1]]);
    expect(ids.value).toEqual(["screen:B"]);
    expect(def.id.value).toBe("screen:B");
    expect([...images.value]).toEqual(["30"]);

    // 设置没被改写，屏回来后默认目标恢复
    emitScreens(SCREENS);
    expect(ids.value).toEqual(["screen:A", "screen:B"]);
    expect(def.id.value).toBe("screen:A");
    // 事件自带完整列表，不回读
    expect(invoke).not.toHaveBeenCalledWith("list_wallpaper_screens");
  });

  it("新接一块屏：多出一个活跃目标", () => {
    store.values.wallpaperDisplayMode = "single";
    const ids = useActiveWallpaperTargets();
    emitScreens([...SCREENS, screen("C", false, 4480, 1920, 1080)]);
    expect(ids.value).toEqual(["screen:B", "screen:A", "screen:C"]);
  });

  it("multiple 下屏数怎么变都只有一个目标", () => {
    const ids = useActiveWallpaperTargets();
    emitScreens([SCREENS[1]]);
    expect(ids.value).toEqual(["multiple"]);
    emitScreens([]);
    expect(ids.value).toEqual(["multiple"]);
  });

  it("形状不对的事件忽略", () => {
    store.values.wallpaperDisplayMode = "single";
    const ids = useActiveWallpaperTargets();
    listeners.get("wallpaper-screens-change")?.({ payload: null });
    listeners.get("wallpaper-screens-change")?.({ payload: { screens: "nope" } });
    expect(ids.value).toEqual(["screen:B", "screen:A"]);
  });
});

describe("目标配置与有效样式 / 过渡", () => {
  it("默认目标：读当前壁纸、轮播路径，样式 / 过渡取当前壁纸模式名下的值", () => {
    const def = useWallpaperTarget();
    expect(def.currentImageId.value).toBe("10");
    expect(def.rotationPath.value).toBe("images://gallery/hide/album/a1/sort/by-album-order");
    expect(def.style.value).toBe("center");
    // native 名下没存过渡：取该组合第一项
    expect(def.transition.value).toBe("none");
    expect(def.combo.value?.styles.map((o) => o.value)).toEqual(["fill", "fit", "center"]);
  });

  it("切壁纸模式：同一个目标换读另一个模式名下的值，选项跟着换", () => {
    const def = useWallpaperTarget();
    store.values.wallpaperMode = "window";
    expect(def.style.value).toBe("tile");
    expect(def.transition.value).toBe("slide");
    expect(def.combo.value?.transitions.map((o) => o.value)).toEqual(["none", "fade", "slide", "zoom"]);
  });

  it("存的值不在当前组合的选项里：取第一项，不写回", () => {
    // single × native 只有 fill / fit；screen:A 没存样式，screen:B 存了 fit
    store.values.wallpaperDisplayMode = "single";
    expect(useWallpaperTarget("screen:A").style.value).toBe("fill");
    expect(useWallpaperTarget("screen:B").style.value).toBe("fit");
    store.values.wallpaperTargets["screen:B"].style.native = "center";
    expect(useWallpaperTarget("screen:B").style.value).toBe("fill");
    expect(store.values.wallpaperTargets["screen:B"].style.native).toBe("center");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("后端整个 map 换掉后跟着更新；目标还没落盘时配置为空、样式取第一项", () => {
    const def = useWallpaperTarget();
    store.values.wallpaperTargets = { multiple: target({ style: { native: "fit" }, currentImageId: "11" }) };
    expect(def.currentImageId.value).toBe("11");
    expect(def.style.value).toBe("fit");
    store.values.wallpaperTargets = {};
    expect(def.config.value).toBeNull();
    expect(def.currentImageId.value).toBeNull();
    expect(def.rotationPath.value).toBeNull();
    expect(def.style.value).toBe("fill");
  });

  it("loading 跟随设置的首次加载", () => {
    const def = useWallpaperTarget();
    expect(def.loading.value).toBe(false);
    store.loading = true;
    expect(def.loading.value).toBe(true);
  });
});

describe("写操作", () => {
  it("默认目标不带 target，由后端落到默认目标；不改本地值", async () => {
    const def = useWallpaperTarget();
    await expect(def.setStyle("fit")).resolves.toBe(true);
    await expect(def.setTransition("none")).resolves.toBe(true);
    await expect(def.setRotationPath("images://gallery/hide/all")).resolves.toBe(true);
    expect(invoke.mock.calls).toEqual([
      ["set_wallpaper_style", { style: "fit" }],
      ["set_wallpaper_rotation_transition", { transition: "none" }],
      ["set_wallpaper_rotation_path", { path: "images://gallery/hide/all" }],
    ]);
    expect(def.style.value).toBe("center");
    expect(def.rotationPath.value).toBe("images://gallery/hide/album/a1/sort/by-album-order");
  });

  it("指定目标时带上 target", async () => {
    store.values.wallpaperDisplayMode = "single";
    const a = useWallpaperTarget("screen:A");
    await a.setStyle("fit");
    await a.setRotationPath("");
    expect(invoke.mock.calls).toEqual([
      ["set_wallpaper_style", { style: "fit", target: "screen:A" }],
      ["set_wallpaper_rotation_path", { path: "", target: "screen:A" }],
    ]);
  });

  it("先选了目标的入口：按给的目标写轮播路径，不给就落到默认目标", async () => {
    await expect(setWallpaperRotationPath("images://gallery/hide/all", "screen:A")).resolves.toBe(true);
    await expect(setWallpaperRotationPath("images://gallery/hide/all")).resolves.toBe(true);
    expect(invoke.mock.calls).toEqual([
      ["set_wallpaper_rotation_path", { path: "images://gallery/hide/all", target: "screen:A" }],
      ["set_wallpaper_rotation_path", { path: "images://gallery/hide/all" }],
    ]);
    env.web = true;
    await expect(setWallpaperRotationPath("images://gallery/hide/all", "screen:A")).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("后端拒绝时原样抛出", async () => {
    invoke.mockRejectedValueOnce("当前壁纸模式不支持该样式: tile");
    await expect(useWallpaperTarget().setStyle("tile")).rejects.toBe("当前壁纸模式不支持该样式: tile");
  });

  it("Web 版拦下并提示桌面版，不发命令", async () => {
    env.web = true;
    const def = useWallpaperTarget();
    await expect(def.setRotationPath("images://gallery/hide/all")).resolves.toBe(false);
    await expect(def.setStyle("fit")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(guardDesktopOnly.mock.calls).toEqual([["wallpaperRotation"], ["wallpaper"]]);
  });
});

describe("活跃目标的当前壁纸与轮播路径", () => {
  it("multiple：只算 multiple 目标，别的显示器模式与断开屏的目标不算", () => {
    expect([...useActiveWallpaperImageIds().value]).toEqual(["10"]);
    expect(useActiveWallpaperRotationPaths().value).toEqual(["images://gallery/hide/album/a1/sort/by-album-order"]);
  });

  it("single：各在线屏的目标都算，没设轮播路径的目标不出现在路径里", () => {
    store.values.wallpaperDisplayMode = "single";
    expect([...useActiveWallpaperImageIds().value].sort()).toEqual(["20", "30"]);
    expect(useActiveWallpaperRotationPaths().value).toEqual(["images://gallery/hide/sort/random-1"]);
    expect(activeWallpaperRotationPaths()).toEqual(useActiveWallpaperRotationPaths().value);
  });

  it("轮播来源按活跃目标逐个给出，没设路径的目标也在（path 为 null）", () => {
    const sources = useWallpaperRotationSources();
    expect(sources.value).toEqual([
      { targetId: "multiple", path: "images://gallery/hide/album/a1/sort/by-album-order" },
    ]);
    store.values.wallpaperDisplayMode = "single";
    // 与活跃目标同序：默认目标（主屏 B）在前
    expect(sources.value).toEqual([
      { targetId: "screen:B", path: null },
      { targetId: "screen:A", path: "images://gallery/hide/sort/random-1" },
    ]);
  });

  it("即时快照与响应式版本是同一份计算", () => {
    expect(activeWallpaperTargets()).toEqual(["multiple"]);
    store.values.wallpaperDisplayMode = "single";
    store.values.wallpaperDefaultScreen = "A";
    expect(activeWallpaperTargets()).toEqual(useActiveWallpaperTargets().value);
    expect(activeWallpaperTargets()).toEqual(["screen:A", "screen:B"]);
  });

  it("逐屏目标的屏名：有名字用名字，没有用布局图上的序号；不是逐屏目标或屏不在线为 null", () => {
    // 两块屏都没有名字：序号按在线屏列表的顺序
    expect(wallpaperTargetScreenName("screen:A")).toBe('settings.screenNumbered:{"n":1}');
    expect(wallpaperTargetScreenName("screen:B")).toBe('settings.screenNumbered:{"n":2}');
    emitScreens([{ ...SCREENS[0], name: "DELL U2720Q" }, SCREENS[1]]);
    expect(wallpaperTargetScreenName("screen:A")).toBe("DELL U2720Q");
    expect(wallpaperTargetScreenName("screen:已拔掉")).toBeNull();
    expect(wallpaperTargetScreenName("multiple")).toBeNull();
    expect(wallpaperTargetScreenName("span")).toBeNull();
  });

  it("当前壁纸被清空后不再算", () => {
    const ids = useActiveWallpaperImageIds();
    store.values.wallpaperTargets = { multiple: target({ currentImageId: null }) };
    expect(ids.value.size).toBe(0);
  });
});
