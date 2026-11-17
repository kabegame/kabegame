// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSceneUnsupportedNotice, type SceneUnsupportedPayload } from "./useSceneUnsupportedNotice";

const events = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  unlisten: vi.fn(),
  listened: [] as string[],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.listened.push(name);
    events.handler = handler;
    return () => {
      events.unlisten();
      if (events.handler === handler) events.handler = null;
    };
  }),
}));
const warning = vi.hoisted(() => vi.fn());
vi.mock("@/utils/kameMessage", () => ({ kameMessage: { warning } }));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string, params?: { keys?: string }) => `${key}|${params?.keys ?? ""}` }),
}));
vi.mock("@/env", () => ({ IS_WEB: false, IS_ANDROID: false }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));

const unmounts: (() => void)[] = [];
beforeEach(() => {
  warning.mockClear();
  events.unlisten.mockClear();
  events.listened = [];
});
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount());
});

async function fixture() {
  const wrapper = mount(
    defineComponent({
      setup() {
        useSceneUnsupportedNotice();
        return () => null;
      },
    }),
  );
  await flushPromises();
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    wrapper.unmount();
  };
  unmounts.push(unmount);
  return unmount;
}
const emit = (payload: SceneUnsupportedPayload) => events.handler?.({ payload });

describe("useSceneUnsupportedNotice", () => {
  it("挂载后监听 wpe-scene-unsupported", async () => {
    await fixture();
    expect(events.listened).toEqual(["wpe-scene-unsupported"]);
  });

  it("同一张图同一个键只提示一次；同图新键只提示新的那几个；不同图同键照样提示", async () => {
    await fixture();
    emit({ image: "a", surface: "preview", keys: ["particle:renderers", "text:engine"] });
    emit({ image: "a", surface: "preview", keys: ["particle:renderers"] });
    emit({ image: "a", surface: "preview", keys: ["text:engine", "fog:group"] });
    emit({ image: "b", surface: "preview", keys: ["particle:renderers"] });
    // 同一张图换到桌面也不重提
    emit({ image: "a", surface: "desktop", keys: ["fog:group"] });
    expect(warning.mock.calls.map(([message]) => message)).toEqual([
      "gallery.wpeSceneUnsupportedPreview|particle:renderers, text:engine",
      "gallery.wpeSceneUnsupportedPreview|fog:group",
      "gallery.wpeSceneUnsupportedPreview|particle:renderers",
    ]);
  });

  it("桌面与预览用各自的文案", async () => {
    await fixture();
    emit({ image: "d", surface: "desktop", keys: ["k1"] });
    emit({ image: "p", surface: "preview", keys: ["k1"] });
    expect(warning.mock.calls.map(([message]) => message)).toEqual([
      "gallery.wpeSceneUnsupportedDesktop|k1",
      "gallery.wpeSceneUnsupportedPreview|k1",
    ]);
  });

  it("卸载后停止监听，之后的事件不再提示", async () => {
    const unmount = await fixture();
    const handler = events.handler;
    unmount();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
    expect(events.handler).toBeNull();
    // 即便有在途的派发也不提示
    handler?.({ payload: { image: "x", surface: "preview", keys: ["k"] } });
    expect(warning).not.toHaveBeenCalled();
  });

  it("监听还没建好就卸载：建好后立刻停掉", async () => {
    const wrapper = mount(
      defineComponent({
        setup() {
          useSceneUnsupportedNotice();
          return () => null;
        },
      }),
    );
    wrapper.unmount();
    await flushPromises();
    expect(events.unlisten).toHaveBeenCalledTimes(1);
    expect(events.handler).toBeNull();
  });
});
