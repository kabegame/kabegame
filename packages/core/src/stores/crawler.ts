import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";

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
  startTime?: number;
  endTime?: number;
  error?: string;
  rhaiDumpPresent?: boolean;
  rhaiDumpConfirmed?: boolean;
  rhaiDumpCreatedAt?: number;
}

export interface ImageInfo {
  id: string;
  url: string;
  localPath: string;
  localExists?: boolean;
  pluginId: string;
  taskId?: string;
  crawledAt: number;
  metadata?: Record<string, any>;
  thumbnailPath: string;
  favorite?: boolean;
  hash: string;
  order?: number;
  isTaskFailed?: boolean;
  taskFailedId?: number;
  taskFailedError?: string;
}

export interface RangedImages {
  images: ImageInfo[];
  total: number;
  offset: number;
  limit: number;
}

export interface PaginatedImages {
  images: ImageInfo[];
  total: number;
  page: number;
  pageSize: number;
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
  const images = ref<ImageInfo[]>([]);
  const isCrawling = ref(false);
  const totalImages = ref(0);
  const pageSize = ref(50);
  const hasMore = ref(false);
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
          status: (raw.status || "pending") as any,
          progress: Number(raw.progress ?? 0),
          deletedCount: Number(raw.deletedCount ?? raw.deleted_count ?? 0),
          startTime: raw.startTime ?? raw.start_time ?? undefined,
          endTime: raw.endTime ?? raw.end_time ?? undefined,
          error: raw.error ?? undefined,
          rhaiDumpPresent:
            raw.rhaiDumpPresent ?? raw.rhai_dump_present ?? undefined,
          rhaiDumpConfirmed:
            raw.rhaiDumpConfirmed ?? raw.rhai_dump_confirmed ?? undefined,
          rhaiDumpCreatedAt:
            raw.rhaiDumpCreatedAt ?? raw.rhai_dump_created_at ?? undefined,
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
        const newStatus = String(payload?.status ?? cur.status) as any;
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

      await listen("task-error", async (_event) => {
        const payload: any = _event.payload as any;
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

          console.log(
            `全局监听器：任务 ${taskId} 收到错误事件:`,
            errorMessage,
            isCanceled ? "(已取消)" : "",
          );

          tasks.value[taskIndex] = {
            ...tasks.value[taskIndex],
            status: isCanceled ? ("canceled" as const) : ("failed" as const),
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
    } catch (error) {
      console.error("设置全局事件监听器失败:", error);
    }
  })();

  async function addTask(
    pluginId: string,
    outputDir?: string,
    userConfig?: Record<string, any>,
    outputAlbumId?: string,
    httpHeaders?: Record<string, string>,
  ) {
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
          status: "failed" as const,
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

  async function runConfig(configId: string) {
    const cfg = runConfigs.value.find((c) => c.id === configId);
    if (!cfg) {
      throw new Error("运行配置不存在");
    }
    await addTask(
      cfg.pluginId,
      cfg.outputDir,
      cfg.userConfig ?? {},
      undefined,
      cfg.httpHeaders ?? {},
    );
  }

  async function loadImages(reset = false) {
    try {
      if (reset) {
        images.value = [];
        hasMore.value = false;
      }

      const offset = images.value.length;
      const result = await invoke<RangedImages>("get_images_range", {
        offset,
        limit: pageSize.value,
      });

      if (reset) {
        images.value = result.images;
      } else {
        images.value.push(...result.images);
      }

      totalImages.value = result.total;
      hasMore.value = images.value.length < result.total;
    } catch (error) {
      console.error("加载图片失败:", error);
    }
  }

  function setPageSize(size: number) {
    pageSize.value = size;
  }

  async function loadImagesCount() {
    try {
      const count = await invoke<number>("get_images_count");
      totalImages.value = count;
    } catch (error) {
      console.error("获取图片总数失败:", error);
    }
  }

  async function deleteImage(imageId: string) {
    try {
      const image = images.value.find((img) => img.id === imageId);
      const taskId = image?.taskId;

      await invoke("delete_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);

      if (taskId) {
        try {
          const updatedTask = await invoke<{
            id: string;
            pluginId: string;
            outputDir?: string;
            userConfig?: Record<string, any>;
            outputAlbumId?: string;
            status: string;
            progress: number;
            deletedCount: number;
            startTime?: number;
            endTime?: number;
            error?: string;
          }>("get_task", { taskId });

          if (updatedTask) {
            const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              tasks.value[taskIndex].deletedCount = updatedTask.deletedCount;
            }
          }
        } catch (error) {
          console.error("更新任务 deletedCount 失败:", error);
        }
      }
    } catch (error) {
      console.error("删除图片失败:", error);
      throw error;
    }
  }

  async function removeImage(imageId: string) {
    try {
      const image = images.value.find((img) => img.id === imageId);
      const taskId = image?.taskId;

      await invoke("remove_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);

      if (taskId) {
        try {
          const updatedTask = await invoke<{
            id: string;
            pluginId: string;
            outputDir?: string;
            userConfig?: Record<string, any>;
            outputAlbumId?: string;
            status: string;
            progress: number;
            deletedCount: number;
            startTime?: number;
            endTime?: number;
            error?: string;
          }>("get_task", { taskId });

          if (updatedTask) {
            const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              tasks.value[taskIndex].deletedCount = updatedTask.deletedCount;
            }
          }
        } catch (error) {
          console.error("更新任务 deletedCount 失败:", error);
        }
      }
    } catch (error) {
      console.error("移除图片失败:", error);
      throw error;
    }
  }

  async function batchDeleteImages(
    imageIds: string[],
    _opts: { emitEvent?: boolean } = {},
  ) {
    try {
      // 在删除前收集所有相关的 taskId
      const taskIds = new Set<string>();
      for (const imageId of imageIds) {
        const image = images.value.find((img) => img.id === imageId);
        if (image?.taskId) {
          taskIds.add(image.taskId);
        }
      }

      await invoke("batch_delete_images", { imageIds });
      images.value = images.value.filter((img) => !imageIds.includes(img.id));

      // 更新所有相关任务的 deletedCount
      for (const taskId of taskIds) {
        try {
          const updatedTask = await invoke<{
            id: string;
            pluginId: string;
            outputDir?: string;
            userConfig?: Record<string, any>;
            outputAlbumId?: string;
            status: string;
            progress: number;
            deletedCount: number;
            startTime?: number;
            endTime?: number;
            error?: string;
          }>("get_task", { taskId });

          if (updatedTask) {
            const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              tasks.value[taskIndex].deletedCount = updatedTask.deletedCount;
            }
          }
        } catch (error) {
          console.error(`更新任务 ${taskId} deletedCount 失败:`, error);
        }
      }
    } catch (error) {
      console.error("批量删除图片失败:", error);
      throw error;
    }
  }

  async function batchRemoveImages(
    imageIds: string[],
    _opts: { emitEvent?: boolean } = {},
  ) {
    try {
      // 在移除前收集所有相关的 taskId
      const taskIds = new Set<string>();
      for (const imageId of imageIds) {
        const image = images.value.find((img) => img.id === imageId);
        if (image?.taskId) {
          taskIds.add(image.taskId);
        }
      }

      await invoke("batch_remove_images", { imageIds });
      images.value = images.value.filter((img) => !imageIds.includes(img.id));

      // 更新所有相关任务的 deletedCount
      for (const taskId of taskIds) {
        try {
          const updatedTask = await invoke<{
            id: string;
            pluginId: string;
            outputDir?: string;
            userConfig?: Record<string, any>;
            outputAlbumId?: string;
            status: string;
            progress: number;
            deletedCount: number;
            startTime?: number;
            endTime?: number;
            error?: string;
          }>("get_task", { taskId });

          if (updatedTask) {
            const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              tasks.value[taskIndex].deletedCount = updatedTask.deletedCount;
            }
          }
        } catch (error) {
          console.error(`更新任务 ${taskId} deletedCount 失败:`, error);
        }
      }
    } catch (error) {
      console.error("批量移除图片失败:", error);
      throw error;
    }
  }

  async function applyRemovedImageIds(imageIds: string[]) {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    const before = images.value.length;

    const taskIdsSet = new Set<string>();
    images.value.forEach((img) => {
      if (idSet.has(img.id) && img.taskId) {
        taskIdsSet.add(img.taskId);
      }
    });

    images.value = images.value.filter((img) => !idSet.has(img.id));
    const removed = before - images.value.length;
    if (removed > 0) {
      totalImages.value = Math.max(0, totalImages.value - removed);
      hasMore.value = images.value.length < totalImages.value;
    }

    if (taskIdsSet.size > 0) {
      const taskIds = Array.from(taskIdsSet);
      for (const taskId of taskIds) {
        try {
          const updatedTask = await invoke<{
            id: string;
            pluginId: string;
            outputDir?: string;
            userConfig?: Record<string, any>;
            outputAlbumId?: string;
            status: string;
            progress: number;
            deletedCount: number;
            startTime?: number;
            endTime?: number;
            error?: string;
          }>("get_task", { taskId });

          if (updatedTask) {
            const taskIndex = tasks.value.findIndex((t) => t.id === taskId);
            if (taskIndex !== -1) {
              tasks.value[taskIndex].deletedCount = updatedTask.deletedCount;
            }
          }
        } catch (error) {
          console.error(`更新任务 ${taskId} deletedCount 失败:`, error);
        }
      }
    }
  }

  const imagesByPlugin = computed(() => {
    const grouped: Record<string, ImageInfo[]> = {};
    images.value.forEach((img) => {
      if (!grouped[img.pluginId]) {
        grouped[img.pluginId] = [];
      }
      grouped[img.pluginId].push(img);
    });
    return grouped;
  });

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
          startTime?: number;
          endTime?: number;
          error?: string;
          rhaiDumpPresent?: boolean;
          rhaiDumpConfirmed?: boolean;
          rhaiDumpCreatedAt?: number;
        }>
      >("get_all_tasks");

      tasks.value = finalTasks.map((t) => ({
        id: t.id,
        pluginId: t.pluginId,
        outputDir: t.outputDir,
        userConfig: t.userConfig,
        outputAlbumId: t.outputAlbumId,
        status: t.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "canceled",
        progress: t.progress ?? 0,
        deletedCount: t.deletedCount || 0,
        startTime: t.startTime,
        endTime: t.endTime,
        error: t.error,
        rhaiDumpPresent: t.rhaiDumpPresent,
        rhaiDumpConfirmed: t.rhaiDumpConfirmed,
        rhaiDumpCreatedAt: t.rhaiDumpCreatedAt,
      }));
    } catch (error) {
      console.error("加载任务失败:", error);
    }
  }

  async function confirmTaskRhaiDump(taskId: string) {
    await invoke("confirm_task_rhai_dump", { taskId });
    const idx = tasks.value.findIndex((t) => t.id === taskId);
    if (idx !== -1) {
      tasks.value[idx] = {
        ...tasks.value[idx],
        rhaiDumpConfirmed: true,
      };
    }
  }

  async function getTaskImages(taskId: string): Promise<ImageInfo[]> {
    try {
      return await invoke<ImageInfo[]>("get_task_images", { taskId });
    } catch (error) {
      console.error("获取任务图片失败:", error);
      return [];
    }
  }

  async function getTaskImagesPaginated(
    taskId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedImages> {
    try {
      return await invoke<PaginatedImages>("get_task_images_paginated", {
        taskId,
        page,
        pageSize,
      });
    } catch (error) {
      console.error("获取任务图片失败:", error);
      return { images: [], total: 0, page: 0, pageSize: 0 };
    }
  }

  async function retryTask(task: CrawlTask) {
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
    images,
    isCrawling,
    imagesByPlugin,
    totalImages,
    pageSize,
    hasMore,
    setPageSize,
    addTask,
    loadImages,
    loadImagesCount,
    deleteImage,
    removeImage,
    batchDeleteImages,
    batchRemoveImages,
    applyRemovedImageIds,
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
    confirmTaskRhaiDump,
    getTaskImages,
    getTaskImagesPaginated,
  };
});
