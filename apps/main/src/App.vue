<template>
  <!-- 主窗口 -->
  <el-container class="app-container" :class="{ 'app-container-android': IS_ANDROID }">
    <!-- 全局文件拖拽提示层 -->
    <FileDropOverlay ref="fileDropOverlayRef" @click="handleOverlayClick" />
    <!-- 文件拖拽导入确认弹窗（封装 ElMessageBox.confirm） -->
    <ImportConfirmDialog ref="importConfirmDialogRef" />
    <!-- 外部插件导入弹窗 -->
    <PluginImportDialog 
      v-model:visible="showImportDialog" 
      :kgpg-path="importKgpgPath"
    />
    <!-- 全局唯一的快捷设置抽屉（避免多页面实例冲突） -->
    <QuickSettingsDrawer />
    <!-- 全局唯一的帮助抽屉（按页面展示帮助内容） -->
    <HelpDrawer />
    <!-- 全局唯一的任务抽屉（避免多页面实例冲突） -->
    <TaskDrawer v-model="taskDrawerVisible" :tasks="taskDrawerTasks" />
    <!-- 非 Android：侧边栏 + 主内容 -->
    <template v-if="!IS_ANDROID">
      <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed, 'bg-transparent': IS_WINDOWS || IS_MACOS, 'bg-white': !IS_WINDOWS && !IS_MACOS }" :width="isCollapsed ? '64px' : '200px'">
        <div class="sidebar-header">
          <img src="/icon.png" alt="Logo" class="app-logo logo-clickable" @click="toggleCollapse" />
          <div v-if="!isCollapsed" class="sidebar-title-section">
            <h1>Kabegame</h1>
          </div>
        </div>
        <el-menu :default-active="activeRoute" router class="sidebar-menu" :collapse="isCollapsed">
          <el-menu-item :index="galleryMenuRoute">
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
          <el-menu-item index="/help">
            <el-icon>
              <QuestionFilled />
            </el-icon>
            <span>帮助</span>
          </el-menu-item>
        </el-menu>
      </el-aside>
    </template>
    <el-main class="app-main">
      <router-view v-slot="{ Component }" :key="routerViewKey">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </el-main>
    <!-- Android：底部均匀分布的 Tab 栏 -->
    <nav v-if="IS_ANDROID" class="app-bottom-tabs" aria-label="主导航">
      <router-link
        v-for="tab in bottomTabs"
        :key="tab.index"
        :to="tab.index"
        class="bottom-tab-item"
        :class="{ 'is-active': activeRoute === tab.index }"
      >
        <el-icon class="bottom-tab-icon">
          <component :is="tab.icon" />
        </el-icon>
        <span class="bottom-tab-label">{{ tab.label }}</span>
      </router-link>
    </nav>
  </el-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { Picture, Grid, Setting, Collection, QuestionFilled } from "@element-plus/icons-vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";
import HelpDrawer from "./components/help/HelpDrawer.vue";
import TaskDrawer from "./components/TaskDrawer.vue";
import { useTaskDrawerStore } from "./stores/taskDrawer";
import { storeToRefs } from "pinia";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import ImportConfirmDialog from "./components/import/ImportConfirmDialog.vue";
import PluginImportDialog from "./components/import/PluginImportDialog.vue";
import { useActiveRoute } from "./composables/useActiveRoute";
import { useWindowEvents } from "./composables/useWindowEvents";
import { useFileDrop } from "./composables/useFileDrop";
import { useSidebar } from "./composables/useSidebar";
import { listen, emit, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_WINDOWS, IS_MACOS, IS_ANDROID } from "@kabegame/core/env";

// 路由高亮
const { activeRoute, galleryMenuRoute } = useActiveRoute();

// Android 底部 Tab 配置（均匀分布，与侧边栏菜单项一致）
const bottomTabs = computed(() => [
  { index: galleryMenuRoute.value, icon: Picture, label: "画廊" },
  { index: "/albums", icon: Collection, label: "画册" },
  { index: "/plugin-browser", icon: Grid, label: "收集源" },
  { index: "/settings", icon: Setting, label: "设置" },
  { index: "/help", icon: QuestionFilled, label: "帮助" },
]);

// 任务抽屉 store
const taskDrawerStore = useTaskDrawerStore();
const { visible: taskDrawerVisible, tasks: taskDrawerTasks } = storeToRefs(taskDrawerStore);

// 文件拖拽提示层引用
const fileDropOverlayRef = ref<any>(null);
const importConfirmDialogRef = ref<any>(null);

// 外部导入插件对话框
const showImportDialog = ref(false);
const importKgpgPath = ref<string | null>(null);

// 路由视图 key，用于强制刷新组件
const routerViewKey = ref(0);

// 窗口事件监听
const { init: initWindowEvents } = useWindowEvents();

// 文件拖拽
const { init: initFileDrop, handleOverlayClick } = useFileDrop(fileDropOverlayRef, importConfirmDialogRef);

// 侧边栏
const { isCollapsed, toggleCollapse } = useSidebar();

// 设置变更事件监听器
let unlistenSettingChange: UnlistenFn | null = null;

onMounted(async () => {
  // 初始化 settings store
  const settingsStore = useSettingsStore();
  await settingsStore.init();
  // 加载全部设置
  await settingsStore.loadAll();

  // 初始化各个 composables
  await initWindowEvents();
  await initFileDrop();

  // 监听设置变更事件（事件驱动更新设置）
  // 当后端设置变化时，自动更新本地设置 store
  unlistenSettingChange = await listen<{ changes: Record<string, any> }>("setting-change", async (event) => {
    const changes = event.payload.changes;
    // 只更新变化的部分（后端只广播变化的部分）
    if (changes && typeof changes === "object") {
      Object.assign(settingsStore.values, changes);
      console.log("[Settings] 收到设置变更事件，已更新:", Object.keys(changes));
    }
  });

  // 监听显示窗口事件（IPC）
  await listen('app-show-window', async () => {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  });

  // 监听插件导入事件（IPC）
  await listen<{ kgpgPath: string }>('app-import-plugin', async (event) => {
    console.log("Received app-import-plugin:", event.payload);
    const win = getCurrentWindow();
    
    // 尝试显示窗口并获取焦点（如果窗口被隐藏或最小化）
    // 使用 try-catch 包裹，避免权限错误或窗口状态异常
    try {
      const isVisible = await win.isVisible();
      if (!isVisible) {
        await win.show();
      }
      await win.setFocus();
    } catch (error) {
      console.warn("无法显示窗口或设置焦点:", error);
      // 即使失败也继续显示 dialog
    }
    
    importKgpgPath.value = event.payload.kgpgPath;
    showImportDialog.value = true;
  });
  
  // 通知后端已准备好接收事件
  emit('app-ready');

  // 预加载关键路由组件，避免首次点击时的卡顿
  // 使用 requestIdleCallback（如有）或 setTimeout 在空闲时加载
  const preloadRouteComponents = () => {
    // 预加载"收集源"页面（通常是用户第二个访问的页面）
    void import("@/views/PluginBrowser.vue");
    // 可选：预加载其他常用页面
    void import("@/views/Albums.vue");
    void import("@/views/Settings.vue");
  };
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(() => preloadRouteComponents(), { timeout: 2000 });
  } else {
    setTimeout(preloadRouteComponents, 50);
  }
});

onUnmounted(() => {
  // 清理设置变更事件监听器
  if (unlistenSettingChange) {
    unlistenSettingChange();
    unlistenSettingChange = null;
  }
});

</script>

<style lang="scss">
html,
body,
#app {
  height: 100%;
  background: transparent;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.app-container {
  height: 100vh;
  display: flex;
  // 让窗口透明层透出（DWM blur behind 只在透明像素处可见）
  background: transparent;

  &.app-container-android {
    flex-direction: column;
  }
}

// Android 底部 Tab 栏：均匀分布
.app-bottom-tabs {
  flex: 0 0 auto;
  display: flex;
  flex-direction: row;
  width: 100%;
  border-top: 2px solid var(--anime-border);
  background: var(--anime-bg-card);
  padding-bottom: env(safe-area-inset-bottom, 0);
  box-shadow: 0 -4px 20px rgba(255, 107, 157, 0.08);

  .bottom-tab-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 8px 4px;
    min-width: 0;
    color: var(--anime-text-secondary);
    text-decoration: none;
    transition: color 0.2s ease, background 0.2s ease;

    &:active {
      background: rgba(255, 107, 157, 0.08);
    }

    &.is-active {
      color: var(--anime-primary);
      background: linear-gradient(180deg, rgba(255, 107, 157, 0.12) 0%, rgba(167, 139, 250, 0.08) 100%);
    }
  }

  .bottom-tab-icon {
    font-size: 22px;
    flex-shrink: 0;
  }

  .bottom-tab-label {
    font-size: 11px;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
}

.app-sidebar {
  // 关键：侧栏背景必须半透明，DWM 才能透出模糊效果
  // background: transparent;
  // 非 Windows / DWM 失效时的降级（浏览器预览也能看到"玻璃感"）
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  border-right: 2px solid var(--anime-border);
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-shadow: 4px 0 20px rgba(255, 107, 157, 0.1);
  transition: width 0.3s ease;
  // 防止横向滚动条
  overflow-x: hidden;
  overflow-y: auto;

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

    .sidebar-title-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
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

    .offline-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
    }

    .offline-hint {
      font-size: 14px;
      color: var(--anime-text-secondary);
      margin: 0;
      line-height: 1.4;
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

      .sidebar-title-section {
        display: none;
      }
    }

    .sidebar-menu {
      padding: 8px 0;
      // 防止菜单溢出导致横向滚动
      overflow-x: hidden;
      width: 100%;

      .el-menu-item {
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 0;
        height: 48px;
        // 折叠状态下减少左右 margin，避免超出 64px 宽度
        margin: 4px 4px;
        border-radius: 8px;
        text-align: center;
        position: relative;
        transition: all 0.3s ease;
        // 确保菜单项不会超出容器
        max-width: 100%;
        box-sizing: border-box;

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
    // Element Plus 默认给 el-menu 一个不透明背景，会把"半透明侧栏"盖住，导致看起来没有毛玻璃
    background: transparent;

    // 覆盖 Element Plus 菜单的背景色（展开/折叠都需要）
    &.el-menu {
      background-color: transparent;
    }

    .el-menu-item,
    .el-sub-menu__title {
      background-color: transparent;
    }

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

  // macOS 毛玻璃效果下，文字需要白色才能看清
  &.bg-transparent {
    .sidebar-header {
      h1 {
        // 标题文字在毛玻璃背景下使用白色，但保持渐变效果
        -webkit-text-fill-color: white;
        color: white;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      }
    }

    .sidebar-menu {
      .el-menu-item {
        color: white;

        .el-icon {
          color: white;
        }

        span {
          color: white;
        }

        // 激活状态保持渐变背景，文字为白色
        &.is-active {
          color: white;

          .el-icon {
            color: white;
          }

          span {
            color: white;
          }
        }

        // 悬浮状态：文字稍微变亮
        &:hover {
          color: rgba(255, 255, 255, 0.9);

          .el-icon {
            color: rgba(255, 255, 255, 0.9);
          }

          span {
            color: rgba(255, 255, 255, 0.9);
          }
        }
      }
    }

    // 折叠状态下的菜单项也需要白色
    &.sidebar-collapsed {
      .sidebar-menu {
        .el-menu-item {
          color: white;

          .el-icon {
            color: white;
          }

          // 激活状态：渐变背景 + 白色图标
          &.is-active {
            color: white;

            .el-icon {
              color: white;
            }
          }

          // 悬浮状态
          &:hover {
            color: rgba(255, 255, 255, 0.9);

            .el-icon {
              color: rgba(255, 255, 255, 0.9);
            }
          }
        }
      }
    }
  }
}

.app-main {
  padding: 0;
  overflow-y: auto;
  flex: 1;
  // 主内容保持不透明，避免整窗“穿透桌面”
  background: var(--anime-bg-main);
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
.file-drop-confirm-dialog {
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

// Daemon 加载态样式
@keyframes pulse {

  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.7;
    transform: scale(0.95);
  }
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}
</style>
