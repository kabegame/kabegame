// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, reactive, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperDisplayMode, WallpaperScreen, WallpaperTargets } from "@/utils/wallpaperTargets";
import WallpaperScreenLayout from "./WallpaperScreenLayout.vue";

const env = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined),
}));
// vi.mock 的工厂先于模块顶层执行，响应式状态放在工厂里建、再从这里取
const state = vi.hoisted(() => ({
  screens: null as unknown as { value: WallpaperScreen[] },
  canvasWidth: null as unknown as { value: number },
  settings: null as unknown as { values: { wallpaperTargets: WallpaperTargets } },
}));

vi.mock("@/api/rpc", () => ({ invoke: env.invoke }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${params.n}` : key) }),
}));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: { error: vi.fn() } }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/composables/useWallpaperScreens", () => ({ useWallpaperScreens: () => state.screens }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => state.settings }));
// 测试环境没有布局：直接给画布一个宽度
vi.mock("@vueuse/core", () => ({ useElementSize: () => ({ width: state.canvasWidth }) }));

state.screens = ref<WallpaperScreen[]>([]);
state.canvasWidth = ref(600);
state.settings = reactive({ values: { wallpaperTargets: {} as WallpaperTargets } });

function screen(id: string, overrides: Partial<WallpaperScreen> = {}): WallpaperScreen {
  return {
    id,
    name: `${id} Display`,
    x: 0,
    y: 0,
    width: 1512,
    height: 982,
    pixelWidth: 3024,
    pixelHeight: 1964,
    scale: 2,
    primary: false,
    ...overrides,
  };
}
const MAIN = screen("main", { primary: true });
const SIDE = screen("side", { x: 1512, y: 82, width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800 });

/** 「忘记」按钮的替身（组件库按钮是全局注册的，测试里没有） */
const ElButton = defineComponent({
  setup(_props, { slots }) {
    return () => h("button", { class: "forget" }, slots.default?.());
  },
});

const wrappers: ReturnType<typeof mount>[] = [];
function mountLayout(props: {
  displayMode: WallpaperDisplayMode;
  selected?: string | null;
  defaultScreen?: string | null;
  showDisconnected?: boolean;
}) {
  const wrapper = mount(WallpaperScreenLayout, {
    props,
    global: { components: { ElButton } },
  });
  wrappers.push(wrapper);
  return wrapper;
}
const boxes = (wrapper: ReturnType<typeof mount>) => wrapper.findAll("[data-screen-id]");
const pressed = (wrapper: ReturnType<typeof mount>) => boxes(wrapper).map((box) => box.attributes("aria-pressed"));

beforeEach(() => {
  state.screens.value = [MAIN, SIDE];
  state.canvasWidth.value = 600;
  state.settings.values.wallpaperTargets = {};
  env.invoke.mockClear();
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WallpaperScreenLayout", () => {
  it("没有在线屏信息时什么都不渲染", () => {
    state.screens.value = [];
    const wrapper = mountLayout({ displayMode: "multiple", selected: "multiple" });
    expect(wrapper.find("[role='group']").exists()).toBe(false);
    expect(boxes(wrapper)).toHaveLength(0);
  });

  it("每块屏一个块：序号、名字、物理像素分辨率，主屏带角标；位置按桌面排布缩放", () => {
    const wrapper = mountLayout({ displayMode: "multiple", selected: "multiple" });
    const [main, side] = boxes(wrapper);
    expect(main.text()).toContain("1");
    expect(main.text()).toContain("main Display");
    expect(main.text()).toContain("3024×1964");
    expect(main.text()).toContain("settings.screenPrimary");
    expect(side.text()).toContain("2");
    expect(side.text()).toContain("2880×1800");
    expect(side.text()).not.toContain("settings.screenPrimary");
    // 600 × 132 的可用区域：按高度缩，副屏在主屏右边、上边低一截，块之间留 4px 的缝
    expect(main.attributes("style")).toContain("left: 2px");
    expect(main.attributes("style")).toContain("top: 2px");
    expect(side.attributes("style")).toContain("left: 205px");
    expect(side.attributes("style")).toContain("top: 13px");
    expect(wrapper.text()).not.toContain("settings.screenOnlyOne");
  });

  it("屏没有名字时用「显示器 N」", () => {
    state.screens.value = [MAIN, { ...SIDE, name: null }];
    const wrapper = mountLayout({ displayMode: "multiple" });
    expect(boxes(wrapper)[1].text()).toContain("settings.screenNumbered:2");
  });

  it("multiple：所有块一起高亮，点任一块都选中唯一的目标", async () => {
    const wrapper = mountLayout({ displayMode: "multiple", selected: "multiple" });
    expect(pressed(wrapper)).toEqual(["true", "true"]);
    await boxes(wrapper)[1].trigger("click");
    await boxes(wrapper)[0].trigger("click");
    expect(wrapper.emitted("update:selected")).toEqual([["multiple"], ["multiple"]]);
    // 没有默认屏的概念
    expect(wrapper.text()).not.toContain("settings.screenDefault");
  });

  it("span：同样是一个目标，另画并集外框", async () => {
    const wrapper = mountLayout({ displayMode: "span", selected: "span" });
    expect(pressed(wrapper)).toEqual(["true", "true"]);
    expect(wrapper.find(".border-dashed").exists()).toBe(true);
    await boxes(wrapper)[0].trigger("click");
    expect(wrapper.emitted("update:selected")).toEqual([["span"]]);
  });

  it("single：每块屏各是一个目标，只高亮选中的；默认屏带角标（未指定时是主屏）", async () => {
    const wrapper = mountLayout({ displayMode: "single", selected: "screen:side" });
    expect(pressed(wrapper)).toEqual(["false", "true"]);
    expect(boxes(wrapper)[0].text()).toContain("settings.screenDefault");
    expect(boxes(wrapper)[1].text()).not.toContain("settings.screenDefault");
    await boxes(wrapper)[0].trigger("click");
    expect(wrapper.emitted("update:selected")).toEqual([["screen:main"]]);

    await wrapper.setProps({ defaultScreen: "side" });
    expect(boxes(wrapper)[0].text()).not.toContain("settings.screenDefault");
    expect(boxes(wrapper)[1].text()).toContain("settings.screenDefault");
    // 默认屏不在线：回到主屏
    await wrapper.setProps({ defaultScreen: "gone" });
    expect(boxes(wrapper)[0].text()).toContain("settings.screenDefault");
  });

  it("在线屏变化后跟着重画；只剩一块时附说明", async () => {
    const wrapper = mountLayout({ displayMode: "multiple", selected: "multiple" });
    state.screens.value = [MAIN];
    await nextTick();
    expect(boxes(wrapper)).toHaveLength(1);
    expect(wrapper.text()).toContain("settings.screenOnlyOne");
    state.screens.value = [MAIN, SIDE];
    await nextTick();
    expect(boxes(wrapper)).toHaveLength(2);
    expect(wrapper.text()).not.toContain("settings.screenOnlyOne");
  });

  it("块放不下时只留序号，完整信息在 title 里", async () => {
    state.canvasWidth.value = 120;
    const wrapper = mountLayout({ displayMode: "multiple", selected: "multiple" });
    const [main] = boxes(wrapper);
    expect(main.text().trim()).toBe("1");
    expect(main.attributes("title")).toBe("1 · main Display · 3024×1964 · settings.screenPrimary");
  });

  it("已断开的屏：只在逐屏独立且要求显示时列出，可以忘记", async () => {
    const config = { rotationPath: null, rotationPosition: 0, style: {}, transition: {}, currentImageId: null };
    state.settings.values.wallpaperTargets = {
      multiple: config,
      "screen:main": config,
      "screen:0123456789ABCDEF": config,
    };
    expect(mountLayout({ displayMode: "single", selected: "screen:main" }).text()).not.toContain(
      "settings.screenDisconnected",
    );
    expect(mountLayout({ displayMode: "multiple", selected: "multiple", showDisconnected: true }).text()).not.toContain(
      "settings.screenDisconnected",
    );

    const wrapper = mountLayout({ displayMode: "single", selected: "screen:main", showDisconnected: true });
    expect(wrapper.text()).toContain("settings.screenDisconnected");
    expect(wrapper.text()).toContain("01234567");
    expect(wrapper.findAll(".forget")).toHaveLength(1);
    await wrapper.find(".forget").trigger("click");
    expect(env.invoke).toHaveBeenCalledWith("forget_wallpaper_target", { targetId: "screen:0123456789ABCDEF" });
  });
});
