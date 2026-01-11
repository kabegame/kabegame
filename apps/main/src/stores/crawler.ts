import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface CrawlTask {
  id: string;
  pluginId: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  outputAlbumId?: string; // 输出画册ID，如果指定则下载完成后自动添加到画册
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
  /**
   * 后端提供：本地文件是否存在。
   * - false：源文件已丢失/移动（仍展示条目，但 UI 会提示）
   * - true/undefined：认为存在或未知（兼容旧数据）
   */
  localExists?: boolean;
  pluginId: string;
  taskId?: string;
  crawledAt: number;
  metadata?: Record<string, any>;
  thumbnailPath: string;
  favorite?: boolean;
  hash: string;
  order?: number;

  // TaskDetail：失败图片占位（不入库 images）
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
  createdAt: number;
}

export const useCrawlerStore = defineStore("crawler", () => {
  const tasks = ref<CrawlTask[]>([]);
  const images = ref<ImageInfo[]>([]);
  const isCrawling = ref(false);
  const totalImages = ref(0);
  const pageSize = ref(50); // 每页50张图片
  const hasMore = ref(false);
  const runConfigs = ref<RunConfig[]>([]);

  // 进度事件节流：后端可能高频发送 task-progress（尤其是本地导入/递归扫描时）
  // 如果每条都触发响应式更新，会导致大量重渲染，出现“界面卡死/无法交互”。
  const lastProgressUpdateAt = new Map<string, number>();

  // 初始化全局事件监听器
  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");

      // 任务状态变化（后端 task worker 驱动）
      await listen<{
        taskId: string;
        status: string;
        startTime?: number;
        endTime?: number;
        error?: string;
      }>("task-status", async (event) => {
        const idx = tasks.value.findIndex((t) => t.id === event.payload.taskId);
        if (idx === -1) return;

        const cur = tasks.value[idx];
        const next: CrawlTask = {
          ...cur,
          status: event.payload.status as any,
          startTime: event.payload.startTime ?? cur.startTime,
          endTime: event.payload.endTime ?? cur.endTime,
          error: event.payload.error ?? cur.error,
          // 后端标 completed 时，兜底把进度置 100
          progress:
            event.payload.status === "completed" ? 100 : cur.progress ?? 0,
        };
        tasks.value[idx] = next;
      });

      // 任务进度（Rhai add_progress 驱动）
      await listen<{ taskId: string; progress: number }>(
        "task-progress",
        async (event) => {
          const idx = tasks.value.findIndex(
            (t) => t.id === event.payload.taskId
          );
          if (idx === -1) return;
          const cur = tasks.value[idx];
          const newProgress = event.payload.progress;
          if (newProgress <= (cur.progress ?? 0)) return;

          // 节流：同一 task 的进度更新最多 ~10fps（或最终 100% 立即更新）
          const now = Date.now();
          const lastAt = lastProgressUpdateAt.get(event.payload.taskId) ?? 0;
          if (newProgress < 100 && now - lastAt < 100) return;
          lastProgressUpdateAt.set(event.payload.taskId, now);

          const next: CrawlTask = { ...cur, progress: newProgress };
          tasks.value[idx] = next;
        }
      );

      // 全局错误监听器（作为备用，确保所有错误都能被捕获）
      await listen<{ taskId: string; error: string }>(
        "task-error",
        async (_event) => {
          const taskIndex = tasks.value.findIndex(
            (t) => t.id === _event.payload.taskId
          );
          if (
            taskIndex !== -1 &&
            tasks.value[taskIndex].status !== "failed" &&
            tasks.value[taskIndex].status !== "canceled"
          ) {
            const errorMessage = _event.payload.error;
            const isCanceled = errorMessage.includes("Task canceled");

            console.log(
              `全局监听器：任务 ${_event.payload.taskId} 收到错误事件:`,
              errorMessage,
              isCanceled ? "(已取消)" : ""
            );

            tasks.value[taskIndex] = {
              ...tasks.value[taskIndex],
              status: isCanceled ? ("canceled" as const) : ("failed" as const),
              error: errorMessage,
              progress: 0,
              endTime: Date.now(),
            };

            // 只有在非取消的情况下才触发错误显示事件
            if (!isCanceled) {
              window.dispatchEvent(
                new CustomEvent("task-error-display", {
                  detail: {
                    taskId: _event.payload.taskId,
                    pluginId: tasks.value[taskIndex].pluginId,
                    error: errorMessage,
                  },
                })
              );
            }
          }
        }
      );

      // 注意：image-added 事件由 Gallery.vue 处理增量刷新，
      // store 不再全局监听，避免与 Gallery 的增量刷新逻辑冲突导致闪烁和批量出现问题
    } catch (error) {
      console.error("设置全局事件监听器失败:", error);
    }
  })();

  // 添加爬取任务
  async function addTask(
    pluginId: string,
    outputDir?: string,
    userConfig?: Record<string, any>,
    outputAlbumId?: string
  ) {
    const task: CrawlTask = {
      // 批量添加时 Date.now().toString() 可能碰撞，导致任务覆盖/异常
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pluginId,
      outputDir,
      userConfig,
      outputAlbumId,
      status: "pending",
      progress: 0,
      deletedCount: 0,
      startTime: Date.now(),
    };

    tasks.value.unshift(task);

    // 异步执行任务，不等待完成
    // 任务状态会通过事件或内部状态更新
    startCrawl(task).catch(async (error) => {
      // 如果任务还没有被标记为失败或取消，则标记为失败
      // 这作为最后的保障，确保失败的任务状态被正确设置
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

        // 更新任务失败状态到 SQLite
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

  // 开始爬取
  async function startCrawl(task: CrawlTask) {
    // 如果任务已经是失败或取消状态，不应该重新启动
    if (task.status === "failed" || task.status === "canceled") {
      console.log(
        `任务 ${task.id} 已经是${
          task.status === "canceled" ? "取消" : "失败"
        }状态，不重新启动`
      );
      return;
    }

    try {
      // 新逻辑：后端固定 10 个 task worker 调度
      // 合并落库 + 入队：直接 start_task 并立刻返回；running/pending/failed 等状态由后端通过事件驱动更新
      await invoke("start_task", {
        task: {
          id: task.id,
          pluginId: task.pluginId,
          outputDir: task.outputDir,
          userConfig: task.userConfig,
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
      // 不立即标记失败，等待脚本在 download_image/add_progress 检测到取消后抛错，
      // 由 task-error 事件驱动前端状态更新
    } catch (error) {
      console.error("终止任务失败:", error);
      throw error;
    }
  }

  // 运行配置相关
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
    }
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
    };
    await invoke("add_run_config", { config: cfg });
    await loadRunConfigs();
    return cfg;
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
    await addTask(cfg.pluginId, cfg.outputDir, cfg.userConfig ?? {});
  }

  // 获取图片列表（已改为 offset+limit 模式，不再使用 page）
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

  // 获取图片总数
  async function loadImagesCount() {
    try {
      const count = await invoke<number>("get_images_count");
      totalImages.value = count;
    } catch (error) {
      console.error("获取图片总数失败:", error);
    }
  }

  // 删除图片
  async function deleteImage(imageId: string) {
    try {
      // 先获取图片信息，以便知道属于哪个任务
      const image = images.value.find((img) => img.id === imageId);
      const taskId = image?.taskId;

      await invoke("delete_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);

      // 发送全局事件通知其他页面图片已被删除（传递图片ID以便其他页面更新）
      window.dispatchEvent(
        new CustomEvent("images-deleted", {
          detail: { imageIds: [imageId] },
        })
      );

      // 如果图片属于某个任务，重新获取任务信息以更新 deletedCount
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
          // 忽略错误，不影响主流程
        }
      }
    } catch (error) {
      console.error("删除图片失败:", error);
      throw error;
    }
  }

  // 移除图片（只删除缩略图和数据库记录，不删除原图）
  async function removeImage(imageId: string) {
    try {
      // 先获取图片信息，以便知道属于哪个任务
      const image = images.value.find((img) => img.id === imageId);
      const taskId = image?.taskId;

      await invoke("remove_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);

      // 发送全局事件通知其他页面图片已被移除（传递图片ID以便其他页面更新）
      window.dispatchEvent(
        new CustomEvent("images-removed", {
          detail: { imageIds: [imageId] },
        })
      );

      // 如果图片属于某个任务，重新获取任务信息以更新 deletedCount
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
          // 忽略错误，不影响主流程
        }
      }
    } catch (error) {
      console.error("移除图片失败:", error);
      throw error;
    }
  }

  // 批量删除图片（删除文件和数据库记录）
  async function batchDeleteImages(
    imageIds: string[],
    opts: { emitEvent?: boolean } = {}
  ) {
    try {
      await invoke("batch_delete_images", { imageIds });
      // 从本地 store 中移除图片
      images.value = images.value.filter((img) => !imageIds.includes(img.id));

      // 发送全局事件通知其他页面图片已被批量删除（传递图片ID以便其他页面更新）
      const emitEvent = opts.emitEvent ?? true;
      if (emitEvent) {
        window.dispatchEvent(
          new CustomEvent("images-deleted", {
            detail: { imageIds },
          })
        );
      }
    } catch (error) {
      console.error("批量删除图片失败:", error);
      throw error;
    }
  }

  // 批量移除图片（仅删除数据库记录，不删除文件）
  async function batchRemoveImages(
    imageIds: string[],
    opts: { emitEvent?: boolean } = {}
  ) {
    try {
      await invoke("batch_remove_images", { imageIds });
      // 从本地 store 中移除图片
      images.value = images.value.filter((img) => !imageIds.includes(img.id));

      // 发送全局事件通知其他页面图片已被批量移除（传递图片ID以便其他页面更新）
      const emitEvent = opts.emitEvent ?? true;
      if (emitEvent) {
        window.dispatchEvent(
          new CustomEvent("images-removed", {
            detail: { imageIds },
          })
        );
      }
    } catch (error) {
      console.error("批量移除图片失败:", error);
      throw error;
    }
  }

  // 批量从本地 store 中移除图片（用于后端批量操作后的 UI 同步）
  async function applyRemovedImageIds(imageIds: string[]) {
    if (!imageIds || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    const before = images.value.length;

    // 在移除前，收集被移除图片的 taskId（用于后续更新任务的 deletedCount）
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

    // 更新受影响的任务的 deletedCount
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
          // 忽略错误，不影响主流程
        }
      }
    }
  }

  // 按插件ID筛选图片
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

  // 删除任务
  async function deleteTask(taskId: string) {
    // 从 SQLite 删除任务（会同时删除关联的图片）
    try {
      await invoke("delete_task", { taskId });
    } catch (error) {
      console.error("从数据库删除任务失败:", error);
    }

    // 从内存中删除
    const index = tasks.value.findIndex((t) => t.id === taskId);
    if (index !== -1) {
      tasks.value.splice(index, 1);
    }
  }

  // 加载所有任务（从 SQLite）
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

      // 新逻辑：pending 是“排队中”的合法状态；running 由后端 task worker 驱动。
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

  // 获取任务的已下载图片
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
    pageSize: number
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

  // 重新运行任务（不删除旧任务，创建新任务）
  async function retryTask(task: CrawlTask) {
    // 创建新任务（不删除旧任务，保留已下载的图片）
    return await addTask(
      task.pluginId,
      task.outputDir,
      task.userConfig,
      task.outputAlbumId
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
    deleteRunConfig,
    runConfig,
    loadTasks,
    confirmTaskRhaiDump,
    getTaskImages,
    getTaskImagesPaginated,
  };
});
