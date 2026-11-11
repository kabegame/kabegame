import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOrganizeStore, type OrganizeFinished, type OrganizeOptions } from "@/stores/organize";

const { invoke, listen, success } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/api/rpc", () => ({ invoke, listen }));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: { success, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/services/busyTasks", () => ({ busyPoller: { invalidate: vi.fn() } }));
vi.mock("@kabegame/i18n", () => ({
  i18n: {
    global: { t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}` },
  },
}));

import { dispose, init, organizeDoneMessage, start } from "./organize";

const options: OrganizeOptions = {
  dedupe: false,
  dedupeKeepNew: true,
  removeMissing: false,
  removeUnrecognized: false,
  regenThumbnails: false,
  regenCompatible: false,
  backfillNativeMetadata: false,
  recomputePalette: true,
  deleteSourceFiles: false,
  rangeStart: 1000,
  rangeEnd: 2000,
};

const finished = (extra: Partial<OrganizeFinished> = {}): OrganizeFinished => ({
  removed: 1,
  regenerated: 2,
  backfilled: 0,
  canceled: false,
  error: null,
  ...extra,
});

beforeEach(() => {
  setActivePinia(createPinia());
  invoke.mockReset();
  listen.mockReset();
  success.mockReset();
});

describe("整理服务：重新计算代表色", () => {
  it("start 把开关原样传给 start_organize", async () => {
    invoke.mockResolvedValue(null);
    await start(options);
    expect(invoke).toHaveBeenCalledWith("start_organize", {
      args: expect.objectContaining({ recomputePalette: true, rangeStart: 1000, rangeEnd: 2000 }),
    });

    useOrganizeStore().applyFinished(finished());
    await start({ ...options, recomputePalette: false });
    expect(invoke).toHaveBeenLastCalledWith("start_organize", {
      args: expect.objectContaining({ recomputePalette: false }),
    });
  });

  it("完成提示：勾了开关或确实更新了代表色才带代表色计数", () => {
    expect(organizeDoneMessage(finished({ palettesUpdated: 5 }), true)).toEqual({
      key: "gallery.organizeDoneWithPalette",
      params: { removed: 1, regenerated: 2, palettes: 5 },
    });
    // 勾了但一张都没变：照样显示 0
    expect(organizeDoneMessage(finished(), true)).toEqual({
      key: "gallery.organizeDoneWithPalette",
      params: { removed: 1, regenerated: 2, palettes: 0 },
    });
    // 快照先把本次参数清掉了，但事件里有计数
    expect(organizeDoneMessage(finished({ palettesUpdated: 3 }), false).key).toBe("gallery.organizeDoneWithPalette");
    expect(organizeDoneMessage(finished({ palettesUpdated: 0 }), false)).toEqual({
      key: "gallery.organizeDone",
      params: { removed: 1, regenerated: 2 },
    });
  });

  it("完成事件按本次参数选提示文案", async () => {
    let handler: ((event: { payload: OrganizeFinished }) => void) | undefined;
    listen.mockImplementation(async (_name: string, cb: typeof handler) => {
      handler = cb;
      return () => {};
    });
    await init();
    const store = useOrganizeStore();
    store.begin(options);
    store.endStarting();

    handler!({ payload: finished({ palettesUpdated: 4 }) });
    expect(success).toHaveBeenCalledWith(
      `gallery.organizeDoneWithPalette:${JSON.stringify({ removed: 1, regenerated: 2, palettes: 4 })}`,
    );
    expect(store.progress.palettesUpdated).toBe(4);
    dispose();
  });
});
