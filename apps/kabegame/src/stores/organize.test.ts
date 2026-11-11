import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOrganizeStore, type OrganizeOptions, type OrganizeRunState } from "./organize";

const options: OrganizeOptions = {
  dedupe: false,
  dedupeKeepNew: false,
  removeMissing: true,
  removeUnrecognized: false,
  regenThumbnails: false,
  regenCompatible: false,
  backfillNativeMetadata: false,
  recomputePalette: false,
  deleteSourceFiles: false,
  rangeStart: null,
  rangeEnd: null,
};

const stoppedSnapshot = (): OrganizeRunState => ({
  ...options,
  running: false,
  processedGlobal: 0,
  libraryTotal: 0,
  rangeStart: null,
  rangeEnd: null,
  removed: 0,
  regenerated: 0,
  backfilled: 0,
  palettesUpdated: 0,
});

describe("organize store 快照收尾", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("running=false 快照立即收尾，迟到 finished 保持幂等", () => {
    const store = useOrganizeStore();
    store.begin(options);
    store.endStarting();
    store.applyRunState(stoppedSnapshot());
    expect(store.running).toBe(false);
    expect(store.startedAtMs).toBeNull();
    expect(store.lastRunOptions).toBeNull();

    store.applyFinished({ removed: 9, regenerated: 8, backfilled: 7, canceled: false, error: "late" });
    expect(store.progress.removed).toBe(0);
    expect(store.lastError).toBe("late");
  });

  it("starting 期间忽略旧的 running=false 快照", () => {
    const store = useOrganizeStore();
    store.begin(options);
    store.applyRunState(stoppedSnapshot());
    expect(store.starting).toBe(true);
    expect(store.running).toBe(true);
    expect(store.lastRunOptions).toEqual(options);
  });
});

describe("organize store 重新计算代表色", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("运行态快照带回开关与代表色计数", () => {
    const store = useOrganizeStore();
    store.applyRunState({
      ...stoppedSnapshot(),
      running: true,
      recomputePalette: true,
      processedGlobal: 30,
      libraryTotal: 100,
      palettesUpdated: 12,
    });
    expect(store.lastRunOptions?.recomputePalette).toBe(true);
    expect(store.progress.palettesUpdated).toBe(12);
  });

  it("旧版本后端的快照没有这两项时按关闭与 0 处理", () => {
    const store = useOrganizeStore();
    const legacy = { ...stoppedSnapshot(), running: true } as Partial<OrganizeRunState>;
    delete legacy.recomputePalette;
    delete legacy.palettesUpdated;
    store.applyRunState(legacy as OrganizeRunState);
    expect(store.lastRunOptions?.recomputePalette).toBe(false);
    expect(store.progress.palettesUpdated).toBe(0);
  });

  it("完成事件更新代表色计数；事件里没有这一项时保留进度里的值", () => {
    const store = useOrganizeStore();
    store.begin({ ...options, recomputePalette: true });
    store.endStarting();
    store.applyRunState({ ...stoppedSnapshot(), running: true, recomputePalette: true, palettesUpdated: 3 });
    store.applyFinished({ removed: 0, regenerated: 0, backfilled: 0, canceled: false, error: null });
    expect(store.progress.palettesUpdated).toBe(3);

    store.begin({ ...options, recomputePalette: true });
    store.endStarting();
    store.applyFinished({
      removed: 1,
      regenerated: 2,
      backfilled: 0,
      palettesUpdated: 9,
      canceled: false,
      error: null,
    });
    expect(store.progress.palettesUpdated).toBe(9);
    expect(store.running).toBe(false);
  });
});
