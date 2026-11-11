<template>
  <div class="settings-container" :class="{ 'settings-container--embedded': embedded }">
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
        <nav v-if="!isCompact" class="settings-category-nav" :aria-label="$t('settings.title')">
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
              <SettingRow :label="$t('settings.kamechanEnabled')" :description="$t('settings.kamechanEnabledDesc')">
                <SettingSwitchControl setting-key="kamechanEnabled" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID && !IS_WEB"
                :label="$t('settings.autoLaunch')"
                :description="$t('settings.autoLaunchDesc')"
              >
                <SettingSwitchControl setting-key="autoLaunch" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID"
                :label="$t('settings.imageClickAction')"
                :description="$t('settings.imageClickActionDesc')"
              >
                <SettingRadioControl setting-key="imageClickAction" :options="imageClickActionOptions" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID"
                :label="$t('settings.previewSlideshowSpeed')"
                :description="$t('settings.previewSlideshowSpeedDesc')"
              >
                <SettingRadioControl setting-key="previewSlideshowSpeed" :options="previewSlideshowSpeedOptions" />
              </SettingRow>
              <SettingRow
                :label="$t('settings.previewSwitchDirection')"
                :description="$t('settings.previewSwitchDirectionDesc')"
              >
                <SettingRadioControl setting-key="previewSwitchDirection" :options="previewSwitchDirectionOptions" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID && !IS_WEB"
                :label="$t('settings.linkOpenMode')"
                :description="$t('settings.linkOpenModeDesc')"
              >
                <SettingRadioControl setting-key="linkOpenMode" :options="linkOpenModeOptions" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID && !IS_WEB"
                :label="$t('settings.fastFolderSync')"
                :description="$t('settings.fastFolderSyncDesc')"
              >
                <SettingSwitchControl setting-key="fastFolderSync" />
              </SettingRow>
            </SettingsSection>

            <SettingsSection
              v-show="activeTab === 'appearance'"
              :title="$t('settings.categoryAppearance')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
              <SettingRow
                v-if="!IS_ANDROID"
                :label="isHorizontal ? $t('settings.galleryRows') : $t('settings.galleryColumns')"
                :description="isHorizontal ? $t('settings.galleryRowsDesc') : $t('settings.galleryColumnsDesc')"
              >
                <GalleryGridColumnsSetting />
              </SettingRow>
              <SettingRow :label="$t('settings.galleryPageSize')" :description="$t('settings.galleryPageSizeDesc')">
                <GalleryPageSizeSetting />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID"
                :label="$t('settings.galleryLayoutMode')"
                :description="$t('settings.galleryLayoutModeDesc')"
              >
                <SettingRadioControl setting-key="galleryLayoutMode" :options="galleryLayoutModeOptions" />
              </SettingRow>
              <SettingRow
                v-if="!IS_ANDROID"
                :label="$t('settings.galleryLayoutDirection')"
                :description="$t('settings.galleryLayoutDirectionDesc')"
              >
                <SettingRadioControl setting-key="galleryLayoutDirection" :options="galleryLayoutDirectionOptions" />
              </SettingRow>
              <SettingRow :label="$t('settings.imageFit')" :description="$t('settings.imageFitDesc')">
                <SettingRadioControl setting-key="imageFit" :options="imageFitOptions" />
              </SettingRow>
              <SettingRow :label="$t('settings.previewFollowPage')" :description="$t('settings.previewFollowPageDesc')">
                <SettingSwitchControl setting-key="previewFollowPage" />
              </SettingRow>
              <SettingRow
                :label="$t('settings.appBackgroundEnabled')"
                :description="$t('settings.appBackgroundEnabledDesc')"
              >
                <SettingSwitchControl setting-key="appBackgroundEnabled" />
              </SettingRow>
              <template v-if="settingsStore.values.appBackgroundEnabled">
                <SettingRow
                  :label="$t('settings.appBackgroundOpacity')"
                  :description="$t('settings.appBackgroundOpacityDesc')"
                >
                  <SettingSliderControl
                    setting-key="appBackgroundOpacity"
                    :min="0.05"
                    :max="1"
                    :step="0.05"
                    :precision="2"
                  />
                </SettingRow>
                <SettingRow
                  :label="$t('settings.appBackgroundBlur')"
                  :description="$t('settings.appBackgroundBlurDesc')"
                >
                  <SettingSliderControl setting-key="appBackgroundBlur" :min="0" :max="20" :step="1" :precision="0" />
                </SettingRow>
              </template>
            </SettingsSection>

            <SettingsSection
              v-if="!IS_WEB"
              v-show="activeTab === 'wallpaper'"
              :title="$t('settings.categoryWallpaper')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
              <SettingRow :label="$t('settings.wallpaperEnabled')" :description="$t('settings.wallpaperEnabledDesc')">
                <SettingSwitchControl setting-key="wallpaperEnabled" />
              </SettingRow>

              <div :class="{ 'pointer-events-none opacity-50': wallpaperDisabled }">
                <!-- 第一层：全局设置。壁纸模式排在最前，它决定下面哪些显示器模式可选 -->
                <SettingRow
                  v-if="IS_WINDOWS || IS_MACOS || IS_LINUX"
                  :label="$t('settings.wallpaperModeLabel')"
                  :description="$t('settings.wallpaperModeDesc')"
                >
                  <WallpaperModeSetting />
                </SettingRow>

                <!-- 能力表只列一种显示器模式时（Android、Plasma 插件模式）没有可选的，不显示 -->
                <SettingRow
                  v-if="displayModeSelectable"
                  :label="$t('settings.displayMode')"
                  :description="$t('settings.displayModeDesc')"
                >
                  <WallpaperDisplayModeSetting />
                </SettingRow>

                <!-- 轮播开关与间隔是全局的：一开全开，所有目标同一个节拍 -->
                <SettingRow
                  :label="$t('settings.wallpaperRotationEnabled')"
                  :description="$t('settings.wallpaperRotationEnabledDesc')"
                >
                  <WallpaperRotationEnabledSetting />
                </SettingRow>

                <SettingRow
                  :label="$t('settings.wallpaperRotationInterval')"
                  :description="$t('settings.wallpaperRotationIntervalDesc', { min: rotationIntervalMin })"
                >
                  <SettingNumberControl
                    setting-key="wallpaperRotationIntervalMinutes"
                    :min="rotationIntervalMin"
                    :max="1440"
                    :step="10"
                  />
                </SettingRow>

                <!-- 第二层：显示器布局图，点一块屏选中要设置的目标。没有屏幕信息的平台不显示 -->
                <!-- 上边线与 SettingRow 的分隔线同色 -->
                <div
                  v-if="showScreenLayout"
                  class="min-w-0 border-0 border-t border-solid border-[color-mix(in_srgb,var(--anime-primary)_15%,transparent)] py-[15px]"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0 text-[14px] font-600 leading-5 text-[var(--anime-text-primary)]">
                      {{ $t("settings.screenLayout") }}
                    </div>
                    <!-- 逐屏独立下：把选中的屏设为默认屏 -->
                    <el-button
                      v-if="selectedScreenCanBeDefault"
                      size="small"
                      :disabled="defaultScreenBusy"
                      @click="setSelectedScreenAsDefault"
                    >
                      {{ $t("settings.screenSetDefault") }}
                    </el-button>
                  </div>
                  <p class="m-0 mb-3 mt-1 text-[12px] leading-[1.55] text-[var(--anime-text-muted)]">
                    {{ screenLayoutDescription }}
                  </p>
                  <WallpaperScreenLayout
                    v-model:selected="selectedTargetId"
                    :display-mode="displayMode"
                    :default-screen="settingsStore.values.wallpaperDefaultScreen"
                    show-disconnected
                  />
                </div>

                <!-- 第三层：选中目标的设置。轮播来源只读展示：入口在画廊过滤栏 ⋯ 面板的「用当前视图轮播」 -->
                <SettingRow
                  :label="$t('settings.wallpaperRotationPath')"
                  :description="$t('settings.wallpaperRotationPathDesc')"
                >
                  <code class="setting-rotation-path" :title="wallpaperRotationPathDisplay">
                    {{ wallpaperRotationPathDisplay }}
                  </code>
                </SettingRow>
                <SettingRow v-if="currentWallpaperPath" :label="$t('settings.wallpaperCurrent')">
                  <button type="button" class="setting-current-wallpaper-path" @click="openCurrentWallpaperPath">
                    {{ currentWallpaperPath }}
                  </button>
                  <el-button v-if="currentWallpaperHasProps" size="small" @click="wpePropsOpen = true">
                    {{ $t("settings.wallpaperCurrentProperties") }}
                  </el-button>
                </SettingRow>
                <WpeWebPropertiesDialog
                  v-model="wpePropsOpen"
                  :image-id="currentWallpaperImageId"
                  :image-type="currentWallpaperType"
                  :title="currentWallpaperName"
                />

                <SettingRow
                  v-if="IS_WINDOWS || IS_LINUX || IS_MACOS"
                  :label="$t('settings.wallpaperStyle')"
                  :description="$t('settings.wallpaperStyleDesc')"
                >
                  <WallpaperStyleSetting :target-id="selectedTargetId" />
                </SettingRow>

                <SettingRow
                  v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)"
                  :label="$t('settings.wallpaperTransition')"
                  :description="$t('settings.wallpaperTransitionDesc')"
                >
                  <WallpaperTransitionSetting :target-id="selectedTargetId" />
                </SettingRow>

                <!-- 以下回到全局设置 -->
                <!-- 视频、网页、场景共用：只有窗口模式的桌面上有在播放的实例 -->
                <SettingRow
                  v-if="desktopWallpaperLive"
                  :label="$t('settings.wallpaperPaused')"
                  :description="$t('settings.wallpaperPausedDesc')"
                >
                  <SettingSwitchControl setting-key="wallpaperPaused" />
                </SettingRow>

                <SettingRow
                  v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)"
                  :label="$t('settings.wallpaperVolume')"
                  :description="$t('settings.wallpaperVolumeDesc')"
                >
                  <SettingSliderControl setting-key="wallpaperVolume" :min="0" :max="1" :step="0.1" :precision="1" />
                </SettingRow>

                <SettingRow
                  v-if="IS_WINDOWS || IS_MACOS || (IS_LINUX && isPlasma)"
                  :label="$t('settings.wallpaperVideoPlaybackRate')"
                  :description="$t('settings.wallpaperVideoPlaybackRateDesc')"
                >
                  <SettingSliderControl
                    setting-key="wallpaperVideoPlaybackRate"
                    :min="0.25"
                    :max="3"
                    :step="0.25"
                    :precision="2"
                  />
                </SettingRow>

                <SettingRow
                  v-if="IS_WINDOWS"
                  :label="$t('settings.wpeMediaIntegration')"
                  :description="$t('settings.wpeMediaIntegrationDesc')"
                >
                  <SettingSwitchControl setting-key="wpeMediaIntegration" />
                </SettingRow>

                <SettingRow
                  v-if="!IS_ANDROID && !IS_WEB"
                  :label="$t('settings.wpeScenePostprocess')"
                  :description="$t('settings.wpeScenePostprocessDesc')"
                >
                  <SettingRadioControl setting-key="wpeScenePostprocess" :options="wpeScenePostprocessOptions" />
                </SettingRow>

                <SettingRow
                  v-if="!IS_ANDROID && !IS_WEB"
                  :label="$t('settings.wpeEngineDir')"
                  :description="$t('settings.wpeEngineDirDesc')"
                >
                  <WpeEngineDirSetting />
                </SettingRow>
              </div>
            </SettingsSection>

            <SettingsSection
              v-show="activeTab === 'download'"
              :title="$t('settings.categoryDownload')"
              :transparent="settingsStore.values.appBackgroundEnabled"
            >
              <SettingRow
                :label="$t('settings.maxConcurrentTasks')"
                :description="$t('settings.maxConcurrentTasksDesc')"
              >
                <SettingNumberControl setting-key="maxConcurrentTasks" :min="1" :max="10" :step="1" />
              </SettingRow>

              <SettingRow
                :label="$t('settings.maxConcurrentDownloads')"
                :description="$t('settings.maxConcurrentDownloadsDesc')"
              >
                <SettingNumberControl setting-key="maxConcurrentDownloads" :min="1" :max="10" :step="1" />
              </SettingRow>

              <SettingRow :label="$t('settings.downloadInterval')" :description="$t('settings.downloadIntervalDesc')">
                <DownloadIntervalSetting />
              </SettingRow>

              <SettingRow :label="$t('settings.networkRetryCount')" :description="$t('settings.networkRetryCountDesc')">
                <SettingNumberControl setting-key="networkRetryCount" :min="0" :max="10" :step="1" />
              </SettingRow>

              <SettingRow :label="$t('settings.autoDeduplicate')" :description="$t('settings.autoDeduplicateDesc')">
                <SettingSwitchControl setting-key="autoDeduplicate" />
              </SettingRow>

              <SettingRow
                :label="$t('settings.dedupUpdateMetadata')"
                :description="$t('settings.dedupUpdateMetadataDesc')"
              >
                <SettingSwitchControl setting-key="dedupUpdateMetadata" />
              </SettingRow>

              <SettingRow
                v-if="!IS_WEB"
                :label="$t('settings.surfFreezePage')"
                :description="$t('settings.surfFreezePageDesc')"
              >
                <SettingSwitchControl setting-key="surfFreezePage" />
              </SettingRow>

              <SettingRow
                v-if="!IS_ANDROID"
                :label="$t('settings.defaultDownloadDir')"
                :description="$t('settings.defaultDownloadDirDesc')"
              >
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
              <SettingRow v-if="IS_WEB" :label="$t('settings.superMode')" :description="$t('settings.superModeDesc')">
                <SuperModeSetting />
              </SettingRow>
              <!-- 画册盘自带两行（开关 + 挂载点），不再套外层 SettingRow -->
              <AlbumDriveSetting v-if="!IS_WEB && !isLightMode" />
              <WebServerSettingsPanel v-if="!IS_WEB" class="settings-web-server-panel" />
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
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { invoke } from "@/api/rpc";
import PageHeader from "@/components/common/PageHeader.vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import {
  useActiveWallpaperTargets,
  useWallpaperDisplayMode,
  useWallpaperTarget,
} from "@/composables/useWallpaperTarget";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import { useWallpaperScreens } from "@/composables/useWallpaperScreens";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { trackEvent } from "@/track/umami";
import SettingRow from "@/components/settings/SettingRow.vue";
import WallpaperScreenLayout from "@/components/wallpaper/WallpaperScreenLayout.vue";
import WpeWebPropertiesDialog from "@/components/wallpaper/WpeWebPropertiesDialog.vue";
import { fetchImageById } from "@/utils/imageRow";
import { hasWpeUserProperties } from "@/utils/mediaMime";
import { defaultScreenId, screenIdOfTarget } from "@/utils/wallpaperTargets";
import SettingSwitchControl from "@/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@/components/settings/controls/SettingNumberControl.vue";
import SettingSliderControl from "@/components/settings/controls/SettingSliderControl.vue";
import SettingRadioControl from "@/components/settings/controls/SettingRadioControl.vue";
import DefaultDownloadDirSetting from "@/components/settings/items/DefaultDownloadDirSetting.vue";
import WpeEngineDirSetting from "@/components/settings/items/WpeEngineDirSetting.vue";
import DownloadIntervalSetting from "@/components/settings/items/DownloadIntervalSetting.vue";
import GalleryGridColumnsSetting from "@/components/settings/items/GalleryGridColumnsSetting.vue";
import GalleryPageSizeSetting from "@/components/settings/items/GalleryPageSizeSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperDisplayModeSetting from "@/components/settings/items/WallpaperDisplayModeSetting.vue";
import AlbumDriveSetting from "@/components/settings/items/AlbumDriveSetting.vue";
import LanguageSetting from "@/components/settings/items/LanguageSetting.vue";
import SuperModeSetting from "@/components/settings/items/SuperModeSetting.vue";
import WebServerSettingsPanel from "@/components/settings/WebServerSettingsPanel.vue";
import McpSettingsPanel from "@/components/settings/McpSettingsPanel.vue";
import PluginDefaultConfigsPanel from "@/components/settings/PluginDefaultConfigsPanel.vue";
import SettingsSection from "@/components/settings/SettingsSection.vue";
import { APP_VERSION, IS_WINDOWS, IS_LINUX, IS_LIGHT_MODE, IS_ANDROID, IS_MACOS, IS_WEB } from "@/env";

const props = withDefaults(
  defineProps<{
    embedded?: boolean;
  }>(),
  {
    embedded: false,
  },
);
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
const previewSlideshowSpeedOptions = computed(() => [
  { label: t("settings.previewSlideshowSpeedFast"), value: "fast" },
  { label: t("settings.previewSlideshowSpeedMedium"), value: "medium" },
  { label: t("settings.previewSlideshowSpeedSlow"), value: "slow" },
]);
const previewSwitchDirectionOptions = computed(() => [
  { label: t("settings.previewSwitchDirectionAuto"), value: "auto" },
  { label: t("settings.previewSwitchDirectionPrev"), value: "prev" },
  { label: t("settings.previewSwitchDirectionNext"), value: "next" },
]);
const galleryLayoutModeOptions = computed(() => [
  { label: t("settings.galleryLayoutModeGrid"), value: "grid" },
  { label: t("settings.galleryLayoutModeGallery"), value: "gallery" },
]);
const galleryLayoutDirectionOptions = computed(() => [
  { label: t("settings.galleryLayoutDirectionVertical"), value: "vertical" },
  { label: t("settings.galleryLayoutDirectionHorizontal"), value: "horizontal" },
]);
const imageFitOptions = computed(() => [
  { label: t("settings.imageFitContain"), value: "fit" },
  { label: t("settings.imageFitCover"), value: "fill" },
]);
const wpeScenePostprocessOptions = computed(() => [
  { label: t("settings.wpeScenePostprocessFollow"), value: "follow" },
  { label: t("settings.wpeScenePostprocessDisabled"), value: "disabled" },
  { label: t("settings.wpeScenePostprocessEnabled"), value: "enabled" },
  { label: t("settings.wpeScenePostprocessUltra"), value: "ultra" },
]);
const linkOpenModeOptions = computed(() => [
  { label: t("settings.linkOpenSurf"), value: "surf" },
  { label: t("settings.linkOpenBrowser"), value: "browser" },
  { label: t("settings.linkOpenAsk"), value: "unconfigured" },
]);

import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";
import { useDesktop } from "@/composables/useDesktop";

// 使用 300ms 防闪屏加载延迟
const { loading, showLoading } = useLoadingDelay(300);

const settingsStore = useSettingsStore();
const isHorizontal = computed(() => settingsStore.values.galleryLayoutDirection === "horizontal");

// 持久化用户最后访问的设置分类，并兼容旧版 app / mcp tab 值。
const SETTINGS_TAB_NAMES = ["general", "appearance", "wallpaper", "download", "plugins", "advanced"] as const;
type SettingsTabName = (typeof SETTINGS_TAB_NAMES)[number];
const storedSettingsTab = useLocalStorage("kabegame-settings-last-tab", "general");
const settingsCategories = computed(() => [
  {
    name: "general" as const,
    label: t("settings.categoryGeneral"),
    icon: Operation,
    summary: t("settings.categoryGeneralSummary"),
  },
  {
    name: "appearance" as const,
    label: t("settings.categoryAppearance"),
    icon: Brush,
    summary: t("settings.categoryAppearanceSummary"),
  },
  ...(!IS_WEB
    ? [
        {
          name: "wallpaper" as const,
          label: t("settings.categoryWallpaper"),
          icon: PictureRounded,
          summary: t("settings.categoryWallpaperSummary"),
        },
      ]
    : []),
  {
    name: "download" as const,
    label: t("settings.categoryDownload"),
    icon: Download,
    summary: t("settings.categoryDownloadSummary"),
  },
  {
    name: "plugins" as const,
    label: t("settings.categoryPlugins"),
    icon: Connection,
    summary: t("settings.categoryPluginsSummary"),
  },
  ...(!IS_ANDROID
    ? [
        {
          name: "advanced" as const,
          label: t("settings.categoryAdvanced"),
          icon: Tools,
          summary: t("settings.categoryAdvancedSummary"),
        },
      ]
    : []),
]);

// 安卓/紧凑布局下的两级导航：null 表示停留在一级分类列表。
const mobileCategory = ref<SettingsTabName | null>(null);
const mobileDetailOpen = computed(() => isCompact.value && mobileCategory.value !== null);
const mobileCategoryLabel = computed(
  () => settingsCategories.value.find((category) => category.name === mobileCategory.value)?.label ?? "",
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
    return SETTINGS_TAB_NAMES.includes(value as SettingsTabName) && available ? (value as SettingsTabName) : "general";
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

// ---- 壁纸分区：全局设置 → 显示器布局图（选目标）→ 选中目标的设置 ----
const wallpaperCapabilities = useWallpaperCapabilities();
const wallpaperScreens = useWallpaperScreens();
/** 生效的显示器模式（设置里的值在当前壁纸模式下不可用时是 multiple） */
const displayMode = useWallpaperDisplayMode();
const activeWallpaperTargets = useActiveWallpaperTargets();
/** 当前壁纸模式下列出不止一种显示器模式才有得选（不可用的项也算：置灰并给原因） */
const displayModeSelectable = computed(
  () => wallpaperCapabilities.displayModesFor(settingsStore.values.wallpaperMode || "native").length > 1,
);
/** 有在线屏信息才画布局图（Android、Web 与还没有屏幕枚举的平台没有） */
const showScreenLayout = computed(() => wallpaperScreens.value.length > 0);
const screenLayoutDescription = computed(() => {
  if (displayMode.value === "single") return t("settings.screenLayoutSingleDesc");
  if (displayMode.value === "span") return t("settings.screenLayoutSpanDesc");
  return t("settings.screenLayoutMultipleDesc");
});

/**
 * 正在设置哪个目标：页面本地状态，记在 localStorage，不进设置。记下的目标不在当前活跃集合里
 * （换了显示器模式、那块屏拔了）时回到默认目标；记录不动，屏接回来还是它。
 */
const storedWallpaperTarget = useLocalStorage("kabegame-settings-wallpaper-target", "");
const selectedTargetId = computed<string>({
  get: () =>
    activeWallpaperTargets.value.includes(storedWallpaperTarget.value)
      ? storedWallpaperTarget.value
      : activeWallpaperTargets.value[0],
  set: (targetId) => {
    storedWallpaperTarget.value = targetId;
  },
});

// 逐屏独立下把选中的屏设为默认屏（目标选择弹窗的预选项，也是不带目标的操作落到的屏）
const { disabled: defaultScreenBusy, set: setDefaultScreen } = useSettingKeyState("wallpaperDefaultScreen");
const selectedScreenId = computed(() => screenIdOfTarget(selectedTargetId.value));
const selectedScreenCanBeDefault = computed(
  () =>
    displayMode.value === "single" &&
    !!selectedScreenId.value &&
    selectedScreenId.value !== defaultScreenId(wallpaperScreens.value, settingsStore.values.wallpaperDefaultScreen),
);
async function setSelectedScreenAsDefault() {
  if (!selectedScreenId.value) return;
  try {
    await setDefaultScreen(selectedScreenId.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// 轮播路径、当前壁纸、样式、过渡都挂在壁纸目标上；这里读写选中的目标
const wallpaperTarget = useWallpaperTarget(selectedTargetId);
// 未设置时后端落到默认全画廊随机路径
const wallpaperRotationPathDisplay = computed(
  () => wallpaperTarget.rotationPath.value || t("settings.wallpaperRotationPathDefault"),
);
const rotationIntervalMin = computed(() => (IS_ANDROID ? 15 : 1));
const currentWallpaperPath = ref<string | null>(null);
/** 当前壁纸是网页或场景壁纸：可打开作者属性面板 */
const currentWallpaperHasProps = ref(false);
/** 当前壁纸的 type：属性面板据此隐藏场景用不到的属性 */
const currentWallpaperType = ref<string | null>(null);
/** 当前网页 / 场景壁纸的显示名，作属性弹窗标题（面板自带「壁纸属性」标题栏） */
const currentWallpaperName = ref<string | null>(null);
const currentWallpaperImageId = wallpaperTarget.currentImageId;
const wpePropsOpen = ref(false);
let wallpaperLookup = 0;
async function refreshCurrentWallpaperPath() {
  const lookup = ++wallpaperLookup;
  const id = currentWallpaperImageId.value;
  currentWallpaperHasProps.value = false;
  try {
    const path = await invoke<string | null>("get_current_wallpaper_path", { target: selectedTargetId.value });
    currentWallpaperPath.value = path && path.trim() ? path : null;
  } catch {
    currentWallpaperPath.value = null;
  }
  if (id) {
    try {
      const image = await fetchImageById(id);
      if (lookup === wallpaperLookup) {
        currentWallpaperHasProps.value = hasWpeUserProperties(image?.type);
        currentWallpaperType.value = image?.type ?? null;
        currentWallpaperName.value = image?.displayName || null;
      }
    } catch {
      if (lookup === wallpaperLookup) currentWallpaperHasProps.value = false;
    }
  }
}
async function openCurrentWallpaperPath() {
  if (!currentWallpaperPath.value) return;
  try {
    await invoke("open_path", { path: currentWallpaperPath.value });
  } catch (e) {
    ElMessage.error(t("settings.messageOpenFailed"));
  }
}
// 当前壁纸换了、或换了要看的目标，都重新取路径
watch([currentWallpaperImageId, selectedTargetId], () => {
  void refreshCurrentWallpaperPath();
});
const wallpaperMode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");
/** 只有窗口模式的桌面上有在播放的视频、网页与场景（原生模式交给系统，Android / Web 没有窗口壁纸），暂停只在这时显示 */
const desktopWallpaperLive = computed(() => !IS_ANDROID && !IS_WEB && wallpaperMode.value === "window");
// 「打开壁纸」关掉期间将其余壁纸控件置灰（还没读到值时按开启处理）
const wallpaperDisabled = computed(() => settingsStore.values.wallpaperEnabled === false);
// native 模式下关掉「打开壁纸」时提示用户系统壁纸保持现状、无法自动还原
watch(wallpaperDisabled, (disabled, prev) => {
  if (disabled && !prev && wallpaperMode.value === "native") {
    ElMessage.warning(t("settings.wallpaperDisabledNativeWarning"));
  }
});
const isLightMode = IS_LIGHT_MODE;

const settingsShowIds = computed(() => []);

function handleSettingsAction(_payload: { id: string; data: { type: string } }) {
  // HeaderFeatureId.Help 已下线；HeaderFeatureId.CheckUpdate 迁移到全局工具箱「维护」分组。
  // settingsShowIds 现为空数组，这里暂无需要处理的 action。
}

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
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;

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
  // 行内的长路径按面板宽度的比例封顶（见 .setting-rotation-path），需要面板作容器
  container-type: inline-size;
}

:deep(.setting-control .el-input__wrapper),
:deep(.setting-control .el-select .el-input__wrapper),
:deep(.setting-control .android-picker-select) {
  min-height: 34px;
}

// 路径很长，不封顶会把左边的标题列挤成一个字宽（窗口缩到最窄时面板只有四百多像素）
.setting-rotation-path {
  display: block;
  max-width: min(460px, 70cqw);
  overflow: hidden;
  color: var(--anime-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  user-select: text;
  white-space: nowrap;
}

.setting-current-wallpaper-path {
  appearance: none;
  max-width: min(460px, 70cqw);
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
