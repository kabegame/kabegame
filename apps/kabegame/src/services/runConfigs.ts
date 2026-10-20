import { listen } from "@/api";
import { pathqlCount, pathqlFetch, pathqlList } from "@/services/pathql";
import type { RunConfig, ScheduleSpec } from "@/stores/crawler";
import { encodeSeg } from "@kabegame/pathql-client";

export const RUN_CONFIG_PAGE_SIZE = 20;

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

function scheduleSpec(value: unknown): ScheduleSpec | undefined {
  const row = jsonObject<Record<string, unknown>>(value);
  if (!row) return undefined;
  if (row.mode === "interval") {
    const intervalSecs = numberOpt(row.intervalSecs);
    return intervalSecs != null && intervalSecs > 0 ? { mode: "interval", intervalSecs } : undefined;
  }
  if (row.mode === "daily") {
    const hour = numberOpt(row.hour);
    const minute = numberOpt(row.minute);
    return hour != null && minute != null ? { mode: "daily", hour, minute } : undefined;
  }
  if (row.mode === "weekly") {
    const weekday = numberOpt(row.weekday);
    const hour = numberOpt(row.hour);
    const minute = numberOpt(row.minute);
    return weekday != null && hour != null && minute != null ? { mode: "weekly", weekday, hour, minute } : undefined;
  }
  return undefined;
}

export function normalizeRunConfigRow(raw: unknown): RunConfig | null {
  if (raw == null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const pluginId = String(row.pluginId ?? row.plugin_id ?? "").trim();
  if (!id || !pluginId) return null;
  const maxRaw = row.maxConcurrentDownloads ?? row.max_concurrent_downloads;
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
    maxConcurrentDownloads: maxRaw == null ? null : Number(maxRaw),
    isDryRun: Boolean(row.isDryRun ?? row.is_dry_run ?? false),
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    scheduleEnabled: Boolean(row.scheduleEnabled ?? row.schedule_enabled),
    scheduleSpec: scheduleSpec(row.scheduleSpec ?? row.schedule_spec),
    schedulePlannedAt: numberOpt(row.schedulePlannedAt ?? row.schedule_planned_at),
    scheduleLastRunAt: numberOpt(row.scheduleLastRunAt ?? row.schedule_last_run_at),
  };
}

export function runConfigFilterPath(options: { pluginId?: string | null; onlyEnabled?: boolean }): string {
  const segments: string[] = [];
  if (options.onlyEnabled) segments.push("enabled");
  if (options.pluginId) segments.push(`plugin/${encodeSeg(options.pluginId)}`);
  return segments.length ? `${segments.join("/")}/` : "";
}

function cursorSegment(last: RunConfig): string {
  return `before_${last.createdAt}_${encodeSeg(last.id)}/`;
}

export async function fetchRunConfigPage(base: string, after?: RunConfig): Promise<RunConfig[]> {
  const cursor = after ? cursorSegment(after) : "";
  const rows = await pathqlFetch<Record<string, unknown>>(
    `run_configs://${base}${cursor}x${RUN_CONFIG_PAGE_SIZE}x/1`,
  );
  return rows.map(normalizeRunConfigRow).filter((config): config is RunConfig => config != null);
}

export async function fetchRunConfigTotal(base = ""): Promise<number> {
  return (await pathqlCount(`run_configs://${base.replace(/\/$/, "")}`)).total;
}

export async function fetchRunConfig(id: string): Promise<RunConfig | null> {
  const rows = await pathqlFetch<Record<string, unknown>>(`run_configs://id_${encodeSeg(id)}`);
  return normalizeRunConfigRow(rows[0]);
}

export async function fetchRunConfigPluginCounts(onlyEnabled = false): Promise<Record<string, number>> {
  const entries = await pathqlList(`run_configs://${onlyEnabled ? "enabled/" : ""}plugin`);
  return Object.fromEntries(
    entries.map((entry) => [entry.name, Number((entry.meta as Record<string, unknown> | null)?.count ?? 0)]),
  );
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
