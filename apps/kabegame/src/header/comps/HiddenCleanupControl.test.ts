// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ref } from "vue";
import HiddenCleanupControl from "./HiddenCleanupControl.vue";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import { messageBox } from "@/components/ui/messageBox";
import { start as startCleanup } from "@/services/hiddenCleanup";

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
vi.mock("@/components/ui/messageBox", () => ({ messageBox: { confirm: vi.fn() } }));
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
    // 数量显示在 ToolRow 的右侧提示里，要真渲染它
    const wrapper = mount(HiddenCleanupControl);
    cleanups.push(() => wrapper.unmount());
    expect(pathqlAll).toHaveBeenCalledExactlyOnceWith([
      { kind: "count", path: `images://gallery/album/${HIDDEN_ALBUM_ID}` },
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain("7");
    pathqlAll.mockClear();
    listeners.get("album-images-added")?.({ payload: { albumId: "other" } });
    listeners.get("images-deleted")?.({ payload: { seq: 1, imageIds: ["a"] } });
    expect(pathqlAll).not.toHaveBeenCalled();
    pathqlAll.mockResolvedValue([2]);
    listeners.get("album-images-deleted")?.({ payload: { albumId: HIDDEN_ALBUM_ID } });
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("2");
    wrapper.unmount();
    pathqlAll.mockClear();
    listeners.get("album-images-added")?.({ payload: { albumId: HIDDEN_ALBUM_ID } });
    expect(pathqlAll).not.toHaveBeenCalled();
  });
});

describe("删源文件的勾选", () => {
  type Checkbox = { label: string; model: Ref<boolean>; hint?: string };

  /**
   * 挂一个控件，返回「点一次按钮」的函数。
   * 复位只在同一个实例上点第二次才看得见（换实例的话 ref 本来就是新的 false），所以挂载与点击要分开。
   */
  async function mountControl() {
    pathqlAll.mockReset().mockResolvedValue([3]);
    vi.mocked(messageBox.confirm).mockReset();
    vi.mocked(startCleanup).mockReset();
    const wrapper = mount(HiddenCleanupControl);
    cleanups.push(() => wrapper.unmount());
    await flushPromises();
    /** 点一次，返回确认框这次收到的勾选项（`decide` 在确认前改勾选值；给 false 表示取消） */
    return async function click(decide?: (model: Ref<boolean>) => boolean | void) {
      let seen: Checkbox | undefined;
      vi.mocked(messageBox.confirm).mockImplementation((...args: unknown[]) => {
        seen = (args[2] as { checkbox?: Checkbox }).checkbox;
        const opened = seen!.model.value; // 复位之后、用户改动之前的值
        const ok = decide?.(seen!.model) ?? true;
        seen = { ...seen!, model: { value: opened } as Ref<boolean> };
        return ok === false ? Promise.reject("cancel") : Promise.resolve("confirm" as never);
      });
      await wrapper.find(".kb-tool-row, button, div").trigger("click");
      await flushPromises();
      return seen!;
    };
  }

  it("默认不勾，不勾就不删源文件", async () => {
    const click = await mountControl();
    const checkbox = await click();
    expect(checkbox.model.value).toBe(false);
    expect(checkbox.label).toBe("gallery.hiddenCleanupDeleteFiles");
    expect(startCleanup).toHaveBeenCalledWith(3, false);
  });

  it("勾上才把 true 传下去", async () => {
    const click = await mountControl();
    await click((model) => {
      model.value = true;
    });
    expect(startCleanup).toHaveBeenCalledWith(3, true);
  });

  it("同一个控件上，上次勾过不会留到下一次", async () => {
    const click = await mountControl();
    await click((model) => {
      model.value = true;
    });
    const second = await click();
    expect(second.model.value).toBe(false); // 打开时已被复位
    expect(startCleanup).toHaveBeenNthCalledWith(1, 3, true);
    expect(startCleanup).toHaveBeenNthCalledWith(2, 3, false);
  });

  it("取消就不启动清理", async () => {
    const click = await mountControl();
    await click(() => false);
    expect(startCleanup).not.toHaveBeenCalled();
  });
});
