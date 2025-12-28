import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface CrawlTask {
  id: string;
  pluginId: string;
  url: string;
  outputDir?: string;
  userConfig?: Record<string, any>;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  totalImages: number;
  downloadedImages: number;
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface ImageInfo {
  id: string;
  url: string;
  localPath: string;
  pluginId: string;
  crawledAt: number;
  metadata?: Record<string, any>;
  thumbnailPath: string;
  favorite?: boolean;
  hash: string;
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
  const currentPage = ref(0);
  const pageSize = ref(50); // 每页50张图片
  const hasMore = ref(true);
  const runConfigs = ref<RunConfig[]>([]);

  // 初始化全局事件监听器
  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");

      // 全局错误监听器（作为备用，确保所有错误都能被捕获）
      await listen<{ taskId: string; error: string }>(
        "task-error",
        (_event) => {
          const taskIndex = tasks.value.findIndex(
            (t) => t.id === _event.payload.taskId
          );
          if (taskIndex !== -1 && tasks.value[taskIndex].status !== "failed") {
            console.log(
              `全局监听器：任务 ${_event.payload.taskId} 收到错误事件:`,
              _event.payload.error
            );

            tasks.value[taskIndex] = {
              ...tasks.value[taskIndex],
              status: "failed" as const,
              error: _event.payload.error,
              progress: 0,
              endTime: Date.now(),
            };

            // 触发错误显示事件，确保用户能看到错误消息
            window.dispatchEvent(
              new CustomEvent("task-error-display", {
                detail: {
                  taskId: _event.payload.taskId,
                  pluginId: tasks.value[taskIndex].pluginId,
                  error: _event.payload.error,
                },
              })
            );
          }
        }
      );

      // 图片添加事件监听器：当有新图片下载完成时，刷新画廊
      let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
      await listen<{ taskId: string; imageId: string }>(
        "image-added",
        async (_event) => {
          if (refreshTimeout) {
            clearTimeout(refreshTimeout);
          }
          refreshTimeout = setTimeout(async () => {
            await loadImages(true);
            refreshTimeout = null;
          }, 500);
        }
      );
    } catch (error) {
      console.error("设置全局事件监听器失败:", error);
    }
  })();

  // 添加爬取任务
  async function addTask(
    pluginId: string,
    url: string,
    outputDir?: string,
    userConfig?: Record<string, any>
  ) {
    const task: CrawlTask = {
      id: Date.now().toString(),
      pluginId,
      url,
      outputDir,
      userConfig,
      status: "pending",
      progress: 0,
      totalImages: 0,
      downloadedImages: 0,
      startTime: Date.now(),
    };

    // 保存任务到 SQLite
    try {
      await invoke("add_task", {
        task: {
          id: task.id,
          pluginId: task.pluginId,
          url: task.url,
          outputDir: task.outputDir,
          userConfig: task.userConfig,
          status: task.status,
          progress: task.progress,
          totalImages: task.totalImages,
          downloadedImages: task.downloadedImages,
          startTime: task.startTime,
          endTime: task.endTime,
          error: task.error,
        },
      });
    } catch (error) {
      console.error("保存任务到数据库失败:", error);
    }

    tasks.value.unshift(task);

    // 异步执行任务，不等待完成
    // 任务状态会通过事件或内部状态更新
    startCrawl(task).catch(async (error) => {
      // 如果任务还没有被标记为失败，则标记为失败
      // 这作为最后的保障，确保失败的任务状态被正确设置
      const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
      if (taskIndex !== -1 && tasks.value[taskIndex].status !== "failed") {
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
              url: tasks.value[taskIndex].url,
              outputDir: tasks.value[taskIndex].outputDir,
              userConfig: tasks.value[taskIndex].userConfig,
              status: tasks.value[taskIndex].status,
              progress: tasks.value[taskIndex].progress,
              totalImages: tasks.value[taskIndex].totalImages,
              downloadedImages: tasks.value[taskIndex].downloadedImages,
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
    // 如果任务已经是失败状态，不应该重新启动
    if (task.status === "failed") {
      console.log(`任务 ${task.id} 已经是失败状态，不重新启动`);
      return;
    }

    const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
    if (taskIndex !== -1) {
      tasks.value[taskIndex] = {
        ...tasks.value[taskIndex],
        status: "running" as const,
      };
    }
    isCrawling.value = true;

    // 更新任务状态到 SQLite
    try {
      await invoke("update_task", {
        task: {
          id: task.id,
          pluginId: task.pluginId,
          url: task.url,
          outputDir: task.outputDir,
          userConfig: task.userConfig,
          status: task.status,
          progress: task.progress,
          totalImages: task.totalImages,
          downloadedImages: task.downloadedImages,
          startTime: task.startTime,
          endTime: task.endTime,
          error: task.error,
        },
      });
    } catch (error) {
      console.error("更新任务运行状态到数据库失败:", error);
    }

    let unlistenProgress: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let errorReceived = false; // 标记是否收到错误事件
    let errorDisplayTriggered = false; // 标记是否已触发错误显示事件

    try {
      console.log("开始执行爬取任务:", task);

      // 先设置监听器，确保能捕获所有事件（包括快速失败的情况）
      const { listen } = await import("@tauri-apps/api/event");

      // 监听任务错误事件（必须在 invoke 之前设置）
      unlistenError = await listen<{ taskId: string; error: string }>(
        "task-error",
        async (event) => {
          if (event.payload.taskId === task.id) {
            console.log(`任务 ${task.id} 收到错误事件:`, event.payload.error);
            errorReceived = true;

            // 通过更新 tasks 数组来确保响应式更新
            const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
            if (
              taskIndex !== -1 &&
              tasks.value[taskIndex].status !== "failed"
            ) {
              // 创建新对象以确保响应式更新
              const updatedTask = {
                ...tasks.value[taskIndex],
                status: "failed" as const,
                error: event.payload.error,
                progress: 0,
                endTime: Date.now(),
              };
              tasks.value[taskIndex] = updatedTask;

              console.log(
                `任务 ${task.id} 状态已通过事件更新为失败:`,
                tasks.value[taskIndex].status,
                tasks.value[taskIndex].error
              );

              // 更新任务状态到 SQLite
              try {
                await invoke("update_task", {
                  task: {
                    id: updatedTask.id,
                    pluginId: updatedTask.pluginId,
                    url: updatedTask.url,
                    outputDir: updatedTask.outputDir,
                    userConfig: updatedTask.userConfig,
                    status: updatedTask.status,
                    progress: updatedTask.progress,
                    totalImages: updatedTask.totalImages,
                    downloadedImages: updatedTask.downloadedImages,
                    startTime: updatedTask.startTime,
                    endTime: updatedTask.endTime,
                    error: updatedTask.error,
                  },
                });
              } catch (error) {
                console.error("更新任务失败状态到数据库失败:", error);
              }

              // 只触发一次错误显示（通过事件通知 UI 层）
              // 使用自定义事件通知 UI 层显示错误弹窗
              if (!errorDisplayTriggered) {
                errorDisplayTriggered = true;
                window.dispatchEvent(
                  new CustomEvent("task-error-display", {
                    detail: {
                      taskId: task.id,
                      pluginId: task.pluginId,
                      error: event.payload.error,
                    },
                  })
                );
              } else {
                console.log(
                  `任务 ${task.id} 的错误显示事件已触发过，跳过重复触发`
                );
              }
            }
          }
        }
      );

      // 监听任务进度更新事件
      unlistenProgress = await listen<{ taskId: string; progress: number }>(
        "task-progress",
        async (event) => {
          if (event.payload.taskId === task.id) {
            // 确保进度不会降低，只能增加
            const newProgress = event.payload.progress;
            const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
            if (
              taskIndex !== -1 &&
              newProgress > tasks.value[taskIndex].progress
            ) {
              // 通过创建新对象来确保响应式更新
              tasks.value[taskIndex] = {
                ...tasks.value[taskIndex],
                progress: newProgress,
              };

              // 更新任务进度到 SQLite
              try {
                await invoke("update_task", {
                  task: {
                    id: tasks.value[taskIndex].id,
                    pluginId: tasks.value[taskIndex].pluginId,
                    url: tasks.value[taskIndex].url,
                    outputDir: tasks.value[taskIndex].outputDir,
                    userConfig: tasks.value[taskIndex].userConfig,
                    status: tasks.value[taskIndex].status,
                    progress: tasks.value[taskIndex].progress,
                    totalImages: tasks.value[taskIndex].totalImages,
                    downloadedImages: tasks.value[taskIndex].downloadedImages,
                    startTime: tasks.value[taskIndex].startTime,
                    endTime: tasks.value[taskIndex].endTime,
                    error: tasks.value[taskIndex].error,
                  },
                });
              } catch (error) {
                console.error("更新任务进度到数据库失败:", error);
              }
            }
          }
        }
      );

      const result = await invoke<{
        total: number;
        downloaded: number;
        images: Array<{
          url: string;
          localPath: string;
          metadata?: Record<string, any>;
          thumbnailPath: string;
        }>;
      }>("crawl_images_command", {
        pluginId: task.pluginId,
        url: task.url,
        taskId: task.id,
        outputDir: task.outputDir,
        userConfig: task.userConfig,
      });

      console.log("爬取任务完成:", result);

      // 取消监听
      if (unlistenProgress) unlistenProgress();
      if (unlistenError) unlistenError();

      const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
      if (taskIndex !== -1) {
        tasks.value[taskIndex] = {
          ...tasks.value[taskIndex],
          totalImages: result.total,
          downloadedImages: result.downloaded,
          progress: 100,
          status: "completed" as const,
          endTime: Date.now(),
        };

        // 更新任务完成状态到 SQLite
        try {
          await invoke("update_task", {
            task: {
              id: tasks.value[taskIndex].id,
              pluginId: tasks.value[taskIndex].pluginId,
              url: tasks.value[taskIndex].url,
              outputDir: tasks.value[taskIndex].outputDir,
              userConfig: tasks.value[taskIndex].userConfig,
              status: tasks.value[taskIndex].status,
              progress: tasks.value[taskIndex].progress,
              totalImages: tasks.value[taskIndex].totalImages,
              downloadedImages: tasks.value[taskIndex].downloadedImages,
              startTime: tasks.value[taskIndex].startTime,
              endTime: tasks.value[taskIndex].endTime,
              error: tasks.value[taskIndex].error,
            },
          });
        } catch (error) {
          console.error("更新任务完成状态到数据库失败:", error);
        }
      }

      // 图片信息已由后端保存到全局 store，这里不需要再添加
      // 刷新图片列表
      await loadImages(true);
    } catch (error) {
      // 取消监听
      if (unlistenProgress) unlistenProgress();
      if (unlistenError) unlistenError();

      console.log(
        `任务 ${task.id} 执行失败:`,
        error,
        "当前状态:",
        task.status,
        "是否收到错误事件:",
        errorReceived
      );

      // 如果已经通过错误事件更新了状态，不需要再次更新或触发弹窗
      // 检查任务在数组中的实际状态
      const taskIndex = tasks.value.findIndex((t) => t.id === task.id);
      const currentTask = taskIndex !== -1 ? tasks.value[taskIndex] : null;

      if (currentTask && currentTask.status === "failed" && errorReceived) {
        // 已经通过错误事件更新，不需要再次更新或触发弹窗
        console.log(`任务 ${task.id} 状态已通过错误事件更新，无需再次更新`);
        return; // 直接返回，避免后续处理
      }

      // 需要更新状态（只有在没有收到错误事件的情况下）
      if (!errorReceived && taskIndex !== -1) {
        const errorMessage =
          error instanceof Error ? error.message : "爬取失败";

        // 通过更新 tasks 数组来确保响应式更新
        const updatedTask = {
          ...tasks.value[taskIndex],
          status: "failed" as const,
          error: errorMessage,
          progress: 0,
          endTime: Date.now(),
        };
        tasks.value[taskIndex] = updatedTask;

        console.log(
          `任务 ${task.id} 状态已更新为失败:`,
          tasks.value[taskIndex].status,
          tasks.value[taskIndex].error
        );

        // 更新任务失败状态到 SQLite
        try {
          await invoke("update_task", {
            task: {
              id: updatedTask.id,
              pluginId: updatedTask.pluginId,
              url: updatedTask.url,
              outputDir: updatedTask.outputDir,
              userConfig: updatedTask.userConfig,
              status: updatedTask.status,
              progress: updatedTask.progress,
              totalImages: updatedTask.totalImages,
              downloadedImages: updatedTask.downloadedImages,
              startTime: updatedTask.startTime,
              endTime: updatedTask.endTime,
              error: updatedTask.error,
            },
          });
        } catch (error) {
          console.error("更新任务失败状态到数据库失败:", error);
        }

        // 触发错误显示事件（只有在没有收到错误事件且未触发过的情况下）
        if (!errorDisplayTriggered) {
          errorDisplayTriggered = true;
          window.dispatchEvent(
            new CustomEvent("task-error-display", {
              detail: {
                taskId: task.id,
                pluginId: task.pluginId,
                error: errorMessage,
              },
            })
          );
        } else {
          console.log(`任务 ${task.id} 的错误显示事件已触发过，跳过重复触发`);
        }
      }

      // 任务失败时，不抛出错误，让 watch 监听处理显示
      // 这样确保所有失败的任务都能正确显示错误状态
      return;
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
      userConfig: config.userConfig,
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
    await addTask(cfg.pluginId, cfg.url, cfg.outputDir, cfg.userConfig);
  }

  // 获取图片列表（分页）
  async function loadImages(
    reset = false,
    pluginId?: string | null,
    favoritesOnly?: boolean
  ) {
    try {
      if (reset) {
        currentPage.value = 0;
        images.value = [];
        hasMore.value = true;
      }

      const page = currentPage.value;
      const result = await invoke<{
        images: ImageInfo[];
        total: number;
        page: number;
        pageSize: number;
      }>("get_images_paginated", {
        page,
        pageSize: pageSize.value,
        pluginId: pluginId || null,
        favoritesOnly: favoritesOnly || null,
      });

      if (reset) {
        images.value = result.images;
      } else {
        images.value.push(...result.images);
      }

      totalImages.value = result.total;
      hasMore.value = (page + 1) * pageSize.value < result.total;
      currentPage.value = page + 1;
    } catch (error) {
      console.error("加载图片失败:", error);
    }
  }

  function setPageSize(size: number) {
    pageSize.value = size;
  }

  // 获取图片总数
  async function loadImagesCount(pluginId?: string | null) {
    try {
      const count = await invoke<number>("get_images_count", {
        pluginId: pluginId || null,
      });
      totalImages.value = count;
    } catch (error) {
      console.error("获取图片总数失败:", error);
    }
  }

  // 删除图片
  async function deleteImage(imageId: string) {
    try {
      await invoke("delete_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);
    } catch (error) {
      console.error("删除图片失败:", error);
      throw error;
    }
  }

  // 移除图片（只删除缩略图和数据库记录，不删除原图）
  async function removeImage(imageId: string) {
    try {
      await invoke("remove_image", { imageId });
      images.value = images.value.filter((img) => img.id !== imageId);
    } catch (error) {
      console.error("移除图片失败:", error);
      throw error;
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
      const dbTasks = await invoke<
        Array<{
          id: string;
          pluginId: string;
          url: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          status: string;
          progress: number;
          totalImages: number;
          downloadedImages: number;
          startTime?: number;
          endTime?: number;
          error?: string;
        }>
      >("get_all_tasks");

      // 处理迁移遗留的无效任务：将所有 pending 状态的任务标记为失败
      // 因为如果任务真的在运行，状态应该是 "running"，pending 状态表示任务从未真正开始
      const now = Date.now();
      const invalidTasks: string[] = [];

      for (const task of dbTasks) {
        // 如果任务处于 pending 状态，直接标记为失败（迁移遗留的无效任务）
        if (task.status === "pending") {
          invalidTasks.push(task.id);
          // 更新任务状态为失败
          try {
            await invoke("update_task", {
              task: {
                id: task.id,
                pluginId: task.pluginId,
                url: task.url,
                outputDir: task.outputDir,
                userConfig: task.userConfig,
                status: "failed",
                progress: 0,
                totalImages: task.totalImages,
                downloadedImages: task.downloadedImages,
                startTime: task.startTime || now,
                endTime: task.endTime || now,
                error: "任务已过期（迁移遗留的无效任务，原状态：pending）",
              },
            });
            console.log(`已将无效的 pending 任务 ${task.id} 标记为失败`);
          } catch (error) {
            console.error(`更新无效任务 ${task.id} 状态失败:`, error);
          }
        }
      }

      if (invalidTasks.length > 0) {
        console.log(
          `发现并修复了 ${invalidTasks.length} 个无效的 pending 任务`
        );
      }

      // 重新加载任务列表（获取更新后的状态）
      const updatedTasks = await invoke<
        Array<{
          id: string;
          pluginId: string;
          url: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          status: string;
          progress: number;
          totalImages: number;
          downloadedImages: number;
          startTime?: number;
          endTime?: number;
          error?: string;
        }>
      >("get_all_tasks");

      // 处理 running 状态的任务：如果任务状态是 running 但已经结束（有 endTime），标记为失败
      // 因为应用重启后，running 状态的任务实际上已经停止了
      for (const task of updatedTasks) {
        if (task.status === "running" && task.endTime) {
          // running 状态但已有 endTime，说明任务已经结束但状态未更新，标记为失败
          try {
            await invoke("update_task", {
              task: {
                id: task.id,
                pluginId: task.pluginId,
                url: task.url,
                outputDir: task.outputDir,
                userConfig: task.userConfig,
                status: "failed",
                progress: task.progress,
                totalImages: task.totalImages,
                downloadedImages: task.downloadedImages,
                startTime: task.startTime,
                endTime: task.endTime,
                error: task.error || "任务在应用重启前未正确结束",
              },
            });
            console.log(`已将异常的 running 任务 ${task.id} 标记为失败`);
          } catch (error) {
            console.error(`更新异常 running 任务 ${task.id} 状态失败:`, error);
          }
        } else if (task.status === "running" && !task.endTime) {
          // running 状态但没有 endTime，可能是应用崩溃导致，也标记为失败
          try {
            await invoke("update_task", {
              task: {
                id: task.id,
                pluginId: task.pluginId,
                url: task.url,
                outputDir: task.outputDir,
                userConfig: task.userConfig,
                status: "failed",
                progress: task.progress,
                totalImages: task.totalImages,
                downloadedImages: task.downloadedImages,
                startTime: task.startTime,
                endTime: now,
                error:
                  task.error || "任务在应用重启前未正确结束（原状态：running）",
              },
            });
            console.log(`已将异常的 running 任务 ${task.id} 标记为失败`);
          } catch (error) {
            console.error(`更新异常 running 任务 ${task.id} 状态失败:`, error);
          }
        }
      }

      // 重新加载任务列表（获取更新后的状态）
      const finalTasks = await invoke<
        Array<{
          id: string;
          pluginId: string;
          url: string;
          outputDir?: string;
          userConfig?: Record<string, any>;
          status: string;
          progress: number;
          totalImages: number;
          downloadedImages: number;
          startTime?: number;
          endTime?: number;
          error?: string;
        }>
      >("get_all_tasks");

      // 加载所有任务到内存（包括失败和已完成的任务）
      // 应用重启后，所有 running 任务都应该被标记为失败
      tasks.value = finalTasks
        .filter((t) => t.status === "failed" || t.status === "completed")
        .map((t) => ({
          id: t.id,
          pluginId: t.pluginId,
          url: t.url,
          outputDir: t.outputDir,
          userConfig: t.userConfig,
          status: t.status as "pending" | "running" | "completed" | "failed",
          progress: t.progress,
          totalImages: t.totalImages,
          downloadedImages: t.downloadedImages,
          startTime: t.startTime,
          endTime: t.endTime,
          error: t.error,
        }));
    } catch (error) {
      console.error("加载任务失败:", error);
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
      task.url,
      task.outputDir,
      task.userConfig
    );
  }

  return {
    tasks,
    images,
    isCrawling,
    imagesByPlugin,
    totalImages,
    currentPage,
    pageSize,
    hasMore,
    setPageSize,
    addTask,
    loadImages,
    loadImagesCount,
    deleteImage,
    removeImage,
    deleteTask,
    stopTask,
    retryTask,
    runConfigs,
    loadRunConfigs,
    addRunConfig,
    deleteRunConfig,
    runConfig,
    loadTasks,
    getTaskImages,
    getTaskImagesPaginated,
  };
});
