// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperTarget } from "@/components/wallpaper/types";
import type { WallpaperTargetConfig, WallpaperTargets } from "@/utils/wallpaperTargets";
import WallpaperWindow from "./WallpaperWindow.vue";

const backend = vi.hoisted(() => ({
  targets: {} as Record<string, unknown>,
  capabilities: null as unknown,
  /** 本窗口目标当前壁纸对应的壁纸目标（没按目标区分时用） */
  current: null as unknown,
  /** 按目标 id 给当前壁纸；有这个目标的条目时优先于 `current` */
  currentByTarget: {} as Record<string, unknown>,
  /** 后端给本窗口的布置；undefined 表示命令失败（没有这个窗口的记录） */
  assignment: undefined as unknown,
  calls: [] as string[],
  /** `get_current_wallpaper_target` 每次调用带的 target 参数 */
  targetArgs: [] as unknown[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "wallpaper" }) }));
vi.mock("@/api/rpc", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    backend.calls.push(command);
    if (command === "get_wallpaper_window_assignment") {
      if (backend.assignment === undefined) throw new Error("no assignment");
      return backend.assignment;
    }
    if (command === "get_wallpaper_targets") return backend.targets;
    if (command === "get_wallpaper_capabilities") {
      if (!backend.capabilities) throw new Error("no capabilities");
      return backend.capabilities;
    }
    if (command === "get_wallpaper_volume") return 0.8;
    if (command === "get_current_wallpaper_target") {
      const target = args?.target;
      backend.targetArgs.push(target);
      return typeof target === "string" && target in backend.currentByTarget
        ? backend.currentByTarget[target]
        : backend.current;
    }
    return undefined;
  }),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    backend.listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@/stores/frameMonitor", () => ({
  FRAME_MONITOR_SAMPLE_MS: 300,
  getFrameMonitorLevel: () => "good",
  useFrameMonitorStore: () => ({ registerHook: () => 1, unregisterHook: () => {} }),
}));
vi.mock("@/components/wallpaper/WallpaperStage.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "WallpaperStage",
      props: { target: Object, styleMode: String, transition: String, volume: Number },
      setup(_props, { expose }) {
        expose({ debugState: () => null, delegatesPing: () => false });
        return () => h("div", { class: "stage" });
      },
    }),
  };
});

const option = (value: string) => ({ value, label: {}, desc: {} });
const WINDOW_CAPABILITIES = {
  modes: [option("native"), option("window")],
  displayModes: {
    native: [],
    window: [
      ...["multiple", "single"].map((value) => ({
        value,
        label: {},
        desc: {},
        unavailable: null,
        styles: ["fill", "fit", "stretch", "center", "tile"].map(option),
        transitions: ["none", "fade", "slide", "zoom"].map(option),
        sharedStyle: false,
      })),
    ],
  },
};

function target(overrides: Partial<WallpaperTargetConfig> = {}): WallpaperTargetConfig {
  return { rotationPath: null, rotationPosition: 0, style: {}, transition: {}, currentImageId: null, ...overrides };
}
const wallpaper = (id: string): WallpaperTarget => ({ id, path: `/images/${id}.png`, type: "image/png" });

const wrappers: ReturnType<typeof mount>[] = [];

async function mountWindow(targets: WallpaperTargets) {
  backend.targets = targets;
  const wrapper = mount(WallpaperWindow, { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

const stage = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent({ name: "WallpaperStage" });

async function settingChange(changes: Record<string, unknown>) {
  backend.listeners.get("setting-change")?.({ payload: { changes } });
  await flushPromises();
}

async function assignmentChange(payload: unknown) {
  backend.listeners.get("wallpaper-assignment")?.({ payload });
  await flushPromises();
}

const targetFetches = () => backend.calls.filter((command) => command === "get_current_wallpaper_target").length;

beforeEach(() => {
  backend.listeners.clear();
  backend.calls.length = 0;
  backend.targetArgs.length = 0;
  backend.capabilities = WINDOW_CAPABILITIES;
  backend.current = wallpaper("1");
  backend.currentByTarget = {};
  backend.assignment = { targetId: "multiple", audible: true };
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WallpaperWindow 读布置给它的壁纸目标", () => {
  it("启动：样式 / 过渡取 multiple 目标在窗口模式名下的值，当前壁纸交给 Stage", async () => {
    const wrapper = await mountWindow({
      multiple: target({
        style: { native: "center", window: "fit" },
        transition: { native: "fade", window: "zoom" },
        currentImageId: "1",
      }),
    });
    expect(stage(wrapper).props("styleMode")).toBe("fit");
    expect(stage(wrapper).props("transition")).toBe("zoom");
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
    expect(backend.calls).toContain("wallpaper_window_ready");
    // 已删除的旧命令不再调用
    expect(backend.calls).not.toContain("get_wallpaper_rotation_style");
    expect(backend.calls).not.toContain("get_wallpaper_rotation_transition");
    // 显示哪个目标由布置决定，不再自己按显示器模式 / 默认屏 / 在线屏推
    expect(backend.calls).not.toContain("get_wallpaper_display_mode");
    expect(backend.calls).not.toContain("get_wallpaper_default_screen");
    expect(backend.calls).not.toContain("list_wallpaper_screens");
    expect(backend.listeners.has("wallpaper-screens-change")).toBe(false);
    // 取当前壁纸时明确带上布置的目标
    expect(backend.targetArgs).toEqual(["multiple"]);
  });

  it("窗口模式名下没存、或存的值不被支持：取能力表第一项", async () => {
    const wrapper = await mountWindow({
      multiple: target({ style: { native: "center" }, transition: { window: "dissolve" }, currentImageId: "1" }),
    });
    expect(stage(wrapper).props("styleMode")).toBe("fill");
    expect(stage(wrapper).props("transition")).toBe("none");
  });

  it("能力表读不到时不连累初始化：直接用存下来的值", async () => {
    backend.capabilities = null;
    const wrapper = await mountWindow({
      multiple: target({ style: { window: "tile" }, transition: { window: "slide" }, currentImageId: "1" }),
    });
    expect(stage(wrapper).props("styleMode")).toBe("tile");
    expect(stage(wrapper).props("transition")).toBe("slide");
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
    expect(backend.calls).toContain("wallpaper_window_ready");
  });

  it("setting-change：样式 / 过渡就地更新，不重新取壁纸", async () => {
    const base = target({ style: { window: "fill" }, transition: { window: "none" }, currentImageId: "1" });
    const wrapper = await mountWindow({ multiple: base });
    const fetched = targetFetches();

    await settingChange({ wallpaperTargets: { multiple: { ...base, style: { window: "center" } } } });
    expect(stage(wrapper).props("styleMode")).toBe("center");
    await settingChange({
      wallpaperTargets: { multiple: { ...base, style: { window: "center" }, transition: { window: "fade" } } },
    });
    expect(stage(wrapper).props("transition")).toBe("fade");
    // 轮播位置之类的写入也发整个 map，当前壁纸没变就不动
    await settingChange({
      wallpaperTargets: {
        multiple: { ...base, style: { window: "center" }, transition: { window: "fade" }, rotationPosition: 7 },
      },
    });
    expect(targetFetches()).toBe(fetched);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
  });

  it("setting-change：默认目标的当前壁纸 id 变了才重新取壁纸目标", async () => {
    const base = target({ currentImageId: "1" });
    const wrapper = await mountWindow({ multiple: base });
    const fetched = targetFetches();

    backend.current = wallpaper("2");
    await settingChange({ wallpaperTargets: { multiple: { ...base, currentImageId: "2" } } });
    expect(targetFetches()).toBe(fetched + 1);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "2" });
    // 显示器模式、默认屏的变化与本窗口无关：目标换不换只听布置
    await settingChange({ wallpaperDisplayMode: "single", wallpaperDefaultScreen: "side" });
    expect(targetFetches()).toBe(fetched + 1);
  });

  it("别的目标换壁纸不影响本窗口", async () => {
    const base = target({ currentImageId: "1" });
    const wrapper = await mountWindow({ multiple: base, span: target({ currentImageId: "5" }) });
    const fetched = targetFetches();

    await settingChange({ wallpaperTargets: { multiple: base, span: target({ currentImageId: "6" }) } });
    expect(targetFetches()).toBe(fetched);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
  });

  it("当前壁纸被清空（图片被删）：保留画面上的那张", async () => {
    const base = target({ currentImageId: "1" });
    const wrapper = await mountWindow({ multiple: base });

    backend.current = null;
    await settingChange({ wallpaperTargets: { multiple: { ...base, currentImageId: null } } });
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
  });

  it("与目标无关的 setting-change 不触发重算", async () => {
    const wrapper = await mountWindow({ multiple: target({ style: { window: "fit" }, currentImageId: "1" }) });
    const fetched = targetFetches();
    await settingChange({ wallpaperVolume: 0.3, wallpaperMode: "window" });
    expect(stage(wrapper).props("styleMode")).toBe("fit");
    expect(targetFetches()).toBe(fetched);
  });
});

describe("WallpaperWindow 的布置", () => {
  const main = "screen:main";
  const side = "screen:side";

  it("启动：读布置的目标（逐屏独立下是本屏的目标），不是默认目标", async () => {
    backend.assignment = { targetId: side, audible: true };
    backend.currentByTarget = { [main]: wallpaper("1"), [side]: wallpaper("7") };
    const wrapper = await mountWindow({
      [main]: target({ style: { window: "fit" }, currentImageId: "1" }),
      [side]: target({ style: { window: "center" }, transition: { window: "slide" }, currentImageId: "7" }),
    });
    expect(stage(wrapper).props("styleMode")).toBe("center");
    expect(stage(wrapper).props("transition")).toBe("slide");
    expect(stage(wrapper).props("target")).toMatchObject({ id: "7" });
    expect(backend.targetArgs).toEqual([side]);
  });

  it("别的屏的目标换壁纸、改样式都不影响本窗口", async () => {
    backend.assignment = { targetId: side, audible: true };
    backend.currentByTarget = { [side]: wallpaper("7") };
    const mine = target({ style: { window: "center" }, currentImageId: "7" });
    const wrapper = await mountWindow({ [main]: target({ currentImageId: "1" }), [side]: mine });
    const fetched = targetFetches();

    await settingChange({
      wallpaperTargets: { [main]: target({ style: { window: "tile" }, currentImageId: "2" }), [side]: mine },
    });
    expect(targetFetches()).toBe(fetched);
    expect(stage(wrapper).props("styleMode")).toBe("center");
    expect(stage(wrapper).props("target")).toMatchObject({ id: "7" });
  });

  it("不出声的布置把音量压到 0，出声的用全局音量", async () => {
    backend.assignment = { targetId: "multiple", audible: false };
    const wrapper = await mountWindow({ multiple: target({ currentImageId: "1" }) });
    expect(stage(wrapper).props("volume")).toBe(0);
    // 全局音量变化不让静音的窗口出声
    await settingChange({ wallpaperVolume: 0.5 });
    expect(stage(wrapper).props("volume")).toBe(0);

    await assignmentChange({ targetId: "multiple", audible: true });
    expect(stage(wrapper).props("volume")).toBe(0.5);
  });

  it("布置换了目标：改读新目标的样式，当前壁纸不同才重新取", async () => {
    backend.currentByTarget = { [side]: wallpaper("7") };
    const wrapper = await mountWindow({
      multiple: target({ style: { window: "fit" }, currentImageId: "1" }),
      [main]: target({ style: { window: "tile" }, currentImageId: "1" }),
      [side]: target({ style: { window: "center" }, currentImageId: "7" }),
    });
    const fetched = targetFetches();

    // multiple → 本屏目标，当前壁纸与画面上的是同一张：只换样式，不重新取
    await assignmentChange({ targetId: main, audible: true });
    expect(stage(wrapper).props("styleMode")).toBe("tile");
    expect(targetFetches()).toBe(fetched);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });

    // 换到当前壁纸不同的目标：按新目标取
    await assignmentChange({ targetId: side, audible: true });
    expect(stage(wrapper).props("styleMode")).toBe("center");
    expect(targetFetches()).toBe(fetched + 1);
    expect(backend.targetArgs.at(-1)).toBe(side);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "7" });
  });

  it("布置先于目标配置到达：画面先不动，配置到了再算", async () => {
    const wrapper = await mountWindow({ multiple: target({ style: { window: "fit" }, currentImageId: "1" }) });
    const fetched = targetFetches();

    await assignmentChange({ targetId: side, audible: true });
    expect(stage(wrapper).props("styleMode")).toBe("fit");
    expect(targetFetches()).toBe(fetched);

    // 带着新目标的 setting-change 到了：样式跟上；当前壁纸与画面上的相同，不重新取
    await settingChange({
      wallpaperTargets: {
        multiple: target({ style: { window: "fit" }, currentImageId: "1" }),
        [side]: target({ style: { window: "stretch" }, currentImageId: "1" }),
      },
    });
    expect(stage(wrapper).props("styleMode")).toBe("stretch");
    expect(targetFetches()).toBe(fetched);
  });

  it("形状不对的布置事件忽略", async () => {
    const wrapper = await mountWindow({ multiple: target({ style: { window: "fit" }, currentImageId: "1" }) });
    const fetched = targetFetches();
    await assignmentChange(null);
    await assignmentChange({ targetId: "", audible: true });
    await assignmentChange({ targetId: side });
    expect(stage(wrapper).props("styleMode")).toBe("fit");
    expect(stage(wrapper).props("volume")).toBe(0.8);
    expect(targetFetches()).toBe(fetched);
  });

  it("取不到布置时不连累初始化：按 multiple 目标、出声处理", async () => {
    backend.assignment = undefined;
    const wrapper = await mountWindow({ multiple: target({ style: { window: "tile" }, currentImageId: "1" }) });
    expect(stage(wrapper).props("styleMode")).toBe("tile");
    expect(stage(wrapper).props("volume")).toBe(0.8);
    expect(stage(wrapper).props("target")).toMatchObject({ id: "1" });
    expect(backend.calls).toContain("wallpaper_window_ready");
  });
});
