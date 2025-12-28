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
import { Picture, Grid, Setting, Expand, Fold, Collection } from "@element-plus/icons-vue";
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

onMounted(async () => {
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

</style>
