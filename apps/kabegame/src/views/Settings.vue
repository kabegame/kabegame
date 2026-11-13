<template>
  <!-- embedded：弹窗正文去掉了内边距，左导航 + 右面板贴边，底部两角跟随对话框的圆角裁切；
       固定高度，切换分类时弹窗不跳动 -->
  <div
    class="box-border w-full overflow-hidden"
    :class="
      embedded ? 'h-[min(620px,72dvh)] rounded-b-kb-lg border-0 border-t border-solid border-kb-line' : 'h-full p-5'
    "
  >
    <div class="flex h-full flex-col">
      <!-- embedded（桌面弹窗）时标题与关闭按钮由 Dialog 自带的标题栏提供，这里不再自绘 -->
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

      <div class="flex min-h-0 flex-1">
        <!-- 左导航：中性选中（压暗的底 + 正文色），强调色只落在选中项的图标上 -->
        <nav
          v-if="!isCompact"
          class="box-border flex w-[200px] flex-none flex-col gap-0.5 overflow-y-auto border-0 border-r border-solid border-kb-line px-2 py-2.5"
          :aria-label="$t('settings.title')"
        >
          <button
            v-for="category in settingsCategories"
            :key="category.name"
            type="button"
            class="m-0 box-border flex h-9 w-full flex-none cursor-pointer items-center gap-2.5 rounded-kb-md border-0 px-3 text-left text-[13.5px] [font-family:inherit] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring [&_svg]:size-[17px] [&_svg]:shrink-0"
            :class="
              activeTab === category.name
                ? 'bg-kb-pressed font-600 text-kb-fg [&_svg]:text-kb-accent'
                : 'bg-transparent font-400 text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg'
            "
            :aria-current="activeTab === category.name ? 'page' : undefined"
            @click="activeTab = category.name"
          >
            <component :is="category.icon" />
            <span class="min-w-0 truncate">{{ category.label }}</span>
          </button>
          <div class="flex-1" />
          <div class="px-3 pb-1.5 text-[11px] text-kb-fg-subtle">Kabegame {{ appVersion }}</div>
        </nav>

        <div v-if="isCompact && !mobileDetailOpen" class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
          <button
            v-for="category in settingsCategories"
            :key="category.name"
            type="button"
            class="m-0 box-border flex w-full cursor-pointer items-center gap-3.5 rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-4 py-3.5 text-left [font-family:inherit] transition-transform duration-100 active:scale-[0.99]"
            @click="activeTab = category.name"
          >
            <span
              class="grid size-9.5 flex-none place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-5"
            >
              <component :is="category.icon" />
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[15px] font-600 text-kb-fg">{{ category.label }}</span>
              <span class="truncate text-[12.5px] text-kb-fg-muted">{{ category.summary }}</span>
            </span>
            <ChevronRight class="size-4 flex-none text-kb-fg-subtle" />
          </button>
        </div>

        <main
          v-if="!isCompact || mobileDetailOpen"
          v-loading="showLoading"
          class="settings-panel min-h-[120px] min-w-0 flex-1 overflow-auto"
          :class="embedded ? 'px-9 pb-7 pt-5.5' : 'px-4 pb-6 pt-0'"
        >
          <!-- 行内的长路径按面板宽度的比例封顶（见 .setting-rotation-path），需要面板作容器 -->
          <div
            v-if="!loading"
            class="flex flex-col [container-type:inline-size]"
            :class="embedded ? 'max-w-[660px]' : ''"
          >
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
                <div v-if="showScreenLayout" class="min-w-0 border-0 border-t border-solid border-kb-line py-[15px]">
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0 text-[14px] font-600 leading-5 text-kb-fg">
                      {{ $t("settings.screenLayout") }}
                    </div>
                    <!-- 逐屏独立下：把选中的屏设为默认屏 -->
                    <Button
                      v-if="selectedScreenCanBeDefault"
                      size="sm"
                      :disabled="defaultScreenBusy"
                      @click="setSelectedScreenAsDefault"
                    >
                      {{ $t("settings.screenSetDefault") }}
                    </Button>
                  </div>
                  <p class="m-0 mb-3 mt-1 text-[12px] leading-[1.55] text-kb-fg-muted">
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
                  <code
                    class="setting-rotation-path block overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-kb-fg-muted kb-selectable"
                    :title="wallpaperRotationPathDisplay"
                  >
                    {{ wallpaperRotationPathDisplay }}
                  </code>
                </SettingRow>
                <SettingRow v-if="currentWallpaperPath" :label="$t('settings.wallpaperCurrent')">
                  <button
                    type="button"
                    class="setting-current-wallpaper-path m-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 bg-transparent p-0 text-left text-[12px] text-kb-fg [font-family:inherit] hover:underline"
                    :title="currentWallpaperPath"
                    @click="openCurrentWallpaperPath"
                  >
                    {{ currentWallpaperPath }}
                  </button>
                  <Button v-if="currentWallpaperHasProps" size="sm" class="ml-2" @click="wpePropsOpen = true">
                    {{ $t("settings.wallpaperCurrentProperties") }}
                  </Button>
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
              <WebServerSettingsPanel v-if="!IS_WEB" />
              <McpSettingsPanel v-if="!IS_WEB" class="mx-[-8px] mb-1 mt-[18px]" />
            </SettingsSection>
          </div>
        </main>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onActivated, computed, watch } from "vue";
import { ChevronRight, Download, Image as ImageIcon, Palette, Puzzle, SlidersHorizontal, Wrench } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useLocalStorage } from "@vueuse/core";
import { kameMessage } from "@/utils/kameMessage";
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
import { vLoading } from "@/components/ui/loading";
import Button from "@/components/ui/Button.vue";

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
    icon: SlidersHorizontal,
    summary: t("settings.categoryGeneralSummary"),
  },
  {
    name: "appearance" as const,
    label: t("settings.categoryAppearance"),
    icon: Palette,
    summary: t("settings.categoryAppearanceSummary"),
  },
  ...(!IS_WEB
    ? [
        {
          name: "wallpaper" as const,
          label: t("settings.categoryWallpaper"),
          icon: ImageIcon,
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
    icon: Puzzle,
    summary: t("settings.categoryPluginsSummary"),
  },
  ...(!IS_ANDROID
    ? [
        {
          name: "advanced" as const,
          label: t("settings.categoryAdvanced"),
          icon: Wrench,
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
    kameMessage.error(e instanceof Error ? e.message : String(e));
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
    kameMessage.error(t("settings.messageOpenFailed"));
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
    kameMessage.warning(t("settings.wallpaperDisabledNativeWarning"));
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

<style scoped>
/* 路径很长，不封顶会把左边的标题列挤成一个字宽（窗口缩到最窄时面板只有四百多像素） */
.setting-rotation-path,
.setting-current-wallpaper-path {
  max-width: min(460px, 70cqw);
}

.settings-panel {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--kb-fg-subtle) 40%, transparent) transparent;
}
</style>
