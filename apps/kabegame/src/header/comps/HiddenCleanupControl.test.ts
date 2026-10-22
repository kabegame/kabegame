// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import HiddenCleanupControl from "./HiddenCleanupControl.vue";
import { HIDDEN_ALBUM_ID } from "@/services/albums";

const pathqlAll = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));
vi.mock("@/services/albums", () => ({ HIDDEN_ALBUM_ID: "hidden", FAVORITE_ALBUM_ID: "favorite" }));
vi.mock("@/stores/hiddenCleanup", () => ({ useHiddenCleanupStore: () => ({ running: false }) }));
vi.mock("@/services/hiddenCleanup", () => ({ start: vi.fn() }));
vi.mock("@kabegame/element-plus", () => ({ ElMessageBox: {} }));
vi.mock("@kabegame/element-plus-icons", () => ({ Delete: { render: () => null } }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});

describe("隐藏图数 pathql 观察", () => {
  it("setup 只请求一次；只接受隐藏画册成员事件，卸载后释放", async () => {
    vi.useFakeTimers();
    pathqlAll.mockReset().mockResolvedValue([7]);
    const wrapper = shallowMount(HiddenCleanupControl, {
      global: { stubs: { "el-button": { template: "<button><slot /></button>" }, "el-icon": true } },
    });
    cleanups.push(() => wrapper.unmount());
    expect(pathqlAll).toHaveBeenCalledExactlyOnceWith([
      { kind: "count", path: `images://gallery/album/${HIDDEN_ALBUM_ID}` },
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain("7");
    pathqlAll.mockClear();
    listeners.get("album-images-change")?.({ payload: { albumIds: ["other"] } });
    listeners.get("images-change")?.({ payload: { reason: "delete" } });
    expect(pathqlAll).not.toHaveBeenCalled();
    pathqlAll.mockResolvedValue([2]);
    listeners.get("album-images-change")?.({ payload: { albumIds: [HIDDEN_ALBUM_ID] } });
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("2");
    wrapper.unmount();
    pathqlAll.mockClear();
    listeners.get("album-images-change")?.({ payload: { albumIds: [HIDDEN_ALBUM_ID] } });
    expect(pathqlAll).not.toHaveBeenCalled();
  });
});
