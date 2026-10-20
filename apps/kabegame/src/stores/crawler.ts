import { defineStore } from "pinia";
import { ref, unref } from "vue";
import { invoke } from "../api";
import { i18n, resolveConfigText } from "@kabegame/i18n";
import { canonicalizeUserConfig, type PluginVarDef } from "../utils/pluginVarForm";
import { normalizeTaskRow } from "@/services/tasks";
import { normalizeRunConfigRow } from "@/services/runConfigs";
import { usePluginStore } from "./plugins";

export { normalizeDiffKeys } from "@/services/tasks";
export { normalizeRunConfigRow as parseRunConfigRaw } from "@/services/runConfigs";

/** 创建爬虫任务前的异步守卫；返回 `false` 时不创建任务（如最低应用版本不满足） */
export type CrawlerBeforeAddTaskGuard = (pluginId: string) => Promise<boolean>;

let beforeAddTaskGuard: CrawlerBeforeAddTaskGuard | null = null;

export function setCrawlerBeforeAddTaskGuard(guard: CrawlerBeforeAddTaskGuard | null) {
  beforeAddTaskGuard = guard;
}

export interface CrawlTask {
  id: string;
  pluginId: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  httpHeaders?: Record<string, string>;
  maxConcurrentDownloads?: number | null;
  isDryRun: boolean;
  outputAlbumId?: string;
  runConfigId?: string;
  runConfigName?: string | null;
  triggerSource: "manual" | "scheduled";
  status: "pending" | "running" | "waiting_downloads" | "completed" | "failed" | "canceled";
  progress: number;
  deletedCount: number;
  dedupCount: number;
  /** 成功下载数量 */
  successCount?: number;
  /** 失败数量（task_failed_images 计数） */
  failedCount?: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

/** 与后端 `ScheduleSpec` JSON（`schedule_spec` 列）一致 */
export type ScheduleSpec =
  | { mode: "interval"; intervalSecs: number }
  | { mode: "hourly"; minute: number }
  | { mode: "daily"; hour: number; minute: number }
  /** weekdays: 0=周一 … 6=周日 */
  | { mode: "weekly"; weekdays: number[]; hour: number; minute: number };

export type RunConfigLastResult = "never" | "failed" | "running" | "canceled" | "partial" | "ok";

export interface RunConfigLastTask {
  id: string;
  status: CrawlTask["status"];
  startTime: number;
  endTime?: number;
  successCount: number;
  failedCount: number;
  error?: string;
}

export interface RunConfig {
  id: string;
  name: string;
  description?: string;
  pluginId: string;
  url: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  httpHeaders?: Record<string, string>;
  maxConcurrentDownloads?: number | null;
  isDryRun: boolean;
  /** 输出画册：定时任务与手动任务写入同一画册 */
  outputAlbumId?: string;
  createdAt: number;
  scheduleEnabled: boolean;
  scheduleSpec?: ScheduleSpec;
  schedulePlannedAt?: number;
  scheduleLastRunAt?: number;
  lastTask?: RunConfigLastTask;
  lastResult: RunConfigLastResult;
}

/**
 * task config：一次收集任务的全部参数。
 * `userConfig` 即 plugin config，统一存后端格式（与 `RunConfig.userConfig` / `Task.userConfig` 同形）。
 */
export interface TaskConfig {
  pluginId: string;
  userConfig: Record<string, any>;
  outputDir: string;
  httpHeaders: Record<string, string>;
  outputAlbumId: string | null;
  maxConcurrentDownloads: number | null;
  isDryRun: boolean;
}

export interface MissedRunItem {
  configId: string;
  configName: string;
  scheduleMode: "interval" | "hourly" | "daily" | "weekly";
  missedCount: number;
  lastDueAt: number;
}

/** 与后端 `AutoConfigChange.reason` 一致 */
export type AutoConfigChangeReason = "configadd" | "configdelete" | "configchange";

function numOpt(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 解析 `schedule_spec` JSON 对象或字符串 */
export function parseScheduleSpecRaw(v: unknown): ScheduleSpec | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return undefined;
    try {
      return parseScheduleSpecRaw(JSON.parse(t));
    } catch {
      return undefined;
    }
  }
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const mode = o.mode;
  if (mode === "interval") {
    const intervalSecs = numOpt(o.intervalSecs);
    if (intervalSecs == null || intervalSecs <= 0) return undefined;
    return { mode: "interval", intervalSecs };
  }
  if (mode === "daily") {
    const hour = numOpt(o.hour);
    const minute = numOpt(o.minute);
    if (hour == null || minute == null) return undefined;
    if (hour === -1) return { mode: "hourly", minute: Math.min(59, Math.max(0, minute)) };
    return { mode: "daily", hour, minute };
  }
  if (mode === "hourly") {
    const minute = numOpt(o.minute);
    return minute == null ? undefined : { mode: "hourly", minute: Math.min(59, Math.max(0, minute)) };
  }
  if (mode === "weekly") {
    const weekdays = Array.isArray(o.weekdays)
      ? o.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : numOpt(o.weekday) != null
        ? [Number(o.weekday)]
        : [];
    const hour = numOpt(o.hour);
    const minute = numOpt(o.minute);
    if (weekdays.length === 0 || hour == null || minute == null) return undefined;
    return { mode: "weekly", weekdays: [...new Set(weekdays)].sort((a, b) => a - b), hour, minute };
  }
  return undefined;
}

/** 插件包内 `configs/*.json` 推荐运行配置（已合并 pluginId、filename、baseUrl） */
export interface PluginRecommendedPreset {
  isImported?: boolean;
  pluginId: string;
  filename: string;
  baseUrl: string;
  name: unknown;
  description?: unknown;
  userConfig?: Record<string, any>;
  scheduleSpec?: ScheduleSpec;
  httpHeaders?: Record<string, string>;
  isDryRun: boolean;
}

function parseFlatI18nText(obj: Record<string, unknown>, baseKey: string): Record<string, string> | string | undefined {
  const rawBase = obj[baseKey];
  const out: Record<string, string> = {};
  if (rawBase && typeof rawBase === "object" && !Array.isArray(rawBase)) {
    for (const [k, v] of Object.entries(rawBase as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
  }
  if (typeof rawBase === "string" && rawBase.trim()) {
    out.default = rawBase;
  }
  const prefix = `${baseKey}.`;
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith(prefix) || typeof v !== "string" || !v.trim()) continue;
    const lang = k.slice(prefix.length).trim();
    if (!lang) continue;
    out[lang] = v;
  }
  if (Object.keys(out).length > 0) {
    if (!out.default) out.default = out.en ?? Object.values(out)[0] ?? "";
    return out;
  }
  if (typeof rawBase === "string") return rawBase;
  return undefined;
}

export function parsePluginRecommendedPreset(
  raw: unknown,
  baseUrlByPluginId: Map<string, string>,
): PluginRecommendedPreset | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pluginId = String(o.pluginId ?? o.plugin_id ?? "").trim();
  const filename = String(o.filename ?? "").trim();
  if (!pluginId || !filename) return null;
  const nameText = parseFlatI18nText(o, "name");
  const descText = parseFlatI18nText(o, "description");
  return {
    pluginId,
    filename,
    baseUrl: String(o.baseUrl ?? o.base_url ?? baseUrlByPluginId.get(pluginId) ?? ""),
    name: nameText ?? filename,
    description: descText,
    userConfig: (o.userConfig ?? o.user_config) as Record<string, any> | undefined,
    scheduleSpec: parseScheduleSpecRaw(o.scheduleSpec ?? o.schedule_spec),
    httpHeaders: (o.httpHeaders ?? o.http_headers) as Record<string, string> | undefined,
    isDryRun: Boolean(o.isDryRun ?? o.is_dry_run ?? false),
    isImported: Boolean(o.isImported),
  };
}

/**
 * 把运行配置导出为插件 `configs/*.json` 推荐配置的文件内容，字段与 `parsePluginRecommendedPreset` 读取的一致。
 * `pluginId` / `filename` / `baseUrl` 由插件包决定，输出目录、画册、并发等本机设置不导出；dry-run 属插件语义。
 */
export function runConfigToPresetJson(cfg: RunConfig): string {
  const out: Record<string, unknown> = { name: cfg.name };
  if (cfg.description) out.description = cfg.description;
  out.userConfig = cfg.userConfig ?? {};
  if (cfg.scheduleSpec?.mode) out.scheduleSpec = cfg.scheduleSpec;
  if (cfg.httpHeaders && Object.keys(cfg.httpHeaders).length > 0) out.httpHeaders = cfg.httpHeaders;
  if (cfg.isDryRun) out.isDryRun = true;
  return `${JSON.stringify(out, null, 2)}\n`;
}

export const useCrawlerStore = defineStore("crawler", () => {
  /** 已安装插件包内 `configs/*.json` 推荐配置（启动与插件列表刷新时拉取） */
  /**
   * 全局唯一的 task config：收集弹窗只响应式地编辑这一份对象，
   * 调用方「先写再打开」（见 apps 侧 `writeTaskConfig`）。
   */
  const taskConfig = ref<TaskConfig | null>(null);
  /** 仅外部写入时递增；用于以 `:key` 重建插件变量表单（用户编辑不触发） */
  const taskConfigRevision = ref(0);

  /** 整体替换 task config，并让插件变量表单按新值重建 */
  function setTaskConfig(cfg: TaskConfig | null) {
    taskConfig.value = cfg;
    taskConfigRevision.value++;
  }

  /** @returns 是否已创建任务（前置守卫拒绝时为 `false`） */
  async function addTask(
    pluginId: string,
    outputDir?: string,
    userConfig?: Record<string, any>,
    outputAlbumId?: string,
    httpHeaders?: Record<string, string>,
    runConfigId?: string,
    triggerSource: CrawlTask["triggerSource"] = "manual",
    maxConcurrentDownloads?: number | null,
    isDryRun = false,
  ): Promise<boolean> {
    if (beforeAddTaskGuard) {
      try {
        const allowed = await beforeAddTaskGuard(pluginId);
        if (!allowed) return false;
      } catch (e) {
        console.error("addTask 前置守卫异常:", e);
        return false;
      }
    }

    try {
      await invoke("start_task", {
        task: {
          pluginId,
          outputDir,
          userConfig,
          httpHeaders,
          outputAlbumId,
          runConfigId,
          triggerSource,
          maxConcurrentDownloads,
          isDryRun,
        },
      });
      return true;
    } catch (error) {
      console.error("任务入队失败:", error);
      return false;
    }
  }

  async function stopTask(taskId: string) {
    try {
      await invoke("cancel_task", { taskId });
    } catch (error) {
      console.error("终止任务失败:", error);
      throw error;
    }
  }

  async function setTaskMaxConcurrentDownloads(taskId: string, value: number | null) {
    const raw = await invoke<unknown>("set_task_max_concurrent_downloads", {
      taskId,
      maxConcurrentDownloads: value,
    });
    const task = normalizeTaskRow(raw);
    if (!task) throw new Error("set_task_max_concurrent_downloads: invalid payload");
    return task;
  }

  /** 导入推荐配置为本地运行配置；`scheduleEnabled` 受设置项与预设是否有 `scheduleSpec` 影响 */
  async function importRecommendedPreset(preset: PluginRecommendedPreset) {
    let importScheduleDefault = true;
    try {
      importScheduleDefault = await invoke<boolean>("get_import_recommended_schedule_enabled");
    } catch {
      importScheduleDefault = true;
    }
    const locale = String(unref(i18n.global.locale) ?? "zh");
    const nameStr = resolveConfigText(preset.name as any, locale).trim() || preset.filename;
    const descRaw = preset.description;
    const description =
      descRaw != null && descRaw !== "" ? resolveConfigText(descRaw as any, locale).trim() || undefined : undefined;
    const spec = preset.scheduleSpec;
    const scheduleEnabled = Boolean(importScheduleDefault && spec);
    // 推荐配置由插件作者手写，可能含 "" / [] 等旧式空值；入库前按插件定义规范化。
    const defs = (usePluginStore().plugins.find((p) => p.id === preset.pluginId)?.config?.vars ?? []) as PluginVarDef[];
    return await addRunConfig({
      name: nameStr,
      description,
      pluginId: preset.pluginId,
      url: preset.baseUrl || "",
      userConfig: canonicalizeUserConfig(preset.userConfig ?? {}, defs),
      httpHeaders: preset.httpHeaders ?? {},
      isDryRun: preset.isDryRun,
      scheduleEnabled,
      scheduleSpec: spec,
      schedulePlannedAt: undefined,
      scheduleLastRunAt: undefined,
      outputDir: undefined,
    });
  }

  async function addRunConfig(
    config: Omit<RunConfig, "id" | "createdAt" | "lastResult"> & {
      id?: string;
      createdAt?: number;
      lastResult?: RunConfigLastResult;
    },
  ) {
    const cfg: RunConfig = {
      id: config.id ?? Date.now().toString(),
      createdAt: config.createdAt ?? Date.now(),
      name: config.name,
      description: config.description,
      pluginId: config.pluginId,
      url: config.url,
      outputDir: config.outputDir,
      userConfig: config.userConfig ?? {},
      httpHeaders: config.httpHeaders ?? {},
      maxConcurrentDownloads: config.maxConcurrentDownloads ?? null,
      isDryRun: config.isDryRun ?? false,
      outputAlbumId: config.outputAlbumId,
      scheduleEnabled: config.scheduleEnabled ?? false,
      scheduleSpec: config.scheduleSpec,
      schedulePlannedAt: config.schedulePlannedAt,
      scheduleLastRunAt: config.scheduleLastRunAt,
      lastTask: config.lastTask,
      lastResult: config.lastResult ?? "never",
    };
    const saved = normalizeRunConfigRow(await invoke<unknown>("add_run_config", { config: cfg }));
    if (!saved) throw new Error("add_run_config: invalid payload");
    return saved;
  }

  async function updateRunConfig(config: RunConfig) {
    const saved = normalizeRunConfigRow(await invoke<unknown>("update_run_config", { config }));
    if (!saved) throw new Error("update_run_config: invalid payload");
    return saved;
  }

  async function deleteRunConfig(configId: string) {
    await invoke("delete_run_config", { configId });
  }

  async function copyRunConfig(configId: string) {
    const raw = await invoke<unknown>("copy_run_config", { configId });
    const copied = normalizeRunConfigRow(raw);
    if (!copied) throw new Error("copy_run_config: invalid payload");
    return copied;
  }

  async function getMissedRuns(): Promise<MissedRunItem[]> {
    try {
      const items = await invoke<MissedRunItem[]>("get_missed_runs");
      return Array.isArray(items) ? items : [];
    } catch (error) {
      console.error("加载漏跑配置失败:", error);
      return [];
    }
  }

  async function runMissedConfigs(configIds: string[]): Promise<void> {
    await invoke("run_missed_configs", { configIds });
  }

  async function dismissMissedConfigs(configIds: string[]): Promise<void> {
    await invoke("dismiss_missed_configs", { configIds });
  }

  async function deleteTask(taskId: string) {
    await invoke("delete_task", { taskId });
  }

  async function retryTask(task: CrawlTask): Promise<boolean> {
    return await addTask(
      task.pluginId,
      task.outputDir,
      task.userConfig,
      task.outputAlbumId,
      task.httpHeaders,
      task.runConfigId,
      "manual",
      task.maxConcurrentDownloads ?? null,
      task.isDryRun,
    );
  }

  return {
    addTask,
    deleteTask,
    stopTask,
    setTaskMaxConcurrentDownloads,
    retryTask,
    taskConfig,
    taskConfigRevision,
    setTaskConfig,
    importRecommendedPreset,
    addRunConfig,
    updateRunConfig,
    deleteRunConfig,
    copyRunConfig,
    getMissedRuns,
    runMissedConfigs,
    dismissMissedConfigs,
  };
});
