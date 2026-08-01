<template>
  <div
    class="settings-container"
    :class="{ 'settings-container--embedded': embedded }"
    v-pull-to-refresh="pullToRefreshOpts"
  >
    <div class="settings-content">
      <!-- embedded（桌面弹窗）时标题与关闭按钮由 el-dialog 自带 header 提供，这里不再自绘 -->
      <PageHeader
        v-if="!embedded"
        :title="mobileDetailOpen ? mobileCategoryLabel : $t('settings.title')"
        :show="settingsShowIds"
        :show-back="mobileDetailOpen"
        :fold="[]"
        sticky
        class="settings-page-header"
        @back="closeMobileCategory"
        @action="handleSettingsAction"
      />

      <div class="settings-layout">
        <nav
          v-if="!isCompact"
          class="settings-category-nav"
          :aria-label="$t('settings.title')"
        >
          <button
            v-for="category in settingsCategories"
            :key="category.name"
            type="button"
            class="settings-category-button"
            :class="{ 'is-active': activeTab === category.name }"
            :aria-current="activeTab === category.name ? 'page' : undefined"
            @click="activeTab = category.name"
          >
            <el-icon class="settings-category-icon">
              <component :is="category.icon" />
            </el-icon>
            <span>{{ category.label }}</span>
          </button>
          <div class="settings-category-nav-spacer" />
          <div class="settings-category-nav-version">Kabegame {{ appVersion }}</div>
        </nav>

        <div v-if="isCompact && !mobileDetailOpen" class="settings-mobile-category-list">
          <button
            v-for="(category, index) in settingsCategories"
            :key="category.name"
            type="button"
            class="settings-mobile-category-card"
            @click="activeTab = category.name"
          >
            <span class="settings-mobile-category-icon" :class="{ 'is-alt': index % 2 === 1 }">
              <el-icon><component :is="category.icon" /></el-icon>
            </span>
            <span class="settings-mobile-category-text">
              <span class="settings-mobile-category-title">{{ category.label }}</span>
              <span class="settings-mobile-category-summary">{{ category.summary }}</span>
            </span>
            <el-icon class="settings-mobile-category-chevron"><ArrowRight /></el-icon>
          </button>
        </div>

        <main
          v-if="!isCompact || mobileDetailOpen"
          v-loading="showLoading"
          element-loading-text=""
          class="settings-panel"
        >
          <div class="settings-panel-inner" v-if="!loading">
            <SettingsSection
              v-show="activeTab === 'general'"
              :title="$t('settings.categoryGeneral')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
                <SettingRow :label="$t('settings.language')" :description="$t('settings.languageDesc')">
                  <LanguageSetting />
                </SettingRow>
                <SettingRow :label="$t('settings.kamechanEnabled')"
                  :description="$t('settings.kamechanEnabledDesc')">
                  <SettingSwitchControl setting-key="kamechanEnabled" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && !IS_WEB" :label="$t('settings.autoLaunch')"
                  :description="$t('settings.autoLaunchDesc')">
                  <SettingSwitchControl setting-key="autoLaunch" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID" :label="$t('settings.imageClickAction')"
                  :description="$t('settings.imageClickActionDesc')">
                  <SettingRadioControl setting-key="imageClickAction" :options="imageClickActionOptions" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && !IS_WEB" :label="$t('settings.linkOpenMode')"
                  :description="$t('settings.linkOpenModeDesc')">
                  <SettingRadioControl setting-key="linkOpenMode" :options="linkOpenModeOptions" />
                </SettingRow>
                <SettingRow v-if="IS_WINDOWS || IS_LINUX" :label="$t('settings.closeAction')"
                  :description="$t('settings.closeActionDesc')">
                  <SettingRadioControl setting-key="closeAction" :options="closeActionOptions" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && !IS_WEB" :label="$t('settings.realtimeFolderSync')"
                  :description="$t('settings.realtimeFolderSyncDesc')">
                  <RealtimeFolderSyncSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID && !IS_WEB" :label="$t('settings.fastFolderSync')"
                  :description="$t('settings.fastFolderSyncDesc')">
                  <SettingSwitchControl setting-key="fastFolderSync" />
                </SettingRow>
            </SettingsSection>

            <SettingsSection
              v-show="activeTab === 'appearance'"
              :title="$t('settings.categoryAppearance')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
                <SettingRow v-if="!IS_ANDROID"
                  :label="isHorizontal ? $t('settings.galleryRows') : $t('settings.galleryColumns')"
                  :description="isHorizontal ? $t('settings.galleryRowsDesc') : $t('settings.galleryColumnsDesc')">
                  <GalleryGridColumnsSetting />
                </SettingRow>
                <SettingRow :label="$t('settings.galleryPageSize')"
                  :description="$t('settings.galleryPageSizeDesc')">
                  <GalleryPageSizeSetting />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID"
                  :label="$t('settings.galleryLayoutMode')"
                  :description="$t('settings.galleryLayoutModeDesc')">
                  <SettingRadioControl setting-key="galleryLayoutMode" :options="galleryLayoutModeOptions" />
                </SettingRow>
                <SettingRow v-if="!IS_ANDROID"
                  :label="$t('settings.galleryLayoutDirection')"
                  :description="$t('settings.galleryLayoutDirectionDesc')">
                  <SettingRadioControl setting-key="galleryLayoutDirection" :options="galleryLayoutDirectionOptions" />
                </SettingRow>
                <SettingRow :label="$t('settings.appBackgroundEnabled')"
                  :description="$t('settings.appBackgroundEnabledDesc')">
                  <SettingSwitchControl setting-key="appBackgroundEnabled" />
                </SettingRow>
                <template v-if="settingsStore.values.appBackgroundEnabled">
                  <SettingRow :label="$t('settings.appBackgroundOpacity')"
                    :description="$t('settings.appBackgroundOpacityDesc')">
                    <SettingSliderControl setting-key="appBackgroundOpacity" :min="0.05" :max="1" :step="0.05"
                      :precision="2" />
                  </SettingRow>
                  <SettingRow :label="$t('settings.appBackgroundBlur')"
                    :description="$t('settings.appBackgroundBlurDesc')">
                    <SettingSliderControl setting-key="appBackgroundBlur" :min="0" :max="20" :step="1"
                      :precision="0" />
                  </SettingRow>
                </template>
            </SettingsSection>

            <SettingsSection
              v-if="!IS_WEB"
              v-show="activeTab === 'wallpaper'"
              :title="$t('settings.categoryWallpaper')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
                <SettingRow :label="$t('settings.wallpaperDisabled')"
                  :description="$t('settings.wallpaperDisabledDesc')">
                  <SettingSwitchControl setting-key="wallpaperDisabled" />
                </SettingRow>

                <div :class="{ 'pointer-events-none opacity-50': wallpaperDisabled }">
                <SettingRow :label="$t('settings.wallpaperRotationEnabled')"
                  :description="$t('settings.wallpaperRotationEnabledDesc')">
                  <WallpaperRotationEnabledSetting />
                </SettingRow>

                <SettingRow :label="$t('settings.wallpaperSelectAlbum')"
                  :description="$t('settings.wallpaperSelectAlbumDesc')">
                  <WallpaperRotationTargetSetting />
                </SettingRow>
                <SettingRow
                  v-if="wallpaperRotationTargetsAlbum"
                  :label="$t('settings.wallpaperRotationIncludeSubalbums')"
                  :description="$t('settings.wallpaperRotationIncludeSubalbumsDesc')"
                >
                  <SettingSwitchControl setting-key="wallpaperRotationIncludeSubalbums" />
                </SettingRow>
                <SettingRow v-if="currentWallpaperPath" :label="$t('settings.wallpaperCurrent')">
                    <button type="button" class="setting-current-wallpaper-path" @click="openCurrentWallpaperPath">
                      {{ currentWallpaperPath }}
                    </button>
                </SettingRow>

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

                </div>
            </SettingsSection>

            <SettingsSection
              v-show="activeTab === 'download'"
              :title="$t('settings.categoryDownload')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
                <SettingRow :label="$t('settings.maxConcurrentTasks')"
                  :description="$t('settings.maxConcurrentTasksDesc')">
                  <SettingNumberControl setting-key="maxConcurrentTasks" :min="1" :max="10" :step="1" />
                </SettingRow>

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
            </SettingsSection>

            <SettingsSection
              v-show="activeTab === 'plugins'"
              :title="$t('settings.categoryPlugins')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
                <SettingRow
                  :label="$t('settings.importRecommendedScheduleEnabled')"
                  :description="$t('settings.importRecommendedScheduleEnabledDesc')"
                >
                  <SettingSwitchControl setting-key="importRecommendedScheduleEnabled" />
                </SettingRow>
                <PluginDefaultConfigsPanel />
            </SettingsSection>

            <SettingsSection
              v-if="!IS_ANDROID"
              v-show="activeTab === 'advanced'"
              :title="$t('settings.categoryAdvanced')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
              <SettingRow v-if="IS_WEB" :label="$t('settings.superMode')"
                :description="$t('settings.superModeDesc')">
                <SuperModeSetting />
              </SettingRow>
              <!-- 画册盘自带两行（开关 + 挂载点），不再套外层 SettingRow -->
              <AlbumDriveSetting v-if="!IS_WEB && !isLightMode" />
              <McpSettingsPanel v-if="!IS_WEB" class="settings-mcp-panel" />
            </SettingsSection>
          </div>
        </main>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated, computed, watch } from "vue";
import {
  ArrowRight,
  Brush,
  Connection,
  Download,
  Operation,
  PictureRounded,
  Tools,
} from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useLocalStorage } from "@vueuse/core";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { invoke } from "@/api/rpc";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useUiStore } from "@kabegame/core/stores/ui";
import { trackEvent } from "@kabegame/core/track/umami";
import SettingRow from "@kabegame/core/components/settings/SettingRow.vue";
import SettingSwitchControl from "@kabegame/core/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@kabegame/core/components/settings/controls/SettingNumberControl.vue";
import SettingSliderControl from "@kabegame/core/components/settings/controls/SettingSliderControl.vue";
import SettingRadioControl from "@kabegame/core/components/settings/controls/SettingRadioControl.vue";
import DefaultDownloadDirSetting from "@kabegame/core/components/settings/items/DefaultDownloadDirSetting.vue";
import DownloadIntervalSetting from "@/components/settings/items/DownloadIntervalSetting.vue";
import GalleryGridColumnsSetting from "@/components/settings/items/GalleryGridColumnsSetting.vue";
import GalleryPageSizeSetting from "@/components/settings/items/GalleryPageSizeSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperRotationTargetSetting from "@/components/settings/items/WallpaperRotationTargetSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import AlbumDriveSetting from "@/components/settings/items/AlbumDriveSetting.vue";
import RealtimeFolderSyncSetting from "@/components/settings/items/RealtimeFolderSyncSetting.vue";
import LanguageSetting from "@/components/settings/items/LanguageSetting.vue";
import SuperModeSetting from "@/components/settings/items/SuperModeSetting.vue";
import McpSettingsPanel from "@/components/settings/McpSettingsPanel.vue";
import PluginDefaultConfigsPanel from "@/components/settings/PluginDefaultConfigsPanel.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { APP_VERSION, IS_WINDOWS, IS_LINUX, IS_LIGHT_MODE, IS_ANDROID, IS_MACOS, IS_WEB } from "@kabegame/core/env";

const props = withDefaults(defineProps<{
  embedded?: boolean;
}>(), {
  embedded: false,
});
const { embedded } = props;

const { t } = useI18n();
const uiStore = useUiStore();
const isCompact = computed(() => uiStore.isCompact);
const appVersion = computed(() => APP_VERSION ?? "");

const { isPlasma } = useDesktop();

const imageClickActionOptions = computed(() => [
  { label: t("settings.imageClickPreview"), value: "preview" },
  { label: t("settings.imageClickOpen"), value: "open" },
  { label: t("settings.imageClickAsk"), value: "unconfigured" },
]);
const wallpaperModeOptions = computed(() => [
  { label: t("settings.wallpaperModeRandom"), value: "random" },
  { label: t("settings.wallpaperModeSequential"), value: "sequential" },
]);
const galleryLayoutModeOptions = computed(() => [
  { label: t("settings.galleryLayoutModeGrid"), value: "grid" },
  { label: t("settings.galleryLayoutModeGallery"), value: "gallery" },
]);
const galleryLayoutDirectionOptions = computed(() => [
  { label: t("settings.galleryLayoutDirectionVertical"), value: "vertical" },
  { label: t("settings.galleryLayoutDirectionHorizontal"), value: "horizontal" },
]);
const linkOpenModeOptions = computed(() => [
  { label: t("settings.linkOpenSurf"), value: "surf" },
  { label: t("settings.linkOpenBrowser"), value: "browser" },
  { label: t("settings.linkOpenAsk"), value: "unconfigured" },
]);
const closeActionOptions = computed(() => [
  { label: t("settings.closeActionExit"), value: "exit" },
  { label: t("settings.closeActionTray"), value: "tray" },
  { label: t("settings.closeActionAsk"), value: "unconfigured" },
]);

import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";
import { useDesktop } from "@/composables/useDesktop";

// 使用 300ms 防闪屏加载延迟
const { loading, showLoading } = useLoadingDelay(300);

const settingsStore = useSettingsStore();
const isHorizontal = computed(
  () => settingsStore.values.galleryLayoutDirection === "horizontal"
);

// 持久化用户最后访问的设置分类，并兼容旧版 app / mcp tab 值。
const SETTINGS_TAB_NAMES = ["general", "appearance", "wallpaper", "download", "plugins", "advanced"] as const;
type SettingsTabName = (typeof SETTINGS_TAB_NAMES)[number];
const storedSettingsTab = useLocalStorage("kabegame-settings-last-tab", "general");
const settingsCategories = computed(() => [
  { name: "general" as const, label: t("settings.categoryGeneral"), icon: Operation, summary: t("settings.categoryGeneralSummary") },
  { name: "appearance" as const, label: t("settings.categoryAppearance"), icon: Brush, summary: t("settings.categoryAppearanceSummary") },
  ...(!IS_WEB
    ? [{ name: "wallpaper" as const, label: t("settings.categoryWallpaper"), icon: PictureRounded, summary: t("settings.categoryWallpaperSummary") }]
    : []),
  { name: "download" as const, label: t("settings.categoryDownload"), icon: Download, summary: t("settings.categoryDownloadSummary") },
  { name: "plugins" as const, label: t("settings.categoryPlugins"), icon: Connection, summary: t("settings.categoryPluginsSummary") },
  ...(!IS_ANDROID
    ? [{ name: "advanced" as const, label: t("settings.categoryAdvanced"), icon: Tools, summary: t("settings.categoryAdvancedSummary") }]
    : []),
]);

// 安卓/紧凑布局下的两级导航：null 表示停留在一级分类列表。
const mobileCategory = ref<SettingsTabName | null>(null);
const mobileDetailOpen = computed(() => isCompact.value && mobileCategory.value !== null);
const mobileCategoryLabel = computed(
  () => settingsCategories.value.find((category) => category.name === mobileCategory.value)?.label ?? ""
);
function closeMobileCategory() {
  mobileCategory.value = null;
}
watch(isCompact, (compact) => {
  if (!compact) mobileCategory.value = null;
});

const activeTab = computed({
  get: (): SettingsTabName => {
    if (isCompact.value) return mobileCategory.value ?? "general";
    const legacyMap: Record<string, SettingsTabName> = {
      app: "general",
      mcp: "advanced",
    };
    const value = legacyMap[storedSettingsTab.value] ?? storedSettingsTab.value;
    const available = settingsCategories.value.some((category) => category.name === value);
    return SETTINGS_TAB_NAMES.includes(value as SettingsTabName) && available
      ? value as SettingsTabName
      : "general";
  },
  set: (v: SettingsTabName) => {
    if (isCompact.value) {
      mobileCategory.value = v;
      return;
    }
    storedSettingsTab.value = v;
  },
});

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

watch(activeTab, (tab, previousTab) => {
  if (!IS_WEB) return;
  if (!previousTab || previousTab === tab) return;
  trackEvent("settings_tab_change", {
    tab,
    previousTab,
    url: currentUrl(),
  });
});

const isRefreshing = ref(false);
const wallpaperRotationTargetsAlbum = computed(() => {
  const raw = settingsStore.values.wallpaperRotationAlbumId as string | null | undefined;
  if (raw == null) return false;
  return String(raw).trim().length > 0;
});
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
// 关闭壁纸：禁用期间将其余壁纸控件置灰
const wallpaperDisabled = computed(() => settingsStore.values.wallpaperDisabled === true);
// native 模式下开启"关闭壁纸"时提示用户系统壁纸保持现状、无法自动还原
watch(wallpaperDisabled, (disabled, prev) => {
  if (disabled && !prev && wallpaperMode.value === "native") {
    ElMessage.warning(t("settings.wallpaperDisabledNativeWarning"));
  }
});
const isLightMode = IS_LIGHT_MODE;

const settingsShowIds = computed(() => []);
const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

function handleSettingsAction(_payload: { id: string; data: { type: string } }) {
  // HeaderFeatureId.Help 已下线；HeaderFeatureId.CheckUpdate 迁移到全局工具箱「维护」分组。
  // settingsShowIds 现为空数组，这里暂无需要处理的 action。
}

const refreshSettings = async () => {
  await settingsStore.refreshAll();
};

// 统一的刷新处理
const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await refreshSettings();
    ElMessage.success(t("settings.messageRefreshSuccess"));
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error(t("settings.messageRefreshFailed"));
  } finally {
    isRefreshing.value = false;
  }
};

const batteryOptimizationStore = useBatteryOptimizationStore();

// 首次进入时加载设置
onMounted(async () => {
  await refreshCurrentWallpaperPath();
});

onActivated(async () => {
  if (!IS_ANDROID) return;
  await batteryOptimizationStore.checkAndPromptIfNeeded();
});

</script>

<style scoped lang="scss">
.settings-container {
  width: 100%;
  height: 100%;
  padding: 20px;
  overflow: hidden;

  // 弹窗内 el-dialog 高度为 auto，这里给一个固定高度，避免切换分类时弹窗高度跳动；
  // 圆角 + 描边让「左导航 + 右面板」在 el-dialog 自带内边距里成为一块完整面板
  &--embedded {
    height: min(620px, 72dvh);
    padding: 0;
    border: 1px solid var(--anime-border);
    border-radius: 14px;
  }
}

.settings-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}

.settings-category-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 200px;
  gap: 2px;
  padding: 10px 8px;
  overflow-y: auto;
  border-right: 1px solid var(--anime-border);
  background: var(--anime-bg-sidebar);
}

.settings-category-button {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 42px;
  padding: 0 14px;
  border: none;
  border-radius: 12px;
  margin: 0;
  font: inherit;
  font-size: 14px;
  color: var(--anime-text-primary);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;

  &:hover {
    background: color-mix(in srgb, var(--anime-primary) 8%, transparent);
  }

  &.is-active {
    color: #fff;
    font-weight: 600;
    background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
    box-shadow: var(--anime-shadow);
  }
}

.settings-category-icon {
  flex: none;
  font-size: 17px;
}

.settings-category-nav-spacer {
  flex: 1;
}

.settings-category-nav-version {
  padding: 0 14px 6px;
  color: var(--anime-text-muted);
  font-size: 11px;
}

.settings-mobile-category-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px;
  overflow-y: auto;
}

.settings-mobile-category-card {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 16px;
  border: 1px solid var(--anime-border);
  border-radius: 18px;
  margin: 0;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
  cursor: pointer;
  font: inherit;
  text-align: left;

  &:active {
    transform: scale(0.99);
  }
}

.settings-mobile-category-icon {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--anime-primary), var(--anime-secondary));
  box-shadow: 0 4px 12px rgba(255, 107, 157, 0.25);
  color: #fff;
  font-size: 20px;

  &.is-alt {
    background: linear-gradient(135deg, var(--anime-primary-light), var(--anime-secondary-light));
  }
}

.settings-mobile-category-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.settings-mobile-category-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--anime-text-primary);
}

.settings-mobile-category-summary {
  overflow: hidden;
  color: var(--anime-text-muted);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-mobile-category-chevron {
  flex: none;
  color: color-mix(in srgb, var(--anime-secondary) 45%, transparent);
  font-size: 15px;
}

.settings-panel {
  flex: 1;
  min-width: 0;
  min-height: 120px;
  padding: 22px 36px 28px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--anime-text-muted) 30%, transparent) transparent;
}

.settings-panel-inner {
  display: flex;
  flex-direction: column;
  max-width: 660px;
}

:deep(.setting-control .el-input__wrapper),
:deep(.setting-control .el-select .el-input__wrapper),
:deep(.setting-control .el-input-number),
:deep(.setting-control .android-picker-select) {
  min-height: 34px;
}

.setting-current-wallpaper-path {
  appearance: none;
  max-width: 460px;
  padding: 0;
  overflow: hidden;
  border: 0;
  margin: 0;
  color: var(--anime-primary);
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }
}

.settings-mcp-panel {
  margin: 18px -8px 4px;
}

:deep(.setting-control > .setting-slider-wrap) {
  width: min(280px, 100%);
}

// 紧凑布局（安卓 / 窄视口 web）恒为非 embedded 全屏页：取消侧栏后内容区不设 max-width。
.settings-container:not(.settings-container--embedded) {
  .settings-panel {
    padding: 0 16px 24px;
  }

  .settings-panel-inner {
    max-width: none;
  }
}
</style>
