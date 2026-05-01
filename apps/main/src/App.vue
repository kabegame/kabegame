<template>
  <el-config-provider :locale="elementPlusLocale">
  <!-- 主窗口 -->
  <el-container class="app-container" :class="{ 'app-container-compact': uiStore.isCompact, 'has-app-background': bgVisible }">
    <div
      v-if="bgVisible"
      class="app-background-layer"
      aria-hidden="true"
    >
      <img
        :src="bgImageUrl"
        class="app-background-img"
        :style="bgImageStyle"
      />
    </div>
    <!-- 全局文件拖拽提示层（仅非安卓平台） -->
    <FileDropOverlay v-if="!uiStore.isCompact" ref="fileDropOverlayRef" @click="handleOverlayClick" />
    <!-- 文件拖拽导入确认弹窗（仅非安卓平台） -->
    <ImportConfirmDialog v-if="!uiStore.isCompact" ref="importConfirmDialogRef" />
    <!-- 外部插件导入弹窗 -->
    <PluginImportDialog 
      v-model:visible="showImportDialog" 
      :kgpg-path="importKgpgPath"
    />
    <!-- 全局唯一的快捷设置抽屉（桌面与安卓均挂载，安卓用 useModalBack 处理返回键） -->
    <QuickSettingsDrawer />
    <!-- 全局唯一的帮助抽屉（按页面展示帮助内容） -->
    <HelpDrawer />
    <!-- 全局唯一的任务抽屉（避免多页面实例冲突） -->
    <TaskDrawer v-model="taskDrawerVisible" :tasks="taskDrawerTasks" />
    <AutoConfigDialog />
    <!-- Android：全局导入抽屉 -->
    <CrawlerDialog v-if="uiStore.isCompact" v-model="crawlerDrawerVisible"
      :initial-config="crawlerDrawerInitialConfig" />
    <MissedRunsDialog
      v-model="missedRunsVisible"
      :items="missedRunItems"
      @run-now="handleRunMissedNow"
      @dismiss="handleDismissMissed"
    />
    <!-- 非紧凑布局：侧边栏 + 主内容 -->
    <template v-if="!uiStore.isCompact">
      <el-aside class="app-sidebar" :class="{ 'sidebar-collapsed': isCollapsed, 'bg-transparent': (IS_WINDOWS || IS_MACOS) && !IS_WEB, 'bg-white': !IS_WINDOWS && !IS_MACOS || IS_WEB }" :width="isCollapsed ? '64px' : '200px'">
        <div class="sidebar-header">
          <img :src="appLogoUrl" alt="Logo" class="app-logo logo-clickable" @click="toggleCollapse" />
          <div v-if="!isCollapsed" class="sidebar-title-section">
            <h1>Kabegame</h1>
          </div>
        </div>
        <el-menu :default-active="activeRoute" router class="sidebar-menu" :collapse="isCollapsed">
          <el-menu-item :index="galleryMenuRoute">
            <el-icon>
              <Picture />
            </el-icon>
            <span>{{ $t('route.gallery') }}</span>
          </el-menu-item>
          <el-menu-item index="/albums">
            <el-icon>
              <Collection />
            </el-icon>
            <span>{{ $t('route.albums') }}</span>
          </el-menu-item>
          <el-menu-item index="/plugin-browser">
            <el-icon>
              <Grid />
            </el-icon>
            <span>{{ $t('route.pluginBrowser') }}</span>
          </el-menu-item>
          <el-menu-item index="/surf" v-if="!IS_WEB">
            <el-icon>
              <Compass />
            </el-icon>
            <span>{{ $t('route.surf') }}</span>
          </el-menu-item>
          <el-menu-item index="/auto-configs" v-if="!uiStore.isCompact">
            <el-icon>
              <AlarmClock />
            </el-icon>
            <span>{{ $t('route.autoConfigs') }}</span>
          </el-menu-item>
          <el-menu-item index="/settings">
            <el-icon>
              <Setting />
            </el-icon>
            <span>{{ $t('route.settings') }}</span>
          </el-menu-item>
          <el-menu-item index="/help">
            <el-icon>
              <QuestionFilled />
            </el-icon>
            <span>{{ $t('route.help') }}</span>
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
    <!-- Web mode：super 模式切换（左下角浮动） -->
    <SuperModeToggle v-if="IS_WEB && !uiStore.isCompact" />
    <!-- 紧凑布局：底部 Tab 栏（长按操作由 ActionRenderer 统一处理） -->
    <nav v-if="uiStore.isCompact" class="app-bottom-tabs" aria-label="主导航">
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
  </el-config-provider>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import zhCn from "element-plus/dist/locale/zh-cn.mjs";
import en from "element-plus/dist/locale/en.mjs";
import zhTw from "element-plus/dist/locale/zh-tw.mjs";
import ja from "element-plus/dist/locale/ja.mjs";
import ko from "element-plus/dist/locale/ko.mjs";
import { Picture, Grid, Setting, Collection, QuestionFilled, Compass, AlarmClock } from "@element-plus/icons-vue";
import appLogoUrl from "@/assets/icon-small.png";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useI18n, setLocale, resolveLanguage, i18n } from "@kabegame/i18n";
import { registerHeaderFeatures } from "@/header/headerFeatures";
import QuickSettingsDrawer from "./components/settings/QuickSettingsDrawer.vue";
import HelpDrawer from "./components/help/HelpDrawer.vue";
import TaskDrawer from "./components/TaskDrawer.vue";
import { useTaskDrawerStore } from "./stores/taskDrawer";
import { useCrawlerDrawerStore } from "./stores/crawlerDrawer";
import { storeToRefs } from "pinia";
import FileDropOverlay from "./components/FileDropOverlay.vue";
import ImportConfirmDialog from "./components/import/ImportConfirmDialog.vue";
import PluginImportDialog from "./components/import/PluginImportDialog.vue";
import CrawlerDialog from "./components/CrawlerDialog.vue";
import MissedRunsDialog from "./components/scheduler/MissedRunsDialog.vue";
import AutoConfigDialog from "./components/scheduler/AutoConfigDialog.vue";
import SuperModeToggle from "./components/SuperModeToggle.vue";
import { useActiveRoute } from "./composables/useActiveRoute";
import { useWindowEvents } from "./composables/useWindowEvents";
import { useFileDrop } from "./composables/useFileDrop";
import { useSidebar } from "./composables/useSidebar";
import { listen, emit, UnlistenFn } from "@/api/rpc";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from "@/api/rpc";
import { IS_WINDOWS, IS_MACOS, IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { fileToUrl, initHttpServerBaseUrl } from "@kabegame/core/httpServer";
import type { ImageInfo } from "@kabegame/core/types/image";
import { usePluginStore } from "./stores/plugins";
import { useFailedImagesStore } from "./stores/failedImages";
import { useCrawlerStore } from "./stores/crawler";
import { useRouter } from "vue-router";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";
import { ElMessage, ElMessageBox } from "element-plus";
import { useThrottleFn } from "@vueuse/core";
import { useApp } from "@/stores/app";

// 路由高亮
const { activeRoute, galleryMenuRoute } = useActiveRoute();
const { t, locale } = useI18n();

/** Element Plus 组件（含 DatePicker 面板文案）与 vue-i18n 语言对齐 */
const elementPlusLocale = computed(() => {
  switch (locale.value) {
    case "zh":
      return zhCn;
    case "zhtw":
      return zhTw;
    case "ja":
      return ja;
    case "ko":
      return ko;
    default:
      return en;
  }
});

// Android 底部 Tab 配置（均匀分布；爬虫仅桌面端有代理，故仅侧栏展示）
// 依赖 locale 以便语言切换时标签立即更新
// 安卓暂不展示「运行配置」入口（与桌面侧栏 /auto-configs 区分）
const bottomTabs = computed(() => {
  void locale.value;
  const tabs = [
    { index: galleryMenuRoute.value, icon: Picture, label: i18n.global.t("route.gallery") },
    { index: "/albums", icon: Collection, label: i18n.global.t("route.albums") },
    { index: "/plugin-browser", icon: Grid, label: i18n.global.t("route.pluginBrowser") },
    { index: "/auto-configs", icon: AlarmClock, label: i18n.global.t("route.autoConfigs") },
    { index: "/settings", icon: Setting, label: i18n.global.t("route.settings") },
    { index: "/help", icon: QuestionFilled, label: i18n.global.t("route.help") },
  ];
  if (uiStore.isCompact) {
    return tabs.filter((t) => t.index !== "/auto-configs");
  }
  return tabs;
});

// 任务抽屉 store
const taskDrawerStore = useTaskDrawerStore();
const { visible: taskDrawerVisible, tasks: taskDrawerTasks } = storeToRefs(taskDrawerStore);

// Android：导入抽屉 store
const crawlerDrawerStore = useCrawlerDrawerStore();
const { visible: crawlerDrawerVisible, initialConfig: crawlerDrawerInitialConfig } = storeToRefs(crawlerDrawerStore);

const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const crawlerStore = useCrawlerStore();

const router = useRouter();
const modalStack = useModalStackStore();

// 文件拖拽提示层引用
const fileDropOverlayRef = ref<any>(null);
const importConfirmDialogRef = ref<any>(null);

// 外部导入插件对话框
const showImportDialog = ref(false);
const importKgpgPath = ref<string | null>(null);

// 路由视图 key，用于强制刷新组件
const routerViewKey = ref(0);
const appStore = useApp();
if (IS_WEB) {
  watch(() => appStore.isSuper, () => { routerViewKey.value += 1; });
}
const missedRunsVisible = ref(false);
const missedRunItems = ref<import("@kabegame/core/stores/crawler").MissedRunItem[]>([]);

type GalleryBrowseEntry =
  | { kind: "dir"; name: string }
  | { kind: "image"; image: ImageInfo };

type GalleryBrowseResult = {
  entries: GalleryBrowseEntry[];
  total: number | null;
  meta?: { kind: string; data: unknown } | null;
  note?: { title: string; content: string } | null;
};

// 窗口事件监听
const { init: initWindowEvents } = useWindowEvents();

// 文件拖拽
const { init: initFileDrop, handleOverlayClick } = useFileDrop(fileDropOverlayRef, importConfirmDialogRef);

// 侧边栏
const { isCollapsed, toggleCollapse } = useSidebar();

// 紧凑布局信号（Android 恒紧凑；web mode 跟随视口；Tauri 桌面永不紧凑）
const uiStore = useUiStore();
const settingsStore = useSettingsStore();

const bgImageUrl = ref("");
const isAbsoluteUrl = (url: string) => /^https?:\/\//i.test(url);
let bgResolveToken = 0;

watch(
  () => settingsStore.values.currentWallpaperImageId,
  async (id) => {
    const token = ++bgResolveToken;
    const imageId = typeof id === "string" ? id.trim() : "";
    console.log("[AppBackground] wallpaper id changed", {
      rawId: id,
      imageId,
      enabled: settingsStore.values.appBackgroundEnabled,
      opacity: settingsStore.values.appBackgroundOpacity,
      blur: settingsStore.values.appBackgroundBlur,
    });
    if (!imageId) {
      bgImageUrl.value = "";
      console.log("[AppBackground] cleared: empty currentWallpaperImageId");
      return;
    }

    try {
      console.log("[AppBackground] get_image_by_id start", { imageId });
      let image = (await invoke<ImageInfo | null>("get_image_by_id", { imageId })) ?? undefined;
      console.log("[AppBackground] get_image_by_id result", { image });

      if (!image) {
        const path = `/images/id_${imageId}/`;
        console.log("[AppBackground] get_image_by_id empty, fallback query_provider start", { path });
        const res = await invoke<GalleryBrowseResult>("query_provider", {
          path,
        });
        console.log("[AppBackground] query_provider result", {
          total: res.total,
          entryCount: res.entries?.length ?? 0,
          entries: res.entries,
          meta: res.meta,
          note: res.note,
        });
        image = (res.entries || []).find((entry) => entry.kind === "image")?.image;
      }

      const source = image?.url && isAbsoluteUrl(image.url)
        ? image.url
        : image?.localPath
          ? fileToUrl(image.localPath)
          : "";
      if (token !== bgResolveToken) return;
      bgImageUrl.value = source;
      console.log("[AppBackground] resolved", {
        imageId,
        image,
        source,
        sourceIsEmpty: !source,
      });
    } catch (error) {
      if (token !== bgResolveToken) return;
      console.warn("[AppBackground] failed to resolve app background image", error);
      bgImageUrl.value = "";
    }
  },
  { immediate: true },
);

const bgVisible = computed(() =>
  !!settingsStore.values.appBackgroundEnabled &&
  !!settingsStore.values.currentWallpaperImageId &&
  !!bgImageUrl.value
);
const bgOpacity = computed(() => settingsStore.values.appBackgroundOpacity ?? 0.25);
const bgBlurPx = computed(() => settingsStore.values.appBackgroundBlur ?? 2);
const bgImageStyle = computed(() => ({
  opacity: bgOpacity.value,
  filter: bgBlurPx.value > 0 ? `blur(${bgBlurPx.value}px)` : "none",
}));

watch(
  () => ({
    visible: bgVisible.value,
    enabled: settingsStore.values.appBackgroundEnabled,
    currentWallpaperImageId: settingsStore.values.currentWallpaperImageId,
    url: bgImageUrl.value,
    opacity: bgOpacity.value,
    blur: bgBlurPx.value,
  }),
  (state) => {
    console.log("[AppBackground] visibility state", state);
  },
  { immediate: true },
);

// 设置变更事件监听器
let unlistenSettingChange: UnlistenFn | null = null;

// F11 全屏：仅在本窗口获得焦点时响应，不占用其他应用（如浏览器）的 F11
let removeF11Listener: (() => void) | null = null;

onMounted(async () => {
  if (!IS_ANDROID) {
    await initHttpServerBaseUrl();
  }

  // Android Back Button Handling
  let confirmingExit = false;
  if (IS_ANDROID) {
    try {
      const { onBackButtonPress } = await import("@tauri-apps/api/app");
      const EXIT_COOLDOWN_MS = 400;
      await onBackButtonPress(useThrottleFn(async () => {
        if (confirmingExit) {
          ElMessageBox.close();
          confirmingExit = false;
          return;
        }
        // 1. Modal Stack
        if (await modalStack.closeTop()) {
          return;
        }

        // 2. Router Back
        const currentPath = router.currentRoute.value.path;
        const rootPaths = bottomTabs.value.map((t) => t.index);
        // If not at root, go back
        if (!rootPaths.includes(currentPath) && currentPath !== "/") {
          router.back();
          return;
        }

        // 3. Exit Confirm
        try {
          confirmingExit = true;
          await ElMessageBox.confirm(i18n.global.t("common.exitConfirm"), i18n.global.t("common.exitTitle"), {
            confirmButtonText: i18n.global.t("common.bye"),
            cancelButtonText: i18n.global.t("common.cancel"),
            type: "warning",
            center: true,
            customClass: "exit-confirm-dialog",
          });
          await invoke("exit_app");
        } catch {
          // Cancelled
        } finally {
          confirmingExit = false;
        }
      }, EXIT_COOLDOWN_MS));
    } catch (e) {
      console.warn("Failed to register Android back button listener:", e);
    }
  }

  // 加载全部设置
  await settingsStore.loadAll();
  console.log("[AppBackground] settings loaded", {
    appBackgroundEnabled: settingsStore.values.appBackgroundEnabled,
    appBackgroundOpacity: settingsStore.values.appBackgroundOpacity,
    appBackgroundBlur: settingsStore.values.appBackgroundBlur,
    currentWallpaperImageId: settingsStore.values.currentWallpaperImageId,
  });

  // 从配置恢复语言：解析链生效后若与存储不一致则写回 canonical，避免长期为 null/别名/非法值
  {
    const raw = settingsStore.values.language;
    const canonical = resolveLanguage(raw ?? undefined);
    setLocale(canonical);
    if ((raw ?? "").trim() !== canonical) {
      await settingsStore.save("language", canonical);
    }
  }
  registerHeaderFeatures();
  console.log("[App.vue] about to call pluginStore.loadPlugins()");
  try {
    await pluginStore.loadPlugins();
    console.log("[App.vue] pluginStore.loadPlugins() resolved");
  } catch (e) {
    console.error("加载已安装插件列表失败:", e);
  }
  await failedImagesStore.initListeners();
  await checkMissedRunsAtStartup();

  // 初始化各个 composables
  await initWindowEvents();
  // 安卓下不支持拖拽导入，跳过初始化
  if (!IS_ANDROID) {
    await initFileDrop();
  }

  // 桌面端（非 macOS）：在窗口内监听 F11 切换全屏，仅当本窗口有焦点时触发，不占用系统/浏览器的 F11
  if (!IS_ANDROID && !IS_MACOS) {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        invoke("toggle_fullscreen").catch((err) => console.warn("toggle_fullscreen failed:", err));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    removeF11Listener = () => window.removeEventListener("keydown", onKeyDown);
  }

  // Android：右滑手势已移除，避免与手机左右滑动导航冲突
  // 现在只能通过点击导入按钮打开 drawer

  // 监听设置变更事件（事件驱动更新设置）
  // 当后端设置变化时，自动更新本地设置 store
  unlistenSettingChange = await listen<{ changes?: Record<string, any> } & Record<string, unknown>>("setting-change", async (event) => {
    const raw = event.payload as Record<string, unknown> | undefined;
    const changes = raw && typeof raw === "object" ? (raw.changes as Record<string, unknown> | undefined) ?? raw : undefined;
    if (changes && typeof changes === "object") {
      Object.assign(settingsStore.values, changes);
      if ("language" in changes) {
        const raw = settingsStore.values.language;
        const canonical = resolveLanguage(raw ?? undefined);
        setLocale(canonical);
        if ((raw ?? "").trim() !== canonical) {
          await settingsStore.save("language", canonical);
        }
        registerHeaderFeatures();
      }
      console.log("[Settings] 收到设置变更事件，已更新:", Object.keys(changes));
    }
  });

  // Web mode 无 setting-change 事件，改用 watch 响应语言切换
  if (IS_WEB) {
    watch(
      () => settingsStore.values.language,
      (raw) => {
        const canonical = resolveLanguage(raw ?? undefined);
        setLocale(canonical);
        registerHeaderFeatures();
      },
    );
  }

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

  // Android 适配：供原生代码调用的全局方法
  if (IS_ANDROID) {
    (window as any).onKabegameImportPlugin = (path: string) => {
      console.log("[Android] Received import request:", path);
      // 触发相同的逻辑
      importKgpgPath.value = path;
      showImportDialog.value = true;
    };
  }
  
  // 通知后端已准备好接收事件
  emit('app-ready');
});

const checkMissedRunsAtStartup = async () => {
  if (IS_WEB) return; // web mode: backend auto-runs missed configs on startup
  try {
    await crawlerStore.runConfigsReady;
    const items = await crawlerStore.getMissedRuns();
    if (!items.length) return;
    missedRunItems.value = items;
    missedRunsVisible.value = true;
  } catch (error) {
    console.warn("检查漏跑任务失败:", error);
  }
};

const handleRunMissedNow = async () => {
  const ids = missedRunItems.value.map((item) => item.configId);
  if (!ids.length) {
    missedRunsVisible.value = false;
    return;
  }
  await crawlerStore.runMissedConfigs(ids);
  missedRunsVisible.value = false;
  missedRunItems.value = [];
  ElMessage.success(t("autoConfig.missedRuns.runNowSuccess"));
};

const handleDismissMissed = async () => {
  const ids = missedRunItems.value.map((item) => item.configId);
  if (!ids.length) {
    missedRunsVisible.value = false;
    return;
  }
  await crawlerStore.dismissMissedConfigs(ids);
  missedRunsVisible.value = false;
  missedRunItems.value = [];
  ElMessage.info(t("autoConfig.missedRuns.dismissed"));
};

onUnmounted(() => {
  // 清理设置变更事件监听器
  if (unlistenSettingChange) {
    unlistenSettingChange();
    unlistenSettingChange = null;
  }
  if (removeF11Listener) {
    removeF11Listener();
    removeF11Listener = null;
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
  height: 100dvh;
  display: flex;
  position: relative;
  overflow: hidden;
  // 让窗口透明层透出（DWM blur behind 只在透明像素处可见）
  background: transparent;

  &.app-container-compact {
    flex-direction: column;
  }

  &.has-app-background {
    .app-main {
      background: rgba(255, 255, 255, 0.65);
    }

    .app-sidebar {
      background: transparent;
    }

    .app-bottom-tabs {
      background: rgba(255, 255, 255, 0.7);
    }
  }

  > :not(.app-background-layer) {
    position: relative;
    z-index: 1;
  }
}

.app-background-layer {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.app-background-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(1.04);
  transition: opacity 0.25s ease, filter 0.25s ease;
}

// 紧凑布局：主内容区顶部留出状态栏高度，避免与 Android 系统状态栏重叠（桌面浏览器 env() 为 0）
.app-container.app-container-compact .app-main {
  padding-top: var(--sat, env(safe-area-inset-top, 24px));
}

// 紧凑布局：全局去除触摸时的浅蓝色高亮（与画廊图片等一致）
.app-container.app-container-compact,
.app-container.app-container-compact * {
  -webkit-tap-highlight-color: transparent;
  tap-highlight-color: transparent;
}

// Android 底部 Tab 栏：均匀分布
.app-bottom-tabs {
  flex: 0 0 auto;
  display: flex;
  flex-direction: row;
  width: 100%;
  border-top: 2px solid var(--anime-border);
  background: var(--anime-bg-card);
  padding-bottom: var(--sab, env(safe-area-inset-bottom, 0px));
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
  height: 100dvh;
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

<style lang="scss">
/* 安卓下全局 Dialog 宽度固定为 90vw（el-dialog 挂载在 body，需非 scoped） */
html.platform-android .el-dialog {
  width: 90vw !important;
  max-width: 90vw !important;
}
</style>
