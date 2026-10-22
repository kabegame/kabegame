import { listen } from "@/api";
import { pathqlCount, pathqlFetch, pathqlList } from "@/services/pathql";
import type { CrawlTask } from "@/stores/crawler";
import { encodeSeg } from "@kabegame/pathql-client";

export const TASK_PAGE_SIZE = 20;

export type TaskEvent =
  | { type: "TaskAdded"; task: unknown }
  | { type: "TaskDeleted"; taskId: string }
  | { type: "TaskChanged"; taskId: string; diff: Partial<CrawlTask> };

function numberOpt(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function nullableNumberField(row: Record<string, unknown>, camel: string, snake: string): number | null | undefined {
  const key = Object.prototype.hasOwnProperty.call(row, camel) ? camel : snake;
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const value = row[key];
  if (value == null) return null;
  return numberOpt(value);
}

function jsonObject<T>(value: unknown): T | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" ? (value as T) : undefined;
}

export function normalizeTaskRow(raw: unknown): CrawlTask | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? row.taskId ?? row.task_id ?? "").trim();
  const pluginId = String(row.pluginId ?? row.plugin_id ?? "").trim();
  if (!id || !pluginId) return null;
  const runConfigNameRaw = row.runConfigName ?? row.run_config_name;
  return {
    id,
    pluginId,
    outputDir: (row.outputDir ?? row.output_dir) as string | undefined,
    userConfig: jsonObject<Record<string, any>>(row.userConfig ?? row.user_config),
    httpHeaders: jsonObject<Record<string, string>>(row.httpHeaders ?? row.http_headers),
    maxConcurrentDownloads: nullableNumberField(row, "maxConcurrentDownloads", "max_concurrent_downloads"),
    isDryRun: Boolean(row.isDryRun ?? row.is_dry_run ?? false),
    outputAlbumId: (row.outputAlbumId ?? row.output_album_id) as string | undefined,
    runConfigId: (row.runConfigId ?? row.run_config_id) as string | undefined,
    runConfigName: runConfigNameRaw == null ? null : String(runConfigNameRaw),
    triggerSource: (row.triggerSource ?? row.trigger_source ?? "manual") as CrawlTask["triggerSource"],
    status: (row.status ?? "pending") as CrawlTask["status"],
    progress: Number(row.progress ?? 0),
    deletedCount: Number(row.deletedCount ?? row.deleted_count ?? 0),
    dedupCount: Number(row.dedupCount ?? row.dedup_count ?? 0),
    successCount: Number(row.successCount ?? row.success_count ?? 0),
    failedCount: Number(row.failedCount ?? row.failed_count ?? 0),
    startTime: numberOpt(row.startTime ?? row.start_time),
    endTime: numberOpt(row.endTime ?? row.end_time),
    error: row.error == null ? undefined : String(row.error),
  };
}

export function normalizeDiffKeys(diff: Record<string, unknown>): Partial<CrawlTask> {
  const out: Partial<CrawlTask> = {};
  if (typeof diff.status === "string") out.status = diff.status as CrawlTask["status"];
  const progress = numberOpt(diff.progress);
  if (progress != null) out.progress = progress;
  const startTime = numberOpt(diff.startTime ?? diff.start_time);
  if (startTime != null) out.startTime = startTime;
  const endTime = numberOpt(diff.endTime ?? diff.end_time);
  if (endTime != null) out.endTime = endTime;
  if (diff.error != null) out.error = String(diff.error);
  for (const [camel, snake] of [
    ["successCount", "success_count"],
    ["deletedCount", "deleted_count"],
    ["failedCount", "failed_count"],
    ["dedupCount", "dedup_count"],
  ] as const) {
    const value = numberOpt(diff[camel] ?? diff[snake]);
    if (value != null) (out as Record<string, unknown>)[camel] = value;
  }
  if (
    Object.prototype.hasOwnProperty.call(diff, "maxConcurrentDownloads") ||
    Object.prototype.hasOwnProperty.call(diff, "max_concurrent_downloads")
  ) {
    const value = diff.maxConcurrentDownloads ?? diff.max_concurrent_downloads;
    out.maxConcurrentDownloads = value == null ? null : Number(value);
  }
  return out;
}

export function taskSearchPath(query: string, pluginIds: string[]): string {
  const q = query.trim();
  if (!q) return "";
  const branches = [...[...new Set(pluginIds)].map((id) => `plugin/${encodeSeg(id)}`), `plugin_search/${encodeSeg(q)}`];
  return `~any/${branches.join("/~or/")}/~end/`;
}

export function taskCursorSeg(last: CrawlTask): string {
  return `before_${last.startTime ?? 0}_${encodeSeg(last.id)}/`;
}

export async function fetchTaskPage(base: string, after?: CrawlTask): Promise<CrawlTask[]> {
  const cursor = after ? taskCursorSeg(after) : "";
  const rows = await pathqlFetch<Record<string, unknown>>(`tasks://${base}${cursor}x${TASK_PAGE_SIZE}x/1`);
  return rows.map(normalizeTaskRow).filter((task): task is CrawlTask => task != null);
}

export async function fetchTaskTotal(base: string): Promise<number> {
  return (await pathqlCount(`tasks://${base.replace(/\/$/, "")}`)).total;
}

export async function fetchTask(id: string): Promise<CrawlTask | null> {
  const rows = await pathqlFetch<Record<string, unknown>>(`tasks://id_${encodeSeg(id)}`);
  return normalizeTaskRow(rows[0]);
}

export async function fetchTaskStatusCounts(): Promise<Record<string, number>> {
  const entries = await pathqlList("tasks://status");
  return Object.fromEntries(
    entries.map((entry) => [entry.name, Number((entry.meta as Record<string, unknown> | null)?.count ?? 0)]),
  );
}

const taskSubscribers = new Set<(event: TaskEvent) => void>();
let taskUnlisten: (() => void) | null = null;
let taskListenPending: Promise<void> | null = null;

export function normalizeTaskEvent(payload: unknown): TaskEvent | null {
  if (payload == null || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const type = String(row.type ?? "");
  if (type === "TaskAdded") return { type, task: row.task };
  const taskId = String(row.taskId ?? row.task_id ?? "").trim();
  if (!taskId) return null;
  if (type === "TaskDeleted") return { type, taskId };
  if (type === "TaskChanged") {
    const diff = row.diff != null && typeof row.diff === "object" ? (row.diff as Record<string, unknown>) : {};
    return { type, taskId, diff: normalizeDiffKeys(diff) };
  }
  return null;
}

function ensureTaskListener() {
  if (taskUnlisten || taskListenPending) return;
  taskListenPending = listen("tasks-change", (event) => {
    const normalized = normalizeTaskEvent(event.payload);
    if (!normalized) return;
    for (const subscriber of [...taskSubscribers]) subscriber(normalized);
  })
    .then((unlisten) => {
      taskListenPending = null;
      if (taskSubscribers.size === 0) unlisten();
      else taskUnlisten = unlisten;
    })
    .catch((error) => {
      taskListenPending = null;
      console.error("监听任务事件失败:", error);
    });
}

export function subscribeTaskEvents(handler: (event: TaskEvent) => void): () => void {
  taskSubscribers.add(handler);
  ensureTaskListener();
  return () => {
    taskSubscribers.delete(handler);
    if (taskSubscribers.size === 0 && taskUnlisten) {
      taskUnlisten();
      taskUnlisten = null;
    }
  };
}
