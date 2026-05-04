import { ref, Ref, onUnmounted } from "vue";
import { ElMessage } from "element-plus";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke, uploadImport } from "@/api/rpc";
import FileDropOverlay from "@/components/FileDropOverlay.vue";
import ImportConfirmDialog from "@/components/import/ImportConfirmDialog.vue";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import { useCrawlerStore } from "@/stores/crawler";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { i18n } from "@kabegame/i18n";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

// 支持的扩展名列表（用于默认提示文案），运行时由 updateSupportedTypes 从后端覆盖
let SUPPORTED_ARCHIVE_EXTENSIONS = ["zip", "rar"];
let SUPPORTED_KGPG_EXTENSIONS = ["kgpg"];

/** 后端根据路径推断类型（扩展名 + infer），用于拖入文件分类 */
interface FileDropKindItem {
  path: string;
  isDirectory: boolean;
  isImage: boolean;
  isVideo: boolean;
  isArchive: boolean;
  isKgpg: boolean;
}

const getFileDropKinds = async (paths: string[]): Promise<FileDropKindItem[]> => {
  if (paths.length === 0) return [];
  return invoke<FileDropKindItem[]>("get_file_drop_kinds", { paths });
};

export interface ImportItem {
  path: string;
  name: string;
  isDirectory: boolean;
  isArchive?: boolean;
  isKgpg?: boolean;
  isVideo?: boolean;
}

interface WebFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface WebFileSystemFileEntry extends WebFileSystemEntry {
  isFile: true;
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
}

interface WebFileSystemDirectoryEntry extends WebFileSystemEntry {
  isDirectory: true;
  createReader: () => {
    readEntries: (
      success: (entries: WebFileSystemEntry[]) => void,
      error?: (error: DOMException) => void,
    ) => void;
  };
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => WebFileSystemEntry | null;
};

const getExt = (name: string) => {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
};

const isArchiveName = (name: string) =>
  SUPPORTED_ARCHIVE_EXTENSIONS.includes(getExt(name));

const isKgpgName = (name: string) =>
  SUPPORTED_KGPG_EXTENSIONS.includes(getExt(name));

const isImageFile = (file: File) =>
  file.type.startsWith("image/") ||
  ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "jxl"].includes(getExt(file.name));

const isVideoFile = (file: File) =>
  file.type.startsWith("video/") ||
  ["mp4", "webm", "mkv", "mov", "avi"].includes(getExt(file.name));

const isWebImportableFile = (file: File) =>
  !isKgpgName(file.name) && (isImageFile(file) || isVideoFile(file) || isArchiveName(file.name));

const fileDisplayPath = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

const withRelativePath = (file: File, relPath: string) => {
  if (!relPath || relPath === file.name) return file;
  try {
    Object.defineProperty(file, "webkitRelativePath", {
      value: relPath,
      configurable: true,
    });
  } catch {
    // Some browsers expose webkitRelativePath as non-configurable. Falling back
    // to the original filename still lets the upload proceed.
  }
  return file;
};

const readFileEntry = (entry: WebFileSystemFileEntry, relPath: string) =>
  new Promise<File>((resolve, reject) => {
    entry.file(
      (file) => resolve(withRelativePath(file, relPath)),
      (error) => reject(error),
    );
  });

const readAllDirectoryEntries = async (entry: WebFileSystemDirectoryEntry) => {
  const reader = entry.createReader();
  const all: WebFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<WebFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
};

const collectEntryFiles = async (
  entry: WebFileSystemEntry,
  parentPath = "",
): Promise<File[]> => {
  const relPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    return [await readFileEntry(entry as WebFileSystemFileEntry, relPath)];
  }
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(entry as WebFileSystemDirectoryEntry);
    const nested = await Promise.all(children.map((child) => collectEntryFiles(child, relPath)));
    return nested.flat();
  }
  return [];
};

const getWebDroppedFiles = async (dataTransfer: DataTransfer | null): Promise<File[]> => {
  if (!dataTransfer) return [];
  const itemFiles = await Promise.all(
    Array.from(dataTransfer.items || [])
      .filter((item) => item.kind === "file")
      .map(async (rawItem) => {
        const item = rawItem as DataTransferItemWithEntry;
        const entry = item.webkitGetAsEntry?.();
        if (entry) return collectEntryFiles(entry);
        const file = item.getAsFile();
        return file ? [file] : [];
      }),
  );
  const files = itemFiles.flat();
  return files.length > 0 ? files : Array.from(dataTransfer.files || []);
};

/**
 * 文件拖拽 composable
 */
export function useFileDrop(
  fileDropOverlayRef: Ref<any>,
  importConfirmDialogRef: Ref<any>,
) {
  const taskDrawerStore = useTaskDrawerStore();
  const crawlerStore = useCrawlerStore();

  let fileDropUnlisten: (() => void) | null = null;
  let currentWindow: ReturnType<typeof getCurrentWebviewWindow> | null = null;
  let isOverlayVisible = false; // 跟踪遮罩是否显示
  let webDragDepth = 0;

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
      const dropRes = await invoke<{
        archiveExtensions: string[];
        pluginExtensions: string[];
      }>("get_file_drop_supported_types");
      if (dropRes?.archiveExtensions) {
        SUPPORTED_ARCHIVE_EXTENSIONS = dropRes.archiveExtensions;
      }
      if (dropRes?.pluginExtensions) {
        SUPPORTED_KGPG_EXTENSIONS = dropRes.pluginExtensions;
      }
    } catch (e) {
      console.warn("[App] 获取支持的文件类型失败，使用默认值:", e);
    }
  };

  const webDropText = (files?: File[]) => {
    const t = (key: string, params?: Record<string, string>) =>
      i18n.global.t(key, params);
    const exts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
    const first = files?.[0];
    if (!first) return t("import.dropFileToImport");
    if (isArchiveName(first.name)) return t("import.dropArchiveToImport", { exts });
    if (isImageFile(first)) return t("import.dropImageToImport");
    if (isVideoFile(first)) return t("import.dropVideoToImport");
    return t("import.dropSupportedTypes", { exts });
  };

  const handleWebDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    webDragDepth = 0;
    fileDropOverlayRef.value?.hide();
    isOverlayVisible = false;

    try {
      const droppedFiles = await getWebDroppedFiles(event.dataTransfer);
      const files = droppedFiles.filter(isWebImportableFile);
      if (files.length === 0) {
        ElMessage.warning(i18n.global.t("import.noImportableFound"));
        return;
      }

      const items: ImportItem[] = files.map((file) => {
        const path = fileDisplayPath(file);
        return {
          path,
          name: path.split("/").pop() || file.name,
          isDirectory: path.includes("/"),
          isArchive: isArchiveName(file.name),
          isKgpg: false,
          isVideo: isVideoFile(file),
        };
      });

      const confirmed = (await importConfirmDialogRef.value?.open(items)) !== null;
      if (!confirmed) {
        console.log("[App] 用户取消导入");
        return;
      }

      if (await guardDesktopOnly("localImport", { needSuper: true })) return;

      try {
        taskDrawerStore.open();
      } catch {
        // ignore
      }

      await uploadImport(files, {
        recursive: true,
        includeArchive: files.some((file) => isArchiveName(file.name)),
      });
      ElMessage.success(i18n.global.t("import.addedLocalImport"));
    } catch (error) {
      console.error("[App] 处理 Web 文件拖入失败:", error);
      ElMessage.error(
        `${i18n.global.t("import.fileDropFailed")}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const initWebFileDrop = () => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types || []).includes("Files");

    const showOverlay = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      fileDropOverlayRef.value?.show(webDropText());
      isOverlayVisible = true;
    };

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      webDragDepth += 1;
      showOverlay(event);
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      showOverlay(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      webDragDepth = Math.max(0, webDragDepth - 1);
      if (webDragDepth === 0) {
        fileDropOverlayRef.value?.hide();
        isOverlayVisible = false;
      }
    };

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", handleWebDrop, true);
    fileDropUnlisten = () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", handleWebDrop, true);
    };
  };

  const init = async () => {
    // 安卓下不支持拖拽导入，直接返回
    if (IS_ANDROID) {
      return;
    }

    // 初始化时获取支持的类型
    await updateSupportedTypes();

    if (IS_WEB) {
      initWebFileDrop();
      return;
    }

    // 注册全局文件拖拽事件监听（使用 onDragDropEvent，根据 Tauri v2 文档）
    try {
      currentWindow = getCurrentWebviewWindow();
      
      fileDropUnlisten = await currentWindow.onDragDropEvent(async (event) => {
        if (event.payload.type === "enter") {
          // 文件/文件夹进入窗口时，显示视觉提示（后端按路径推断类型：扩展名 + infer）
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            try {
              const kinds = await getFileDropKinds(paths.slice(0, 1));
              const first = kinds[0];
              const t = (key: string, params?: Record<string, string>) =>
                i18n.global.t(key, params);
              const exts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
              let text = t("import.dropFileToImport");
              let isImportable = false;

              if (first) {
                if (first.isDirectory) {
                  text = t("import.dropFolderToImport");
                  isImportable = true;
                } else if (first.isKgpg) {
                  text = t("import.dropPluginToImport");
                  isImportable = true;
                } else if (first.isArchive) {
                  text = t("import.dropArchiveToImport", { exts });
                  isImportable = true;
                } else if (first.isImage) {
                  isImportable = true;
                  text = t("import.dropImageToImport");
                } else if (first.isVideo) {
                  isImportable = true;
                  text = t("import.dropVideoToImport");
                } else {
                  text = t("import.dropSupportedTypes", { exts });
                }
              }

              fileDropOverlayRef.value?.show(text);
              isOverlayVisible = true;
              if (isImportable) {
                await bringWindowToFront();
              }
            } catch (error) {
              const exts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
              fileDropOverlayRef.value?.show(
                i18n.global.t("import.dropSupportedTypes", { exts }),
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
              // 后端根据路径推断类型（扩展名 + infer），一次调用得到所有分类
              const kinds = await getFileDropKinds(droppedPaths);
              const items: ImportItem[] = [];

              for (const k of kinds) {
                const pathParts = k.path.split(/[/\\]/);
                const name = pathParts[pathParts.length - 1] || k.path;

                if (k.isDirectory) {
                  items.push({
                    path: k.path,
                    name,
                    isDirectory: true,
                    isArchive: false,
                    isKgpg: false,
                  });
                } else if (k.isImage || k.isVideo || k.isArchive || k.isKgpg) {
                  items.push({
                    path: k.path,
                    name: k.isKgpg ? `${name}${i18n.global.t("import.pluginPackageSuffix")}` : name,
                    isDirectory: false,
                    isArchive: k.isArchive,
                    isKgpg: k.isKgpg,
                    isVideo: k.isVideo,
                  });
                } else {
                  console.log("[App] 跳过不支持的文件:", k.path);
                }
              }

              if (items.length === 0) {
                ElMessage.warning(i18n.global.t("import.noImportableFound"));
                return;
              }

              const confirmed = (await importConfirmDialogRef.value?.open(items)) !== null;
              if (!confirmed) {
                // 用户取消
                console.log("[App] 用户取消导入");
                return;
              }

              // 用户确认，开始导入
              console.log("[App] 用户确认导入，开始添加任务");

              const kgpgItems = items.filter((it) => it.isKgpg);
              const localImportItems = items.filter((it) => !it.isKgpg);
              const hasCrawlerImport = localImportItems.length > 0;
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
                let importedPluginCount = 0;

                // kgpg：逐个导入插件
                for (const item of kgpgItems) {
                  try {
                    await invoke("import_plugin_from_zip", {
                      zipPath: item.path,
                    });
                    importedPluginCount++;
                    console.log("[App] 已导入插件包:", item.path);
                  } catch (error) {
                    console.error("[App] 导入插件失败:", item.path, error);
                    ElMessage.error(
                      `${i18n.global.t("import.importPluginFailed")}: ${item.name}`,
                    );
                  }
                }

                // 本地导入：单一任务，所有路径
                if (localImportItems.length > 0) {
                  const allPaths = localImportItems.map((it) => it.path);
                  const hasArchiveFiles = localImportItems.some((it) => it.isArchive);
                  crawlerStore.addTask(
                    "local-import",
                    undefined,
                    {
                      paths: allPaths,
                      recursive: true,
                      include_archive: hasArchiveFiles,
                    },
                  );
                  console.log("[App] 已添加本地导入任务:", allPaths.length, "个路径");
                }


                if (localImportItems.length > 0 && importedPluginCount > 0) {
                  ElMessage.success(
                    i18n.global.t("import.addedLocalImportAndPlugins", {
                      count: String(importedPluginCount),
                    }),
                  );
                } else if (localImportItems.length > 0) {
                  ElMessage.success(i18n.global.t("import.addedLocalImport"));
                } else if (importedPluginCount > 0) {
                  ElMessage.success(
                    i18n.global.t("import.importedPluginsCount", {
                      count: String(importedPluginCount),
                    }),
                  );
                } else {
                  ElMessage.info(i18n.global.t("import.nothingToImport"));
                }
              })();
            } catch (error) {
              console.error("[App] 处理文件拖入失败:", error);
              ElMessage.error(
                `${i18n.global.t("import.fileDropFailed")}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
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
