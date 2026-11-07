// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WpeSceneView from "./WpeSceneView.vue";
import { WPE_SCENE_SIZE, WPE_SCENE_STYLE, WPE_SCENE_STYLE_REQUEST } from "./wpeSceneStyle";

vi.mock("@/api", () => ({ invoke: async () => "file:///D:/host/index.html" }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const wrappers: ReturnType<typeof mount>[] = [];

async function mountView(styleMode = "fit") {
  const wrapper = mount(WpeSceneView, {
    props: { target: { id: "7", path: "D:/wpe/7" }, styleMode, volume: 1 } as never,
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  await flushPromises();
  const frame = wrapper.find("iframe").element as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const fromHost = (data: unknown, source: Window | null = frame.contentWindow) => {
    const event = new MessageEvent("message", { source, data });
    // 合成事件的 isTrusted 为 false，这里模拟真实消息
    Object.defineProperty(event, "isTrusted", { value: true });
    window.dispatchEvent(event);
  };
  return { wrapper, post, fromHost };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WpeSceneView 样式与尺寸", () => {
  it("宿主请求时回当前样式，样式变化时主动推", async () => {
    const { wrapper, post, fromHost } = await mountView("fit");
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    expect(post).toHaveBeenLastCalledWith({ type: WPE_SCENE_STYLE, style: "fit" }, "*");
    await wrapper.setProps({ styleMode: "center" });
    expect(post).toHaveBeenLastCalledWith({ type: WPE_SCENE_STYLE, style: "center" }, "*");
  });

  it("把宿主报的场景分辨率发出去", async () => {
    const { wrapper, fromHost } = await mountView();
    fromHost({ type: WPE_SCENE_SIZE, width: 2560, height: 1440 });
    expect(wrapper.emitted("size")).toEqual([[{ width: 2560, height: 1440 }]]);
  });

  it("别的窗口发来的消息不理", async () => {
    const { wrapper, post, fromHost } = await mountView();
    fromHost({ type: WPE_SCENE_STYLE_REQUEST }, window);
    fromHost({ type: WPE_SCENE_SIZE, width: 2560, height: 1440 }, window);
    expect(post).not.toHaveBeenCalled();
    expect(wrapper.emitted("size")).toBeUndefined();
  });
});
