import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { fetchAppLogs, watchAppLogs, type LogRecord } from "@/services/appLogs";

/** 前端保留的日志条数上限（后端环形缓冲 2000 条，查看器打开期间会继续累积）。 */
const MAX_RECORDS = 5000;

/**
 * 「查看日志」弹窗的状态与日志订阅。
 * 打开时先订阅实时日志、再拉历史，按 seq 去重合并；关闭即退订，已收到的记录保留，
 * 再次打开只补拉上次之后的历史。
 */
export const useAppLogsStore = defineStore("appLogs", () => {
  const visible = ref(false);
  const records = shallowRef<LogRecord[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const seen = new Set<number>();
  /** 收到过的最大 seq：补拉历史与「清空」后不回填都以它为界 */
  let cursor = 0;
  let unwatch: (() => void) | null = null;
  /** 开关代数：异步订阅返回时若已关闭（或重开），丢弃这次结果 */
  let generation = 0;

  function append(incoming: LogRecord[]) {
    const fresh = incoming.filter((r) => r.seq > 0 && !seen.has(r.seq));
    if (fresh.length === 0) return;
    const current = records.value;
    const lastSeq = current.length > 0 ? current[current.length - 1].seq : 0;
    let next = current.concat(fresh);
    // 多线程打日志时广播顺序可能与 seq 不一致，乱序才排序
    if (fresh.some((r, i) => r.seq < (i === 0 ? lastSeq : fresh[i - 1].seq))) {
      next.sort((a, b) => a.seq - b.seq);
    }
    for (const r of fresh) {
      seen.add(r.seq);
      if (r.seq > cursor) cursor = r.seq;
    }
    if (next.length > MAX_RECORDS) {
      for (const r of next.slice(0, next.length - MAX_RECORDS)) seen.delete(r.seq);
      next = next.slice(next.length - MAX_RECORDS);
    }
    records.value = next;
  }

  async function start() {
    if (unwatch) return;
    const gen = ++generation;
    loading.value = true;
    error.value = null;
    try {
      const stop = await watchAppLogs(append);
      if (gen !== generation) {
        stop();
        return;
      }
      unwatch = stop;
      append(await fetchAppLogs(cursor > 0 ? cursor : undefined));
    } catch (e) {
      if (gen === generation) error.value = String(e);
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  function stop() {
    generation++;
    loading.value = false;
    unwatch?.();
    unwatch = null;
  }

  function open() {
    visible.value = true;
  }

  function close() {
    visible.value = false;
  }

  /** 清空当前视图；cursor 不回退，之前的日志不会被补拉回来 */
  function clear() {
    seen.clear();
    records.value = [];
  }

  return { visible, records, loading, error, open, close, start, stop, clear };
});
