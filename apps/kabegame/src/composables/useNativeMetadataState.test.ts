import { effectScope, nextTick, ref } from "vue";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMetadataPayload } from "../types/nativeMetadata";

const invoke = vi.hoisted(() =>
  vi.fn<(command: string, args: { imageId: string }) => Promise<NativeMetadataPayload>>(),
);

vi.mock("../api", () => ({ invoke }));
vi.mock("../env", () => ({ IS_WEB: false }));
vi.mock("../cache/nativeMetadataCache", () => ({ nativeMetadataCacheDb: {} }));

const { useNativeMetadataState } = await import("./useNativeMetadataState");

function payload(value: string): NativeMetadataPayload {
  return {
    format: "png",
    groups: [{ id: "text", entries: [{ tag: "prompt", value }] }],
  } as unknown as NativeMetadataPayload;
}

const scopes: ReturnType<typeof effectScope>[] = [];

function mount(imageId: string, imageMetadataId?: number) {
  const id = ref<string | undefined>(imageId);
  const metadataId = ref<number | undefined>(imageMetadataId);
  const scope = effectScope();
  scopes.push(scope);
  const state = scope.run(() => useNativeMetadataState(id, metadataId))!;
  return { id, metadataId, state };
}

beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
});

describe("useNativeMetadataState", () => {
  it("懒解析挂上 imageMetadataId 后重新取数，但不清空已显示的内容", async () => {
    invoke.mockResolvedValueOnce(payload("1girl"));
    const { metadataId, state } = mount("img-a");
    await flushPromises();
    expect(state.state.value).toBe("loaded");
    expect(invoke).toHaveBeenCalledTimes(1);

    // 后端 image-changed 补丁：同一张图，imageMetadataId 从空变成新行。
    let resolveSecond!: (value: NativeMetadataPayload) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    metadataId.value = 42;
    await nextTick();
    // 缓存 key 带 imageMetadataId：必须重新取数；取数期间仍显示旧内容。
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(state.state.value).toBe("loaded");
    expect(state.displayGroups.value).toHaveLength(1);

    resolveSecond(payload("1girl, cute"));
    await flushPromises();
    expect(state.payload.value?.groups[0]?.entries[0]?.value).toBe("1girl, cute");
  });

  it("重新取数失败不推翻已显示的内容", async () => {
    invoke.mockResolvedValueOnce(payload("x"));
    const { metadataId, state } = mount("img-b");
    await flushPromises();
    invoke.mockRejectedValueOnce(new Error("boom"));
    metadataId.value = 7;
    await flushPromises();
    expect(state.state.value).toBe("loaded");
    expect(state.errorDetail.value).toBe("");
  });

  it("换了图片照常清空并进入加载态", async () => {
    invoke.mockResolvedValueOnce(payload("x"));
    const { id, state } = mount("img-c", 1);
    await flushPromises();
    invoke.mockImplementationOnce(() => new Promise(() => {}));
    id.value = "img-d";
    await nextTick();
    expect(state.state.value).toBe("loading");
    expect(state.payload.value).toBeNull();
  });
});
