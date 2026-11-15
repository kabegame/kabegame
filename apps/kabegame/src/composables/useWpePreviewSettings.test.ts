// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWpePreviewSettings } from "./useWpePreviewSettings";
import { WPE_SETTING_DEFAULTS } from "@/utils/wpeSettings";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
/** 后端替身：每张图存了的预览设置与 metadataId */
const backend = vi.hoisted(() => ({
  stored: new Map<string, Record<string, unknown>>(),
  metadataId: 1,
  calls: [] as { command: string; args: Record<string, unknown> }[],
}));
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    backend.calls.push({ command, args });
    const id = String(args.imageId);
    if (command === "set_wpe_preview_settings") {
      const next = { ...(backend.stored.get(id) ?? {}) };
      for (const [key, value] of Object.entries(args.changes as Record<string, unknown>)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      backend.stored.set(id, next);
      backend.metadataId++;
    }
    return { imageId: id, metadataId: backend.metadataId, settings: backend.stored.get(id) ?? {} };
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const cleanups: (() => void)[] = [];
beforeEach(() => {
  backend.stored.clear();
  backend.calls.length = 0;
  vi.useFakeTimers();
});
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

function fixture(id: Ref<string | null>) {
  let model!: ReturnType<typeof useWpePreviewSettings>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useWpePreviewSettings(id);
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return model;
}

const commands = (name: string) => backend.calls.filter((call) => call.command === name);

describe("useWpePreviewSettings", () => {
  it("没设的项取默认值；存了的叠上去", async () => {
    backend.stored.set("1", { volume: 0.4, shadows: "high" });
    const model = fixture(ref("1"));
    expect(model.values.value).toEqual(WPE_SETTING_DEFAULTS);
    await flushPromises();
    expect(model.values.value).toEqual({ ...WPE_SETTING_DEFAULTS, volume: 0.4, shadows: "high" });
    expect(model.modified.value).toEqual({ volume: true, shadows: true });
  });

  it("同一张的使用方共用一份：一处改了另一处当场看到，300 ms 后合并写一次", async () => {
    const id = ref<string | null>("1");
    const panel = fixture(id);
    const content = fixture(id);
    await flushPromises();
    expect(commands("get_wpe_preview_settings")).toHaveLength(1);
    panel.set("volume", 0.2);
    panel.set("reflection", "disabled");
    expect(content.values.value.volume).toBe(0.2);
    expect(commands("set_wpe_preview_settings")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(commands("set_wpe_preview_settings")).toEqual([
      { command: "set_wpe_preview_settings", args: { imageId: "1", changes: { volume: 0.2, reflection: "disabled" } } },
    ]);
    expect(content.values.value).toMatchObject({ volume: 0.2, reflection: "disabled" });
    // 恢复默认：写 null
    content.reset("volume");
    await vi.advanceTimersByTimeAsync(300);
    expect(commands("set_wpe_preview_settings").at(-1)?.args.changes).toEqual({ volume: null });
    expect(panel.values.value.volume).toBe(1);
  });

  it("别处改写（metadataId 补丁）时重读，同一 metadataId 不重读", async () => {
    const model = fixture(ref("1"));
    await flushPromises();
    const reads = () => commands("get_wpe_preview_settings").length;
    listeners.get("image-changed")?.({ payload: { patch: { id: "1", metadataId: backend.metadataId } } });
    await flushPromises();
    expect(reads()).toBe(1);
    backend.stored.set("1", { playbackRate: 2 });
    listeners.get("image-changed")?.({ payload: { patch: { id: "1", metadataId: backend.metadataId + 5 } } });
    await flushPromises();
    expect(reads()).toBe(2);
    expect(model.values.value.playbackRate).toBe(2);
    listeners.get("images-change")?.({ payload: { patches: [{ id: "2", metadataId: 99 }] } });
    await flushPromises();
    expect(reads()).toBe(2);
  });

  it("换图前没写的草稿照写到原来那张", async () => {
    const id = ref<string | null>("1");
    const model = fixture(id);
    await flushPromises();
    model.set("mediaIntegration", false);
    id.value = "2";
    await flushPromises();
    await vi.advanceTimersByTimeAsync(300);
    expect(commands("set_wpe_preview_settings")).toEqual([
      { command: "set_wpe_preview_settings", args: { imageId: "1", changes: { mediaIntegration: false } } },
    ]);
    expect(model.values.value).toEqual(WPE_SETTING_DEFAULTS);
  });
});
