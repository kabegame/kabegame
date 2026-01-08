<template>
  <!-- 壁纸窗口：通过 index.html?wallpaper=1 启动，只渲染壁纸层，不渲染侧边栏/路由页面 -->
  <WallpaperLayer v-if="isWallpaperWindow" />

  <!-- 主窗口 -->
  <el-container v-else class="app-container">
    <!-- 全局文件拖拽提示层 -->
    <FileDropOverlay ref="fileDropOverlayRef" />
    <!-- 文件拖拽导入确认弹窗（封装 ElMessageBox.confirm） -->
    <ImportConfirmDialog ref="importConfirmDialogRef" />
    <!-- 全局唯一的快捷设置抽屉（避免多页面实例冲突） -->
    <QuickSettingsDrawer />
    <!-- 全局唯一的任务抽屉（避免多页面实例冲突） -->
    <TaskDrawer v-model="taskDrawerVisible" :tasks="taskDrawerTasks" />
    <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed }" :width="isCollapsed ? '64px' : '200px'">
      <div class="sidebar-header">
        <img src="/icon.png" alt="Logo" class="app-logo logo-clickable" @click="toggleCollapse" />
        <h1 v-if="!isCollapsed">Kabegame</h1>
      </div>
      <el-menu :default-active="activeRoute" router class="sidebar-menu" :collapse="isCollapsed">
        <el-menu-item index="/gallery">
          <el-icon>
            <Picture />
          </el-icon>
          <span>画廊</span>
        </el-menu-item>
        <el-menu-item index="/albums">
          <el-icon>
            <Collection />
          </el-icon>
          <span>画册</span>
        </el-menu-item>
        <el-menu-item index="/plugin-browser">
          <el-icon>
            <Grid />
          </el-icon>
          <span>收集源</span>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon>
            <Setting />
          </el-icon>
          <span>设置</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-main class="app-main">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { Picture, Grid, Setting, Collection } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import WallpaperLayer from "./components/WallpaperLayer.vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useSettingsStore } from "./stores/settings";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";
import TaskDrawer from "./components/TaskDrawer.vue";
import { useTaskDrawerStore } from "./stores/taskDrawer";
import { useCrawlerStore } from "./stores/crawler";
import { useAlbumStore } from "./stores/albums";
import { storeToRefs } from "pinia";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import { stat } from "@tauri-apps/plugin-fs";
import ImportConfirmDialog from "./components/import/ImportConfirmDialog.vue";

const route = useRoute();
const activeRoute = computed(() => route.path);

// 任务抽屉 store
const taskDrawerStore = useTaskDrawerStore();
const { visible: taskDrawerVisible, tasks: taskDrawerTasks } = storeToRefs(taskDrawerStore);

// 爬虫 store
const crawlerStore = useCrawlerStore();
const albumStore = useAlbumStore();

// 文件拖拽提示层引用
const fileDropOverlayRef = ref<InstanceType<typeof FileDropOverlay> | null>(null);
const importConfirmDialogRef = ref<InstanceType<typeof ImportConfirmDialog> | null>(null);

// 支持的图片格式
const SUPPORTED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const SUPPORTED_ZIP_EXTENSIONS = ['zip'];

// 让出 UI：避免在一次性批量导入/创建任务时长时间占用主线程导致“界面卡死”
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// 从文件路径提取扩展名（小写，不含点号）
const getFileExtension = (filePath: string): string => {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot >= 0 && lastDot < filePath.length - 1) {
    return filePath.substring(lastDot + 1).toLowerCase();
  }
  return '';
};

// 检查文件是否为支持的图片格式
const isSupportedImageFile = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
};

// 检查文件是否为 zip（压缩包导入：后端会解压到临时目录再递归导入图片）
const isZipFile = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return SUPPORTED_ZIP_EXTENSIONS.includes(ext);
};

// 辅助函数：从文件路径提取目录路径
const getDirectoryFromPath = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  if (lastSlash >= 0) {
    return filePath.substring(0, lastSlash);
  }
  return '';
};

// 关键：同步判断当前窗口 label，确保壁纸窗口首次渲染就进入 WallpaperLayer
const isWallpaperWindow = ref(false);
try {
  // wallpaper / wallpaper-debug 都渲染壁纸层（便于调试）
  isWallpaperWindow.value = getCurrentWebviewWindow().label.startsWith("wallpaper");
} catch {
  // 非 Tauri 环境（浏览器打开）会走这里
  isWallpaperWindow.value = false;
}

let fileDropUnlisten: (() => void) | null = null;
let minimizeUnlisten: (() => void) | null = null;

onMounted(async () => {
  // 初始化 settings store
  const settingsStore = useSettingsStore();
  await settingsStore.init();

  if (!isWallpaperWindow.value) {
    // 监听窗口关闭事件 - 隐藏而不是退出
    try {
      const currentWindow = getCurrentWebviewWindow();
      await currentWindow.onCloseRequested(async (event) => {
        // 阻止默认关闭行为
        event.preventDefault();
        // 调用后端命令隐藏窗口
        try {
          await invoke("hide_main_window");
        } catch (error) {
          console.error("隐藏窗口失败:", error);
        }
      });
    } catch (error) {
      console.error("注册窗口关闭事件监听失败:", error);
    }

    // 监听窗口最小化事件 - 修复壁纸窗口 Z-order（防止覆盖桌面图标）
    try {
      const currentWindow = getCurrentWebviewWindow();
      minimizeUnlisten = await currentWindow.listen('tauri://window-minimized', async () => {
        // 窗口最小化时，修复壁纸窗口 Z-order
        try {
          await invoke("fix_wallpaper_zorder");
        } catch (error) {
          // 忽略错误（非 Windows 或壁纸窗口不存在时）
        }
      });
    } catch (error) {
      console.error("注册窗口最小化事件监听失败:", error);
    }

    // 注册全局文件拖拽事件监听（使用 onDragDropEvent，根据 Tauri v2 文档）
    try {
      const currentWindow = getCurrentWebviewWindow();
      fileDropUnlisten = await currentWindow.onDragDropEvent(async (event) => {
        console.log('[App] 收到拖拽事件:', event.payload.type, event.payload);

        if (event.payload.type === 'enter') {
          // 文件/文件夹进入窗口时，显示视觉提示
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            try {
              const firstPath = paths[0];
              const metadata = await stat(firstPath);
              const text = metadata.isDirectory ? '拖入文件夹以导入' : '拖入文件以导入';
              fileDropOverlayRef.value?.show(text);
            } catch (error) {
              // 如果检查失败，显示通用提示
              fileDropOverlayRef.value?.show('拖入文件或文件夹以导入');
            }
          }
        } else if (event.payload.type === 'over') {
          // 文件/文件夹在窗口上移动时，保持显示提示（over 事件只有 position，没有 paths）
          // 这里不需要额外处理，提示已经在 enter 时显示
        } else if (event.payload.type === 'drop') {
          // 隐藏视觉提示
          fileDropOverlayRef.value?.hide();

          const droppedPaths = event.payload.paths;
          if (droppedPaths && droppedPaths.length > 0) {
            try {
              console.log('[App] 处理拖入路径:', droppedPaths);

              // 处理所有路径，区分文件和文件夹，并过滤文件
              interface ImportItem {
                path: string;
                name: string;
                isDirectory: boolean;
                isZip?: boolean;
              }

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
                      isZip: false,
                    });
                  } else {
                    // 文件：检查是否为支持的图片格式 / zip
                    if (isSupportedImageFile(path) || isZipFile(path)) {
                      items.push({
                        path,
                        name,
                        isDirectory: false,
                        isZip: isZipFile(path),
                      });
                    } else {
                      console.log('[App] 跳过不支持的文件:', path);
                    }
                  }
                } catch (error) {
                  console.error('[App] 检查路径失败:', path, error);
                }
              }

              if (items.length === 0) {
                ElMessage.warning('没有找到可导入的文件或文件夹');
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
              console.log('[App] 用户确认导入，开始添加任务');

              // 任务抽屉打开，用户可以在导入过程中随时查看/操作
              try {
                taskDrawerStore.open();
              } catch {
                // ignore
              }

              // 关键：不要在拖拽回调里长时间串行 await；放到后台任务并分批让出 UI
              void (async () => {
                let createdAnyAlbum = false;
                for (let i = 0; i < items.length; i++) {
                  const item = items[i];
                  try {
                    // 可选：为每个“文件夹/压缩包”单独创建画册，并把 outputAlbumId 传给任务
                    let outputAlbumId: string | undefined = undefined;
                    if (createAlbumPerSource && (item.isDirectory || item.isZip)) {
                      try {
                        // 批量导入时避免每个画册都 reload 一次，最后再统一 load
                        const created = await albumStore.createAlbum(item.name, { reload: false });
                        outputAlbumId = created.id;
                        createdAnyAlbum = true;
                      } catch (e) {
                        console.warn("[App] 创建导入画册失败，将仅导入到画廊:", item.name, e);
                        ElMessage.warning(`创建画册失败，将仅导入到画廊：${item.name}`);
                        outputAlbumId = undefined;
                      }
                    }

                    if (item.isDirectory) {
                      // 文件夹：使用 local-import，递归子文件夹
                      await crawlerStore.addTask(
                        'local-import',
                        item.path, // outputDir 为文件夹自身
                        {
                          folder_path: item.path,
                          recursive: true, // 递归子文件夹
                        },
                        outputAlbumId
                      );
                      console.log('[App] 已添加文件夹导入任务:', item.path);
                    } else {
                      // 文件：使用 local-import
                      // - 图片：默认输出到文件所在目录（保持原行为）
                      // - ZIP：不指定 outputDir，让后端按“默认下载目录/内置目录”决定（修复 ZIP 默认落在 ZIP 所在目录的问题）
                      const fileDir = getDirectoryFromPath(item.path);
                      await crawlerStore.addTask(
                        'local-import',
                        item.isZip ? undefined : fileDir,
                        {
                          file_path: item.path,
                        },
                        outputAlbumId
                      );
                      console.log('[App] 已添加文件导入任务:', item.path);
                    }
                  } catch (error) {
                    console.error('[App] 添加任务失败:', item.path, error);
                    ElMessage.error(`添加任务失败: ${item.name}`);
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

                ElMessage.success(`已添加 ${items.length} 个导入任务`);
              })();
            } catch (error) {
              console.error('[App] 处理文件拖入失败:', error);
              ElMessage.error('处理文件拖入失败: ' + (error instanceof Error ? error.message : String(error)));
            }
          }
        } else if (event.payload.type === 'leave') {
          // 文件/文件夹离开窗口时，隐藏提示
          fileDropOverlayRef.value?.hide();
        }
      });
      console.log('[App] 文件拖拽事件监听器注册成功');
    } catch (error) {
      console.error('[App] 注册文件拖拽事件监听失败:', error);
    }
  }
});

onUnmounted(() => {
  // 清理文件拖拽事件监听
  if (fileDropUnlisten) {
    fileDropUnlisten();
    fileDropUnlisten = null;
  }
  // 清理最小化事件监听
  if (minimizeUnlisten) {
    minimizeUnlisten();
    minimizeUnlisten = null;
  }
});

// 侧边栏收起状态
const isCollapsed = ref(false);

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

</script>

<style lang="scss">
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.app-container {
  height: 100vh;
  display: flex;
  background: var(--anime-bg-main);
}

.app-sidebar {
  background: var(--anime-bg-sidebar);
  border-right: 2px solid var(--anime-border);
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-shadow: 4px 0 20px rgba(255, 107, 157, 0.1);
  transition: width 0.3s ease;

  .sidebar-header {
    padding: 24px 20px;
    border-bottom: 2px solid var(--anime-border);
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.1) 0%, rgba(167, 139, 250, 0.1) 100%);
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    position: relative;
    min-height: 80px;
    justify-content: flex-start;
    transition: padding 0.3s ease;

    .app-logo {
      width: 56px;
      height: 56px;
      object-fit: contain;
      transition: all 0.3s ease;
      flex-shrink: 0;

      &.logo-clickable {
        cursor: pointer;
        border-radius: 8px;
        padding: 4px;
        transition: all 0.3s ease;

        &:hover {
          filter: drop-shadow(0 0 8px rgba(255, 107, 157, 0.6)) drop-shadow(0 0 16px rgba(167, 139, 250, 0.4));
          transform: scale(1.05);
        }
      }
    }

    h1 {
      font-size: 18px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin: 0;
      letter-spacing: 1px;
      transition: all 0.3s ease;
    }
  }

  &.sidebar-collapsed {
    .sidebar-header {
      padding: 16px;
      min-height: 64px;
      gap: 0;
      justify-content: center;

      .app-logo {
        width: 40px;
        height: 40px;
      }

      h1 {
        display: none;
      }
    }

    .sidebar-menu {
      padding: 8px 0;

      .el-menu-item {
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0;
        height: 48px;
        margin: 4px 8px;
        border-radius: 8px;
        text-align: center;
        position: relative;
        transition: all 0.3s ease;

        &.is-active {
          background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
        }

        &:not(.is-active) {
          background: transparent;

          &:hover {
            background: rgba(255, 107, 157, 0.1);
          }
        }

        span {
          opacity: 0;
          width: 0;
          margin: 0;
          padding: 0;
          display: inline-block;
        }

        .el-icon {
          margin: 0 !important;
          padding: 0 !important;
          font-size: 20px;
          width: auto !important;
          height: auto !important;
        }
      }

    }
  }

  .sidebar-menu {
    flex: 1;
    border-right: none;
    padding: 10px 0;
    transition: padding 0.3s ease;

    // 展开状态下，菜单项保持左对齐
    .el-menu-item {
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      text-align: left;

      span {
        transition: opacity 0.3s ease, width 0.3s ease, margin 0.3s ease;
        overflow: hidden;
        opacity: 1;
        width: auto;
        margin: 0;
        padding: 0;
      }

      .el-icon {
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
      }
    }
  }
}

.app-main {
  padding: 0;
  overflow-y: auto;
  flex: 1;
  background: transparent;
  /* 隐藏滚动条 */
  scrollbar-width: none;
  /* Firefox */
  -ms-overflow-style: none;
  /* IE and Edge */

  &::-webkit-scrollbar {
    display: none;
    /* Chrome, Safari, Opera */
  }
}

// 文件拖拽确认对话框样式
:deep(.file-drop-confirm-dialog) {
  .import-confirm-content {
    max-width: 500px;

    .import-summary {
      margin-bottom: 20px;

      p {
        margin-bottom: 12px;
        font-size: 16px;
        color: var(--anime-text-primary);

        strong {
          color: var(--anime-primary);
          font-weight: 600;
        }
      }

      .summary-stats {
        display: flex;
        gap: 20px;
        font-size: 14px;
        color: var(--anime-text-secondary);

        strong {
          color: var(--anime-primary);
          font-weight: 600;
        }
      }
    }

    .import-options {
      margin: 8px 0 14px 0;
      padding: 10px 12px;
      border: 1px dashed var(--anime-border);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.35);

      .import-option {
        color: var(--anime-text-primary);
        font-size: 14px;
      }
    }

    .import-list {
      max-height: 400px;
      overflow-y: auto;
      border: 1px solid var(--anime-border);
      border-radius: 12px;
      padding: 12px;
      background: var(--anime-bg-card);

      .import-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        margin-bottom: 8px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.5);
        transition: all 0.2s ease;

        &:last-child {
          margin-bottom: 0;
        }

        &:hover {
          background: rgba(255, 107, 157, 0.1);
          transform: translateX(4px);
        }

        .item-icon {
          font-size: 20px;
          flex-shrink: 0;
        }

        .item-name {
          flex: 1;
          font-size: 14px;
          color: var(--anime-text-primary);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .item-type {
          font-size: 12px;
          color: var(--anime-text-secondary);
          padding: 4px 8px;
          background: rgba(167, 139, 250, 0.1);
          border-radius: 6px;
          flex-shrink: 0;
        }
      }
    }
  }
}

// 覆盖：拖入项目过多时，确认弹窗不应撑满屏幕；列表区域滚动即可
::deep(.file-drop-confirm-dialog) {
  // 限制整个 MessageBox 的最大高度
  max-height: 80vh;
  display: flex;
  flex-direction: column;

  .el-message-box__content {
    max-height: none;
    overflow: visible;
    flex: 1;
    min-height: 0;
  }

  .el-message-box__message {
    max-height: none;
    overflow: visible;
  }

  .import-confirm-content {
    max-height: 60vh;
    display: flex;
    flex-direction: column;
  }

  .import-confirm-content .summary-stats {
    flex-wrap: wrap;
    gap: 16px;
  }

  .import-confirm-content .import-list {
    flex: 1;
    min-height: 160px;
    max-height: 45vh;
    overflow-y: auto;
  }
}
</style>
