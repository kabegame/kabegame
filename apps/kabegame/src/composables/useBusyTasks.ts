import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";
import { useOrganizeStore } from "@/stores/organize";
import { useHiddenCleanupStore } from "@/stores/hiddenCleanup";
import { useFolderSyncStore } from "@/stores/folderSync";
import { useUpdaterStore } from "@/stores/updater";
import * as organizeService from "@/services/organize";
import * as hiddenCleanupService from "@/services/hiddenCleanup";
import * as updaterService from "@/services/updater";

const SHOW_DELAY_MS = 1_800;
const CLOCK_INTERVAL_MS = 500;

export type BusyCard =
  | { kind: "organize" }
  | { kind: "hiddenCleanup" }
  | { kind: "folderSync"; albumId: string }
  | { kind: "updater" };

const now = ref(Date.now());
const hasUnseenFailure = ref(false);
let clock: ReturnType<typeof setInterval> | null = null;
let aggregationInitialized = false;

function isDelayElapsed(startedAtMs: number | null | undefined): boolean {
  return typeof startedAtMs === "number" && now.value - startedAtMs >= SHOW_DELAY_MS;
}

function startClock() {
  now.value = Date.now();
  if (clock) return;
  clock = setInterval(() => {
    now.value = Date.now();
  }, CLOCK_INTERVAL_MS);
}

function stopClock() {
  if (!clock) return;
  clearInterval(clock);
  clock = null;
}

export interface BusyTasksAggregation {
  cards: ComputedRef<BusyCard[]>;
  count: ComputedRef<number>;
  summaryPercent: ComputedRef<number | null>;
  hasUnseenFailure: Ref<boolean>;
  markFailuresSeen: () => void;
  cancelAll: () => Promise<void>;
}

/** 只读聚合三个专用 store；任务详情仍由各自卡片直接读取对应 store。 */
export function useBusyTasks(): BusyTasksAggregation {
  const organizeStore = useOrganizeStore();
  const hiddenCleanupStore = useHiddenCleanupStore();
  const folderSyncStore = useFolderSyncStore();
  const updaterStore = useUpdaterStore();

  const anyRunning = computed(
    () =>
      organizeStore.running ||
      hiddenCleanupStore.running ||
      folderSyncStore.runningCount > 0 ||
      updaterStore.isDownloading,
  );

  if (!aggregationInitialized) {
    aggregationInitialized = true;
    watch(
      anyRunning,
      (running) => {
        if (running) startClock();
        else stopClock();
      },
      { immediate: true },
    );
    watch(
      [
        () => organizeStore.lastError,
        () => hiddenCleanupStore.lastError,
        () => folderSyncStore.lastError,
        () => updaterStore.lastDownloadError,
      ],
      ([organizeError, hiddenCleanupError, folderError, updaterError], previous) => {
        const errors = [organizeError, hiddenCleanupError, folderError, updaterError];
        if (errors.some((error, index) => !!error && error !== previous?.[index])) {
          hasUnseenFailure.value = true;
        }
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      stopClock();
      aggregationInitialized = false;
    });
  }

  const organizeVisible = computed(
    () => organizeStore.running && isDelayElapsed(organizeStore.startedAtMs),
  );
  const hiddenCleanupVisible = computed(
    () => hiddenCleanupStore.running && isDelayElapsed(hiddenCleanupStore.startedAtMs),
  );
  const updaterVisible = computed(
    () => updaterStore.isDownloading && isDelayElapsed(updaterStore.downloadStartedAtMs),
  );

  const cards = computed<BusyCard[]>(() => {
    const result: BusyCard[] = [];
    if (organizeVisible.value) result.push({ kind: "organize" });
    if (hiddenCleanupVisible.value) result.push({ kind: "hiddenCleanup" });
    [...folderSyncStore.tasks.values()]
      .filter((task) => isDelayElapsed(task.startedAtMs))
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.albumId.localeCompare(b.albumId))
      .forEach((task) => result.push({ kind: "folderSync", albumId: task.albumId }));
    if (updaterVisible.value) result.push({ kind: "updater" });
    return result;
  });

  const count = computed(() => cards.value.length);
  const summaryPercent = computed<number | null>(() => {
    const percentages: number[] = [];
    if (organizeVisible.value) percentages.push(organizeStore.progressPercentage);
    if (hiddenCleanupVisible.value) percentages.push(hiddenCleanupStore.progressPercentage);
    if (updaterVisible.value) percentages.push(updaterStore.downloadPercent);
    if (percentages.length === 0) return null;
    return Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length);
  });

  function markFailuresSeen() {
    hasUnseenFailure.value = false;
    organizeStore.clearError();
    hiddenCleanupStore.clearError();
    folderSyncStore.clearError();
    updaterStore.setDownloadError("");
  }

  async function cancelAll() {
    await Promise.allSettled([
      organizeStore.running ? organizeService.cancel() : Promise.resolve(),
      hiddenCleanupStore.running ? hiddenCleanupService.cancel() : Promise.resolve(),
      updaterStore.isDownloading ? updaterService.cancelDownload() : Promise.resolve(),
    ]);
  }

  return {
    cards,
    count,
    summaryPercent,
    hasUnseenFailure,
    markFailuresSeen,
    cancelAll,
  };
}
