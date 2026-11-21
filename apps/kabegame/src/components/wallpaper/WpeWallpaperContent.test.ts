// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import WpeWallpaperContent from "./WpeWallpaperContent.vue";
import type { WallpaperTarget } from "./types";
import { WPE_VOLUME_MESSAGE, WPE_VOLUME_REQUEST } from "./wpeWebVolume";
import { WPE_CONTEXT_MENU } from "./wpeContextMenu";
import { framePointerEvents } from "./framePointer";

/** WpeSceneView 的替身：记录挂载 / 卸载与 props，测试里按需 emit ready / fallback / alive。 */
const stub = vi.hoisted(() => ({
  scenes: [] as {
    id: string;
    unmounted: boolean;
    props: Record<string, unknown>;
    emit: (event: "ready" | "fallback" | "alive", ...args: unknown[]) => void;
  }[],
}));

vi.mock("./WpeSceneView.vue", async () => {
  const { defineComponent, h, onBeforeUnmount } = await import("vue");
  return {
    default: defineComponent({
      props: {
        target: { type: Object, required: true },
        styleMode: String,
        paused: Boolean,
        volume: Number,
        interactive: Boolean,
        sceneSettings: Object,
      },
      emits: ["ready", "fallback", "alive", "contextmenu", "progress"],
      setup(props, { emit }) {
        const record = {
          id: (props.target as WallpaperTarget).id,
          unmounted: false,
          props: props as Record<string, unknown>,
          emit: emit as (event: "ready" | "fallback" | "alive", ...args: unknown[]) => void,
        };
        stub.scenes.push(record);
        onBeforeUnmount(() => {
          record.unmounted = true;
        });
        return () => h("canvas", { class: "scene-stub" });
      },
    }),
  };
});

const rpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/api/rpc", () => ({ invoke: rpc.invoke }));

/** 属性推送（useWpeStateDelivery）的替身：记下每个实例的取值函数与 frameLoaded / reset 的调用。 */
const delivery = vi.hoisted(() => ({
  instances: [] as {
    imageId: () => string | null;
    target: () => Window | null;
    calls: string[];
  }[],
}));
vi.mock("@/composables/useWpeStateDelivery", () => ({
  useWpeStateDelivery: (options: { imageId: () => string | null; target: () => Window | null }) => {
    const instance = { ...options, calls: [] as string[] };
    delivery.instances.push(instance);
    return {
      frameLoaded: () => instance.calls.push("frameLoaded"),
      reset: () => instance.calls.push("reset"),
    };
  },
}));

const wrappers: ReturnType<typeof mount>[] = [];

const web = (id: string, webEntry: string | null = `about:blank#${id}`): WallpaperTarget => ({
  id,
  path: `C:/wpe/${id}`,
  type: "x-wpe/web",
  webEntry,
});
const scene = (id: string): WallpaperTarget => ({
  id,
  path: `C:/wpe/${id}`,
  type: "x-wpe/scene",
  sceneAssets: ["C:/wpe/assets"],
});

function mountContent(props: Record<string, unknown>) {
  const wrapper = mount(WpeWallpaperContent, { props: props as never, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frameOf(wrapper: ReturnType<typeof mount>): HTMLIFrameElement {
  const frame = wrapper.element.querySelector("iframe.wallpaper-web-frame") as HTMLIFrameElement | null;
  expect(frame?.contentWindow).toBeTruthy();
  return frame!;
}

/** 截下发给 iframe 的音量消息。 */
function spyPosts(frame: HTMLIFrameElement) {
  return vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
}

function request(source: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source: source as Window, data: { type: WPE_VOLUME_REQUEST } }));
}

/** 让 iframe 看起来停在某个文档上：`href` 为 null 时像导航到了跨源的 `file:` 页面（读 location 抛错）。 */
function fakeDocument(frame: HTMLIFrameElement, href: string | null) {
  const real = frame.contentWindow!;
  const fake = {
    postMessage: real.postMessage.bind(real),
    get location() {
      if (href === null) throw new DOMException("cross-origin", "SecurityError");
      return { href };
    },
  };
  Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => fake });
}

/** 抓 `delay` 毫秒的那个 setTimeout 回调（挂载期间设的）。 */
function captureTimeout(delay: number) {
  const spy = vi.spyOn(window, "setTimeout");
  return () => {
    const call = spy.mock.calls.find(([, ms]) => ms === delay);
    spy.mockRestore();
    expect(call).toBeDefined();
    return call![0] as () => void;
  };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  stub.scenes.splice(0);
  delivery.instances.splice(0);
  rpc.invoke.mockReset();
});

describe("WpeWallpaperContent 网页壁纸的音量消息", () => {
  it("只回答自己 iframe 的请求，回复当前 volume", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a"), volume: 0.6 });
    await settle();
    const frame = frameOf(wrapper);
    const posts = spyPosts(frame);

    request(window);
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "other" } }));
    expect(posts).not.toHaveBeenCalled();

    request(frame.contentWindow);
    expect(posts.mock.calls).toEqual([
      [{ type: WPE_VOLUME_MESSAGE, volume: 0.6, paused: false, interactive: false }, "*"],
    ]);
  });

  it("volume / paused 变化时主动推；paused 时为 0", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a"), volume: 0.6 });
    await settle();
    const posts = spyPosts(frameOf(wrapper));

    await wrapper.setProps({ volume: 0.3 });
    await wrapper.setProps({ paused: true });
    await wrapper.setProps({ paused: false });
    expect(posts.mock.calls.map(([message]) => (message as { volume: number }).volume)).toEqual([0.3, 0, 0.3]);
    // 垫片据此调页面的 setPaused
    expect(posts.mock.calls.map(([message]) => (message as { paused: boolean }).paused)).toEqual([false, true, false]);
  });

  it("同一窗口里两个实例各答各的 iframe", async () => {
    const background = mountContent({ imageId: "a", target: web("a"), volume: 0 });
    const preview = mountContent({ imageId: "b", target: web("b"), volume: 0.8 });
    await settle();
    const backgroundPosts = spyPosts(frameOf(background));
    const previewPosts = spyPosts(frameOf(preview));

    request(frameOf(background).contentWindow);
    request(frameOf(preview).contentWindow);
    expect(backgroundPosts.mock.calls.map(([message]) => message)).toEqual([
      { type: WPE_VOLUME_MESSAGE, volume: 0, paused: false, interactive: false },
    ]);
    expect(previewPosts.mock.calls.map(([message]) => message)).toEqual([
      { type: WPE_VOLUME_MESSAGE, volume: 0.8, paused: false, interactive: false },
    ]);
  });

  it("interactive 随消息交给垫片、变化时主动推；iframe 按平台收不收真实鼠标", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a") });
    await settle();
    const frame = frameOf(wrapper);
    const posts = spyPosts(frame);
    expect(frame.style.pointerEvents).toBe("none");
    await wrapper.setProps({ interactive: true });
    // 鼠标由 Rust 直接注入 frame 时一律不收；Linux 退回时可交互才收
    expect(frame.style.pointerEvents).toBe(framePointerEvents(true));
    await wrapper.setProps({ interactive: false });
    expect(posts.mock.calls.map(([message]) => (message as { interactive: boolean }).interactive)).toEqual([
      true,
      false,
    ]);
    expect(frame.style.pointerEvents).toBe("none");
  });
});

describe("WpeWallpaperContent 网页壁纸的右键", () => {
  function contextMenuFrom(source: unknown, trusted = true) {
    const event = new MessageEvent("message", {
      source: source as Window,
      data: { type: WPE_CONTEXT_MENU, x: 40, y: 30 },
    });
    // 合成事件的 isTrusted 为 false，这里模拟真实消息
    if (trusted) Object.defineProperty(event, "isTrusted", { value: true });
    window.dispatchEvent(event);
  }

  it("自己 iframe 转发的右键换算到本页面视口后往上抛；别的来源、不可信的不理", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a") });
    await settle();
    const frame = frameOf(wrapper);
    Object.defineProperty(frame, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(frame, "offsetHeight", { configurable: true, value: 600 });
    frame.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 }) as DOMRect;

    contextMenuFrom(window);
    contextMenuFrom(frame.contentWindow, false);
    expect(wrapper.emitted("contextmenu")).toBeUndefined();
    contextMenuFrom(frame.contentWindow);
    expect(wrapper.emitted("contextmenu")).toEqual([[{ x: 30, y: 35 }]]);
  });
});

describe("WpeWallpaperContent 网页壁纸的属性推送", () => {
  it("建 iframe 前 reset；第一次真实 load 后 frameLoaded（推整份），页面自己导航出来的 load 再调（只发就绪）", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a", "about:blank") });
    await settle();
    const [instance] = delivery.instances;
    expect(instance.imageId()).toBe("a");
    const frame = frameOf(wrapper);
    expect(instance.target()).toBe(frame.contentWindow);
    // 初始空文档的 load 不算
    instance.calls.splice(0, instance.calls.indexOf("reset") + 1);
    fakeDocument(frame, "about:blank");
    frame.dispatchEvent(new Event("load"));
    expect(instance.calls).toEqual([]);
    fakeDocument(frame, null);
    frame.dispatchEvent(new Event("load"));
    expect(instance.calls).toEqual(["frameLoaded"]);
    // 页面自己 reload：又一次 load
    frame.dispatchEvent(new Event("load"));
    expect(instance.calls).toEqual(["frameLoaded", "frameLoaded"]);
  });

  it("被拦的导航不推；场景壁纸的属性由 WpeSceneView 推，这里不取", async () => {
    const blocked = mountContent({ imageId: "a", target: web("a", "about:blank") });
    await settle();
    const frame = frameOf(blocked);
    fakeDocument(frame, "about:blank#blocked");
    frame.dispatchEvent(new Event("load"));
    expect(delivery.instances[0].calls).not.toContain("frameLoaded");

    mountContent({ imageId: "s", target: scene("s") });
    await settle();
    expect(delivery.instances[1].imageId()).toBeNull();
  });

  it("换目标：新 iframe 建出来之前 reset，target 指向新 iframe", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a") });
    await settle();
    const [instance] = delivery.instances;
    const resets = instance.calls.filter((call) => call === "reset").length;
    await wrapper.setProps({ imageId: "b", target: web("b") });
    await settle();
    expect(instance.calls.filter((call) => call === "reset").length).toBe(resets + 1);
    expect(instance.imageId()).toBe("b");
    expect(instance.target()).toBe(frameOf(wrapper).contentWindow);
  });
});

describe("WpeWallpaperContent 网页壁纸的结果", () => {
  // 入口用 about:blank：happy-dom 自己会给 iframe 触发一次 load，地址是初始空文档才会被忽略，结果由用例自己定
  it("页面 load 报 live；初始 about:blank 的 load 不算", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a", "about:blank") });
    await settle();
    const frame = frameOf(wrapper);
    fakeDocument(frame, "about:blank");
    frame.dispatchEvent(new Event("load"));
    expect(wrapper.emitted("live")).toBeUndefined();
    fakeDocument(frame, null);
    frame.dispatchEvent(new Event("load"));
    expect(wrapper.emitted("live")).toHaveLength(1);
    expect(wrapper.emitted("fail")).toBeUndefined();
  });

  it("导航被改写成同源文档（about:blank#blocked）报 fail", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a", "about:blank") });
    await settle();
    const frame = frameOf(wrapper);
    fakeDocument(frame, "about:blank#blocked");
    frame.dispatchEvent(new Event("load"));
    expect(wrapper.emitted("fail")).toEqual([[["web:blocked"]]]);
    expect(wrapper.emitted("live")).toBeUndefined();
  });

  it("8 s 内没 load：还停在初始 about:blank 报 not-navigated；导航了只是慢就当 live", async () => {
    let fire = captureTimeout(8_000);
    const stuck = mountContent({ imageId: "a", target: web("a", "about:blank") });
    await settle();
    fakeDocument(frameOf(stuck), "about:blank");
    fire()();
    expect(stuck.emitted("fail")).toEqual([[["web:not-navigated"]]]);

    fire = captureTimeout(8_000);
    const slow = mountContent({ imageId: "b", target: web("b", "about:blank") });
    await settle();
    fakeDocument(frameOf(slow), null);
    fire()();
    expect(slow.emitted("live")).toHaveLength(1);
    expect(slow.emitted("fail")).toBeUndefined();
  });

  it("没有入口：报 fail、不建 iframe", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a", null) });
    await settle();
    expect(wrapper.emitted("fail")).toEqual([[["web:no-entry"]]]);
    expect(wrapper.element.querySelector("iframe")).toBeNull();
  });

  it("换目标销毁旧 iframe 再建新的，iframe 在时委托 ping", async () => {
    const wrapper = mountContent({ imageId: "a", target: web("a") });
    const delegatesPing = () => (wrapper.vm as unknown as { delegatesPing: () => boolean }).delegatesPing();
    await settle();
    const first = frameOf(wrapper);
    expect(delegatesPing()).toBe(true);
    await wrapper.setProps({ imageId: "b", target: web("b") });
    await settle();
    expect(first.isConnected).toBe(false);
    expect(first.getAttribute("src")).toBe("about:blank");
    const frames = wrapper.element.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttribute("src")).toBe("about:blank#b");
  });
});

describe("WpeWallpaperContent 场景壁纸", () => {
  it("把样式、暂停、音量、可交互与场景设置交给 WpeSceneView", async () => {
    const settings = { postprocess: "ultra", reflection: "disabled", shadows: "high", volumetrics: "low" };
    mountContent({
      imageId: "s",
      target: scene("s"),
      styleMode: "center",
      paused: true,
      volume: 0.4,
      interactive: true,
      sceneSettings: settings,
    });
    await settle();
    expect(stub.scenes).toHaveLength(1);
    expect(stub.scenes[0].props).toMatchObject({
      styleMode: "center",
      paused: true,
      volume: 0.4,
      interactive: true,
      sceneSettings: settings,
    });
  });

  it("首帧报 live；退回报 fail 且宿主仍挂着，之后可渲染时再报 live", async () => {
    const wrapper = mountContent({ imageId: "s", target: scene("s") });
    await settle();
    stub.scenes[0].emit("ready");
    expect(wrapper.emitted("live")).toHaveLength(1);
    stub.scenes[0].emit("fallback", ["object:particle"]);
    await settle();
    expect(wrapper.emitted("fail")).toEqual([[["object:particle"]]]);
    expect(stub.scenes[0].unmounted).toBe(false);
    stub.scenes[0].emit("ready");
    expect(wrapper.emitted("live")).toHaveLength(2);
  });

  it("30 s 没有结果：报 fail(render:timeout) 并卸载宿主", async () => {
    const fire = captureTimeout(30_000);
    const wrapper = mountContent({ imageId: "s", target: scene("s") });
    await settle();
    fire()();
    await settle();
    expect(wrapper.emitted("fail")).toEqual([[["render:timeout"]]]);
    expect(stub.scenes[0].unmounted).toBe(true);
    expect(wrapper.find(".scene-stub").exists()).toBe(false);
  });

  it("出了结果之后超时到点什么都不做", async () => {
    const fire = captureTimeout(30_000);
    const wrapper = mountContent({ imageId: "s", target: scene("s") });
    await settle();
    stub.scenes[0].emit("fallback", ["effect:x"]);
    fire()();
    await settle();
    expect(wrapper.emitted("fail")).toEqual([[["effect:x"]]]);
    expect(stub.scenes[0].unmounted).toBe(false);
  });

  it("加载进度：出结果之前转发并重新计时（30 s 内没有新进度才超时），出结果之后不再转发", async () => {
    const spy = vi.spyOn(window, "setTimeout");
    const clear = vi.spyOn(window, "clearTimeout");
    const wrapper = mountContent({ imageId: "s", target: scene("s") });
    await settle();
    const timers = () =>
      spy.mock.calls.flatMap(([, ms], index) => (ms === 30_000 ? [spy.mock.results[index].value] : []));
    expect(timers()).toHaveLength(1);
    stub.scenes[0].emit("progress" as never, { stage: "compile", done: 1, total: 4 });
    expect(wrapper.emitted("progress")).toEqual([[{ stage: "compile", done: 1, total: 4 }]]);
    // 旧的计时清掉、重新起一个 30 s
    expect(timers()).toHaveLength(2);
    expect(clear).toHaveBeenCalledWith(timers()[0]);
    spy.mockRestore();
    clear.mockRestore();
    stub.scenes[0].emit("ready");
    stub.scenes[0].emit("progress" as never, { stage: "frame", done: 1, total: 1 });
    expect(wrapper.emitted("progress")).toHaveLength(1);
  });

  it("垫片请求音量（alive）后才委托 ping", async () => {
    const wrapper = mountContent({ imageId: "s", target: scene("s") });
    const delegatesPing = () => (wrapper.vm as unknown as { delegatesPing: () => boolean }).delegatesPing();
    await settle();
    expect(delegatesPing()).toBe(false);
    stub.scenes[0].emit("alive");
    expect(delegatesPing()).toBe(true);
  });
});

describe("WpeWallpaperContent 取目标", () => {
  it("不给 target 时按 imageId 取", async () => {
    rpc.invoke.mockResolvedValue(scene("s"));
    mountContent({ imageId: "s" });
    await settle();
    expect(rpc.invoke).toHaveBeenCalledWith("get_wallpaper_target_for_image", { imageId: "s" });
    expect(stub.scenes.map((s) => s.id)).toEqual(["s"]);
  });

  it("取不到（行已删、IPC 失败）报致命 error", async () => {
    rpc.invoke.mockResolvedValueOnce(null);
    const missing = mountContent({ imageId: "gone" });
    await settle();
    expect(missing.emitted("error")).toHaveLength(1);

    rpc.invoke.mockRejectedValueOnce(new Error("ipc"));
    const broken = mountContent({ imageId: "x" });
    await settle();
    expect(broken.emitted("error")?.[0]?.[0]).toContain("ipc");
    expect(stub.scenes).toHaveLength(0);
  });
});
