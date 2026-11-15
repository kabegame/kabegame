// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref, type Ref } from "vue";
import WpeSceneView from "./WpeSceneView.vue";
import {
  WALLPAPER_PREVIEW_ZOOM,
  WPE_SCENE_DISPLAY,
  WPE_SCENE_POINTER,
  WPE_SCENE_SETTINGS,
  WPE_SCENE_STYLE,
  WPE_SCENE_STYLE_REQUEST,
} from "./wpeSceneStyle";
import { WPE_CONTEXT_MENU } from "./wpeContextMenu";
import { WPE_SCENE_SHORTCUT } from "./wpeSceneShortcut";
import { WPE_VOLUME_MESSAGE, WPE_VOLUME_REQUEST } from "./wpeWebVolume";
import { framePointerEvents } from "./framePointer";

/** `wpe_scene_cursor` 的返回（开场指针）；其余命令都当取宿主地址。 */
const cursor = vi.hoisted(() => ({ value: null as { x: number; y: number } | null }));
/** 本组件订阅的 `wpe-scene-status` 处理函数（测试里模拟宿主报 ready）。 */
const status = vi.hoisted(() => ({ handler: null as ((event: { payload: unknown }) => void) | null }));
/** 记下每次 `invoke`（P11d 的快捷方式用例读）；`reject` 为真时 `wpe_open_user_shortcut` 失败。 */
const invokes = vi.hoisted(() => ({ list: [] as { command: string; args: unknown }[], reject: false }));
vi.mock("@/api", () => ({
  invoke: async (command: string, args?: unknown) => {
    invokes.list.push({ command, args });
    if (command === "wpe_open_user_shortcut") {
      if (invokes.reject) throw new Error("启动失败");
      return true;
    }
    return command === "wpe_scene_cursor" ? cursor.value : "file:///D:/host/index.html";
  },
}));
const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logger: loggerMock }));
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

  it("宿主请求时回场景设置（缺省都跟随），设置变了主动推", async () => {
    const { wrapper, post, fromHost } = await mountView("fit");
    fromHost({ type: WPE_SCENE_STYLE_REQUEST });
    const follow = { type: WPE_SCENE_SETTINGS, postprocess: "follow", reflection: "follow", shadows: "follow" };
    expect(post).toHaveBeenCalledWith(follow, "*");
    post.mockClear();
    await wrapper.setProps({ sceneSettings: { postprocess: "enabled", reflection: "follow", shadows: "low" } });
    expect(post).toHaveBeenCalledExactlyOnceWith({ ...follow, postprocess: "enabled", shadows: "low" }, "*");
    // 同值的新对象不推
    await wrapper.setProps({ sceneSettings: { postprocess: "enabled", reflection: "follow", shadows: "low" } });
    expect(post).toHaveBeenCalledOnce();
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
    // happy-dom 没有布局：量不出来，只回样式（场景设置另算）
    expect(post.mock.calls.filter(([data]) => (data as { type?: unknown }).type !== WPE_SCENE_SETTINGS)).toEqual([
      [{ type: WPE_SCENE_STYLE, style: "fit" }, "*"],
    ]);
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

  describe("预览放大", () => {
    /** 手动推进的 rAF 队列 */
    let frames: Map<number, FrameRequestCallback>;
    let nextFrameId: number;
    const runFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    };

    beforeEach(() => {
      frames = new Map();
      nextFrameId = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrameId, callback);
        return nextFrameId;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    });

    /** 挂在预览画布里：画布提供放大倍数 */
    async function mountZoomed(zoom: Ref<number>) {
      const wrapper = mount(WpeSceneView, {
        props: { target: { id: "7", path: "D:/wpe/7" }, styleMode: "fit", volume: 1 } as never,
        attachTo: document.body,
        global: { provide: { [WALLPAPER_PREVIEW_ZOOM as symbol]: zoom } },
      });
      wrappers.push(wrapper);
      await flushPromises();
      const frame = wrapper.find("iframe").element as HTMLIFrameElement;
      const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
      return { wrapper, post, frame };
    }

    it("放大时按 sceneDisplayScale 封顶：画布跟着放大到 1 为止", async () => {
      const zoom = ref(2);
      const { post, frame } = await mountZoomed(zoom);
      // 适应时 0.4，放大 2 倍量到 0.8
      layout(frame, 2560, 1440, 0.8);
      poll();
      expect(post).toHaveBeenLastCalledWith(displayMessage(0.8), "*");
      // 放大 5 倍量到 2：封顶到 1
      zoom.value = 5;
      layout(frame, 2560, 1440, 2);
      poll();
      expect(post).toHaveBeenLastCalledWith(displayMessage(1), "*");
    });

    it("放大倍数一变就在下一帧补量一次，同一帧内多次变化只量一次", async () => {
      const zoom = ref(1);
      const { post, frame } = await mountZoomed(zoom);
      layout(frame, 2560, 1440, 0.4);
      poll();
      post.mockClear();
      zoom.value = 1.5;
      await nextTick();
      zoom.value = 2;
      await nextTick();
      layout(frame, 2560, 1440, 0.8);
      expect(displayPosts(post)).toHaveLength(0);
      expect(frames.size).toBe(1);
      runFrames();
      expect(displayPosts(post)).toEqual([[displayMessage(0.8), "*"]]);
    });

    it("卸载时取消还没跑的那一帧", async () => {
      const zoom = ref(1);
      const { wrapper } = await mountZoomed(zoom);
      zoom.value = 3;
      await nextTick();
      expect(frames.size).toBe(1);
      wrappers.splice(wrappers.indexOf(wrapper), 1);
      wrapper.unmount();
      expect(frames.size).toBe(0);
    });

    it("没有提供方（桌面、应用背景）时就是实测值", async () => {
      const { post, fromHost, frame } = await mountView();
      layout(frame, 1000, 500, 2);
      fromHost({ type: WPE_SCENE_STYLE_REQUEST });
      expect(post).toHaveBeenLastCalledWith(displayMessage(2), "*");
    });
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

describe("WpeSceneView 快捷方式（P11d）：应用页是安全边界", () => {
  const launches = () => invokes.list.filter((item) => item.command === "wpe_open_user_shortcut");
  const activation = (isActive: boolean | undefined) =>
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: isActive === undefined ? undefined : { isActive },
    });

  beforeEach(() => {
    invokes.list.length = 0;
    invokes.reject = false;
    loggerMock.warn.mockClear();
    loggerMock.debug.mockClear();
    activation(true);
  });
  afterEach(() => activation(undefined));

  it("可交互 + 用户激活：以本组件的图片 id 调 wpe_open_user_shortcut，消息里别的字段不进命令", async () => {
    const { fromHost } = await mountView("fit", true);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome", imageId: "999", path: "C:/evil.exe" });
    await flushPromises();
    expect(launches()).toEqual([{ command: "wpe_open_user_shortcut", args: { imageId: "7", name: "Chrome" } }]);
  });

  it("不可交互的实例（应用背景等）不启动，记一条 debug", async () => {
    const { fromHost } = await mountView("fit", false);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome" });
    await flushPromises();
    expect(launches()).toEqual([]);
    expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining("不可交互"));
  });

  it("没有用户激活（isActive 为假、浏览器没有这个接口）不启动", async () => {
    const { fromHost } = await mountView("fit", true);
    activation(false);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome" });
    activation(undefined);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome" });
    await flushPromises();
    expect(launches()).toEqual([]);
    expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining("没有用户激活"));
  });

  it("来源不是自己的 iframe、isTrusted 为假的消息不启动", async () => {
    const { fromHost } = await mountView("fit", true);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome" }, window);
    window.dispatchEvent(new MessageEvent("message", { data: { type: WPE_SCENE_SHORTCUT, name: "Chrome" } }));
    await flushPromises();
    expect(launches()).toEqual([]);
  });

  it("名字不合法（空、过长、不是字符串）不启动；按名字 1 秒节流", async () => {
    const { fromHost } = await mountView("fit", true);
    for (const name of ["", "a".repeat(257), 5, null]) fromHost({ type: WPE_SCENE_SHORTCUT, name });
    await flushPromises();
    expect(launches()).toEqual([]);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "a" });
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "a" });
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "b" });
    await flushPromises();
    expect(launches().map((item) => (item.args as { name: string }).name)).toEqual(["a", "b"]);
    expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining("1 秒内重复"));
  });

  it("命令失败只记 warn，不抛", async () => {
    invokes.reject = true;
    const { fromHost } = await mountView("fit", true);
    fromHost({ type: WPE_SCENE_SHORTCUT, name: "Chrome" });
    await flushPromises();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("启动快捷方式失败"));
  });
});

describe("WpeSceneView 鼠标", () => {
  it("音量消息带 interactive，变化时主动推；iframe 按平台收不收真实鼠标", async () => {
    const { wrapper, post, fromHost, frame } = await mountView("fit", true);
    const volumePosts = () =>
      post.mock.calls.filter(([data]) => (data as { type?: unknown }).type === WPE_VOLUME_MESSAGE);
    fromHost({ type: WPE_VOLUME_REQUEST });
    expect(frame.style.pointerEvents).toBe(framePointerEvents(true));
    expect(volumePosts().at(-1)?.[0]).toEqual({
      type: WPE_VOLUME_MESSAGE,
      volume: 1,
      paused: false,
      interactive: true,
    });
    await wrapper.setProps({ interactive: false });
    expect((volumePosts().at(-1)?.[0] as { interactive: boolean }).interactive).toBe(false);
    // 不交互时任何平台都不收真实鼠标
    expect(frame.style.pointerEvents).toBe("none");
  });
});
