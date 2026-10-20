import { listen } from "@/api";
import { pathqlCount, pathqlFetch, pathqlList } from "@/services/pathql";
import type { CrawlTask, RunConfig, RunConfigLastResult, RunConfigLastTask, ScheduleSpec } from "@/stores/crawler";
import { encodeSeg } from "@kabegame/pathql-client";

export const RUN_CONFIG_PAGE_SIZE = 20;
export type RunConfigSort = "next" | "last" | "result" | "name" | "plugin" | "created";
export type RunConfigFacet = "state" | "last" | "plugin" | "mode";
export type RunConfigQuery = {
  search: string;
  state: "enabled" | "paused" | null;
  last: RunConfigLastResult | null;
  plugin: string | null;
  mode: ScheduleSpec["mode"] | "none" | null;
  sort: RunConfigSort;
  dir: "asc" | "desc";
};
export type RunConfigEvent = {
  reason: "configadd" | "configdelete" | "configchange";
  configId: string;
};

function numberOpt(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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

export function parseScheduleSpec(value: unknown): ScheduleSpec | undefined {
  const row = jsonObject<Record<string, unknown>>(value);
  if (!row) return undefined;
  if (row.mode === "interval") {
    const intervalSecs = numberOpt(row.intervalSecs);
    return intervalSecs != null && intervalSecs > 0 ? { mode: "interval", intervalSecs } : undefined;
  }
  if (row.mode === "hourly") {
    const minute = numberOpt(row.minute);
    return minute == null ? undefined : { mode: "hourly", minute: Math.min(59, Math.max(0, minute)) };
  }
  if (row.mode === "daily") {
    const hour = numberOpt(row.hour);
    const minute = numberOpt(row.minute);
    if (hour == null || minute == null) return undefined;
    return hour === -1 ? { mode: "hourly", minute } : { mode: "daily", hour, minute };
  }
  if (row.mode === "weekly") {
    const legacy = numberOpt(row.weekday);
    const weekdays = Array.isArray(row.weekdays)
      ? row.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : legacy == null
        ? []
        : [legacy];
    const hour = numberOpt(row.hour);
    const minute = numberOpt(row.minute);
    return weekdays.length && hour != null && minute != null
      ? { mode: "weekly", weekdays: [...new Set(weekdays)].sort((a, b) => a - b), hour, minute }
      : undefined;
  }
  return undefined;
}

export function lastResultOf(task?: RunConfigLastTask | null): RunConfigLastResult {
  if (!task) return "never";
  if (task.status === "failed") return "failed";
  if (["pending", "running", "waiting_downloads"].includes(task.status)) return "running";
  if (task.status === "canceled") return "canceled";
  return task.failedCount > 0 ? "partial" : "ok";
}

export function lastTaskFromCrawlTask(task: CrawlTask): RunConfigLastTask | undefined {
  if (!task.startTime) return undefined;
  return {
    id: task.id,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    successCount: task.successCount ?? 0,
    failedCount: task.failedCount ?? 0,
    error: task.error,
  };
}

export function normalizeRunConfigRow(raw: unknown): RunConfig | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const pluginId = String(row.pluginId ?? row.plugin_id ?? "").trim();
  if (!id || !pluginId) return null;
  const lastTaskId = String(row.lastTaskId ?? row.last_task_id ?? "").trim();
  const lastStartTime = numberOpt(row.lastTaskStartTime ?? row.last_task_start_time);
  const lastTask: RunConfigLastTask | undefined =
    lastTaskId && lastStartTime != null
      ? {
          id: lastTaskId,
          status: String(row.lastTaskStatus ?? row.last_task_status ?? "pending") as CrawlTask["status"],
          startTime: lastStartTime,
          endTime: numberOpt(row.lastTaskEndTime ?? row.last_task_end_time),
          successCount: Number(row.lastTaskSuccessCount ?? row.last_task_success_count ?? 0),
          failedCount: Number(row.lastTaskFailedCount ?? row.last_task_failed_count ?? 0),
          error:
            row.lastTaskError == null && row.last_task_error == null
              ? undefined
              : String(row.lastTaskError ?? row.last_task_error),
        }
      : undefined;
  return {
    id,
    name: String(row.name ?? ""),
    description: row.description == null || row.description === "" ? undefined : String(row.description),
    pluginId,
    url: String(row.url ?? ""),
    outputDir: (row.outputDir ?? row.output_dir) as string | undefined,
    outputAlbumId: (row.outputAlbumId ?? row.output_album_id) as string | undefined,
    userConfig: jsonObject<Record<string, any>>(row.userConfig ?? row.user_config),
    httpHeaders: jsonObject<Record<string, string>>(row.httpHeaders ?? row.http_headers),
    maxConcurrentDownloads:
      row.maxConcurrentDownloads == null && row.max_concurrent_downloads == null
        ? null
        : Number(row.maxConcurrentDownloads ?? row.max_concurrent_downloads),
    isDryRun: Boolean(row.isDryRun ?? row.is_dry_run ?? false),
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    scheduleEnabled: Boolean(row.scheduleEnabled ?? row.schedule_enabled),
    scheduleSpec: parseScheduleSpec(row.scheduleSpec ?? row.schedule_spec),
    schedulePlannedAt: numberOpt(row.schedulePlannedAt ?? row.schedule_planned_at),
    scheduleLastRunAt: numberOpt(row.scheduleLastRunAt ?? row.schedule_last_run_at),
    lastTask,
    lastResult: (row.lastResult ?? row.last_result ?? lastResultOf(lastTask)) as RunConfigLastResult,
  };
}

export function runConfigFilterPath(query: RunConfigQuery, skipDim?: RunConfigFacet): string {
  const segments: string[] = [];
  const search = query.search.trim();
  if (search) segments.push("search", encodeSeg(search));
  if (skipDim !== "state" && query.state) segments.push(query.state);
  if (skipDim !== "last" && query.last) segments.push("last", query.last);
  if (skipDim !== "plugin" && query.plugin) segments.push("plugin", encodeSeg(query.plugin));
  if (skipDim !== "mode" && query.mode) segments.push("mode", query.mode);
  return segments.length ? `${segments.join("/")}/` : "";
}

export function runConfigViewPath(query: RunConfigQuery): string {
  return `${runConfigFilterPath(query)}sort/${query.sort}/${query.dir === "desc" ? "desc/" : ""}`;
}

export async function fetchRunConfigPage(base: string, page = 1): Promise<RunConfig[]> {
  const rows = await pathqlFetch<Record<string, unknown>>(
    `run_configs://${base}x${RUN_CONFIG_PAGE_SIZE}x/${Math.max(1, page)}`,
  );
  return rows.map(normalizeRunConfigRow).filter((config): config is RunConfig => config != null);
}

export async function fetchRunConfigTotal(base = ""): Promise<number> {
  return (await pathqlCount(`run_configs://${base.replace(/\/$/, "")}`)).total;
}

export async function fetchRunConfigFacet(dim: RunConfigFacet, query: RunConfigQuery): Promise<Record<string, number>> {
  const entries = await pathqlList(`run_configs://${runConfigFilterPath(query, dim)}${dim}`);
  return Object.fromEntries(
    entries.map((entry) => [entry.name, Number((entry.meta as Record<string, unknown> | null)?.count ?? 0)]),
  );
}

export async function fetchRunConfig(id: string): Promise<RunConfig | null> {
  const rows = await pathqlFetch<Record<string, unknown>>(`run_configs://id_${encodeSeg(id)}`);
  return normalizeRunConfigRow(rows[0]);
}

const resultRank: Record<RunConfigLastResult, number> = {
  failed: 0,
  partial: 1,
  running: 2,
  canceled: 3,
  ok: 4,
  never: 5,
};

export function compareRunConfigs(sort: RunConfigSort, dir: "asc" | "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return (a: RunConfig, b: RunConfig): number => {
    let result = 0;
    if (sort === "next") {
      const av = a.schedulePlannedAt;
      const bv = b.schedulePlannedAt;
      if (av == null || bv == null) result = av == null && bv == null ? 0 : av == null ? 1 : -1;
      else result = (av - bv) * sign;
    } else if (sort === "last") result = ((a.lastTask?.startTime ?? 0) - (b.lastTask?.startTime ?? 0)) * sign;
    else if (sort === "result") result = (resultRank[a.lastResult] - resultRank[b.lastResult]) * sign;
    else if (sort === "name") result = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) * sign;
    else if (sort === "plugin") result = a.pluginId.localeCompare(b.pluginId) * sign;
    else result = (a.createdAt - b.createdAt) * sign;
    if (result) return result;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.id.localeCompare(a.id);
  };
}

const configSubscribers = new Set<(event: RunConfigEvent) => void>();
let configUnlisten: (() => void) | null = null;
let configListenPending: Promise<void> | null = null;

function ensureConfigListener() {
  if (configUnlisten || configListenPending) return;
  configListenPending = listen("auto-config-change", (event) => {
    const row = event.payload as Record<string, unknown> | null;
    const reason = String(row?.reason ?? "") as RunConfigEvent["reason"];
    const configId = String(row?.configId ?? row?.config_id ?? "").trim();
    if (!configId || !["configadd", "configdelete", "configchange"].includes(reason)) return;
    for (const subscriber of [...configSubscribers]) subscriber({ reason, configId });
  })
    .then((unlisten) => {
      configListenPending = null;
      if (configSubscribers.size === 0) unlisten();
      else configUnlisten = unlisten;
    })
    .catch((error) => {
      configListenPending = null;
      console.error("监听运行配置事件失败:", error);
    });
}

export function subscribeRunConfigEvents(handler: (event: RunConfigEvent) => void): () => void {
  configSubscribers.add(handler);
  ensureConfigListener();
  return () => {
    configSubscribers.delete(handler);
    if (configSubscribers.size === 0 && configUnlisten) {
      configUnlisten();
      configUnlisten = null;
    }
  };
}
