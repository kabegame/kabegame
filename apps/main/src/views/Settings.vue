<template>
  <div class="settings-container" v-pull-to-refresh="pullToRefreshOpts">
    <div class="settings-content">
      <PageHeader :title="$t('settings.title')" :show="settingsShowIds" :fold="[]" @action="handleSettingsAction"
        sticky />

      <StyledTabs v-model="activeTab" sticky>

        <el-tab-pane :label="$t('settings.appSettings')" :name="SETTINGS_TAB_NAMES[0]">
          <el-card class="settings-card">
            <template #header>
              <span>{{ $t('settings.appSettings') }}</span>
            </template>
            <div v-loading="showLoading" element-loading-text="" style="min-height: 120px;">
              <div v-if="!loading" class="settings-list">
                <SettingRow :label="$t('settings.language')" :description="$t('settings.languageDesc')">
                  <LanguageSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.autoLaunch')"
                  :description="$t('settings.autoLaunchDesc')">
                  <SettingSwitchControl setting-key="autoLaunch" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && !isLightMode" :label="$t('settings.albumDrive')"
                  :description="$t('settings.albumDriveDesc')">
                  <AlbumDriveSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.imageClickAction')"
                  :description="$t('settings.imageClickActionDesc')">
                  <SettingRadioControl setting-key="imageClickAction" :options="imageClickActionOptions" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.imageAspectRatio')"
                  :description="$t('settings.imageAspectRatioDesc')">
                  <GalleryImageAspectRatioSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.galleryColumns')"
                  :description="$t('settings.galleryColumnsDesc')">
                  <GalleryGridColumnsSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.imageObjectPosition')"
                  :description="$t('settings.imageObjectPositionDesc')">
                  <SettingRadioControl setting-key="galleryImageObjectPosition" :options="objectPositionOptions" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.clearUserData')"
                  :description="$t('settings.clearUserDataDesc')">
                  <ClearUserDataSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.autoOpenWebView')"
                  :description="$t('settings.autoOpenWebViewDesc')">
                  <SettingSwitchControl :setting-key="autoOpenCrawlerWebviewKey" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && IS_DEV" :label="$t('settings.debugGenerateImages')"
                  :description="$t('settings.debugGenerateImagesDesc')">
                  <DebugGenerateImagesSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && IS_DEV" :label="$t('settings.devWebView')"
                  :description="$t('settings.devWebViewDesc')">
                  <div class="dev-webview-row">
                    <el-input v-model="devWebviewUrl" :placeholder="$t('settings.devWebviewPlaceholder')" clearable
                      class="dev-webview-input" @keyup.enter="openDevWebview" />
                    <el-button type="primary" :loading="devWebviewOpening" @click="openDevWebview">
                      {{ $t('settings.openWebViewButton') }}
                    </el-button>
                  </div>
                </SettingRow>
              </div>
            </div>
          </el-card>
        </el-tab-pane>

        <el-tab-pane :label="$t('settings.tabWallpaper')" :name="SETTINGS_TAB_NAMES[1]">
          <el-card class="settings-card">
            <template #header>
              <span>{{ $t('settings.wallpaperSectionTitle') }}</span>
            </template>

            <div v-loading="showLoading" element-loading-text="" style="min-height: 200px;">
              <div v-if="!loading" class="settings-list">
                <SettingRow :label="$t('settings.wallpaperRotationEnabled')"
                  :description="$t('settings.wallpaperRotationEnabledDesc')">
                  <WallpaperRotationEnabledSetting />
                </SettingRow>

                <SettingRow :label="$t('settings.wallpaperSelectAlbum')"
                  :description="$t('settings.wallpaperSelectAlbumDesc')">
                  <WallpaperRotationTargetSetting />
                </SettingRow>
                <div v-if="currentWallpaperPath" class="settings-list-current-wallpaper setting-row-desc">
                  <div class="setting-row-desc__spacer"></div>
                  <div class="setting-row-desc__content setting-description">
                    <span class="setting-row-desc__label">{{ $t('settings.wallpaperCurrent') }}</span>
                    <button type="button" class="setting-row-desc__path" @click="openCurrentWallpaperPath">
                      {{ currentWallpaperPath }}
                    </button>
                  </div>
                </div>

                <SettingRow :label="$t('settings.wallpaperRotationInterval')"
                  :description="$t('settings.wallpaperRotationIntervalDesc', { min: rotationIntervalMin })">
                  <SettingNumberControl setting-key="wallpaperRotationIntervalMinutes" :min="rotationIntervalMin"
                    :max="1440" :step="10" />
                </SettingRow>

                <SettingRow :label="$t('settings.wallpaperRotationMode')"
                  :description="$t('settings.wallpaperRotationModeDesc')">
                  <SettingRadioControl setting-key="wallpaperRotationMode" :options="wallpaperModeOptions" />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS || IS_LINUX || IS_MACOS" :label="$t('settings.wallpaperStyle')"
                  :description="$t('settings.wallpaperStyleDesc')">
                  <WallpaperStyleSetting />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)" :label="$t('settings.wallpaperTransition')"
                  :description="$t('settings.wallpaperTransitionDesc')">
                  <WallpaperTransitionSetting />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)" :label="$t('settings.wallpaperVolume')"
                  :description="$t('settings.wallpaperVolumeDesc')">
                  <SettingSliderControl setting-key="wallpaperVolume" :min="0" :max="1" :step="0.1" :precision="1" />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)"
                  :label="$t('settings.wallpaperVideoPlaybackRate')"
                  :description="$t('settings.wallpaperVideoPlaybackRateDesc')">
                  <SettingSliderControl setting-key="wallpaperVideoPlaybackRate" :min="0.25" :max="3" :step="0.25"
                    :precision="2" />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS || IS_MACOS || IS_LINUX" :label="$t('settings.wallpaperModeLabel')"
                  :description="$t('settings.wallpaperModeDesc')">
                  <WallpaperModeSetting />
                </SettingRow>

                <SettingRow v-if="IS_WINDOWS" :label="$t('settings.wallpaperEngineDir')"
                  :description="$t('settings.wallpaperEngineDirDesc')">
                  <WallpaperEngineDirSetting />
                </SettingRow>
              </div>
            </div>
          </el-card>
        </el-tab-pane>

        <el-tab-pane :label="$t('settings.tabDownload')" :name="SETTINGS_TAB_NAMES[2]">
          <el-card class="settings-card">
            <template #header>
              <span>{{ $t('settings.downloadSectionTitle') }}</span>
            </template>

            <div v-loading="showLoading" element-loading-text="" style="min-height: 200px;">
              <div v-if="!loading" class="settings-list">
                <SettingRow :label="$t('settings.maxConcurrentDownloads')"
                  :description="$t('settings.maxConcurrentDownloadsDesc')">
                  <SettingNumberControl setting-key="maxConcurrentDownloads" :min="1" :max="10" :step="1" />
                </SettingRow>

                <SettingRow :label="$t('settings.downloadInterval')" :description="$t('settings.downloadIntervalDesc')">
                  <DownloadIntervalSetting />
                </SettingRow>

                <SettingRow :label="$t('settings.networkRetryCount')"
                  :description="$t('settings.networkRetryCountDesc')">
                  <SettingNumberControl setting-key="networkRetryCount" :min="0" :max="10" :step="1" />
                </SettingRow>

                <SettingRow :label="$t('settings.autoDeduplicate')" :description="$t('settings.autoDeduplicateDesc')">
                  <SettingSwitchControl setting-key="autoDeduplicate" />
                </SettingRow>

                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.defaultDownloadDir')"
                  :description="$t('settings.defaultDownloadDirDesc')">
                  <DefaultDownloadDirSetting />
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
import { ref, onMounted, computed, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useLocalStorage } from "@vueuse/core";
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
import SettingSliderControl from "@kabegame/core/components/settings/controls/SettingSliderControl.vue";
import SettingRadioControl from "@kabegame/core/components/settings/controls/SettingRadioControl.vue";
import DefaultDownloadDirSetting from "@kabegame/core/components/settings/items/DefaultDownloadDirSetting.vue";
import DownloadIntervalSetting from "@/components/settings/items/DownloadIntervalSetting.vue";
import GalleryImageAspectRatioSetting from "@/components/settings/items/GalleryImageAspectRatioSetting.vue";
import GalleryGridColumnsSetting from "@/components/settings/items/GalleryGridColumnsSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperRotationTargetSetting from "@/components/settings/items/WallpaperRotationTargetSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperEngineDirSetting from "@/components/settings/items/WallpaperEngineDirSetting.vue";
import ClearUserDataSetting from "@/components/settings/items/ClearUserDataSetting.vue";
import DebugGenerateImagesSetting from "@/components/settings/items/DebugGenerateImagesSetting.vue";
import AlbumDriveSetting from "@/components/settings/items/AlbumDriveSetting.vue";
import LanguageSetting from "@/components/settings/items/LanguageSetting.vue";
import { IS_WINDOWS, IS_LINUX, IS_LIGHT_MODE, IS_ANDROID, IS_DEV, IS_MACOS } from "@kabegame/core/env";

const { t } = useI18n();

const { isPlasma } = useDesktop();

const imageClickActionOptions = computed(() => [
  { label: t("settings.imageClickPreview"), value: "preview" },
  { label: t("settings.imageClickOpen"), value: "open" },
]);
const objectPositionOptions = computed(() => [
  { label: t("settings.objectPositionCenter"), value: "center" },
  { label: t("settings.objectPositionTop"), value: "top" },
  { label: t("settings.objectPositionBottom"), value: "bottom" },
]);
const wallpaperModeOptions = computed(() => [
  { label: t("settings.wallpaperModeRandom"), value: "random" },
  { label: t("settings.wallpaperModeSequential"), value: "sequential" },
]);

const autoOpenCrawlerWebviewKey: AppSettingKey = "autoOpenCrawlerWebview";
const devWebviewUrl = ref("https://www.example.com");
const devWebviewOpening = ref(false);
async function openDevWebview() {
  const url = devWebviewUrl.value?.trim() || "";
  if (!url) {
    ElMessage.warning(t("settings.messageInputUrl"));
    return;
  }
  devWebviewOpening.value = true;
  try {
    await invoke("open_dev_webview", { url });
    ElMessage.success(t("settings.messageWebViewOpened"));
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    devWebviewOpening.value = false;
  }
}
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useDesktop } from "@/composables/useDesktop";

// 使用 300ms 防闪屏加载延迟
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay(300);

const settingsStore = useSettingsStore();

// 持久化用户最后访问的设置 tab
const SETTINGS_TAB_NAMES = ["app", "wallpaper", "download"] as const;
const storedSettingsTab = useLocalStorage("kabegame-settings-last-tab", "app");
const activeTab = computed({
  get: () =>
    SETTINGS_TAB_NAMES.includes(storedSettingsTab.value as (typeof SETTINGS_TAB_NAMES)[number])
      ? storedSettingsTab.value
      : "app",
  set: (v: string) => {
    storedSettingsTab.value = v;
  },
});
const isRefreshing = ref(false);
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);
const rotationIntervalMin = computed(() => (IS_ANDROID ? 15 : 1));
const currentWallpaperPath = ref<string | null>(null);
async function refreshCurrentWallpaperPath() {
  try {
    const path = await invoke<string | null>("get_current_wallpaper_path");
    currentWallpaperPath.value = path && path.trim() ? path : null;
  } catch {
    currentWallpaperPath.value = null;
  }
}
async function openCurrentWallpaperPath() {
  if (!currentWallpaperPath.value) return;
  try {
    await invoke("open_file_path", { filePath: currentWallpaperPath.value });
  } catch (e) {
    ElMessage.error(t("settings.messageOpenFailed"));
  }
}
watch(
  () => settingsStore.values.currentWallpaperImageId,
  () => {
    void refreshCurrentWallpaperPath();
  }
);
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
    ElMessage.success(t("settings.messageRefreshSuccess"));
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("settings.messageRefreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

// 首次进入时加载设置
onMounted(async () => {
  await loadSettings();
  await refreshCurrentWallpaperPath();
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

/* 与 SettingRow 同宽两列网格，小字显示在下方控件列 */
.setting-row-desc {
  display: grid;
  grid-template-columns: 3fr 7fr;
  gap: 16px;
  align-items: start;
  padding: 0 0 10px 0;
}

.setting-row-desc__spacer {
  min-width: 0;
}

.setting-row-desc__content {
  line-height: 1.4;
  word-break: break-all;
}

.setting-row-desc__label {
  color: var(--anime-text-muted);
}

.setting-row-desc__path {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 12px;
  color: var(--anime-primary);
  cursor: pointer;
  text-decoration: underline;
  text-align: left;

  &:hover {
    color: var(--anime-primary-hover, var(--anime-primary));
  }
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
