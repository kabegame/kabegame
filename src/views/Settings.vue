<template>
  <div class="settings-container">
    <PageHeader title="设置" sticky>
      <el-button @click="handleRefresh" :loading="isRefreshing">
        <el-icon>
          <Refresh />
        </el-icon>
        刷新
      </el-button>
    </PageHeader>

    <StyledTabs v-model="activeTab" sticky>

      <el-tab-pane label="壁纸轮播" name="wallpaper">
        <el-card class="settings-card">
          <template #header>
            <span>壁纸轮播设置</span>
          </template>

          <div v-loading="loading" element-loading-text="" style="min-height: 200px;">
            <div v-if="showContent" class="settings-list">
              <SettingRow label="启用壁纸轮播" description="自动从指定画册中轮播更换桌面壁纸">
                <WallpaperRotationEnabledSetting />
              </SettingRow>

              <SettingRow :label="rotationEnabled ? '选择画册' : '选择壁纸'" description="轮播启用时选择画册；关闭时前往画廊选择单张壁纸">
                <WallpaperRotationTargetSetting />
              </SettingRow>

              <SettingRow v-if="rotationEnabled" label="轮播间隔" description="壁纸更换间隔（分钟，1-1440）">
                <SettingNumberControl setting-key="wallpaperRotationIntervalMinutes"
                  command="set_wallpaper_rotation_interval_minutes" :build-args="(v: number) => ({ minutes: v })"
                  :min="1" :max="1440" :step="10" />
              </SettingRow>

              <SettingRow v-if="rotationEnabled" label="轮播模式" description="随机模式：每次随机选择；顺序模式：按顺序依次更换">
                <SettingRadioControl setting-key="wallpaperRotationMode" command="set_wallpaper_rotation_mode"
                  :build-args="(v: string) => ({ mode: v })" :options="[
                    { label: '随机', value: 'random' },
                    { label: '顺序', value: 'sequential' },
                  ]" />
              </SettingRow>

              <SettingRow label="壁纸显示方式" description="原生模式：根据系统支持显示可用样式；窗口模式：支持所有显示方式">
                <WallpaperStyleSetting />
              </SettingRow>

              <SettingRow label="过渡效果" description="仅轮播支持过渡预览；原生模式下仅支持无过渡和淡入淡出">
                <WallpaperTransitionSetting />
              </SettingRow>

              <SettingRow label="壁纸模式" description="原生模式：性能好但功能有限；窗口模式：更灵活（类似 Wallpaper Engine）">
                <WallpaperModeSetting />
              </SettingRow>

              <SettingRow label="Wallpaper Engine 目录" description="用于“导出并自动导入到 WE”">
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

          <div v-loading="loading" element-loading-text="" style="min-height: 200px;">
            <div v-if="showContent" class="settings-list">
              <SettingRow label="最大并发下载量" description="同时下载的图片数量（1-10）">
                <SettingNumberControl setting-key="maxConcurrentDownloads" command="set_max_concurrent_downloads"
                  :build-args="(v: number) => ({ count: v })" :min="1" :max="10" :step="1" />
              </SettingRow>

              <SettingRow label="网络失效重试次数" description="下载图片遇到网络错误/超时等情况时，额外重试的次数（0-10）">
                <SettingNumberControl setting-key="networkRetryCount" command="set_network_retry_count"
                  :build-args="(v: number) => ({ count: v })" :min="0" :max="10" :step="1" />
              </SettingRow>

              <SettingRow label="自动去重" description="根据文件哈希值自动跳过重复图片，避免在画廊中重复添加相同文件">
                <SettingSwitchControl setting-key="autoDeduplicate" command="set_auto_deduplicate"
                  :build-args="(v: boolean) => ({ enabled: v })" />
              </SettingRow>

              <SettingRow label="默认下载目录" description="未在任务里指定输出目录时，将下载到该目录（按插件分文件夹保存）">
                <DefaultDownloadDirSetting />
              </SettingRow>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="应用设置" name="app">
        <el-card class="settings-card">
          <template #header>
            <span>应用设置</span>
          </template>

          <div v-loading="loading" element-loading-text="" style="min-height: 200px;">
            <div v-if="showContent" class="settings-list">
              <SettingRow label="开机启动" description="应用启动时自动运行">
                <SettingSwitchControl setting-key="autoLaunch" command="set_auto_launch"
                  :build-args="(v: boolean) => ({ enabled: v })" />
              </SettingRow>

              <SettingRow label="恢复上次标签页" description="应用启动时自动恢复到上次访问的标签页">
                <SettingSwitchControl setting-key="restoreLastTab" command="set_restore_last_tab"
                  :build-args="(v: boolean) => ({ enabled: v })" />
              </SettingRow>

              <SettingRow label="图片点击行为" description="左键点击图片时的行为">
                <SettingRadioControl setting-key="imageClickAction" command="set_image_click_action"
                  :build-args="(v: string) => ({ action: v })" :options="[
                    { label: '应用内预览', value: 'preview' },
                    { label: '系统默认打开', value: 'open' },
                  ]" />
              </SettingRow>

              <SettingRow label="图片宽高比" description="影响画廊/画册中图片卡片的展示宽高比">
                <GalleryImageAspectRatioSetting />
              </SettingRow>

              <SettingRow label="每次加载数量" description="画廊“加载更多”时的加载张数（10-200）">
                <SettingNumberControl setting-key="galleryPageSize" command="set_gallery_page_size"
                  :build-args="(v: number) => ({ size: v })" :min="10" :max="200" :step="10" />
              </SettingRow>

              <SettingRow label="清理应用数据" description="将删除所有图片、画册、任务、设置、插件配置等用户数据，应用将自动重启">
                <ClearUserDataSetting />
              </SettingRow>
            </div>
          </div>
        </el-card>
      </el-tab-pane>

    </StyledTabs>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import PageHeader from "@/components/common/PageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import { useLoadingDelay } from "@/utils/useLoadingDelay";
import { useSettingsStore } from "@/stores/settings";
import SettingRow from "@/components/settings/SettingRow.vue";
import SettingSwitchControl from "@/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@/components/settings/controls/SettingNumberControl.vue";
import SettingRadioControl from "@/components/settings/controls/SettingRadioControl.vue";
import DefaultDownloadDirSetting from "@/components/settings/items/DefaultDownloadDirSetting.vue";
import GalleryImageAspectRatioSetting from "@/components/settings/items/GalleryImageAspectRatioSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperRotationTargetSetting from "@/components/settings/items/WallpaperRotationTargetSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperEngineDirSetting from "@/components/settings/items/WallpaperEngineDirSetting.vue";
import ClearUserDataSetting from "@/components/settings/items/ClearUserDataSetting.vue";

// 使用 300ms 防闪屏加载延迟
const { loading, showContent, startLoading, finishLoading } = useLoadingDelay(300);

const settingsStore = useSettingsStore();
const activeTab = ref<string>("wallpaper");
const isRefreshing = ref(false);
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

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
  padding: 20px;
  overflow-y: auto;
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
