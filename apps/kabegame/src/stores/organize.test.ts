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
