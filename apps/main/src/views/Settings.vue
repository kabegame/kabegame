<template>
  <div class="settings-container" v-pull-to-refresh="pullToRefreshOpts">
    <div class="settings-content">
      <PageHeader
        title="设置"
        :show="settingsShowIds"
        :fold="[]"
        @action="handleSettingsAction"
        sticky
      />

        <StyledTabs v-model="activeTab" sticky>

      <el-tab-pane label="壁纸轮播" name="wallpaper">
        <el-card class="settings-card">
          <template #header>
            <span>壁纸轮播设置</span>
          </template>

          <div v-loading="showLoading" element-loading-text="" style="min-height: 200px;">
            <div v-if="!loading" class="settings-list">
              <SettingRow label="启用壁纸轮播" description="自动从指定画册中轮播更换桌面壁纸">
                <WallpaperRotationEnabledSetting />
              </SettingRow>

              <SettingRow :label="rotationEnabled ? '选择画册' : '选择壁纸'" description="轮播启用时选择画册；关闭时前往画廊选择单张壁纸">
                <WallpaperRotationTargetSetting />
              </SettingRow>

              <SettingRow v-if="rotationEnabled" label="轮播间隔" :description="`壁纸更换间隔（分钟，${rotationIntervalMin}-1440）`">
                <SettingNumberControl setting-key="wallpaperRotationIntervalMinutes" :min="rotationIntervalMin" :max="1440" :step="10" />
              </SettingRow>

              <SettingRow v-if="rotationEnabled" label="轮播模式" description="随机模式：每次随机选择；顺序模式：按顺序依次更换">
                <SettingRadioControl setting-key="wallpaperRotationMode" :options="[
                  { label: '随机', value: 'random' },
                  { label: '顺序', value: 'sequential' },
                ]" />
              </SettingRow>

              <SettingRow v-if="IS_WINDOWS || IS_LINUX" label="壁纸显示方式" description="原生模式：根据系统支持显示可用样式">
                <WallpaperStyleSetting />
              </SettingRow>

              <SettingRow v-if="IS_WINDOWS" label="过渡效果" description="仅轮播支持过渡预览">
                <WallpaperTransitionSetting />
              </SettingRow>

              <SettingRow v-if="IS_WINDOWS" label="壁纸模式">
                <WallpaperModeSetting />
              </SettingRow>

              <SettingRow v-if="IS_WINDOWS" label="Wallpaper Engine 目录" description="用于“导出并自动导入到 WE”">
                <WallpaperEngineDirSetting />
              </SettingRow>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="下载设置" name="download">
        <el-card class="settings-card">
          <template #header>
            <span>下载设置</span>
          </template>

          <div v-loading="showLoading" element-loading-text="" style="min-height: 200px;">
            <div v-if="!loading" class="settings-list">
              <SettingRow label="最大并发下载量" description="同时下载的图片数量（1-10）">
                <SettingNumberControl setting-key="maxConcurrentDownloads" :min="1" :max="10" :step="1" />
              </SettingRow>

              <SettingRow label="网络失效重试次数" description="下载图片遇到网络错误/超时等情况时，额外重试的次数（0-10）">
                <SettingNumberControl setting-key="networkRetryCount" :min="0" :max="10" :step="1" />
              </SettingRow>

              <SettingRow label="自动去重" description="根据文件哈希值自动跳过重复图片，避免在画廊中重复添加相同文件">
                <SettingSwitchControl setting-key="autoDeduplicate" />
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID" label="默认下载目录" description="未在任务里指定输出目录时，将下载到该目录（按插件分文件夹保存）">
                <DefaultDownloadDirSetting />
              </SettingRow>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane v-if="!IS_ANDROID" label="应用设置" name="app">
        <el-card class="settings-card">
          <template #header>
            <span>应用设置</span>
          </template>

          <div v-loading="showLoading" element-loading-text="" style="min-height: 200px;">
            <div v-if="!loading" class="settings-list">
              <SettingRow v-if="!IS_ANDROID" label="开机启动" description="应用启动时自动运行">
                <SettingSwitchControl setting-key="autoLaunch" />
              </SettingRow>

              <SettingRow v-if="!isLightMode" label="画册盘" description="在资源管理器中以虚拟盘方式浏览画册（只支持有限的操作）">
                <AlbumDriveSetting />
              </SettingRow>
              <SettingRow v-if="!IS_ANDROID" label="图片点击行为" description="左键点击图片时的行为">
                <SettingRadioControl setting-key="imageClickAction" :options="[
                  { label: '应用内预览', value: 'preview' },
                  { label: '系统默认打开', value: 'open' },
                ]" />
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID" label="图片宽高比" description="影响画廊/画册中图片卡片的展示宽高比">
                <GalleryImageAspectRatioSetting />
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID" label="清理应用数据" description="将删除所有图片、画册、任务、设置、插件配置等用户数据，应用将自动重启">
                <ClearUserDataSetting />
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID" label="爬虫 WebView 窗口" description="打开用于 WebView 插件运行的 crawler 窗口">
                <el-button type="primary" :loading="crawlerWebviewOpening" @click="openCrawlerWindow">
                  打开 WebView 窗口
                </el-button>
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID" label="自动打开 WebView" description="启动 WebView 插件时自动显示并聚焦 WebView 窗口">
                <SettingSwitchControl :setting-key="autoOpenCrawlerWebviewKey" />
              </SettingRow>

              <SettingRow v-if="IS_DEV" label="生成测试图片（调试）" description="基于现有图片数据批量克隆插入，用于性能/分页测试（仅开发模式可见）">
                <DebugGenerateImagesSetting />
              </SettingRow>

              <SettingRow v-if="!IS_ANDROID && IS_DEV" label="桌面端开发：WebView 窗口" description="配置远程 URL，在独立 WebView 窗口中打开（用于爬虫 WebView 后端原型等，参见 CRAWLER_BACKENDS.md）">
                <div class="dev-webview-row">
                  <el-input
                    v-model="devWebviewUrl"
                    placeholder="https://example.com"
                    clearable
                    class="dev-webview-input"
                    @keyup.enter="openDevWebview"
                  />
                  <el-button type="primary" :loading="devWebviewOpening" @click="openDevWebview">
                    打开 WebView 窗口
                  </el-button>
                </div>
              </SettingRow>
            </div>
          </div>
        </el-card>
        </el-tab-pane>

        </StyledTabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import type { AppSettingKey } from "@kabegame/core/stores/settings";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import SettingRow from "@kabegame/core/components/settings/SettingRow.vue";
import SettingSwitchControl from "@kabegame/core/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@kabegame/core/components/settings/controls/SettingNumberControl.vue";
import SettingRadioControl from "@kabegame/core/components/settings/controls/SettingRadioControl.vue";
import DefaultDownloadDirSetting from "@kabegame/core/components/settings/items/DefaultDownloadDirSetting.vue";
import GalleryImageAspectRatioSetting from "@/components/settings/items/GalleryImageAspectRatioSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperRotationTargetSetting from "@/components/settings/items/WallpaperRotationTargetSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperEngineDirSetting from "@/components/settings/items/WallpaperEngineDirSetting.vue";
import ClearUserDataSetting from "@/components/settings/items/ClearUserDataSetting.vue";
import DebugGenerateImagesSetting from "@/components/settings/items/DebugGenerateImagesSetting.vue";
import AlbumDriveSetting from "@/components/settings/items/AlbumDriveSetting.vue";
import { IS_WINDOWS, IS_LINUX, IS_LIGHT_MODE, IS_ANDROID, IS_DEV } from "@kabegame/core/env";
const autoOpenCrawlerWebviewKey: AppSettingKey = "autoOpenCrawlerWebview";
const devWebviewUrl = ref("https://www.example.com");
const devWebviewOpening = ref(false);
const crawlerWebviewOpening = ref(false);
async function openCrawlerWindow() {
  crawlerWebviewOpening.value = true;
  try {
    await invoke("show_crawler_window");
    ElMessage.success("已打开 crawler WebView 窗口");
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    crawlerWebviewOpening.value = false;
  }
}

async function openDevWebview() {
  const url = devWebviewUrl.value?.trim() || "";
  if (!url) {
    ElMessage.warning("请输入要打开的 URL");
    return;
  }
  devWebviewOpening.value = true;
  try {
    await invoke("open_dev_webview", { url });
    ElMessage.success("已打开 WebView 窗口");
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    devWebviewOpening.value = false;
  }
}
import { useHelpDrawerStore } from "@/stores/helpDrawer";

// 使用 300ms 防闪屏加载延迟
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay(300);

const settingsStore = useSettingsStore();
const activeTab = ref<string>("wallpaper");
const isRefreshing = ref(false);
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);
const rotationIntervalMin = computed(() => (IS_ANDROID ? 15 : 1));
const wallpaperMode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("settings");
const isLightMode = IS_LIGHT_MODE;

const settingsShowIds = computed(() => (IS_ANDROID ? [] : [HeaderFeatureId.Refresh, HeaderFeatureId.Help]));
const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

function handleSettingsAction(payload: { id: string; data: { type: string } }) {
  if (payload.id === HeaderFeatureId.Refresh) handleRefresh();
  else if (payload.id === HeaderFeatureId.Help) openHelpDrawer();
}


const loadSettings = async () => {
  startLoading();
  try {
    await settingsStore.loadAll();
  } finally {
    finishLoading();
  }
};

// 统一的刷新处理
const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await loadSettings();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshing.value = false;
  }
};

// 首次进入时加载设置
onMounted(() => {
  loadSettings();
});

</script>

<style scoped lang="scss">
// 切换模式时的鼠标加载态
.wallpaper-mode-switching {
  cursor: wait !important;

  :deep(.el-radio) {
    cursor: wait !important;

    .el-radio__label {
      cursor: wait !important;
    }
  }
}

.settings-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px;
  /* 隐藏滚动条 */
  scrollbar-width: none;
  /* Firefox */
  -ms-overflow-style: none;
  /* IE and Edge */
}

.settings-content {
  height: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
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

.wallpaper-actual-alert {
  width: 100%;
}

.settings-card {
  background: var(--anime-bg-card);
  border-radius: 16px;
  box-shadow: var(--anime-shadow);
  transition: none !important;

  &:hover {
    transform: none !important;
    box-shadow: var(--anime-shadow) !important;
  }
}

.form-item-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dev-webview-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.dev-webview-input {
  flex: 1;
  min-width: 200px;
}

.settings-list {
  display: flex;
  flex-direction: column;
}

.setting-description {
  font-size: 12px;
  color: var(--anime-text-muted);
  margin-top: 0;
}

.path-button {
  padding: 0;
  margin-left: 6px;
  max-width: 100%;
  justify-content: flex-start;
}

.path-text {
  margin-left: 6px;
  max-width: 560px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}

/* 确保 switch 有平滑的过渡动画 */
:deep(.el-switch) {
  transition: all 0.3s ease;
}

:deep(.el-switch__core) {
  transition: all 0.3s ease;
}

:deep(.el-switch__action) {
  transition: all 0.3s ease;
}

/* 移除 input-number 的边框 */
:deep(.el-input-number) {
  border: none !important;

  .el-input__wrapper {
    border: none !important;
    box-shadow: none !important;
  }

  &:hover .el-input__wrapper {
    border: none !important;
    box-shadow: none !important;
  }

  &.is-controls-right {
    border: none !important;

    &:hover {
      border: none !important;
    }
  }

  .el-input-number__increase,
  .el-input-number__decrease {
    border: none !important;
  }

  &:hover .el-input-number__increase,
  &:hover .el-input-number__decrease {
    border: none !important;
  }
}

.loading-placeholder {
  padding: 20px;
  text-align: center;
  color: var(--anime-text-secondary);
}

// 切换模式时的鼠标加载态
.wallpaper-mode-switching-container {
  cursor: wait !important;
}

.wallpaper-mode-switching {
  cursor: wait !important;

  :deep(.el-radio) {
    cursor: wait !important;

    .el-radio__label {
      cursor: wait !important;
    }

    .el-radio__input {
      cursor: wait !important;
    }
  }
}
</style>
