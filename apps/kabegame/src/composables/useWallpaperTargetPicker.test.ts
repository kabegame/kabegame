// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WallpaperTargetPickerHost from "@/components/wallpaper/WallpaperTargetPickerHost.vue";
import { wallpaperScreensLoaded } from "@/composables/useWallpaperScreens";
import type { DisplayModeCapability } from "@/utils/wallpaperTargets";
import {
  pickWallpaperTarget,
  pickedScreenName,
  resolveWallpaperTargetPick,
  wallpaperTargetPickRequest,
} from "./useWallpaperTargetPicker";

const invoke = vi.hoisted(() => vi.fn());
/** 事件名 → 处理函数：测试里直接调用来模拟后端事件 */
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@/api/rpc", () => ({
  invoke,
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  },
}));
vi.mock("@/env", () => ({ IS_WEB: false }));
vi.mock("@/utils/desktopOnlyGuard", () => ({ guardDesktopOnly: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@kabegame/i18n", () => {
  const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key);
  return { i18n: { global: { t } }, useI18n: () => ({ t }) };
});
// 模态栈要 pinia，这里只关心开关：与真实 useModal 同语义（重复 open / close 无副作用，close 时回调一次）
vi.mock("@/composables/useModal", async () => {
  const { ref, computed } = await import("vue");
  return {
    useModal: (options: { onClose?: () => void } = {}) => {
      const open = ref(false);
      return {
        isOpen: computed(() => open.value),
        zIndex: computed(() => 2000),
        open: () => {
          open.value = true;
        },
        close: () => {
          if (!open.value) return;
          open.value = false;
          options.onClose?.();
        },
      };
    },
  };
});
vi.mock("@kabegame/element-plus", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    ElDialog: defineComponent({
      name: "ElDialog",
      props: { modelValue: Boolean, title: String },
      emits: ["update:modelValue", "opened"],
      setup(props, { slots }) {
        return () =>
          props.modelValue
            ? h("div", { class: "dialog", "data-title": props.title }, [slots.default?.(), slots.footer?.()])
            : null;
      },
    }),
    ElButton: defineComponent({
      name: "ElButton",
      props: { disabled: Boolean, type: String },
      setup(props, { slots, attrs }) {
        return () => h("button", { ...attrs, class: `btn-${props.type ?? "plain"}`, disabled: props.disabled }, slots);
      },
    }),
  };
});
vi.mock("@/components/wallpaper/WallpaperScreenLayout.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "WallpaperScreenLayout",
      props: { selected: String, displayMode: String, defaultScreen: String, showDisconnected: Boolean },
      emits: ["update:selected", "confirm"],
      setup(props) {
        return () => h("div", { class: "layout", "data-selected": props.selected, "data-mode": props.displayMode });
      },
    }),
  };
});

const option = (value: string) => ({ value, label: {}, desc: {} });
const combo = (value: DisplayModeCapability["value"]): DisplayModeCapability => ({
  value,
  label: {},
  desc: {},
  unavailable: null,
  styles: [option("fill")],
  transitions: [option("none")],
  sharedStyle: false,
});
const screen = (id: string, primary: boolean, name: string | null = null) => ({
  id,
  name,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  pixelWidth: 1920,
  pixelHeight: 1080,
  scale: 1,
  primary,
});
// 主屏 A、副屏 B（带名字）、第三块 C
const A = screen("A", true);
const B = screen("B", false, "DeskPad Display");
const C = screen("C", false);
/** 模拟后端发来的在线屏变化 */
const emitScreens = (screens: unknown[]) => listeners.get("wallpaper-screens-change")?.({ payload: { screens } });

const store = reactive({
  values: {
    wallpaperMode: "window" as string,
    wallpaperDisplayMode: "single" as string,
    wallpaperDefaultScreen: null as string | null,
    wallpaperTargets: {},
  },
  isLoading: () => false,
});
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => store }));

let host: VueWrapper | null = null;
const mountHost = () => {
  host = mount(WallpaperTargetPickerHost);
  return host;
};
const layout = () => host!.findComponent({ name: "WallpaperScreenLayout" });

beforeEach(async () => {
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_wallpaper_screens") return [A, B];
    if (command === "get_wallpaper_capabilities") {
      return {
        modes: [option("native"), option("window")],
        displayModes: { window: [combo("multiple"), combo("single")], native: [combo("multiple")] },
      };
    }
    return undefined;
  });
  store.values.wallpaperMode = "window";
  store.values.wallpaperDisplayMode = "single";
  store.values.wallpaperDefaultScreen = null;
  // 在线屏是模块级状态：首次使用读一次，之后只跟事件。先等首次读取，再用事件摆成两块屏
  await wallpaperScreensLoaded();
  emitScreens([A, B]);
  await flushPromises();
});

afterEach(() => {
  resolveWallpaperTargetPick(null);
  host?.unmount();
  host = null;
});

describe("pickWallpaperTarget", () => {
  it("只有一个活跃目标时不弹，直接返回它", async () => {
    // 各屏复制：唯一目标 multiple
    store.values.wallpaperDisplayMode = "multiple";
    expect(await pickWallpaperTarget({ action: "setWallpaper" })).toBe("multiple");
    expect(wallpaperTargetPickRequest.value).toBeNull();

    // 逐屏独立但只接一块屏：就是那块屏
    store.values.wallpaperDisplayMode = "single";
    emitScreens([A]);
    expect(await pickWallpaperTarget({ action: "setRotation" })).toBe("screen:A");
    expect(wallpaperTargetPickRequest.value).toBeNull();

    // 逐屏独立在当前壁纸模式下不可用（原生）：按 multiple 生效，同样不弹
    emitScreens([A, B]);
    store.values.wallpaperMode = "native";
    expect(await pickWallpaperTarget({ action: "setWallpaper" })).toBe("multiple");
    expect(wallpaperTargetPickRequest.value).toBeNull();
  });

  it("多个活跃目标时挂起请求，宿主返回哪个就是哪个；取消返回 null", async () => {
    const picked = pickWallpaperTarget({ action: "setRotation" });
    await flushPromises();
    expect(wallpaperTargetPickRequest.value).toEqual({ action: "setRotation" });
    resolveWallpaperTargetPick("screen:B");
    expect(await picked).toBe("screen:B");
    expect(wallpaperTargetPickRequest.value).toBeNull();

    const cancelled = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    resolveWallpaperTargetPick(null);
    expect(await cancelled).toBeNull();
    // 没有待处理的请求时再调用什么都不做
    expect(() => resolveWallpaperTargetPick("screen:A")).not.toThrow();
  });

  it("同时只有一个请求：后来的顶掉前一个，前一个按取消返回", async () => {
    const first = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    const second = pickWallpaperTarget({ action: "setRotation" });
    expect(await first).toBeNull();
    expect(wallpaperTargetPickRequest.value).toEqual({ action: "setRotation" });
    resolveWallpaperTargetPick("screen:A");
    expect(await second).toBe("screen:A");
  });

  it("成功提示里的屏名：多个目标时才有，没名字的屏用序号", async () => {
    expect(pickedScreenName("screen:B")).toBe("DeskPad Display");
    expect(pickedScreenName("screen:A")).toBe('settings.screenNumbered:{"n":1}');
    expect(pickedScreenName(null)).toBeNull();
    // 屏不在线
    expect(pickedScreenName("screen:gone")).toBeNull();
    // 只有一个目标：提示照旧，不带屏名
    emitScreens([B]);
    expect(pickedScreenName("screen:B")).toBeNull();
    emitScreens([A, B]);
    store.values.wallpaperDisplayMode = "multiple";
    expect(pickedScreenName("multiple")).toBeNull();
  });
});

describe("WallpaperTargetPickerHost", () => {
  it("有请求时打开，预选默认屏；标题随动作变；默认屏改了预选跟着变", async () => {
    mountHost();
    expect(host!.find(".dialog").exists()).toBe(false);

    const first = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    expect(host!.find(".dialog").attributes("data-title")).toBe("settings.pickTargetTitleSetWallpaper");
    // 没设默认屏：主屏
    expect(layout().props("selected")).toBe("screen:A");
    // 固定按逐屏独立画、不列断开的屏
    expect(layout().props("displayMode")).toBe("single");
    expect(layout().props("showDisconnected")).toBe(false);
    resolveWallpaperTargetPick(null);
    await first;
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);

    store.values.wallpaperDefaultScreen = "B";
    const second = pickWallpaperTarget({ action: "setRotation" });
    await flushPromises();
    expect(host!.find(".dialog").attributes("data-title")).toBe("settings.pickTargetTitleSetRotation");
    expect(layout().props("selected")).toBe("screen:B");
    resolveWallpaperTargetPick(null);
    await second;
  });

  it("点一块屏选中，「确定」返回它；双击 / 回车直接返回那块屏", async () => {
    mountHost();
    const byButton = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("update:selected", "screen:B");
    await flushPromises();
    expect(layout().props("selected")).toBe("screen:B");
    await host!.find(".btn-primary").trigger("click");
    expect(await byButton).toBe("screen:B");
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);

    const byConfirm = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("confirm", "screen:B");
    expect(await byConfirm).toBe("screen:B");

    // 不在活跃目标里的不认，弹窗保持
    const stale = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("confirm", "screen:gone");
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(true);
    resolveWallpaperTargetPick(null);
    await stale;
  });

  it("「取消」与关闭弹窗都返回 null", async () => {
    mountHost();
    const byCancel = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    await host!.find(".btn-plain").trigger("click");
    expect(await byCancel).toBeNull();
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);

    const byClose = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    host!.findComponent({ name: "ElDialog" }).vm.$emit("update:modelValue", false);
    expect(await byClose).toBeNull();
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);
  });

  it("后来的请求顶掉前一个时弹窗不关，标题与预选按新请求重置", async () => {
    mountHost();
    const first = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("update:selected", "screen:B");
    await flushPromises();

    const second = pickWallpaperTarget({ action: "setRotation" });
    expect(await first).toBeNull();
    await flushPromises();
    expect(host!.find(".dialog").attributes("data-title")).toBe("settings.pickTargetTitleSetRotation");
    expect(layout().props("selected")).toBe("screen:A");
    resolveWallpaperTargetPick("screen:A");
    expect(await second).toBe("screen:A");
  });

  it("打开期间在线屏只剩一块：直接以它返回并关闭", async () => {
    mountHost();
    const picked = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("update:selected", "screen:B");
    await flushPromises();

    // 副屏断开
    emitScreens([A]);
    expect(await picked).toBe("screen:A");
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);
    expect(wallpaperTargetPickRequest.value).toBeNull();
  });

  it("打开期间选中的屏断开、但还有不止一块：预选回到默认屏，其余屏断开不动选中", async () => {
    emitScreens([A, B, C]);
    mountHost();
    const picked = pickWallpaperTarget({ action: "setWallpaper" });
    await flushPromises();
    layout().vm.$emit("update:selected", "screen:C");
    await flushPromises();

    // 没选中的那块断开：选中不变
    emitScreens([A, C]);
    await flushPromises();
    expect(layout().props("selected")).toBe("screen:C");
    // 选中的那块断开、另一块接回来：预选回默认屏
    emitScreens([A, B]);
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(true);
    expect(layout().props("selected")).toBe("screen:A");
    await host!.find(".btn-primary").trigger("click");
    expect(await picked).toBe("screen:A");
  });

  it("打开期间显示器模式变成各屏复制：以唯一目标返回", async () => {
    mountHost();
    const picked = pickWallpaperTarget({ action: "setRotation" });
    await flushPromises();
    store.values.wallpaperDisplayMode = "multiple";
    expect(await picked).toBe("multiple");
    await flushPromises();
    expect(host!.find(".dialog").exists()).toBe(false);
  });
});
