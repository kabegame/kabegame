import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "../env";

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
  outputAlbumId?: string;
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
}

export const useCrawlerStore = defineStore("crawler", () => {
  const tasks = ref<CrawlTask[]>([]);
  /** 分页加载时的总任务数（用于判断是否还有更多） */
  const tasksTotal = ref(0);
  const isCrawling = ref(false);
  const runConfigs = ref<RunConfig[]>([]);

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
        const newStatus = String(payload?.status ?? cur.status) as CrawlTask["status"];
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
            progress: 0,
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
          progress: 0,
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
      const configs = await invoke<RunConfig[]>("get_run_configs");
      runConfigs.value = configs;
    } catch (error) {
      console.error("加载运行配置失败:", error);
      runConfigs.value = [];
    }
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
    };
    await invoke("add_run_config", { config: cfg });
    await loadRunConfigs();
    return cfg;
  }

  async function updateRunConfig(config: RunConfig) {
    await invoke("update_run_config", { config });
    await loadRunConfigs();
  }

  async function deleteRunConfig(configId: string) {
    await invoke("delete_run_config", { configId });
    runConfigs.value = runConfigs.value.filter((c) => c.id !== configId);
  }

  async function runConfig(configId: string): Promise<boolean> {
    const cfg = runConfigs.value.find((c) => c.id === configId);
    if (!cfg) {
      throw new Error("运行配置不存在");
    }
    return await addTask(
      cfg.pluginId,
      cfg.outputDir,
      cfg.userConfig ?? {},
      undefined,
      cfg.httpHeaders ?? {},
    );
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
  async function loadTasksPage(limit: number, offset: number): Promise<{ total: number } | null> {
    try {
      const res = await invoke<{
        tasks: Array<{
          id: string;
          pluginId: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          outputAlbumId?: string;
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

  // Android：每隔 1s 轮询一次任务列表，避免 task_status / task_progress 事件丢失导致界面不同步
  if (IS_ANDROID) {
    setInterval(() => {
      void loadTasks();
    }, 1000);
  }

  async function retryTask(task: CrawlTask): Promise<boolean> {
    return await addTask(
      task.pluginId,
      task.outputDir,
      task.userConfig,
      task.outputAlbumId,
      task.httpHeaders,
    );
  }

  return {
    tasks,
    tasksTotal,
    isCrawling,
    addTask,
    deleteTask,
    stopTask,
    retryTask,
    runConfigs,
    loadRunConfigs,
    addRunConfig,
    updateRunConfig,
    deleteRunConfig,
    runConfig,
    loadTasks,
    loadTasksPage,
  };
});

