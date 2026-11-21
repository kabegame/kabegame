import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { WPE_STATE_MESSAGE, type WpeWebState } from "@/components/wallpaper/wpeWebState";
import { useWpeStateDelivery } from "./useWpeStateDelivery";

/** `wpe_web_get_state` 的每次调用：测试按需 resolve，模拟乱序返回 */
const calls = vi.hoisted(() => ({
  list: [] as { imageId: string; resolve: (state: unknown) => void; reject: (error: unknown) => void }[],
}));
vi.mock("@/api", () => ({
  invoke: (command: string, args: { imageId: string }) => {
    if (command !== "wpe_web_get_state") throw new Error(`unexpected ${command}`);
    return new Promise((resolve, reject) => calls.list.push({ imageId: args.imageId, resolve, reject }));
  },
}));
const events = vi.hoisted(() => ({ subjects: new Map<string, unknown>() }));
vi.mock("@/services/kbEvents/eventSource", async () => {
  const { Subject } = await import("rxjs");
  return {
    kbEvent$: (name: string) => {
      if (!events.subjects.has(name)) events.subjects.set(name, new Subject());
      return events.subjects.get(name);
    },
  };
});
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));

function emit(name: string, payload: unknown) {
  (events.subjects.get(name) as Subject<{ name: string; seq: number; payload: unknown }>).next({
    name,
    seq: 1,
    payload,
  });
}

const state = (imageId: string, speed: number, language = "zh-chs"): WpeWebState => ({
  imageId,
  user: { speed: { type: "slider", value: speed } },
  general: { language, fps: 30 },
  directories: {},
});

async function settle() {
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await nextTick();
}

function setup(initialId = "1") {
  const imageId = ref<string | null>(initialId);
  const posted: unknown[] = [];
  const target = { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) };
  const scope = effectScope();
  const delivery = scope.run(() =>
    useWpeStateDelivery({ imageId: () => imageId.value, target: () => target as unknown as Window }),
  )!;
  return { imageId, posted, delivery, scope };
}

afterEach(() => {
  calls.list.splice(0);
  events.subjects.clear();
});

describe("useWpeStateDelivery", () => {
  it("就绪之前只取不推；第一次 frameLoaded 推整份（状态晚到就到了再推）", async () => {
    const { posted, delivery } = setup();
    expect(calls.list.map((call) => call.imageId)).toEqual(["1"]);
    delivery.frameLoaded();
    expect(posted).toEqual([]);
    calls.list[0].resolve(state("1", 1));
    await settle();
    expect(posted).toEqual([{ type: WPE_STATE_MESSAGE, full: true, state: state("1", 1) }]);
  });

  it("状态先到：frameLoaded 时推整份；之后本张的 metadataId 补丁重取、推增量", async () => {
    const { posted, delivery } = setup();
    calls.list[0].resolve(state("1", 1));
    await settle();
    expect(posted).toEqual([]);
    delivery.frameLoaded();
    expect(posted).toHaveLength(1);
    emit("image-changed", { patch: { id: "1", metadataId: 9 } });
    expect(calls.list).toHaveLength(2);
    calls.list[1].resolve(state("1", 2));
    await settle();
    expect(posted[1]).toEqual({
      type: WPE_STATE_MESSAGE,
      full: false,
      user: { speed: { type: "slider", value: 2 } },
      general: null,
      directories: {},
      directoryChanges: {},
    });
  });

  it("推过增量后基线跟着前进：再取到同样的状态不再推，只推相对上一次的变化", async () => {
    const { posted, delivery } = setup();
    calls.list[0].resolve(state("1", 1));
    await settle();
    delivery.frameLoaded();
    emit("image-changed", { patch: { id: "1", metadataId: 2 } });
    calls.list[1].resolve(state("1", 2));
    await settle();
    emit("image-changed", { patch: { id: "1", metadataId: 3 } });
    calls.list[2].resolve(state("1", 2));
    await settle();
    expect(posted).toHaveLength(2);
    emit("image-changed", { patch: { id: "1", metadataId: 4 } });
    calls.list[3].resolve(state("1", 3, "en-us"));
    await settle();
    expect(posted[2]).toMatchObject({
      full: false,
      user: { speed: { type: "slider", value: 3 } },
      general: { language: "en-us" },
    });
  });

  it("重取触发：别的图片的补丁、不带 metadataId 的补丁、无关设置都不重取；language 与 wpeFps 重取", () => {
    setup();
    emit("image-changed", { patch: { id: "2", metadataId: 9 } });
    emit("image-changed", { patch: { id: "1", favorite: true } });
    emit("images-change", { patches: [{ id: "3", metadataId: 1 }] });
    emit("setting-change", { changes: { wallpaperVolume: 0.5 } });
    expect(calls.list).toHaveLength(1);
    emit("images-change", {
      patches: [
        { id: "3", metadataId: 1 },
        { id: "1", metadataId: 2 },
      ],
    });
    emit("setting-change", { changes: { language: "en" } });
    emit("setting-change", { changes: { wpeFps: 60 } });
    expect(calls.list).toHaveLength(4);
  });

  it("页面自己导航出来的 load：不重推，只发就绪；基线保留，之后照推增量", async () => {
    const { posted, delivery } = setup();
    calls.list[0].resolve(state("1", 1));
    await settle();
    delivery.frameLoaded();
    delivery.frameLoaded();
    expect(posted[1]).toEqual({
      type: WPE_STATE_MESSAGE,
      full: false,
      user: null,
      general: null,
      directories: {},
      directoryChanges: {},
    });
    emit("setting-change", { changes: { language: "en" } });
    calls.list[1].resolve(state("1", 1, "en-us"));
    await settle();
    expect(posted[2]).toMatchObject({ full: false, user: null, general: { language: "en-us", fps: 30 } });
  });

  it("没有变化不推；reset（iframe 重建）后下一次 frameLoaded 重新推整份", async () => {
    const { posted, delivery } = setup();
    calls.list[0].resolve(state("1", 1));
    await settle();
    delivery.frameLoaded();
    emit("image-changed", { patch: { id: "1", metadataId: 3 } });
    calls.list[1].resolve(state("1", 1));
    await settle();
    expect(posted).toHaveLength(1);
    delivery.reset();
    delivery.frameLoaded();
    expect(posted[1]).toMatchObject({ full: true });
  });

  it("乱序：后发先回的落地后，更早发出、更晚返回的丢弃", async () => {
    const { posted, delivery } = setup();
    delivery.frameLoaded();
    emit("setting-change", { changes: { language: "en" } });
    calls.list[1].resolve(state("1", 2));
    await settle();
    calls.list[0].resolve(state("1", 1));
    await settle();
    expect(posted).toEqual([{ type: WPE_STATE_MESSAGE, full: true, state: state("1", 2) }]);
  });

  it("换图片：重取，旧图片的结果不落地；取不到（null）、失败都不推", async () => {
    const { imageId, posted, delivery } = setup();
    delivery.frameLoaded();
    imageId.value = "2";
    await nextTick();
    expect(calls.list.map((call) => call.imageId)).toEqual(["1", "2"]);
    calls.list[0].resolve(state("1", 1));
    calls.list[1].resolve(null);
    await settle();
    expect(posted).toEqual([]);
    emit("image-changed", { patch: { id: "2", metadataId: 1 } });
    calls.list[2].reject(new Error("ipc"));
    await settle();
    expect(posted).toEqual([]);
  });

  it("作用域销毁后不再订阅", () => {
    const { scope } = setup();
    scope.stop();
    emit("setting-change", { changes: { language: "en" } });
    expect(calls.list).toHaveLength(1);
  });
});
