import { ref, Ref, onUnmounted } from "vue";
import { ElMessage } from "element-plus";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import FileDropOverlay from "@/components/FileDropOverlay.vue";
import ImportConfirmDialog from "@/components/import/ImportConfirmDialog.vue";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { IS_ANDROID } from "@kabegame/core/env";

// 支持的扩展名列表（用于默认提示文案），运行时由 updateSupportedTypes 从后端覆盖
let SUPPORTED_ARCHIVE_EXTENSIONS = ["zip", "rar"];
let SUPPORTED_KGPG_EXTENSIONS = ["kgpg"];

/** 后端根据路径推断类型（扩展名 + infer），用于拖入文件分类 */
interface FileDropKindItem {
  path: string;
  isDirectory: boolean;
  isImage: boolean;
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

  const init = async () => {
    // 安卓下不支持拖拽导入，直接返回
    if (IS_ANDROID) {
      return;
    }

    // 初始化时获取支持的类型
    await updateSupportedTypes();

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
              let text = "拖入文件以导入";
              let isImportable = false;

              if (first) {
                if (first.isDirectory) {
                  text = "拖入文件夹以导入";
                  isImportable = true;
                } else if (first.isKgpg) {
                  text = "拖入插件包（.kgpg）以导入";
                  isImportable = true;
                } else if (first.isArchive) {
                  const exts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
                  text = `拖入压缩包（${exts}）以导入`;
                  isImportable = true;
                } else if (first.isImage) {
                  isImportable = true;
                  text = "拖入图片以导入";
                } else {
                  const archiveExts = SUPPORTED_ARCHIVE_EXTENSIONS.join("、");
                  text = `支持拖入文件夹、插件(.kgpg)、图片或压缩包(${archiveExts})`;
                }
              }

              fileDropOverlayRef.value?.show(text);
              isOverlayVisible = true;
              if (isImportable) {
                await bringWindowToFront();
              }
            } catch (error) {
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
                } else if (k.isImage || k.isArchive || k.isKgpg) {
                  items.push({
                    path: k.path,
                    name: k.isKgpg ? `${name}（插件包）` : name,
                    isDirectory: false,
                    isArchive: k.isArchive,
                    isKgpg: k.isKgpg,
                  });
                } else {
                  console.log("[App] 跳过不支持的文件:", k.path);
                }
              }

              if (items.length === 0) {
                ElMessage.warning("没有找到可导入的文件或文件夹");
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
                    ElMessage.error(`导入插件失败: ${item.name}`);
                  }
                }

                // 本地导入：单一任务，所有路径
                if (localImportItems.length > 0) {
                  const allPaths = localImportItems.map((it) => it.path);
                  crawlerStore.addTask("本地导入", undefined, {
                    paths: allPaths,
                    recursive: true,
                    include_archive: false,
                  });
                  console.log("[App] 已添加本地导入任务:", allPaths.length, "个路径");
                }

                // kgpg 导入后刷新"已安装源"
                if (importedPluginCount > 0) {
                  void pluginStore.loadPlugins();
                }

                if (localImportItems.length > 0 && importedPluginCount > 0) {
                  ElMessage.success(
                    `已添加 1 个本地导入任务，已导入 ${importedPluginCount} 个源插件`,
                  );
                } else if (localImportItems.length > 0) {
                  ElMessage.success("已添加本地导入任务");
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
