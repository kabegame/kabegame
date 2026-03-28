import { defineStore } from "pinia";
import { computed, ref, unref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { i18n, resolveConfigText } from "@kabegame/i18n";
import { IS_ANDROID } from "../env";

/** 创建爬虫任务前的异步守卫；返回 `false` 时不创建任务（如最低应用版本不满足） */
export type CrawlerBeforeAddTaskGuard = (pluginId: string) => Promise<boolean>;

let beforeAddTaskGuard: CrawlerBeforeAddTaskGuard | null = null;

export function setCrawlerBeforeAddTaskGuard(
  guard: CrawlerBeforeAddTaskGuard | null,
) {
  beforeAddTaskGuard = guard;
}

export interface CrawlTask {
  id: string;
  pluginId: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  httpHeaders?: Record<string, string>;
  outputAlbumId?: string;
  runConfigId?: string;
  triggerSource: "manual" | "scheduled";
  status: "pending" | "running" | "completed" | "failed" | "canceled";
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
  | { mode: "daily"; hour: number; minute: number }
  /** weekday: 0=周一 … 6=周日 */
  | { mode: "weekly"; weekday: number; hour: number; minute: number };

export interface RunConfig {
  id: string;
  name: string;
  description?: string;
  pluginId: string;
  url: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  httpHeaders?: Record<string, string>;
  createdAt: number;
  scheduleEnabled: boolean;
  scheduleSpec?: ScheduleSpec;
  schedulePlannedAt?: number;
  scheduleLastRunAt?: number;
}

export interface MissedRunItem {
  configId: string;
  configName: string;
  scheduleMode: "interval" | "daily" | "weekly";
  missedCount: number;
  lastDueAt: number;
}

/** 与后端 `AutoConfigChange.reason` 一致 */
export type AutoConfigChangeReason =
  | "configadd"
  | "configdelete"
  | "configchange";

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
    const intervalSecs = numOpt(o.intervalSecs ?? o.interval_secs);
    if (intervalSecs == null || intervalSecs <= 0) return undefined;
    return { mode: "interval", intervalSecs };
  }
  if (mode === "daily") {
    const hour = numOpt(o.hour);
    const minute = numOpt(o.minute);
    if (hour == null || minute == null) return undefined;
    return { mode: "daily", hour, minute };
  }
  if (mode === "weekly") {
    const weekday = numOpt(o.weekday);
    const hour = numOpt(o.hour);
    const minute = numOpt(o.minute);
    if (weekday == null || hour == null || minute == null) return undefined;
    return { mode: "weekly", weekday, hour, minute };
  }
  return undefined;
}

/** 与后端 `compute_next_planned_at` / AutoConfigCardScheduleEditor 对齐：下一次绝对触发时刻（Unix 秒） */
export function computeNextPlannedAtForSpec(spec: ScheduleSpec): number {
  const nowSec = Math.floor(Date.now() / 1000);
  if (spec.mode === "interval") {
    const iv = Math.max(60, Number(spec.intervalSecs) || 3600);
    return nowSec + iv;
  }
  if (spec.mode === "weekly") {
    const minute = Math.min(59, Math.max(0, Number(spec.minute)));
    const hour = Math.min(23, Math.max(0, Number(spec.hour)));
    const wd = Math.min(6, Math.max(0, Number(spec.weekday)));
    const d = new Date(nowSec * 1000);
    const cur = d.getDay() === 0 ? 6 : d.getDay() - 1;
    const days = (wd - cur + 7) % 7;
    let cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, minute, 0, 0);
    if (Math.floor(cand.getTime() / 1000) <= nowSec) {
      cand = new Date(cand.getFullYear(), cand.getMonth(), cand.getDate() + 7, hour, minute, 0, 0);
    }
    return Math.floor(cand.getTime() / 1000);
  }
  const minute = Math.min(59, Math.max(0, Number(spec.minute)));
  const d = new Date(nowSec * 1000);
  if (spec.hour === -1) {
    const slot = new Date(d.getTime());
    slot.setSeconds(0, 0);
    slot.setMinutes(minute);
    if (Math.floor(slot.getTime() / 1000) <= nowSec) {
      slot.setHours(slot.getHours() + 1);
      slot.setMinutes(minute);
      slot.setSeconds(0, 0);
    }
    return Math.floor(slot.getTime() / 1000);
  }
  const hour = Math.min(23, Math.max(0, Number(spec.hour)));
  const slot = new Date(d.getTime());
  slot.setHours(hour, minute, 0, 0);
  if (Math.floor(slot.getTime() / 1000) <= nowSec) {
    slot.setDate(slot.getDate() + 1);
    slot.setHours(hour, minute, 0, 0);
  }
  return Math.floor(slot.getTime() / 1000);
}

/** 插件包内 `configs/*.json` 推荐运行配置（已合并 pluginId、filename、baseUrl） */
export interface PluginRecommendedPreset {
  pluginId: string;
  filename: string;
  baseUrl: string;
  name: unknown;
  description?: unknown;
  userConfig?: Record<string, any>;
  scheduleSpec?: ScheduleSpec;
  httpHeaders?: Record<string, string>;
}

function parseFlatI18nText(
  obj: Record<string, unknown>,
  baseKey: string,
): Record<string, string> | string | undefined {
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
    baseUrl: baseUrlByPluginId.get(pluginId) ?? "",
    name: nameText ?? filename,
    description: descText,
    userConfig: (o.userConfig ?? o.user_config) as Record<string, any> | undefined,
    scheduleSpec: parseScheduleSpecRaw(o.scheduleSpec ?? o.schedule_spec),
    httpHeaders: (o.httpHeaders ?? o.http_headers) as Record<string, string> | undefined,
  };
}

/** 将 `get_run_config` / `get_run_configs` 单条 JSON 规范为 `RunConfig` */
export function parseRunConfigRaw(raw: unknown): RunConfig | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  const pluginId = String(o.pluginId ?? o.plugin_id ?? "").trim();
  if (!id || !pluginId) return null;
  return {
    id,
    name: String(o.name ?? ""),
    description:
      o.description != null && o.description !== ""
        ? String(o.description)
        : undefined,
    pluginId,
    url: String(o.url ?? ""),
    outputDir: (o.outputDir ?? o.output_dir) as string | undefined,
    userConfig: (o.userConfig ?? o.user_config) as
      | Record<string, any>
      | undefined,
    httpHeaders: (o.httpHeaders ?? o.http_headers) as
      | Record<string, string>
      | undefined,
    createdAt: Number(o.createdAt ?? o.created_at ?? 0),
    scheduleEnabled: Boolean(o.scheduleEnabled ?? o.schedule_enabled),
    scheduleSpec: parseScheduleSpecRaw(o.scheduleSpec ?? o.schedule_spec),
    schedulePlannedAt: numOpt(o.schedulePlannedAt ?? o.schedule_planned_at),
    scheduleLastRunAt: numOpt(o.scheduleLastRunAt ?? o.schedule_last_run_at),
  };
}

export const useCrawlerStore = defineStore("crawler", () => {
  const tasks = ref<CrawlTask[]>([]);
  /** 分页加载时的总任务数（用于判断是否还有更多） */
  const tasksTotal = ref(0);
  const isCrawling = ref(false);
  const runConfigs = ref<RunConfig[]>([]);
  /** 已安装插件包内 `configs/*.json` 推荐配置（启动与插件列表刷新时拉取） */
  const pluginRecommendedConfigs = ref<PluginRecommendedPreset[]>([]);

  const lastProgressUpdateAt = new Map<string, number>();
  const loadingTaskPromises = new Map<string, Promise<void>>();

  const ensureTaskLoaded = async (taskId: string) => {
    const id = String(taskId || "").trim();
    if (!id) return;
    if (tasks.value.some((t) => t.id === id)) return;
    const existing = loadingTaskPromises.get(id);
    if (existing) {
      await existing;
      return;
    }

    const p = (async () => {
      try {
        const t = await invoke<any>("get_task", { taskId: id });
        const raw = t && typeof t === "object" ? t : null;
        if (!raw) return;

        const task: CrawlTask = {
          id: String(raw.id ?? raw.taskId ?? raw.task_id ?? id),
          pluginId: String(raw.pluginId ?? raw.plugin_id ?? ""),
          outputDir: raw.outputDir ?? raw.output_dir ?? undefined,
          userConfig: raw.userConfig ?? raw.user_config ?? undefined,
          httpHeaders: raw.httpHeaders ?? raw.http_headers ?? undefined,
          outputAlbumId: raw.outputAlbumId ?? raw.output_album_id ?? undefined,
          runConfigId: raw.runConfigId ?? raw.run_config_id ?? undefined,
          triggerSource: (raw.triggerSource ??
            raw.trigger_source ??
            "manual") as CrawlTask["triggerSource"],
          status: (raw.status || "pending") as CrawlTask["status"],
          progress: Number(raw.progress ?? 0),
          deletedCount: Number(raw.deletedCount ?? raw.deleted_count ?? 0),
          dedupCount: Number(raw.dedupCount ?? raw.dedup_count ?? 0),
          successCount: Number(raw.successCount ?? raw.success_count ?? 0),
          failedCount: Number(raw.failedCount ?? raw.failed_count ?? 0),
          startTime: raw.startTime ?? raw.start_time ?? undefined,
          endTime: raw.endTime ?? raw.end_time ?? undefined,
          error: raw.error ?? undefined,
        };

        if (!task.id || !task.pluginId) return;
        if (!tasks.value.some((x) => x.id === task.id)) {
          tasks.value.unshift(task);
        }
      } catch {
        // ignore
      }
    })().finally(() => {
      loadingTaskPromises.delete(id);
    });

    loadingTaskPromises.set(id, p);
    await p;
  };

  /** 从后端拉取单个任务并更新 store（用于安卓轮询，避免丢失 task_status 事件） */
  const syncTaskFromBackend = async (id: string) => {
    try {
      const raw = await invoke<any>("get_task", { taskId: id });
      if (!raw || typeof raw !== "object") return;
      const idx = tasks.value.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const task: CrawlTask = {
        id: String(raw.id ?? raw.taskId ?? raw.task_id ?? id),
        pluginId: String(raw.pluginId ?? raw.plugin_id ?? ""),
        outputDir: raw.outputDir ?? raw.output_dir ?? undefined,
        userConfig: raw.userConfig ?? raw.user_config ?? undefined,
        httpHeaders: raw.httpHeaders ?? raw.http_headers ?? undefined,
        outputAlbumId: raw.outputAlbumId ?? raw.output_album_id ?? undefined,
        runConfigId: raw.runConfigId ?? raw.run_config_id ?? undefined,
        triggerSource: (raw.triggerSource ??
          raw.trigger_source ??
          "manual") as CrawlTask["triggerSource"],
        status: (raw.status || "pending") as CrawlTask["status"],
        progress: Number(raw.progress ?? 0),
        deletedCount: Number(raw.deletedCount ?? raw.deleted_count ?? 0),
        dedupCount: Number(raw.dedupCount ?? raw.dedup_count ?? 0),
        successCount: Number(raw.successCount ?? raw.success_count ?? 0),
        failedCount: Number(raw.failedCount ?? raw.failed_count ?? 0),
        startTime: raw.startTime ?? raw.start_time ?? undefined,
        endTime: raw.endTime ?? raw.end_time ?? undefined,
        error: raw.error ?? undefined,
      };
      if (task.id && task.pluginId) tasks.value[idx] = task;
    } catch {
      // ignore
    }
  };

  /** 单条拉取并合并进 runConfigs，避免 auto-config 事件触发全表刷新 */
  async function patchRunConfigById(configId: string) {
    const id = String(configId || "").trim();
    if (!id) return;
    try {
      const raw = await invoke<unknown>("get_run_config", { configId: id });
      const cfg = parseRunConfigRaw(raw);
      if (!cfg) {
        await loadRunConfigs();
        return;
      }
      const idx = runConfigs.value.findIndex((c) => c.id === id);
      if (idx === -1) {
        runConfigs.value = [
          ...runConfigs.value.filter((c) => c.id !== id),
          cfg,
        ].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
      } else {
        const next = runConfigs.value.slice();
        next[idx] = cfg;
        runConfigs.value = next;
      }
    } catch {
      await loadRunConfigs();
    }
  }

  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");

      await listen("task-status", async (event) => {
        const payload: any = event.payload as any;
        const taskId = String(payload?.task_id ?? "").trim();
        if (!taskId) return;

        if (!tasks.value.some((t) => t.id === taskId)) {
          await ensureTaskLoaded(taskId);
        }

        const idx = tasks.value.findIndex((t) => t.id === taskId);
        if (idx === -1) return;

        const cur = tasks.value[idx];
        const newStatus = String(
          payload?.status ?? cur.status,
        ) as CrawlTask["status"];
        const startTime = payload?.start_time;
        const endTime = payload?.end_time;
        const error = payload?.error;

        const next: CrawlTask = {
          ...cur,
          status: newStatus,
          startTime: startTime ?? cur.startTime,
          endTime: endTime ?? cur.endTime,
          error: error ?? cur.error,
          progress: newStatus === "completed" ? 100 : (cur.progress ?? 0),
        };
        tasks.value[idx] = next;
      });

      await listen("task-progress", async (event) => {
        const payload: any = event.payload as any;
        const taskId = String(payload?.task_id ?? "").trim();
        if (!taskId) return;
        const newProgress = Number(payload?.progress ?? NaN);
        if (!Number.isFinite(newProgress)) return;

        if (!tasks.value.some((t) => t.id === taskId)) {
          await ensureTaskLoaded(taskId);
        }

        const idx = tasks.value.findIndex((t) => t.id === taskId);
        if (idx === -1) return;
        const cur = tasks.value[idx];
        if (newProgress <= (cur.progress ?? 0)) return;

        const now = Date.now();
        const lastAt = lastProgressUpdateAt.get(taskId) ?? 0;
        if (newProgress < 100 && now - lastAt < 100) return;
        lastProgressUpdateAt.set(taskId, now);

        const next: CrawlTask = { ...cur, progress: newProgress };
        tasks.value[idx] = next;
      });

      await listen("task-error", async (event) => {
        const payload: any = event.payload as any;
        const taskId = String(payload?.task_id ?? "").trim();
        if (!taskId) return;

        if (!tasks.value.some((t) => t.id === taskId)) {
          await ensureTaskLoaded(taskId);
        }

        const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
        if (
          taskIndex !== -1 &&
          tasks.value[taskIndex].status !== "failed" &&
          tasks.value[taskIndex].status !== "canceled"
        ) {
          const errorMessage = String(payload?.error ?? "");
          const isCanceled = errorMessage.includes("Task canceled");

          tasks.value[taskIndex] = {
            ...tasks.value[taskIndex],
            status: isCanceled ? "canceled" : "failed",
            error: errorMessage,
            endTime: Date.now(),
          };

          if (!isCanceled) {
            window.dispatchEvent(
              new CustomEvent("task-error-display", {
                detail: {
                  taskId,
                  pluginId: tasks.value[taskIndex].pluginId,
                  error: errorMessage,
                },
              }),
            );
          }
        }
      });

      await listen("task-image-counts", async (event) => {
        const payload: any = event.payload as any;
        const taskId = String(payload?.task_id ?? payload?.taskId ?? "").trim();
        if (!taskId) return;

        if (!tasks.value.some((t) => t.id === taskId)) {
          await ensureTaskLoaded(taskId);
        }

        const idx = tasks.value.findIndex((t) => t.id === taskId);
        if (idx === -1) return;
        const cur = tasks.value[idx];
        const next: CrawlTask = { ...cur };
        const sc = payload?.success_count ?? payload?.successCount;
        if (sc != null && Number.isFinite(Number(sc))) {
          next.successCount = Number(sc);
        }
        const delc = payload?.deleted_count ?? payload?.deletedCount;
        if (delc != null && Number.isFinite(Number(delc))) {
          next.deletedCount = Number(delc);
        }
        const fc = payload?.failed_count ?? payload?.failedCount;
        if (fc != null && Number.isFinite(Number(fc))) {
          next.failedCount = Number(fc);
        }
        const ddc = payload?.dedup_count ?? payload?.dedupCount;
        if (ddc != null && Number.isFinite(Number(ddc))) {
          next.dedupCount = Number(ddc);
        }
        tasks.value[idx] = next;
      });

      await listen("auto-config-change", async (event) => {
        const payload: any = event.payload as any;
        const reason = String(payload?.reason ?? "");
        const configId = String(
          payload?.configId ?? payload?.config_id ?? "",
        ).trim();
        if (!configId) {
          await loadRunConfigs();
          return;
        }
        if (reason === "configdelete") {
          runConfigs.value = runConfigs.value.filter((c) => c.id !== configId);
          return;
        }
        if (reason === "configadd" || reason === "configchange") {
          await patchRunConfigById(configId);
          return;
        }
        await loadRunConfigs();
      });

      if (IS_ANDROID) {
        setInterval(() => {
          const list = tasks.value;
          for (let i = 0; i < list.length; i++) {
            const t = list[i];
            if (t.status === "running" || t.status === "pending") {
              void syncTaskFromBackend(t.id);
            }
          }
        }, 1000);
      }
    } catch (error) {
      console.error("设置全局事件监听器失败:", error);
    }
  })();

  /** @returns 是否已创建任务（前置守卫拒绝时为 `false`） */
  async function addTask(
    pluginId: string,
    outputDir?: string,
    userConfig?: Record<string, any>,
    outputAlbumId?: string,
    httpHeaders?: Record<string, string>,
    runConfigId?: string,
    triggerSource: CrawlTask["triggerSource"] = "manual",
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

    const task: CrawlTask = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pluginId,
      outputDir,
      userConfig,
      httpHeaders,
      outputAlbumId,
      runConfigId,
      triggerSource,
      status: "pending",
      progress: 0,
      deletedCount: 0,
      dedupCount: 0,
      successCount: 0,
      failedCount: 0,
      startTime: Date.now(),
    };

    tasks.value.unshift(task);

    startCrawl(task).catch(async (error) => {
      const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
      if (
        taskIndex !== -1 &&
        tasks.value[taskIndex].status !== "failed" &&
        tasks.value[taskIndex].status !== "canceled"
      ) {
        tasks.value[taskIndex] = {
          ...tasks.value[taskIndex],
          status: "failed",
          error: error instanceof Error ? error.message : "未知错误",
          endTime: Date.now(),
        };

        try {
          await invoke("update_task", {
            task: {
              id: tasks.value[taskIndex].id,
              pluginId: tasks.value[taskIndex].pluginId,
              outputDir: tasks.value[taskIndex].outputDir,
              userConfig: tasks.value[taskIndex].userConfig,
              outputAlbumId: tasks.value[taskIndex].outputAlbumId,
              runConfigId: tasks.value[taskIndex].runConfigId,
              triggerSource: tasks.value[taskIndex].triggerSource,
              status: tasks.value[taskIndex].status,
              progress: tasks.value[taskIndex].progress,
              deletedCount: tasks.value[taskIndex].deletedCount || 0,
              dedupCount: tasks.value[taskIndex].dedupCount || 0,
              startTime: tasks.value[taskIndex].startTime,
              endTime: tasks.value[taskIndex].endTime,
              error: tasks.value[taskIndex].error,
            },
          });
        } catch (dbError) {
          console.error("更新任务失败状态到数据库失败:", dbError);
        }
      }
      console.error("任务执行失败:", error);
    });
    return true;
  }

  async function startCrawl(task: CrawlTask) {
    if (task.status === "failed" || task.status === "canceled") {
      console.log(
        `任务 ${task.id} 已经是${
          task.status === "canceled" ? "取消" : "失败"
        }状态，不重新启动`,
      );
      return;
    }

    try {
      await invoke("start_task", {
        task: {
          taskId: task.id,
          pluginId: task.pluginId,
          outputDir: task.outputDir,
          userConfig: task.userConfig,
          httpHeaders: task.httpHeaders,
          outputAlbumId: task.outputAlbumId,
          runConfigId: task.runConfigId,
          triggerSource: task.triggerSource,
          status: task.status,
          progress: task.progress,
          deletedCount: task.deletedCount || 0,
          dedupCount: task.dedupCount || 0,
          startTime: task.startTime,
          endTime: task.endTime,
          error: task.error,
        },
      });
    } catch (error) {
      console.error("任务入队失败:", error);
      throw error;
    } finally {
      isCrawling.value = false;
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

  async function loadRunConfigs() {
    try {
      const raw = await invoke<unknown[]>("get_run_configs");
      const list = Array.isArray(raw) ? raw : [];
      runConfigs.value = list
        .map((x) => parseRunConfigRaw(x))
        .filter((c): c is RunConfig => c != null);
    } catch (error) {
      console.error("加载运行配置失败:", error);
      runConfigs.value = [];
    }
  }

  async function loadPluginRecommendedConfigs() {
    try {
      const plugins = await invoke<Array<{ id?: string; baseUrl?: string }>>("get_plugins");
      const list = Array.isArray(plugins) ? plugins : [];
      const baseUrlById = new Map<string, string>();
      const ids: string[] = [];
      for (const p of list) {
        if (!p || typeof p !== "object") continue;
        const id = String(p.id ?? "").trim();
        if (!id) continue;
        ids.push(id);
        baseUrlById.set(id, String(p.baseUrl ?? ""));
      }
      const collected: PluginRecommendedPreset[] = [];
      await Promise.all(
        ids.map(async (pluginId) => {
          try {
            const raw = await invoke<unknown[]>("get_plugin_recommended_configs", {
              pluginId,
            });
            const arr = Array.isArray(raw) ? raw : [];
            for (const item of arr) {
              const parsed = parsePluginRecommendedPreset(item, baseUrlById);
              if (parsed) collected.push(parsed);
            }
          } catch {
            // 单插件无 configs 或读包失败时忽略
          }
        }),
      );
      collected.sort((a, b) =>
        a.pluginId.localeCompare(b.pluginId) || a.filename.localeCompare(b.filename),
      );
      pluginRecommendedConfigs.value = collected;
    } catch (error) {
      console.error("加载插件推荐配置失败:", error);
      pluginRecommendedConfigs.value = [];
    }
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
    const nameStr =
      resolveConfigText(preset.name as any, locale).trim() || preset.filename;
    const descRaw = preset.description;
    const description =
      descRaw != null && descRaw !== ""
        ? resolveConfigText(descRaw as any, locale).trim() || undefined
        : undefined;
    const spec = preset.scheduleSpec;
    const scheduleEnabled = Boolean(importScheduleDefault && spec);
    let schedulePlannedAt: number | undefined;
    if (scheduleEnabled && spec) {
      schedulePlannedAt = computeNextPlannedAtForSpec(spec);
    }
    return await addRunConfig({
      name: nameStr,
      description,
      pluginId: preset.pluginId,
      url: preset.baseUrl || "",
      userConfig: preset.userConfig ?? {},
      httpHeaders: preset.httpHeaders ?? {},
      scheduleEnabled,
      scheduleSpec: spec,
      schedulePlannedAt,
      scheduleLastRunAt: undefined,
      outputDir: undefined,
    });
  }

  async function addRunConfig(
    config: Omit<RunConfig, "id" | "createdAt"> & {
      id?: string;
      createdAt?: number;
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
      scheduleEnabled: config.scheduleEnabled ?? false,
      scheduleSpec: config.scheduleSpec,
      schedulePlannedAt: config.schedulePlannedAt,
      scheduleLastRunAt: config.scheduleLastRunAt,
    };
    await invoke("add_run_config", { config: cfg });
    runConfigs.value = [
      cfg,
      ...runConfigs.value.filter((c) => c.id !== cfg.id),
    ].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return cfg;
  }

  async function updateRunConfig(config: RunConfig) {
    await invoke("update_run_config", { config });
    const idx = runConfigs.value.findIndex((c) => c.id === config.id);
    if (idx !== -1) {
      const next = runConfigs.value.slice();
      next[idx] = config;
      runConfigs.value = next;
    }
  }

  async function deleteRunConfig(configId: string) {
    await invoke("delete_run_config", { configId });
    runConfigs.value = runConfigs.value.filter((c) => c.id !== configId);
  }

  async function copyRunConfig(configId: string) {
    const raw = await invoke<unknown>("copy_run_config", { configId });
    const copied = parseRunConfigRaw(raw);
    if (!copied) {
      await loadRunConfigs();
      throw new Error("copy_run_config: invalid payload");
    }
    runConfigs.value = [
      copied,
      ...runConfigs.value.filter((c) => c.id !== copied.id),
    ].sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return copied;
  }

  const runConfigById = computed(() => {
    const map = new Map<string, RunConfig>();
    for (const item of runConfigs.value) {
      map.set(item.id, item);
    }
    return (id: string): RunConfig | undefined => map.get(id);
  });

  async function runFromConfig(configId: string): Promise<boolean> {
    const cfg = runConfigById.value(configId);
    if (!cfg) {
      throw new Error("运行配置不存在");
    }
    return await addTask(
      cfg.pluginId,
      cfg.outputDir,
      cfg.userConfig ?? {},
      undefined,
      cfg.httpHeaders ?? {},
      cfg.id,
      "manual",
    );
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

  async function resolveMissedRuns(
    configIds: string[],
    action: "run_now" | "dismiss",
  ): Promise<void> {
    await invoke("resolve_missed_runs", { configIds, action });
  }

  // 兼容旧调用名
  async function runConfig(configId: string): Promise<boolean> {
    return runFromConfig(configId);
  }

  async function deleteTask(taskId: string) {
    try {
      await invoke("delete_task", { taskId });
    } catch (error) {
      console.error("从数据库删除任务失败:", error);
    }

    const index = tasks.value.findIndex((t) => t.id === taskId);
    if (index !== -1) {
      tasks.value.splice(index, 1);
    }
  }

  const mapTaskRaw = (t: {
    id: string;
    pluginId: string;
    outputDir?: string;
    userConfig?: Record<string, any>;
    outputAlbumId?: string;
    runConfigId?: string;
    triggerSource?: CrawlTask["triggerSource"];
    status: string;
    progress: number;
    deletedCount: number;
    dedupCount?: number;
    successCount?: number;
    failedCount?: number;
    startTime?: number;
    endTime?: number;
    error?: string;
  }): CrawlTask => ({
    id: t.id,
    pluginId: t.pluginId,
    outputDir: t.outputDir,
    userConfig: t.userConfig,
    outputAlbumId: t.outputAlbumId,
    runConfigId: t.runConfigId,
    triggerSource: t.triggerSource ?? "manual",
    status: t.status as CrawlTask["status"],
    progress: t.progress ?? 0,
    deletedCount: t.deletedCount || 0,
    dedupCount: t.dedupCount ?? 0,
    successCount: t.successCount ?? 0,
    failedCount: t.failedCount ?? 0,
    startTime: t.startTime,
    endTime: t.endTime,
    error: t.error,
  });

  async function loadTasks() {
    try {
      const finalTasks = await invoke<
        Array<{
          id: string;
          pluginId: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          outputAlbumId?: string;
          runConfigId?: string;
          triggerSource?: CrawlTask["triggerSource"];
          status: string;
          progress: number;
          deletedCount: number;
          dedupCount?: number;
          successCount?: number;
          failedCount?: number;
          startTime?: number;
          endTime?: number;
          error?: string;
        }>
      >("get_all_tasks");

      tasks.value = finalTasks.map(mapTaskRaw);
      tasksTotal.value = tasks.value.length;
    } catch (error) {
      console.error("加载任务失败:", error);
    }
  }

  /** 分页加载任务（用于任务抽屉触底加载，减轻首次打开卡顿） */
  async function loadTasksPage(
    limit: number,
    offset: number,
  ): Promise<{ total: number } | null> {
    try {
      const res = await invoke<{
        tasks: Array<{
          id: string;
          pluginId: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          outputAlbumId?: string;
          runConfigId?: string;
          triggerSource?: CrawlTask["triggerSource"];
          status: string;
          progress: number;
          deletedCount: number;
          dedupCount?: number;
          successCount?: number;
          failedCount?: number;
          startTime?: number;
          endTime?: number;
          error?: string;
        }>;
        total: number;
      }>("get_tasks_page", { limit, offset });

      const mapped = (res.tasks || []).map(mapTaskRaw);
      if (offset === 0) {
        tasks.value = mapped;
      } else {
        tasks.value = [...tasks.value, ...mapped];
      }
      tasksTotal.value = res.total ?? 0;
      return { total: res.total ?? 0 };
    } catch (error) {
      console.error("分页加载任务失败:", error);
      return null;
    }
  }

  // Android：每隔 60s 轮询一次任务列表，避免 task_status / task_progress 事件丢失导致界面不同步
  if (IS_ANDROID) {
    setInterval(() => {
      void loadTasks();
    }, 60000);
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
    );
  }

  /** 与后端 clear_finished_tasks 一致：本地只保留 pending / running */
  function applyKeepOnlyPendingAndRunningTasks() {
    tasks.value = tasks.value.filter(
      (t) => t.status === "pending" || t.status === "running",
    );
    tasksTotal.value = tasks.value.length;
  }

  const runConfigsReady = loadRunConfigs().then(() => loadPluginRecommendedConfigs());
  const tasksReady = loadTasks();

  return {
    tasks,
    tasksTotal,
    isCrawling,
    addTask,
    deleteTask,
    stopTask,
    retryTask,
    runConfigs,
    pluginRecommendedConfigs,
    loadRunConfigs,
    loadPluginRecommendedConfigs,
    importRecommendedPreset,
    addRunConfig,
    updateRunConfig,
    deleteRunConfig,
    copyRunConfig,
    runConfigById,
    runFromConfig,
    runConfig,
    getMissedRuns,
    resolveMissedRuns,
    loadTasks,
    loadTasksPage,
    runConfigsReady,
    tasksReady,
    applyKeepOnlyPendingAndRunningTasks,
  };
});

