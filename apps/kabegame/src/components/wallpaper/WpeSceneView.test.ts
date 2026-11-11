// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WpeSceneView from "./WpeSceneView.vue";
import { WPE_SCENE_DISPLAY, WPE_SCENE_POINTER, WPE_SCENE_STYLE, WPE_SCENE_STYLE_REQUEST } from "./wpeSceneStyle";
import { WPE_CONTEXT_MENU } from "./wpeContextMenu";

/** `wpe_scene_cursor` 的返回（开场指针）；其余命令都当取宿主地址。 */
const cursor = vi.hoisted(() => ({ value: null as { x: number; y: number } | null }));
/** 本组件订阅的 `wpe-scene-status` 处理函数（测试里模拟宿主报 ready）。 */
const status = vi.hoisted(() => ({ handler: null as ((event: { payload: unknown }) => void) | null }));
vi.mock("@/api", () => ({
  invoke: async (command: string) => (command === "wpe_scene_cursor" ? cursor.value : "file:///D:/host/index.html"),
}));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (event: { payload: unknown }) => void) => {
    status.handler = handler;
    return () => {};
  },
}));

const wrappers: ReturnType<typeof mount>[] = [];

async function mountView(styleMode = "fit", interactive = false) {
  const wrapper = mount(WpeSceneView, {
    props: { target: { id: "7", path: "D:/wpe/7" }, styleMode, volume: 1, interactive } as never,
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
  return { wrapper, post, fromHost, frame };
}

/** happy-dom 不排版：直接给 iframe 布局尺寸与显示矩形（布局 × 显示缩放）。 */
function layout(frame: HTMLIFrameElement, width: number, height: number, shown: number) {
  Object.defineProperty(frame, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(frame, "offsetHeight", { configurable: true, value: height });
  frame.getBoundingClientRect = () => ({ width: width * shown, height: height * shown }) as DOMRect;
}

const displayMessage = (scale: number) => ({ type: WPE_SCENE_DISPLAY, scale: expect.closeTo(scale, 9) });
const displayPosts = (post: { mock: { calls: unknown[][] } }) =>
  post.mock.calls.filter(([data]) => (data as { type?: unknown }).type === WPE_SCENE_DISPLAY);

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WpeSceneView 样式", () => {
  it("宿主请求时回当前样式，样式变化时主动推", async () => {
    const { wrapper, post, fromHost } = await mountView("fit");
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    expect(post).toHaveBeenLastCalledWith({ type: WPE_SCENE_STYLE, style: "fit" }, "*");
    await wrapper.setProps({ styleMode: "center" });
    expect(post).toHaveBeenLastCalledWith({ type: WPE_SCENE_STYLE, style: "center" }, "*");
  });

  it("别的窗口发来的消息不理", async () => {
    const { post, fromHost } = await mountView();
    fromHost({ type: WPE_SCENE_STYLE_REQUEST }, window);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("WpeSceneView 显示缩放", () => {
  /** 假 ResizeObserver：记录观察的元素，测试里手动回调。 */
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  /** `window.setInterval` 排的回调（轮询）。 */
  let intervals: { callback: () => void; delay: number }[] = [];

  beforeEach(() => {
    observers.splice(0);
    intervals = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly record: (typeof observers)[number];
        constructor(callback: ResizeObserverCallback) {
          this.record = { callback, targets: new Set() };
          observers.push(this.record);
        }
        observe(target: Element) {
          this.record.targets.add(target);
        }
        unobserve(target: Element) {
          this.record.targets.delete(target);
        }
        disconnect() {
          this.record.targets.clear();
        }
      },
    );
    vi.spyOn(window, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
      intervals.push({ callback, delay });
      return intervals.length;
    }) as typeof window.setInterval);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const resized = (frame: Element) =>
    observers.forEach((item) => item.targets.has(frame) && item.callback([], {} as ResizeObserver));
  const poll = () => intervals.filter((item) => item.delay === 250).forEach((item) => item.callback());

  it("挂载：宿主启动时请求，回样式的同时回显示缩放；量不出来时不推", async () => {
    const { post, fromHost, frame } = await mountView("fit");
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    // happy-dom 没有布局：量不出来，只回样式
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: WPE_SCENE_STYLE, style: "fit" }, "*");
    layout(frame, 5760, 1080, 0.18);
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    expect(post).toHaveBeenLastCalledWith(displayMessage(0.18), "*");
    // 宿主再请求（例如重载）时即使没变也照回
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    expect(displayPosts(post)).toHaveLength(2);
  });

  it("iframe 尺寸变化（ResizeObserver）时推新的缩放，没变不推", async () => {
    const { post, fromHost, frame } = await mountView();
    // 宿主 iframe 挂上后就在观察它
    expect(observers.some((item) => item.targets.has(frame))).toBe(true);
    layout(frame, 5760, 1080, 0.18);
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    layout(frame, 3840, 2160, 0.25);
    resized(frame);
    expect(post).toHaveBeenLastCalledWith(displayMessage(0.25), "*");
    resized(frame);
    expect(displayPosts(post)).toHaveLength(2);
  });

  it("只有父级缩放变了（布局不变）：轮询比较，只在值变时推；窗口尺寸变化时也量", async () => {
    const { post, fromHost, frame } = await mountView();
    layout(frame, 5760, 1080, 0.18);
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    poll();
    expect(displayPosts(post)).toHaveLength(1);
    // 预览弹窗被拉大：transform 变了，布局尺寸不变，ResizeObserver 不触发
    layout(frame, 5760, 1080, 0.3);
    poll();
    expect(post).toHaveBeenLastCalledWith(displayMessage(0.3), "*");
    // 亚像素抖动不推
    layout(frame, 5760, 1080, 0.3 * (1 + 1e-6));
    poll();
    expect(displayPosts(post)).toHaveLength(2);
    // 窗口尺寸变化：等这一轮渲染更新（祖先重算 scale）之后再量
    layout(frame, 5760, 1080, 0.4);
    window.dispatchEvent(new Event("resize"));
    expect(displayPosts(post)).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).toHaveBeenLastCalledWith(displayMessage(0.4), "*");
  });

  it("卸载时停掉轮询与观察", async () => {
    const clear = vi.spyOn(window, "clearInterval");
    const { wrapper, frame } = await mountView();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    wrapper.unmount();
    expect(clear).toHaveBeenCalledWith(intervals.findIndex((item) => item.delay === 250) + 1);
    expect(observers.every((item) => !item.targets.has(frame))).toBe(true);
  });
});

describe("WpeSceneView 右键", () => {
  it("宿主转发的右键换算到父页面视口后往上抛；别的窗口发的不理", async () => {
    const { wrapper, fromHost, frame } = await mountView();
    Object.defineProperty(frame, "offsetWidth", { configurable: true, value: 1920 });
    Object.defineProperty(frame, "offsetHeight", { configurable: true, value: 1080 });
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 960, height: 540 }) as DOMRect;
    fromHost({ type: WPE_CONTEXT_MENU, x: 400, y: 200 });
    expect(wrapper.emitted("contextmenu")).toEqual([[{ x: 300, y: 150 }]]);
    fromHost({ type: WPE_CONTEXT_MENU, x: 1, y: 1 }, window);
    expect(wrapper.emitted("contextmenu")).toHaveLength(1);
  });
});

describe("WpeSceneView 开场指针（P5a 收尾）", () => {
  afterEach(() => {
    cursor.value = null;
  });

  const pointerPosts = (post: { mock: { calls: unknown[][] } }) =>
    post.mock.calls.filter(([data]) => (data as { type?: unknown }).type === WPE_SCENE_POINTER).map(([data]) => data);
  /** 显示矩形：左上 (100, 50)、960×540（布局可以更大，按显示矩形算）。 */
  const place = (frame: HTMLIFrameElement) => {
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 960, height: 540 }) as DOMRect;
  };
  /** 宿主报 ready：后端发回的 `wpe-scene-status`，实例号取 iframe 地址里的。 */
  const ready = (frame: HTMLIFrameElement) =>
    status.handler!({ payload: { instance: new URL(frame.src).searchParams.get("kbInstance"), kind: "ready" } });

  it("interactive：iframe load 与宿主 ready 时各发一次，按显示矩形换算、不钳制", async () => {
    const { wrapper, post, frame } = await mountView("fit", true);
    place(frame);
    cursor.value = { x: 340, y: 185 };
    frame.dispatchEvent(new Event("load"));
    await flushPromises();
    expect(pointerPosts(post)).toEqual([{ type: WPE_SCENE_POINTER, x: 0.25, y: 0.25 }]);
    expect(post).toHaveBeenLastCalledWith({ type: WPE_SCENE_POINTER, x: 0.25, y: 0.25 }, "*");
    // 光标在 iframe 外（窗口里别处）：越界照发
    cursor.value = { x: 1060, y: 1130 };
    ready(frame);
    await flushPromises();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(pointerPosts(post)).toEqual([
      { type: WPE_SCENE_POINTER, x: 0.25, y: 0.25 },
      { type: WPE_SCENE_POINTER, x: 1, y: 2 },
    ]);
  });

  it("不交互时不发（也不问光标）", async () => {
    const { wrapper, post, frame } = await mountView("fit", false);
    place(frame);
    cursor.value = { x: 340, y: 185 };
    frame.dispatchEvent(new Event("load"));
    ready(frame);
    await flushPromises();
    expect(wrapper.emitted("ready")).toHaveLength(1);
    expect(pointerPosts(post)).toEqual([]);
  });

  it("命令返回 null：退回本页最近一次鼠标位置；也没有就不发", async () => {
    const { post, frame } = await mountView("fit", true);
    place(frame);
    frame.dispatchEvent(new Event("load"));
    await flushPromises();
    expect(pointerPosts(post)).toEqual([]);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 580, clientY: 320 }));
    window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 820, clientY: 455 }));
    ready(frame);
    await flushPromises();
    expect(pointerPosts(post)).toEqual([{ type: WPE_SCENE_POINTER, x: 0.75, y: 0.75 }]);
  });
});
