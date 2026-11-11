import { describe, expect, it } from "vitest";
import {
  activeTargetIds,
  effectiveDisplayMode,
  effectiveOption,
  effectiveStyle,
  effectiveTransition,
  defaultScreenId,
  disconnectedScreenTargets,
  displayModeOfTarget,
  emptyWallpaperTargetConfig,
  screenIdOfTarget,
  screenTarget,
  targetIdOfScreen,
  type DisplayModeCapability,
  type WallpaperOption,
  type WallpaperScreen,
} from "./wallpaperTargets";

const option = (value: string): WallpaperOption => ({ value, label: {}, desc: {} });

function combo(
  value: DisplayModeCapability["value"],
  overrides: Partial<DisplayModeCapability> = {},
): DisplayModeCapability {
  return {
    value,
    label: {},
    desc: {},
    unavailable: null,
    styles: ["fill", "fit", "center"].map(option),
    transitions: ["none", "fade"].map(option),
    sharedStyle: false,
    ...overrides,
  };
}

function screen(id: string, primary = false): WallpaperScreen {
  return {
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
  };
}

describe("effectiveDisplayMode（与后端 display_mode_for 同规则）", () => {
  const combos = [combo("multiple"), combo("span", { unavailable: { default: "系统没有跨屏铺放" } }), combo("single")];

  it("设置里的值可用就用它", () => {
    expect(effectiveDisplayMode("single", combos)).toBe("single");
    expect(effectiveDisplayMode("multiple", combos)).toBe("multiple");
  });

  it("带 unavailable 或没列出的模式回落 multiple", () => {
    expect(effectiveDisplayMode("span", combos)).toBe("multiple");
    expect(effectiveDisplayMode("single", [combo("multiple")])).toBe("multiple");
  });

  it("不认识的值按 multiple", () => {
    expect(effectiveDisplayMode(undefined, combos)).toBe("multiple");
    expect(effectiveDisplayMode("mirror", combos)).toBe("multiple");
  });

  it("能力表还没读到时信设置里的值", () => {
    expect(effectiveDisplayMode("single", [])).toBe("single");
    expect(effectiveDisplayMode("nope", [])).toBe("multiple");
  });
});

describe("activeTargetIds（与后端 compute_layout 同规则）", () => {
  const screens = [screen("A"), screen("B", true), screen("C")];

  it("multiple / span 各只有一个目标，与屏数无关", () => {
    expect(activeTargetIds("multiple", screens, null)).toEqual(["multiple"]);
    expect(activeTargetIds("multiple", [], null)).toEqual(["multiple"]);
    expect(activeTargetIds("span", screens, "A")).toEqual(["span"]);
    expect(activeTargetIds("span", [], null)).toEqual(["span"]);
  });

  it("single：每块在线屏一个目标，默认屏在线就排第一，其余保持原顺序", () => {
    expect(activeTargetIds("single", screens, "C")).toEqual(["screen:C", "screen:A", "screen:B"]);
  });

  it("single：默认屏未设置或不在线时取主屏", () => {
    expect(activeTargetIds("single", screens, null)).toEqual(["screen:B", "screen:A", "screen:C"]);
    expect(activeTargetIds("single", screens, "已拔掉")).toEqual(["screen:B", "screen:A", "screen:C"]);
  });

  it("single：没有主屏标记时取第一块", () => {
    expect(activeTargetIds("single", [screen("A"), screen("C")], undefined)).toEqual(["screen:A", "screen:C"]);
  });

  it("single 但没有屏幕信息：逐屏无从谈起，按 multiple", () => {
    expect(activeTargetIds("single", [], "A")).toEqual(["multiple"]);
  });

  it("屏幕目标 id 的形状", () => {
    expect(screenTarget("DISPLAY-1")).toBe("screen:DISPLAY-1");
  });
});

describe("屏与目标的对应", () => {
  const screens = [screen("A"), screen("B", true), screen("C")];

  it("目标 id 取回屏幕标识；不是逐屏目标时为 null", () => {
    expect(screenIdOfTarget("screen:37D8832A-2D66-02CA-B9F7-8F30A301B230")).toBe(
      "37D8832A-2D66-02CA-B9F7-8F30A301B230",
    );
    // Windows 的 device interface 路径里本身带冒号
    expect(screenIdOfTarget(screenTarget("\\\\?\\DISPLAY#DEL:1"))).toBe("\\\\?\\DISPLAY#DEL:1");
    expect(screenIdOfTarget("multiple")).toBeNull();
    expect(screenIdOfTarget("span")).toBeNull();
    expect(screenIdOfTarget("screen:")).toBeNull();
  });

  it("multiple / span 下所有屏同属唯一的目标，single 下各是各的", () => {
    expect(targetIdOfScreen("multiple", "A")).toBe("multiple");
    expect(targetIdOfScreen("span", "A")).toBe("span");
    expect(targetIdOfScreen("single", "A")).toBe("screen:A");
  });

  it("目标 id 属于哪个显示器模式（与 targetIdOfScreen 互逆）", () => {
    expect(displayModeOfTarget("multiple")).toBe("multiple");
    expect(displayModeOfTarget("span")).toBe("span");
    expect(displayModeOfTarget("screen:A")).toBe("single");
    for (const mode of ["multiple", "span", "single"] as const) {
      expect(displayModeOfTarget(targetIdOfScreen(mode, "A"))).toBe(mode);
    }
    // 认不出的 id 按各屏复制
    expect(displayModeOfTarget("screen:")).toBe("multiple");
    expect(displayModeOfTarget("")).toBe("multiple");
  });

  it("默认屏：指定的屏在线就是它，否则主屏，再不行第一块，没有屏为 null", () => {
    expect(defaultScreenId(screens, "C")).toBe("C");
    expect(defaultScreenId(screens, "已拔掉")).toBe("B");
    expect(defaultScreenId(screens, null)).toBe("B");
    expect(defaultScreenId([screen("A"), screen("C")], undefined)).toBe("A");
    expect(defaultScreenId([], "A")).toBeNull();
    // 与活跃目标的第一项始终是同一块屏
    for (const wanted of ["C", "已拔掉", null]) {
      expect(activeTargetIds("single", screens, wanted)[0]).toBe(screenTarget(defaultScreenId(screens, wanted)!));
    }
  });

  it("已断开的屏：配置还在、屏不在线的逐屏目标，其它目标不算", () => {
    const config = emptyWallpaperTargetConfig();
    const targets = { multiple: config, span: config, "screen:Z": config, "screen:A": config, "screen:M": config };
    expect(disconnectedScreenTargets(targets, screens)).toEqual(["screen:M", "screen:Z"]);
    expect(disconnectedScreenTargets(targets, [])).toEqual(["screen:A", "screen:M", "screen:Z"]);
    expect(disconnectedScreenTargets({ multiple: config }, screens)).toEqual([]);
    expect(disconnectedScreenTargets(undefined, screens)).toEqual([]);
  });
});

describe("effectiveOption（与后端 pick_option 同规则）", () => {
  const options = ["fill", "fit"].map(option);

  it("存的值在选项里就用它", () => {
    expect(effectiveOption("fit", options, "fill")).toBe("fit");
  });

  it("没存或不在选项里：取能力表第一项", () => {
    expect(effectiveOption(undefined, options, "x")).toBe("fill");
    expect(effectiveOption("tile", options, "x")).toBe("fill");
    expect(effectiveOption("", options, "x")).toBe("fill");
  });

  it("选项为空取 fallback（即使存了值）", () => {
    expect(effectiveOption("fit", [], "fill")).toBe("fill");
    expect(effectiveOption(null, [], "none")).toBe("none");
  });

  it("能力表还没读到（undefined）时先用存下来的值", () => {
    expect(effectiveOption("tile", undefined, "fill")).toBe("tile");
    expect(effectiveOption(undefined, undefined, "fill")).toBe("fill");
  });
});

describe("有效样式 / 过渡按壁纸模式取", () => {
  const config = {
    ...emptyWallpaperTargetConfig(),
    style: { native: "center", window: "tile" },
    transition: { window: "fade" },
  };
  const multiple = combo("multiple");

  it("读当前壁纸模式名下的值", () => {
    expect(effectiveStyle(config, "native", multiple)).toBe("center");
    expect(effectiveTransition(config, "window", multiple)).toBe("fade");
  });

  it("该模式下存的值不被支持：取第一项，不影响另一个模式的值", () => {
    // window 存的是 tile，但这个组合只有 fill / fit / center
    expect(effectiveStyle(config, "window", multiple)).toBe("fill");
    expect(effectiveStyle(config, "native", multiple)).toBe("center");
  });

  it("该模式缺键：取第一项", () => {
    expect(effectiveTransition(config, "native", multiple)).toBe("none");
    expect(effectiveStyle(config, "plasma-plugin", multiple)).toBe("fill");
  });

  it("目标还没有配置：取第一项；能力表也没有时取兜底值", () => {
    expect(effectiveStyle(null, "native", multiple)).toBe("fill");
    expect(effectiveTransition(null, "native", combo("multiple", { transitions: [option("fade")] }))).toBe("fade");
    expect(effectiveStyle(null, "native", undefined)).toBe("fill");
    expect(effectiveTransition(undefined, "native", undefined)).toBe("none");
  });

  it("空目标配置的形状与后端默认值一致", () => {
    expect(emptyWallpaperTargetConfig()).toEqual({
      rotationPath: null,
      rotationPosition: 0,
      style: {},
      transition: {},
      currentImageId: null,
    });
  });
});
