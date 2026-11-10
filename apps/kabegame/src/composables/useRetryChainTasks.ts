import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { normalizeTaskEvent, normalizeTaskRow, retryChainPath } from "@/services/tasks";
import { on, pathqlRequest$, usePathqlLooker } from "@/services/kbEvents";
import { useTaskRowPatches } from "@/composables/useTaskRowPatches";
import type { CrawlTask } from "@/stores/crawler";

/** 重试链里的一格：有行给任务，任务已删除时只剩第几次。 */
export type RetryChainSlot = { attempt: number; task: CrawlTask } | { attempt: number; task: null };

/** 按第几次从新到旧铺满 `max..0`：缺的那几次是被删除的任务，给占位。链上最新几次被删时无从得知，不补。 */
export function retryChainSlots(tasks: readonly CrawlTask[]): RetryChainSlot[] {
  // 还没读到（或读不到）任何行：不凭空给占位，由调用方显示加载态
  if (tasks.length === 0) return [];
  const byAttempt = new Map<number, CrawlTask>();
  for (const task of tasks) {
    if (!byAttempt.has(task.retryAttempt)) byAttempt.set(task.retryAttempt, task);
  }
  const max = tasks.reduce((m, task) => Math.max(m, task.retryAttempt), 0);
  const slots: RetryChainSlot[] = [];
  for (let attempt = max; attempt >= 0; attempt--) {
    slots.push({ attempt, task: byAttempt.get(attempt) ?? null });
  }
  return slots;
}

/**
 * 一条重试链（原始任务 id 为 `rootId`）的全部任务：`rootId()` 非空时观察 `tasks://retry_root/<id>`，
 * 为空时停止观察并清空。新增事件属于本链或删除事件命中已持有行时刷新，其余字段就地补丁。
 */
export function useRetryChainTasks(rootId: () => string | null) {
  const items = shallowRef<CrawlTask[]>([]);
  const active = ref(false);
  const { reset: resetPatches } = useTaskRowPatches(items, active);

  const key = () => {
    const root = rootId();
    return root ? retryChainPath(root) : null;
  };

  const looker = usePathqlLooker({
    kind: "rows",
    key,
    refreshOn: [
      on("tasks-change", (payload) => {
        const event = normalizeTaskEvent(payload);
        if (event?.type === "TaskAdded") {
          const root = rootId();
          return !!root && normalizeTaskRow(event.task)?.retryRootId === root;
        }
        if (event?.type === "TaskDeleted") return items.value.some((task) => task.id === event.taskId);
        return false;
      }),
    ],
    onResult: ({ rows }) => {
      items.value = rows.map(normalizeTaskRow).filter((task): task is CrawlTask => task !== null);
    },
  });

  // 观察方订阅时会先同步拿到该 key 最后可得的数据，这里不能在之后再清空；只在停止观察时清空。
  watch(
    key,
    (next) => {
      resetPatches();
      active.value = next !== null;
      if (!next) {
        items.value = [];
        return;
      }
      pathqlRequest$.next(["rows", next]);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    active.value = false;
    items.value = [];
  });

  const slots = computed(() => retryChainSlots(items.value));
  return { items, slots, loading: looker.loading };
}
