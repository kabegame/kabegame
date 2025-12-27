<template>
  <!-- 壁纸窗口：通过 index.html?wallpaper=1 启动，只渲染壁纸层，不渲染侧边栏/路由页面 -->
  <WallpaperLayer v-if="isWallpaperWindow" />

  <!-- 主窗口 -->
  <el-container v-else class="app-container">
    <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed }" :width="isCollapsed ? '64px' : '200px'">
      <div class="sidebar-header">
        <h1 v-if="!isCollapsed">🎨 Kabegami</h1>
        <h1 v-else class="collapsed-title">🎨</h1>
        <el-button class="collapse-button" :icon="isCollapsed ? Expand : Fold" circle size="small"
          @click="toggleCollapse" />
      </div>
      <el-menu :default-active="activeRoute" router class="sidebar-menu" :collapse="isCollapsed">
        <el-menu-item index="/gallery">
          <el-icon>
            <Picture />
          </el-icon>
          <span>画廊</span>
        </el-menu-item>
        <el-menu-item index="/plugin-browser">
          <el-icon>
            <Grid />
          </el-icon>
          <span>收集源</span>
        </el-menu-item>
        <el-menu-item index="/albums">
          <el-icon>
            <Collection />
          </el-icon>
          <span>画册</span>
        </el-menu-item>
        <el-menu-item index="/downloads" class="download-menu-item">
          <div class="download-icon-wrapper" :class="{ 'download-icon-animate': hasActiveDownloads }">
            <el-icon class="download-icon-slot top">
              <Download />
            </el-icon>
            <el-icon class="download-icon-slot middle">
              <Download />
            </el-icon>
            <el-icon class="download-icon-slot bottom">
              <Download />
            </el-icon>
          </div>
          <span>正在下载</span>
          <el-badge v-if="totalDownloadCount > 0" :value="totalDownloadCount" :max="99" class="download-badge">
          </el-badge>
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
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { Picture, Grid, Setting, Download, Expand, Fold, Collection } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import WallpaperLayer from "./components/WallpaperLayer.vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const route = useRoute();
const activeRoute = computed(() => route.path);

// 关键：同步判断当前窗口 label，确保壁纸窗口首次渲染就进入 WallpaperLayer
const isWallpaperWindow = ref(false);
try {
  // wallpaper / wallpaper_debug 都渲染壁纸层（便于调试）
  isWallpaperWindow.value = getCurrentWebviewWindow().label.startsWith("wallpaper");
} catch {
  // 非 Tauri 环境（浏览器打开）会走这里
  isWallpaperWindow.value = false;
}

onMounted(() => {
  if (!isWallpaperWindow.value) {
    loadDownloadStatus();
    // 每 1 秒刷新一次
    refreshInterval = window.setInterval(loadDownloadStatus, 1000);
  }
});

// 侧边栏收起状态
const isCollapsed = ref(false);

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value;
};

interface ActiveDownloadInfo {
  url: string;
  plugin_id: string;
  start_time: number;
}

const activeDownloadsCount = ref(0);
const queueSize = ref(0);
let refreshInterval: number | null = null;

const totalDownloadCount = computed(() => activeDownloadsCount.value + queueSize.value);
const hasActiveDownloads = computed(() => totalDownloadCount.value > 0);

const loadDownloadStatus = async () => {
  try {
    const [downloads, size] = await Promise.all([
      invoke<ActiveDownloadInfo[]>("get_active_downloads"),
      invoke<number>("get_download_queue_size"),
    ]);
    activeDownloadsCount.value = downloads.length;
    queueSize.value = size;
  } catch (error) {
    console.error("加载下载状态失败:", error);
  }
};

onUnmounted(() => {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
  }
});
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
    flex-direction: column;
    align-items: center;
    gap: 12px;
    position: relative;
    min-height: 80px;
    justify-content: center;
    transition: padding 0.3s ease;

    h1 {
      font-size: 24px;
      font-weight: 700;
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin: 0;
      text-align: center;
      letter-spacing: 1px;
      transition: all 0.3s ease;
      width: 100%;

      &.collapsed-title {
        font-size: 32px;
        margin: 0;
        line-height: 1;
      }
    }

    .collapse-button {
      position: absolute;
      top: 12px;
      right: 12px;
      background: var(--anime-bg-card);
      border: 1px solid var(--anime-border);
      color: var(--anime-text-primary);
      transition: all 0.3s ease;
      z-index: 10;

      &:hover {
        background: var(--anime-primary-light);
        border-color: var(--anime-primary);
        color: var(--anime-primary);
      }
    }
  }

  &.sidebar-collapsed {
    .sidebar-header {
      padding: 16px 8px;
      min-height: 64px;
      gap: 8px;

      .collapse-button {
        position: static;
        margin-top: 0;
        width: 32px;
        height: 32px;
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

      .download-menu-item {

        // 收起状态：徽章放右上角，避免挤占图标区域
        .download-badge {
          position: absolute;
          right: 4px;
          top: 4px;
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
}

.download-menu-item {
  position: relative;
  display: flex;
  align-items: center;

  .download-icon-wrapper {
    position: relative;
    width: 32px;
    height: 1em;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .download-icon-slot {
    position: absolute;
    left: 0;
    right: 0;
    margin: 0 auto;
    color: var(--anime-primary);
    opacity: 0;
    transform: translateY(-10px);
    transition: opacity 0.2s ease;
  }

  .download-icon-slot.middle {
    opacity: 1;
    transform: translateY(0);
  }

  .download-icon-animate .download-icon-slot {
    animation: downloadIconCycle 1.6s infinite;
  }

  .download-icon-animate .download-icon-slot.middle {
    animation-delay: 0s;
  }

  .download-icon-animate .download-icon-slot.bottom {
    animation-delay: 0.8s;
  }

  .download-icon-animate .download-icon-slot.top {
    animation-delay: 1.2s;
  }

  // 静止状态：仅中间图标可见且居中
  &:not(.download-icon-animate) {
    .download-icon-slot {
      opacity: 0;
      transform: translateY(0);
    }

    .download-icon-slot.middle {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .download-badge {
    position: absolute;
    display: flex;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);

    .el-badge__content {
      background-color: #f56c6c;
      border-color: #f56c6c;
      color: #fff;
      border-radius: 999px;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
  }
}

@keyframes downloadIconCycle {
  0% {
    transform: translateY(-18px);
    opacity: 0;
  }

  10% {
    transform: translateY(-6px);
    opacity: 0.8;
  }

  25% {
    transform: translateY(0);
    opacity: 1;
  }

  40% {
    transform: translateY(8px);
    opacity: 0.4;
  }

  55% {
    transform: translateY(18px);
    opacity: 0;
  }

  100% {
    transform: translateY(38px);
    opacity: 0;
  }
}
</style>
