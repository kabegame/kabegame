<template>
  <!-- 壁纸窗口：通过 index.html?wallpaper=1 启动，只渲染壁纸层，不渲染侧边栏/路由页面 -->
  <WallpaperLayer v-if="isWallpaperWindow" />

  <!-- 主窗口 -->
  <el-container v-else class="app-container">
    <!-- 全局唯一的快捷设置抽屉（避免多页面实例冲突） -->
    <QuickSettingsDrawer />
    <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed }" :width="isCollapsed ? '64px' : '200px'">
      <div class="sidebar-header">
        <img src="/icon.png" alt="Logo" class="app-logo" :class="{ 'logo-clickable': isCollapsed }"
          @click="isCollapsed ? toggleCollapse() : null" />
        <h1 v-if="!isCollapsed">Kabegame</h1>
        <el-button v-if="!isCollapsed" class="collapse-button" :icon="Fold" circle size="small"
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
          <span>源</span>
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
import { computed, ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import { Picture, Grid, Setting, Fold, Collection } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import WallpaperLayer from "./components/WallpaperLayer.vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useSettingsStore } from "./stores/settings";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";

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

      .collapse-button {
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
</style>
