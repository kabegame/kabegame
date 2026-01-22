<template>
  <!-- 主窗口 -->
  <el-container class="app-container">
    <!-- Daemon 启动中 - 显示加载态 -->
    <div v-if="!daemonReady && !daemonOffline" class="daemon-loading">
      <div class="loading-content">
        <img src="/icon.png" alt="Logo" class="loading-logo" />
        <h2>正在启动后台服务…</h2>
        <div class="loading-spinner"></div>
      </div>
    </div>
    <!-- Daemon 已就绪或离线 - 显示主内容 -->
    <template v-else>
      <!-- 全局文件拖拽提示层 -->
      <FileDropOverlay ref="fileDropOverlayRef" />
      <!-- 文件拖拽导入确认弹窗（封装 ElMessageBox.confirm） -->
      <ImportConfirmDialog ref="importConfirmDialogRef" />
      <!-- 全局唯一的快捷设置抽屉（避免多页面实例冲突） -->
      <QuickSettingsDrawer />
      <!-- 全局唯一的帮助抽屉（按页面展示帮助内容） -->
      <HelpDrawer />
      <!-- 全局唯一的任务抽屉（避免多页面实例冲突） -->
      <TaskDrawer v-model="taskDrawerVisible" :tasks="taskDrawerTasks" />
      <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed }"
        :width="isCollapsed ? '64px' : '200px'">
        <div class="sidebar-header">
          <img :src="daemonOffline ? '/lost.png' : '/icon.png'" alt="Logo" class="app-logo logo-clickable"
            @click="toggleCollapse" />
          <div v-if="!isCollapsed" class="sidebar-title-section">
            <h1>Kabegame</h1>
            <div v-if="daemonOffline" class="offline-section">
              <p class="offline-hint">呜呜呜，鳄鳄找不到了呢</p>
              <el-button size="small" @click="handleReconnect" :loading="isReconnecting">
                找找看
              </el-button>
            </div>
          </div>
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
          <el-menu-item index="/help">
            <el-icon>
              <QuestionFilled />
            </el-icon>
            <span>帮助</span>
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-main class="app-main">
        <router-view v-slot="{ Component }" :key="routerViewKey">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </template>
  </el-container>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { Picture, Grid, Setting, Collection, QuestionFilled } from "@element-plus/icons-vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";
import HelpDrawer from "./components/help/HelpDrawer.vue";
import TaskDrawer from "./components/TaskDrawer.vue";
import { useTaskDrawerStore } from "./stores/taskDrawer";
import { storeToRefs } from "pinia";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import ImportConfirmDialog from "./components/import/ImportConfirmDialog.vue";
import { useActiveRoute } from "./composables/useActiveRoute";
import { useDaemonStatus } from "./composables/useDaemonStatus";
import { useWindowEvents } from "./composables/useWindowEvents";
import { useFileDrop } from "./composables/useFileDrop";
import { useSidebar } from "./composables/useSidebar";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ElMessageBox } from "element-plus";


// 路由高亮
const { activeRoute } = useActiveRoute();

// 任务抽屉 store
const taskDrawerStore = useTaskDrawerStore();
const { visible: taskDrawerVisible, tasks: taskDrawerTasks } = storeToRefs(taskDrawerStore);

// 文件拖拽提示层引用
const fileDropOverlayRef = ref<any>(null);
const importConfirmDialogRef = ref<any>(null);

// Daemon 状态管理
const { init: initDaemonStatus, daemonOffline, daemonReady, isReconnecting, reconnect } = useDaemonStatus();

// 路由视图 key，用于强制刷新组件
const routerViewKey = ref(0);

// 监听 daemonReady 变化，当从任何状态变为 ready 时刷新路由视图
watch(daemonReady, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    // daemonReady 从 false 变为 true，刷新路由视图
    routerViewKey.value += 1;
  }
});

// 处理重连
const handleReconnect = async () => {
  const error = await reconnect();
  if (error) {
    ElMessageBox.alert(error, "重连失败", { type: "error" });
  }
};

// 窗口事件监听
const { init: initWindowEvents } = useWindowEvents();

// 文件拖拽
const { init: initFileDrop } = useFileDrop(fileDropOverlayRef, importConfirmDialogRef);

// 侧边栏
const { isCollapsed, toggleCollapse } = useSidebar();

// 设置变更事件监听器
let unlistenSettingChange: UnlistenFn | null = null;

onMounted(async () => {
  // 初始化 settings store
  const settingsStore = useSettingsStore();
  await settingsStore.init();

  console.log('初始化 daemon 状态');
  // 初始化各个 composables
  await initDaemonStatus();
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
}

.app-sidebar {
  // 关键：侧栏背景必须半透明，DWM 才能透出模糊效果
  background: transparent;
  // 非 Windows / DWM 失效时的降级（浏览器预览也能看到“玻璃感”）
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
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
    // Element Plus 默认给 el-menu 一个不透明背景，会把“半透明侧栏”盖住，导致看起来没有毛玻璃
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
.daemon-loading {
  width: 100%;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--anime-bg-main);

  .loading-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;

    .loading-logo {
      width: 80px;
      height: 80px;
      object-fit: contain;
      animation: pulse 2s ease-in-out infinite;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--anime-text-primary);
      margin: 0;
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 4px solid var(--anime-border);
      border-top-color: var(--anime-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
  }
}

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
