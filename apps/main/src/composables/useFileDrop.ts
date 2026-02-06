import { ref, Ref, onUnmounted } from "vue";
import { ElMessage } from "element-plus";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { stat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import FileDropOverlay from "@/components/FileDropOverlay.vue";
import ImportConfirmDialog from "@/components/import/ImportConfirmDialog.vue";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import { useCrawlerStore } from "@/stores/crawler";
import { useAlbumStore } from "@/stores/albums";
import { usePluginStore } from "@/stores/plugins";

// 支持的图片格式
const SUPPORTED_IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
];
let SUPPORTED_ARCHIVE_EXTENSIONS = ["zip", "rar"]; // 默认值，会从后端更新
let SUPPORTED_KGPG_EXTENSIONS = ["kgpg"]; // 默认值，会从后端更新

// 让出 UI：避免在一次性批量导入/创建任务时长时间占用主线程导致"界面卡死"
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// 从文件路径提取扩展名（小写，不含点号）
const getFileExtension = (filePath: string): string => {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot >= 0 && lastDot < filePath.length - 1) {
    return filePath.substring(lastDot + 1).toLowerCase();
  }
  return "";
};

// 检查文件是否为支持的图片格式
const isSupportedImageFile = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
};

// 检查文件是否为支持的压缩包
const isArchiveFile = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return SUPPORTED_ARCHIVE_EXTENSIONS.includes(ext);
};

// 检查文件是否为 kgpg 插件包
const isKgpgFile = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return SUPPORTED_KGPG_EXTENSIONS.includes(ext);
};

// 辅助函数：从文件路径提取目录路径
const getDirectoryFromPath = (filePath: string): string => {
  const lastSlash = Math.max(
    filePath.lastIndexOf("\\"),
    filePath.lastIndexOf("/"),
  );
  if (lastSlash >= 0) {
    return filePath.substring(0, lastSlash);
  }
  return "";
};

export interface ImportItem {
  path: string;
  name: string;
  isDirectory: boolean;
  isArchive?: boolean;
  isKgpg?: boolean;
}

/**
 * 文件拖拽 composable
 */
export function useFileDrop(
  fileDropOverlayRef: Ref<any>,
  importConfirmDialogRef: Ref<any>,
) {
  const taskDrawerStore = useTaskDrawerStore();
  const crawlerStore = useCrawlerStore();
  const albumStore = useAlbumStore();
  const pluginStore = usePluginStore();

  let fileDropUnlisten: (() => void) | null = null;
  let currentWindow: ReturnType<typeof getCurrentWebviewWindow> | null = null;
  let isOverlayVisible = false; // 跟踪遮罩是否显示

  // 辅助函数：将窗口带到前台并聚焦（只置顶一次，不设置 alwaysOnTop）
  const bringWindowToFront = async () => {
    if (!currentWindow) {
      currentWindow = getCurrentWebviewWindow();
    }
    try {
      await currentWindow.setFocus();
    } catch (error) {
      console.warn("[FileDrop] 将窗口带到前台失败:", error);
    }
  };

  const updateSupportedTypes = async () => {
    try {
      const res = await invoke<{
        archiveExtensions: string[];
        pluginExtensions: string[];
      }>("get_file_drop_supported_types");

      if (res && res.archiveExtensions) {
        SUPPORTED_ARCHIVE_EXTENSIONS = res.archiveExtensions;
      }
      if (res && res.pluginExtensions) {
        SUPPORTED_KGPG_EXTENSIONS = res.pluginExtensions;
      }
    } catch (e) {
      console.warn("[App] 获取支持的文件类型失败，使用默认值:", e);
    }
  };

  const init = async () => {
    // 初始化时获取支持的类型
    await updateSupportedTypes();

    // 注册全局文件拖拽事件监听（使用 onDragDropEvent，根据 Tauri v2 文档）
    try {
      currentWindow = getCurrentWebviewWindow();
      
      fileDropUnlisten = await currentWindow.onDragDropEvent(async (event) => {
        if (event.payload.type === "enter") {
          // 文件/文件夹进入窗口时，显示视觉提示
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            try {
              const firstPath = paths[0];
              const metadata = await stat(firstPath);
              let text = "拖入文件以导入";
              let isImportable = false;

              if (metadata.isDirectory) {
                text = "拖入文件夹以导入";
                isImportable = true;
              } else if (isKgpgFile(firstPath)) {
                text = "拖入插件包（.kgpg）以导入";
                isImportable = true;
              } else if (isArchiveFile(firstPath)) {
                const exts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
                text = `拖入压缩包（${exts}）以导入`;
                isImportable = true;
              } else if (isSupportedImageFile(firstPath)) {
                // 图片文件也是可导入的
                isImportable = true;
                text = "拖入图片以导入";
              } else {
                // 如果是其他不支持的文件，显示默认提示
                const archiveExts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
                text = `支持拖入文件夹、插件(.kgpg)、图片或压缩包(${archiveExts})`;
              }

              // 检测到可导入类型，显示遮罩并将窗口带到前台
              if (isImportable) {
                fileDropOverlayRef.value?.show(text);
                isOverlayVisible = true;
                await bringWindowToFront();
              } else {
                fileDropOverlayRef.value?.show(text);
                isOverlayVisible = true;
              }
            } catch (error) {
              // 如果检查失败，显示通用提示
              const archiveExts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
              fileDropOverlayRef.value?.show(
                `拖入文件夹、插件(.kgpg)、图片或压缩包(${archiveExts})`,
              );
              isOverlayVisible = true;
            }
          }
        } else if (event.payload.type === "over") {
          // 文件/文件夹在窗口上移动时，保持显示提示并将窗口带到前台
          // over 事件只有 position，没有 paths，但遮罩已经在 enter 时显示
          // 如果遮罩正在显示，说明文件是可导入的，保持窗口在前台
          if (isOverlayVisible) {
            await bringWindowToFront();
          }
        } else if (event.payload.type === "drop") {
          // 隐藏视觉提示
          fileDropOverlayRef.value?.hide();
          isOverlayVisible = false;

          const droppedPaths = event.payload.paths;
          if (droppedPaths && droppedPaths.length > 0) {
            try {
              // 处理所有路径，区分文件和文件夹，并过滤文件
              const items: ImportItem[] = [];

              for (const path of droppedPaths) {
                try {
                  const metadata = await stat(path);
                  const pathParts = path.split(/[/\\]/);
                  const name = pathParts[pathParts.length - 1] || path;

                  if (metadata.isDirectory) {
                    // 文件夹：直接添加
                    items.push({
                      path,
                      name,
                      isDirectory: true,
                      isArchive: false,
                      isKgpg: false,
                    });
                  } else {
                    // 文件：检查是否为支持的图片格式 / archive / kgpg
                    if (
                      isSupportedImageFile(path) ||
                      isArchiveFile(path) ||
                      isKgpgFile(path)
                    ) {
                      const kgpg = isKgpgFile(path);
                      items.push({
                        path,
                        // 列表里明确标注插件包（不改 ImportConfirmDialog 也能看清用途）
                        name: kgpg ? `${name}（插件包）` : name,
                        isDirectory: false,
                        isArchive: isArchiveFile(path),
                        isKgpg: kgpg,
                      });
                    } else {
                      console.log("[App] 跳过不支持的文件:", path);
                    }
                  }
                } catch (error) {
                  console.error("[App] 检查路径失败:", path, error);
                }
              }

              if (items.length === 0) {
                ElMessage.warning("没有找到可导入的文件或文件夹");
                return;
              }

              const createAlbumPerSource =
                (await importConfirmDialogRef.value?.open(items)) ?? null;
              if (createAlbumPerSource === null) {
                // 用户取消
                console.log("[App] 用户取消导入");
                return;
              }

              // 用户确认，开始导入
              console.log("[App] 用户确认导入，开始添加任务");

              const hasCrawlerImport = items.some(
                (it) => it.isDirectory || (!it.isDirectory && !it.isKgpg),
              );
              // 只有存在"图片/archive/文件夹导入任务"时才打开任务抽屉；仅导入 kgpg 时避免打扰
              if (hasCrawlerImport) {
                try {
                  taskDrawerStore.open();
                } catch {
                  // ignore
                }
              }

              // 关键：不要在拖拽回调里长时间串行 await；放到后台任务并分批让出 UI
              void (async () => {
                let createdAnyAlbum = false;
                let importedPluginCount = 0;
                let addedCrawlerTaskCount = 0;
                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  try {
                    // kgpg：自动尝试导入/安装到"已安装源"
                    if (item.isKgpg) {
                      await invoke("import_plugin_from_zip", {
                        zipPath: item.path,
                      });
                      importedPluginCount++;
                      console.log("[App] 已导入插件包:", item.path);
                      continue;
                    }

                    // 可选：为每个"文件夹/压缩包"单独创建画册，并把 outputAlbumId 传给任务
                    let outputAlbumId: string | undefined = undefined;
                    if (
                      createAlbumPerSource &&
                      (item.isDirectory || item.isArchive)
                    ) {
                      try {
                        // 批量导入时避免每个画册都 reload 一次，最后再统一 load
                        const created = await albumStore.createAlbum(
                          item.name,
                          { reload: false },
                        );
                        outputAlbumId = created.id;
                        createdAnyAlbum = true;
                      } catch (e: any) {
                        console.warn(
                          "[App] 创建导入画册失败，将仅导入到画廊:",
                          item.name,
                          e,
                        );
                        // 提取友好的错误信息
                        const errorMessage =
                          typeof e === "string"
                            ? e
                            : e?.message || String(e) || "创建画册失败";
                        ElMessage.warning(
                          `${errorMessage}，将仅导入到画廊：${item.name}`,
                        );
                        outputAlbumId = undefined;
                      }
                    }

                    if (item.isDirectory) {
                      // 文件夹：使用 local-import，递归子文件夹
                      await crawlerStore.addTask(
                        "local-import",
                        item.path, // outputDir 为文件夹自身
                        {
                          folder_path: item.path,
                          recursive: true, // 递归子文件夹
                        },
                        outputAlbumId,
                      );
                      addedCrawlerTaskCount++;
                      console.log("[App] 已添加文件夹导入任务:", item.path);
                    } else {
                      // 文件：使用 local-import
                      // - 图片：默认输出到文件所在目录（保持原行为）
                      // - Archive：不指定 outputDir，让后端按"默认下载目录/内置目录"决定（修复 ZIP 默认落在 ZIP 所在目录的问题）
                      const fileDir = getDirectoryFromPath(item.path);
                      await crawlerStore.addTask(
                        "local-import",
                        item.isArchive ? undefined : fileDir,
                        {
                          file_path: item.path,
                        },
                        outputAlbumId,
                      );
                      addedCrawlerTaskCount++;
                      console.log("[App] 已添加文件导入任务:", item.path);
                    }
                  } catch (error) {
                    console.error("[App] 添加任务失败:", item.path, error);
                    ElMessage.error(
                      item.isKgpg
                        ? `导入插件失败: ${item.name}`
                        : `添加任务失败: ${item.name}`,
                    );
                  }

                  // 每处理 2 个让出一次主线程，让渲染/输入有机会执行
                  if (i % 2 === 1) {
                    await yieldToUi();
                  }
                }

                // 批量创建画册后，统一刷新一次（放后台，不阻塞 UI）
                if (createdAnyAlbum) {
                  void albumStore.loadAlbums();
                }

                // kgpg 导入后刷新"已安装源"
                if (importedPluginCount > 0) {
                  void pluginStore.loadPlugins();
                }

                if (addedCrawlerTaskCount > 0 && importedPluginCount > 0) {
                  ElMessage.success(
                    `已添加 ${addedCrawlerTaskCount} 个导入任务，已导入 ${importedPluginCount} 个源插件`,
                  );
                } else if (addedCrawlerTaskCount > 0) {
                  ElMessage.success(
                    `已添加 ${addedCrawlerTaskCount} 个导入任务`,
                  );
                } else if (importedPluginCount > 0) {
                  ElMessage.success(`已导入 ${importedPluginCount} 个源插件`);
                } else {
                  ElMessage.info("没有可导入的内容");
                }
              })();
            } catch (error) {
              console.error("[App] 处理文件拖入失败:", error);
              ElMessage.error(
                "处理文件拖入失败: " +
                  (error instanceof Error ? error.message : String(error)),
              );
            }
          }
        } else if (event.payload.type === "leave") {
          // 文件/文件夹离开窗口时，隐藏提示
          fileDropOverlayRef.value?.hide();
          isOverlayVisible = false;
        }
      });
    } catch (error) {
      console.error("[App] 注册文件拖拽事件监听失败:", error);
    }
  };

  // 处理遮罩点击关闭
  const handleOverlayClick = async () => {
    fileDropOverlayRef.value?.hide();
    isOverlayVisible = false;
  };

  const cleanup = () => {
    if (fileDropUnlisten) {
      fileDropUnlisten();
      fileDropUnlisten = null;
    }
    currentWindow = null;
  };

  onUnmounted(() => {
    cleanup();
  });

  return {
    init,
    cleanup,
    handleOverlayClick,
  };
}
