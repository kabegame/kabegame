// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperTarget } from "@/components/wallpaper/types";
import WallpaperWindow from "./WallpaperWindow.vue";

const backend = vi.hoisted(() => ({
  paused: false,
  target: null as unknown,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "wallpaper" }) }));
vi.mock("@/api/rpc", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "get_wallpaper_paused") return backend.paused;
    if (command === "get_current_wallpaper_target") return backend.target;
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
      props: { target: Object, paused: Boolean },
      setup(_props, { expose }) {
        expose({ debugState: () => null, delegatesPing: () => false });
        return () => h("div", { class: "stage" });
      },
    }),
  };
});

const wrappers: ReturnType<typeof mount>[] = [];

async function mountWindow(type: string, paused: boolean) {
  backend.paused = paused;
  backend.target = { id: "1", path: "C:/wallpaper", type } satisfies WallpaperTarget;
  const wrapper = mount(WallpaperWindow, { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

const stagePaused = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findComponent({ name: "WallpaperStage" }).props("paused");

function settingChange(changes: Record<string, unknown>) {
  backend.listeners.get("setting-change")?.({ payload: { changes } });
}

beforeEach(() => backend.listeners.clear());
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WallpaperWindow 的 wallpaperPaused 判定", () => {
  it.each(["x-wpe/web", "x-wpe/scene", "video/mp4", "x-wpe/video"])(
    "%s 受设置影响：启动时读取，随 setting-change 更新",
    async (type) => {
      const wrapper = await mountWindow(type, true);
      expect(stagePaused(wrapper)).toBe(true);
      settingChange({ wallpaperPaused: false });
      await flushPromises();
      expect(stagePaused(wrapper)).toBe(false);
      settingChange({ wallpaperPaused: true });
      await flushPromises();
      expect(stagePaused(wrapper)).toBe(true);
    },
  );

  it.each(["image/png", "image/jpg"])("%s 不受影响：图片是静态的", async (type) => {
    const wrapper = await mountWindow(type, true);
    expect(stagePaused(wrapper)).toBe(false);
    settingChange({ wallpaperPaused: true });
    await flushPromises();
    expect(stagePaused(wrapper)).toBe(false);
  });

  it("没有目标时不算暂停", async () => {
    backend.paused = true;
    backend.target = null;
    const wrapper = mount(WallpaperWindow, { attachTo: document.body });
    wrappers.push(wrapper);
    await flushPromises();
    expect(stagePaused(wrapper)).toBe(false);
  });
});
