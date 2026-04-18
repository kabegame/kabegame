<template>
  <div class="plugin-browser-container" v-pull-to-refresh="pullToRefreshOpts">
    <div class="plugin-browser-content">
      <PluginBrowserPageHeader @refresh="handleRefresh" @import-source="handleImportSource" @help="openHelpDrawer"
        @quick-settings="openQuickSettings" @manage-sources="openManageSources" />

      <div v-if="sourcesLoadedOnce && sources.length === 0" class="plugin-sources-empty-hint">
        <el-alert type="info" :closable="false" show-icon>
          <template #title>
            {{ $t('plugins.noStoreSourcesHint') }}
          </template>
          <el-button type="primary" size="small" style="margin-top: 8px" @click="goToOfficialGitHubStoreTab">
            {{ $t('plugins.goToOfficialGitHubStore') }}
          </el-button>
        </el-alert>
      </div>

      <!-- Tab 切换 -->
      <StyledTabs v-model="activeTab" :before-leave="beforeLeaveTab">
        <el-tab-pane :label="$t('plugins.installedTab')" name="installed">
          <!-- 已安装插件配置表格 -->
          <div v-if="showSkeletonBySource['installed'] && activeTab === 'installed'" class="loading-skeleton">
            <el-skeleton :rows="8" animated />
          </div>
          <div v-else-if="installedPlugins.length === 0" class="empty">
            <el-empty :description="$t('plugins.noInstalled')">
              <el-button type="primary" @click="goToOfficialGitHubStoreTab">
                {{ $t('plugins.goToOfficialGitHubStore') }}
              </el-button>
            </el-empty>
          </div>

          <!-- 已安装：布局与商店一致 -->
          <div v-else>
            <transition-group name="fade-in-list" tag="div" class="plugin-grid"
              :class="{ 'plugin-grid-android': IS_ANDROID }">
              <el-card v-for="plugin in installedPlugins" :key="plugin.id" class="plugin-card" shadow="hover"
                @click="viewPluginDetails(plugin)">
                <template v-if="IS_ANDROID">
                  <div class="plugin-android-icon">
                    <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                      <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
                    </div>
                    <div v-else-if="isIconLoading(plugin)" class="plugin-icon-placeholder plugin-icon-loading">
                      <el-icon class="spin">
                        <Loading />
                      </el-icon>
                    </div>
                    <div v-else class="plugin-icon-placeholder">
                      <el-icon>
                        <Grid />
                      </el-icon>
                    </div>
                  </div>
                  <div class="plugin-android-title">
                    <h3>{{ pluginName(plugin) }}</h3>
                  </div>
                </template>
                <div v-else class="plugin-header">
                  <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                    <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
                  </div>
                  <div v-else-if="isIconLoading(plugin)" class="plugin-icon-placeholder plugin-icon-loading">
                    <el-icon class="spin">
                      <Loading />
                    </el-icon>
                  </div>
                  <div v-else class="plugin-icon-placeholder">
                    <el-icon>
                      <Grid />
                    </el-icon>
                  </div>
                  <div class="plugin-title">
                    <h3>{{ pluginName(plugin) }}</h3>
                    <p class="plugin-desp">{{ pluginDescription(plugin) || $t('plugins.noDescription') }}</p>
                  </div>
                </div>

                <div v-if="IS_ANDROID" class="plugin-info plugin-info--marquee">
                  <div class="plugin-info-track">
                    <div class="plugin-info-group">
                      <el-tag type="success" size="small">{{ $t('plugins.installed') }}</el-tag>
                      <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                    </div>
                    <div class="plugin-info-group" aria-hidden="true">
                      <el-tag type="success" size="small">{{ $t('plugins.installed') }}</el-tag>
                      <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                    </div>
                  </div>
                </div>
                <div v-else class="plugin-info">
                  <el-tag type="success" size="small">{{ $t('plugins.installed') }}</el-tag>
                  <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                </div>

                <div class="plugin-footer">
                  <el-button type="danger" size="small" @click.stop="handleDelete(plugin)">
                    {{ $t('plugins.uninstall') }}
                  </el-button>
                </div>
              </el-card>
            </transition-group>
          </div>
        </el-tab-pane>
        <!-- 商店源：按"源名称"动态生成 tab；每个 tab 只显示该源的数据 -->
        <el-tab-pane v-for="s in storeSourcesToRender" :key="s.id" :name="storeTabName(s.id)">
          <template #label>
            <span>{{ pluginSourceDisplayName(s) }}</span>
            <el-icon v-if="s.id !== OFFICIAL_PLUGIN_SOURCE_ID" class="tab-close-icon"
              @click.stop="handleDeleteSource(s)">
              <Close />
            </el-icon>
          </template>
          <!-- 插件列表（300ms 延迟显示骨架屏，避免快速刷新时闪屏） -->
          <div v-if="showSkeletonBySource[s.id]" class="loading-skeleton">
            <div v-if="IS_ANDROID" class="skeleton-grid skeleton-grid-android">
              <div v-for="i in 8" :key="i" class="skeleton-card">
                <el-skeleton :rows="0" animated>
                  <template #template>
                    <div
                      style="display: flex; flex-direction: column; align-items: center; width: 100%; height: 100%; min-height: 0; gap: 0; box-sizing: border-box;">
                      <div
                        style="flex: 0 0 40%; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center;">
                        <el-skeleton-item variant="image"
                          style="width: 48px; height: 48px; border-radius: 8px; flex-shrink: 0;" />
                      </div>
                      <el-skeleton-item variant="h3"
                        style="width: 92%; height: 15px; margin: 2px 0 0; flex-shrink: 0;" />
                      <div
                        style="flex: 0 0 auto; width: 100%; height: 14px; display: flex; flex-flow: row nowrap; gap: 3px; align-items: center; overflow: hidden;">
                        <el-skeleton-item variant="text" style="width: 28%; height: 12px; margin: 0; flex-shrink: 0;" />
                        <el-skeleton-item variant="text" style="width: 32%; height: 12px; margin: 0; flex-shrink: 0;" />
                        <el-skeleton-item variant="text" style="width: 24%; height: 12px; margin: 0; flex-shrink: 0;" />
                      </div>
                      <div style="flex: 1 1 auto; min-height: 0; width: 100%;" />
                      <el-skeleton-item variant="button"
                        style="width: 100%; height: 26px; margin: 0; flex-shrink: 0;" />
                    </div>
                  </template>
                </el-skeleton>
              </div>
            </div>
            <div v-else class="skeleton-grid">
              <div v-for="i in 12" :key="i" class="skeleton-card">
                <el-skeleton :rows="0" animated>
                  <template #template>
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                      <el-skeleton-item variant="image" style="width: 48px; height: 48px; border-radius: 8px;" />
                      <div style="flex: 1;">
                        <el-skeleton-item variant="h3" style="width: 60%; margin-bottom: 8px;" />
                        <el-skeleton-item variant="text" style="width: 80%;" />
                      </div>
                    </div>
                    <el-skeleton-item variant="text" style="width: 40%; margin-bottom: 12px;" />
                    <el-skeleton-item variant="button" style="width: 100%;" />
                  </template>
                </el-skeleton>
              </div>
            </div>
          </div>

          <div v-else-if="!loadingBySource[s.id] && getStorePlugins(s.id).length === 0" class="empty">
            <el-empty :description="$t('plugins.noPluginsInSource', { name: pluginSourceDisplayName(s) })" />
          </div>

          <transition-group v-else name="fade-in-list" tag="div" class="plugin-grid"
            :class="{ 'plugin-grid-android': IS_ANDROID }">
            <el-card v-for="plugin in getStorePlugins(s.id)" :key="plugin.id" class="plugin-card" shadow="hover"
              @click="viewPluginDetails(plugin)">
              <template v-if="IS_ANDROID">
                <div class="plugin-android-icon">
                  <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                    <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
                  </div>
                  <div v-else-if="isIconLoading(plugin)" class="plugin-icon-placeholder plugin-icon-loading">
                    <el-icon class="spin">
                      <Loading />
                    </el-icon>
                  </div>
                  <div v-else class="plugin-icon-placeholder">
                    <el-icon>
                      <Grid />
                    </el-icon>
                  </div>
                </div>
                <div class="plugin-android-title">
                  <h3>{{ pluginName(plugin) }}</h3>
                </div>
              </template>
              <div v-else class="plugin-header">
                <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                  <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
                </div>
                <div v-else-if="isIconLoading(plugin)" class="plugin-icon-placeholder plugin-icon-loading">
                  <el-icon class="spin">
                    <Loading />
                  </el-icon>
                </div>
                <div v-else class="plugin-icon-placeholder">
                  <el-icon>
                    <Grid />
                  </el-icon>
                </div>
                <div class="plugin-title">
                  <h3>{{ pluginName(plugin) }}</h3>
                  <p class="plugin-desp">{{ pluginDescription(plugin) || $t('plugins.noDescription') }}</p>
                </div>
              </div>

              <div v-if="IS_ANDROID" class="plugin-info plugin-info--marquee">
                <div class="plugin-info-track">
                  <div class="plugin-info-group">
                    <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                    <el-tag v-if="plugin.installedVersion" type="success" size="small">{{
                      $t('plugins.installedVersion', { version: plugin.installedVersion }) }}</el-tag>
                    <el-tag v-else type="warning" size="small">{{ $t('plugins.notInstalled') }}</el-tag>
                    <el-tag v-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="danger"
                      size="small">{{
                        $t('plugins.canUpdate') }}</el-tag>
                    <el-tag type="info" size="small">{{ formatBytes(plugin.sizeBytes) }}</el-tag>
                  </div>
                  <div class="plugin-info-group" aria-hidden="true">
                    <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                    <el-tag v-if="plugin.installedVersion" type="success" size="small">{{
                      $t('plugins.installedVersion', { version: plugin.installedVersion }) }}</el-tag>
                    <el-tag v-else type="warning" size="small">{{ $t('plugins.notInstalled') }}</el-tag>
                    <el-tag v-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="danger"
                      size="small">{{
                        $t('plugins.canUpdate') }}</el-tag>
                    <el-tag type="info" size="small">{{ formatBytes(plugin.sizeBytes) }}</el-tag>
                  </div>
                </div>
              </div>
              <div v-else class="plugin-info">
                <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
                <el-tag v-if="plugin.installedVersion" type="success" size="small">{{ $t('plugins.installedVersion', {
                  version: plugin.installedVersion
                }) }}</el-tag>
                <el-tag v-else type="warning" size="small">{{ $t('plugins.notInstalled') }}</el-tag>
                <el-tag v-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="danger" size="small">{{
                  $t('plugins.canUpdate') }}</el-tag>
                <el-tag type="info" size="small">{{ formatBytes(plugin.sizeBytes) }}</el-tag>
              </div>

              <div class="plugin-footer">
                <el-button v-if="!plugin.installedVersion" type="primary" size="small" class="plugin-store-install-btn"
                  :class="{ 'plugin-store-install-btn--progress': isInstalling(plugin.id) }"
                  :disabled="isInstalling(plugin.id)" @click.stop="handleStoreInstall(plugin)">
                  <span v-if="isInstalling(plugin.id)" class="plugin-store-install-btn__fill-wrap">
                    <span class="plugin-store-install-btn__fill"
                      :style="{ width: `${storeInstallPercentClamped(plugin)}%` }" />
                    <span class="plugin-store-install-btn__label">{{
                      t('plugins.installingWithPercent', { percent: storeInstallPercentClamped(plugin) })
                      }}</span>
                  </span>
                  <span v-else>{{ $t('plugins.install') }}</span>
                </el-button>
                <el-button v-else-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="warning"
                  size="small" class="plugin-store-install-btn"
                  :class="{ 'plugin-store-install-btn--progress': isInstalling(plugin.id) }"
                  :disabled="isInstalling(plugin.id)" @click.stop="handleStoreInstall(plugin)">
                  <span v-if="isInstalling(plugin.id)" class="plugin-store-install-btn__fill-wrap">
                    <span class="plugin-store-install-btn__fill"
                      :style="{ width: `${storeInstallPercentClamped(plugin)}%` }" />
                    <span class="plugin-store-install-btn__label">{{
                      t('plugins.updatingWithPercent', { percent: storeInstallPercentClamped(plugin) })
                      }}</span>
                  </span>
                  <span v-else>{{ $t('plugins.update') }}</span>
                </el-button>
                <el-button v-else-if="plugin.installedVersion === plugin.version" type="info" plain disabled
                  size="small" class="plugin-store-install-btn plugin-store-install-btn--installed-only" tabindex="-1">
                  {{ $t('plugins.installed') }}
                </el-button>
                <el-button v-else size="small" class="plugin-store-install-btn"
                  :class="{ 'plugin-store-install-btn--progress': isInstalling(plugin.id) }"
                  :disabled="isInstalling(plugin.id)" @click.stop="handleStoreInstall(plugin, true)">
                  <span v-if="isInstalling(plugin.id)" class="plugin-store-install-btn__fill-wrap">
                    <span class="plugin-store-install-btn__fill"
                      :style="{ width: `${storeInstallPercentClamped(plugin)}%` }" />
                    <span class="plugin-store-install-btn__label">{{
                      t('plugins.reinstallingWithPercent', { percent: storeInstallPercentClamped(plugin) })
                      }}</span>
                  </span>
                  <span v-else>{{ $t('plugins.reinstall') }}</span>
                </el-button>
              </div>
            </el-card>
          </transition-group>
        </el-tab-pane>

        <!-- 添加源 tab -->
        <el-tab-pane name="add-source">
          <template #label>
            <el-icon style="margin-right: 4px;">
              <Plus />
            </el-icon>
            {{ $t('plugins.addSourceTab') }}
          </template>
          <div class="add-source-content">
            <el-empty :description="$t('plugins.addSourceHint')" />
          </div>
        </el-tab-pane>
      </StyledTabs>
    </div>

    <!-- 商店源管理 -->
    <el-dialog v-if="!IS_LIGHT_MODE" v-model="showSourcesDialog" :title="$t('plugins.sourcesDialogTitle')"
      width="720px">
      <div class="sources-hint">
        {{ $t('plugins.sourcesIntro') }}
      </div>
      <el-table :data="sources" style="width: 100%" :empty-text="$t('plugins.noSources')">
        <el-table-column :label="$t('plugins.name')" width="180">
          <template #default="{ row }">
            {{ pluginSourceDisplayName(row) }}
          </template>
        </el-table-column>
        <el-table-column prop="indexUrl" :label="$t('plugins.indexUrl')" show-overflow-tooltip />
        <el-table-column :label="$t('plugins.action')" width="140">
          <template #default="{ row, $index }">
            <el-button size="small" @click="editSource($index)">{{ $t('plugins.edit') }}</el-button>
            <el-button v-if="row.id !== OFFICIAL_PLUGIN_SOURCE_ID" size="small" type="danger"
              @click="removeSource($index)">{{ $t('plugins.delete') }}</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="showSourcesDialog = false">{{ $t('common.close') }}</el-button>
        <el-button @click="addSource">{{ $t('plugins.newSource') }}</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑源 -->
    <el-dialog v-if="!IS_LIGHT_MODE" v-model="showEditSourceDialog"
      :title="editingSourceIndex === null ? $t('plugins.newSource') : $t('plugins.editSource')" width="620px">
      <el-form label-width="110px">
        <el-form-item label="ID">
          <el-input v-model="editSourceForm.id" :placeholder="$t('plugins.idPlaceholder')" />
        </el-form-item>
        <el-form-item :label="$t('plugins.name')">
          <el-input v-model="editSourceForm.name" :placeholder="$t('plugins.namePlaceholder')" />
        </el-form-item>
        <el-form-item label="index.json">
          <el-input v-model="editSourceForm.indexUrl" placeholder="https://.../index.json"
            :disabled="editSourceForm.id === OFFICIAL_PLUGIN_SOURCE_ID" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditSourceDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="isValidatingSource" :disabled="isValidatingSource"
          @click="confirmEditSource">
          {{ $t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 导入源对话框 -->
    <el-dialog v-model="showImportDialog" :title="$t('plugins.importDialogTitle')" width="500px">
      <div class="import-instructions">
        <p>{{ $t('plugins.selectFileHint') }}</p>
        <el-button type="primary" @click="selectPluginFile">
          <el-icon>
            <Upload />
          </el-icon>
          {{ $t('plugins.selectFile') }}
        </el-button>
        <p v-if="selectedFilePath" class="selected-file">
          {{ $t('plugins.selected') }} {{ selectedFilePath }}
        </p>
      </div>
      <template #footer>
        <el-button @click="showImportDialog = false">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" @click="handleImport" :disabled="!selectedFilePath">
          {{ $t('plugins.importButton') }}
        </el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Refresh,
  Upload,
  Grid,
  Plus,
  Setting,
  QuestionFilled,
  Loading,
  Close,
} from "@element-plus/icons-vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import type { PluginManifestText } from "@kabegame/core/stores/plugins";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pickKgpgFile } from "tauri-plugin-picker-api";
import PluginBrowserPageHeader from "@/components/header/PluginBrowserPageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import { isUpdateAvailable } from "@/utils/version";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { IS_LIGHT_MODE, IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

interface PluginSource {
  id: string;
  name: string;
  indexUrl: string;
}

interface StorePluginResolved {
  id: string;
  /** 与已安装插件一致：i18n 对象 { default, zh?, ja?, ... }，由后端从 index.json 归一化 */
  name: PluginManifestText;
  version: string;
  /** 与已安装插件一致：i18n 对象 { default, zh?, ja?, ... }，由后端从 index.json 归一化 */
  description: PluginManifestText;
  downloadUrl: string;
  iconUrl?: string | null;
  packageVersion?: number | null;
  sha256?: string | null;
  sizeBytes: number;
  sourceId: string;
  sourceName: string;
  installedVersion?: string | null;
  /** 后端 get_store_plugins 合并的当前下载进度 0–100 */
  storeDownloadProgress?: number | null;
  storeDownloadError?: string | null;
}

/** 与 Rust `StorePluginDownloadProgressEvent`（camelCase）一致 */
interface StoreDownloadProgressPayload {
  sourceId: string;
  pluginId: string;
  percent: number;
  error?: string | null;
}

/** 已安装插件或商店插件，用于列表卡片、详情跳转等统一入参 */
type PluginListItem = Plugin | StorePluginResolved;


const pluginStore = usePluginStore();
const { t } = useI18n();
const { pluginName, pluginDescription } = usePluginManifestI18n();
const router = useRouter();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("pluginbrowser");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("pluginbrowser");

/** 与后端 `plugin_sources::OFFICIAL_PLUGIN_SOURCE_ID` 一致 */
const OFFICIAL_PLUGIN_SOURCE_ID = "official_github_release";
/** 与 `kabegame_core::storage::plugin_sources` 插入官方源时的默认 `name` 一致（用于识别「未自定义」以走 i18n） */
const OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME = "官方 GitHub Releases 源";

/** 打开商店 tab 时后台重拉 index 的缓存最大年龄（与后端 `plugin_source_cache.updated_at` 比较，秒） */
const STORE_INDEX_REVALIDATE_MAX_AGE_SECS = 24 * 60 * 60;
const storeRevalidateInflight = new Set<string>();

const pluginSourceDisplayName = (s: PluginSource) => {
  if (s.id === OFFICIAL_PLUGIN_SOURCE_ID && s.name === OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME) {
    return t("plugins.officialGithubReleaseSourceName");
  }
  return s.name;
};

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: handleRefresh, refreshing: isRefreshing.value }
    : undefined
);

const handleImportSource = () => {
  if (IS_ANDROID) {
    triggerImportDirect();
  } else {
    showImportDialog.value = true;
  }
};

const openManageSources = () => {
  showSourcesDialog.value = true;
};


const loadingBySource = ref<Record<string, boolean>>({}); // 按源区分的loading状态
const showSkeletonBySource = ref<Record<string, boolean>>({}); // 按源区分的骨架屏状态
const skeletonTimersBySource = ref<Record<string, ReturnType<typeof setTimeout>>>({}); // 按源区分的骨架屏定时器
const activeTab = ref<string>("installed");
const showImportDialog = ref(false);
useModalBack(showImportDialog);
const selectedFilePath = ref<string | null>(null);
const isRefreshing = ref(false);

// 安装/更新进行中状态（避免“刷新感”，并防止重复点击）
const installingById = ref<Record<string, boolean>>({});
const isInstalling = (pluginId: string) => !!installingById.value[pluginId];
const setInstalling = (pluginId: string, installing: boolean) => {
  if (installing) {
    installingById.value = { ...installingById.value, [pluginId]: true };
    return;
  }
  const next = { ...installingById.value };
  delete next[pluginId];
  installingById.value = next;
};

/** 与后端 `source_id::plugin_id` 一致，用于下载进度事件与列表合并 */
const storePluginProgressKey = (p: StorePluginResolved) => `${p.sourceId}::${p.id}`;

/** 按源+插件维度的下载进度（事件优先，其次列表接口合并字段） */
const installProgressByKey = ref<Record<string, number>>({});

const storeInstallPercent = (p: StorePluginResolved): number => {
  const k = storePluginProgressKey(p);
  const fromEvent = installProgressByKey.value[k];
  if (fromEvent != null) return fromEvent;
  if (p.storeDownloadProgress != null) return p.storeDownloadProgress;
  return 0;
};

const storeInstallPercentClamped = (p: StorePluginResolved) =>
  Math.min(storeInstallPercent(p), 100);

let unlistenStoreDownloadProgress: (() => void) | undefined;
let unlistenPluginSourcesChanged: (() => void) | undefined;

// 商店插件：按商店源分组缓存（每个 tab 独立显示/刷新）
const storePluginsBySource = ref<Record<string, StorePluginResolved[]>>({});
const storeLoadedBySource = ref<Record<string, boolean>>({});

const sources = ref<PluginSource[]>([]);
const storeSourcesToRender = computed(() => sources.value);
const sourcesLoadedOnce = ref(false); // 是否已加载过商店源（仅用于避免重复拉取）
const showSourcesDialog = ref(false);
useModalBack(showSourcesDialog);
const showEditSourceDialog = ref(false);
useModalBack(showEditSourceDialog);
const isValidatingSource = ref(false);
const editingSourceIndex = ref<number | null>(null);
const editSourceForm = reactive<{ id: string; name: string; indexUrl: string }>({
  id: "",
  name: "",
  indexUrl: "",
});

const installedPlugins = computed(() => pluginStore.plugins);

const storeTabName = (sourceId: string) => `store:${sourceId}`;
const isStoreTab = (tabName: string) => tabName.startsWith("store:");
const activeStoreSourceId = computed(() => {
  if (!isStoreTab(activeTab.value)) return null;
  return activeTab.value.slice("store:".length);
});

const getStorePlugins = (sourceId: string) => storePluginsBySource.value[sourceId] || [];

// 已安装版本索引：用于给商店列表补齐 installedVersion（按 id + version 判断状态）
const installedVersionById = computed(() => {
  const m = new Map<string, string>();
  for (const p of installedPlugins.value) {
    if (p?.id) m.set(p.id, p.version);
  }
  return m;
});

const applyInstalledVersions = (arr: StorePluginResolved[] | null | undefined): StorePluginResolved[] => {
  const list = arr || [];
  const m = installedVersionById.value;
  return list.map((p) => {
    const installed = m.get(p.id) ?? null;
    // 仅覆盖 installedVersion：避免后端未来补充该字段时被误抹除
    return { ...p, installedVersion: installed };
  });
};

// 插件图标缓存：
// - 本地已安装：key = local:<pluginId>
// - 商店源：key = store:<sourceId>:<pluginId>
//
// 关键：商店 tab 绝不能”命中”本地 icon，即使 id 一样；因此必须用不同 key 做隔离。
const pluginIcons = ref<Record<string, string>>({});
const pluginIconLoading = ref<Record<string, boolean>>({});

const storeIconKey = (sourceId: string, pluginId: string) => `store:${sourceId}:${pluginId}`;
const getIconKey = (p: PluginListItem) => {
  // StorePluginResolved 一定有 sourceId；本地 Plugin 没有该字段
  const sid = "sourceId" in p && typeof p.sourceId === "string" ? p.sourceId : null;
  return sid ? storeIconKey(sid, p.id) : `local:${p.id}`;
};
const isIconLoading = (p: PluginListItem) => {
  const k = getIconKey(p);
  return !!pluginIconLoading.value[k];
};

const setPluginIconLoading = (key: string, loading: boolean) => {
  if (!key) return;
  if (loading) {
    pluginIconLoading.value = { ...pluginIconLoading.value, [key]: true };
    return;
  }
  const next = { ...pluginIconLoading.value };
  delete next[key];
  pluginIconLoading.value = next;
};

const getPluginIconSrc = (p: PluginListItem) => {
  const isStore = "sourceId" in p && typeof p.sourceId === "string";
  if (isStore) {
    const store = p as StorePluginResolved;
    if (store.iconUrl) return store.iconUrl;
    const key = getIconKey(p);
    return pluginIcons.value[key] || null;
  }

  // 已安装：图标已在 Plugin.iconPngBase64 中，直接从 store 读取
  return pluginStore.pluginIconDataUrl(p.id) || null;
};

// 商店列表：当 index.json 不再提供 iconUrl 时，从 .kgpg 固定头部通过 Range 读取 icon（后端返回 PNG bytes）
const loadRemotePluginIcon = async (plugin: {
  id: string;
  sourceId: string;
  downloadUrl?: string | null;
}) => {
  if (!plugin?.id) return;
  if (!plugin.sourceId) return;
  if (!plugin.downloadUrl) return;
  const key = storeIconKey(plugin.sourceId, plugin.id);
  if (pluginIcons.value[key]) return;
  if (pluginIconLoading.value[key]) return;
  setPluginIconLoading(key, true);
  try {
    const iconData = await invoke<number[] | null>("get_remote_plugin_icon", {
      downloadUrl: plugin.downloadUrl,
      sourceId: plugin.sourceId,
      pluginId: plugin.id,
    });
    if (!iconData || iconData.length === 0) return;
    const bytes = new Uint8Array(iconData);
    const binaryString = Array.from(bytes)
      .map((byte) => String.fromCharCode(byte))
      .join("");
    const base64 = btoa(binaryString);
    pluginIcons.value = { ...pluginIcons.value, [key]: `data:image/png;base64,${base64}` };
  } catch {
    // 远程 icon 拉取失败：保持占位符即可
  } finally {
    setPluginIconLoading(key, false);
  }
};

const prefetchRemoteIconsForSource = async (sourceId: string) => {
  const arr = getStorePlugins(sourceId) || [];
  // 控制规模：只预取前 24 个缺失 iconUrl 的条目，避免刷新时并发过多
  const targets = arr
    .filter((p) => {
      const pv = typeof p.packageVersion === "number" ? p.packageVersion : 1;
      return pv >= 2 && !p.iconUrl && !!p.downloadUrl;
    })
    .slice(0, 24);
  // 有限并发：最多同时拉 10 个，避免请求风暴但也不会“一个接一个”太慢
  const concurrency = 10;
  let idx = 0;
  const workers = new Array(Math.min(concurrency, targets.length)).fill(0).map(async () => {
    while (idx < targets.length) {
      const cur = targets[idx];
      idx += 1;
      // eslint-disable-next-line no-await-in-loop
      await loadRemotePluginIcon({
        id: cur.id,
        sourceId,
        downloadUrl: cur.downloadUrl,
      });
    }
  });
  await Promise.all(workers);
};

const refreshPluginIcons = async () => {
  // 已安装插件的图标已内嵌在 Plugin.iconPngBase64 中，无需单独加载
};

const markStorePluginInstalled = (pluginId: string, installedVersion: string) => {
  const next: Record<string, StorePluginResolved[]> = {};
  for (const [sourceId, arr] of Object.entries(storePluginsBySource.value)) {
    next[sourceId] = (arr || []).map((p) =>
      p.id === pluginId ? { ...p, installedVersion } : p
    );
  }
  storePluginsBySource.value = next;
};

watch(
  [
    () => installedPlugins.value.map((p) => p.id).join("|"),
    () => {
      // 让 watch 感知商店列表变化（按源聚合成一个稳定字符串）
      const parts: string[] = [];
      const keys = Object.keys(storePluginsBySource.value).sort();
      for (const k of keys) {
        const arr = storePluginsBySource.value[k] || [];
        parts.push(
          `${k}=` +
          arr.map((p) => `${p.id}:${p.installedVersion ?? ""}:${p.version}`).join(",")
        );
      }
      return parts.join("|");
    },
  ],
  () => {
    refreshPluginIcons();
  },
  { immediate: true }
);

// 当“已安装源”变化时，同步刷新所有已加载商店列表的 installedVersion（否则会出现只有本地源显示已安装的现象）
watch(
  () => installedPlugins.value.map((p) => `${p.id}:${p.version}`).join("|"),
  () => {
    const next: Record<string, StorePluginResolved[]> = {};
    for (const [sourceId, arr] of Object.entries(storePluginsBySource.value)) {
      next[sourceId] = applyInstalledVersions(arr || []);
    }
    storePluginsBySource.value = next;
  },
  { immediate: true }
);


const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const formatBytes = (bytes: number) => {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MB`;
};

const goToOfficialGitHubStoreTab = async () => {
  const r = await loadSources();
  if (!r.success) {
    ElMessage.error(r.error ?? t("plugins.loadSourcesFailed"));
    return;
  }
  const hasOfficial = sources.value.some((s) => s.id === OFFICIAL_PLUGIN_SOURCE_ID);
  if (!hasOfficial) {
    ElMessage.warning(t("plugins.officialSourceMissing"));
    return;
  }
  activeTab.value = storeTabName(OFFICIAL_PLUGIN_SOURCE_ID);
  // 列表加载与后台重拉由 watch(activeTab) 统一处理
};

const loadSources = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const res = await invoke<PluginSource[]>("get_plugin_sources");
    sources.value = res || [];
    sourcesLoadedOnce.value = true;
    return { success: true };
  } catch (e) {
    console.error("加载商店源失败:", e);
    sources.value = [];
    // 提取错误消息
    let errorMessage = "加载商店源失败";
    if (typeof e === 'string') {
      errorMessage = e;
    } else if (e instanceof Error) {
      errorMessage = e.message || e.toString();
    } else if (e && typeof e === 'object' && 'message' in e) {
      errorMessage = String((e as any).message);
    }
    return { success: false, error: errorMessage };
  }
};

const addSource = () => {
  editingSourceIndex.value = null;
  editSourceForm.id = `src_${Date.now()}`;
  editSourceForm.name = "";
  editSourceForm.indexUrl = "";
  showEditSourceDialog.value = true;
};

// 阻止切换到“添加源”这个伪 tab（避免出现空白 tab 闪烁）
// Element Plus: before-leave 返回 false 可以取消切换
const beforeLeaveTab = (newName: string | number, _oldName: string | number) => {
  if (newName === "add-source") {
    addSource();
    return false;
  }
  return true;
};

const editSource = (idx: number) => {
  const s = sources.value[idx];
  if (!s) return;

  editingSourceIndex.value = idx;
  editSourceForm.id = s.id;
  editSourceForm.name = pluginSourceDisplayName(s);
  editSourceForm.indexUrl = s.indexUrl;
  showEditSourceDialog.value = true;
};

const confirmEditSource = async () => {
  if (!editSourceForm.name.trim() || !editSourceForm.indexUrl.trim()) {
    ElMessage.warning(t("plugins.fillNameAndIndexUrl"));
    return;
  }

  // 先验证源可用性（index.json 可获取且可解析）
  // 若验证失败，弹窗询问用户是否仍然添加
  const indexUrl = editSourceForm.indexUrl.trim();
  isValidatingSource.value = true;
  try {
    const skipValidate =
      editSourceForm.id === OFFICIAL_PLUGIN_SOURCE_ID && editingSourceIndex.value !== null;
    if (!skipValidate) {
      await invoke("validate_plugin_source", { indexUrl });
    }
  } catch (e) {
    const msg =
      typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message || e.toString()
          : e && typeof e === "object" && "message" in e
            ? String((e as any).message)
            : "源验证失败";

    try {
      await ElMessageBox.confirm(
        t("plugins.sourceValidateFailedStillAdd", { msg }),
        t("plugins.sourceValidateFailed"),
        {
          type: "warning",
          confirmButtonText: t("plugins.stillAdd"),
          cancelButtonText: t("plugins.backToEdit"),
          distinguishCancelAndClose: true,
        }
      );
      // 用户确认：继续添加
    } catch {
      // 用户取消：保持对话框打开，便于继续修改
      return;
    }
  } finally {
    isValidatingSource.value = false;
  }

  // 确认添加/编辑即持久化（避免用户以为已添加但重启后丢失）
  try {
    const id = editSourceForm.id.trim() || null;
    let name = editSourceForm.name.trim();
    const isOfficial =
      editSourceForm.id === OFFICIAL_PLUGIN_SOURCE_ID ||
      (editingSourceIndex.value !== null &&
        sources.value[editingSourceIndex.value]?.id === OFFICIAL_PLUGIN_SOURCE_ID);
    if (isOfficial) {
      const localizedDefault = t("plugins.officialGithubReleaseSourceName");
      if (name === localizedDefault || name === OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME) {
        name = OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME;
      }
    }

    if (editingSourceIndex.value === null) {
      // 添加新源
      const result = await invoke<PluginSource>("add_plugin_source", { id, name, indexUrl });
      sources.value.push(result);
    } else {
      // 编辑现有源
      const originalId = sources.value[editingSourceIndex.value].id;
      await invoke("update_plugin_source", { id: originalId, name, indexUrl });
      sources.value[editingSourceIndex.value] = {
        id: originalId,
        name,
        indexUrl,
      };
    }

    await loadSources();
    ElMessage.success(editingSourceIndex.value === null ? t("plugins.sourceAdded") : t("plugins.sourceUpdated"));
    showEditSourceDialog.value = false;
  } catch (e) {
    console.error("保存商店源失败:", e);
    let errorMessage = t("plugins.saveSourceFailed");
    if (typeof e === 'string') {
      errorMessage = e;
    } else if (e instanceof Error) {
      errorMessage = e.message || e.toString();
    } else if (e && typeof e === 'object' && 'message' in e) {
      errorMessage = String((e as any).message);
    }
    ElMessage.error(errorMessage);
  }
};

const removeSource = async (idx: number) => {
  const source = sources.value[idx];
  if (!source) return;
  if (source.id === OFFICIAL_PLUGIN_SOURCE_ID) {
    ElMessage.warning(t("plugins.cannotDeleteOfficialSource"));
    return;
  }

  try {
    await ElMessageBox.confirm(t("plugins.confirmDeleteStoreSource"), t("plugins.deleteStoreSourceTitle"), { type: "warning" });
    sources.value.splice(idx, 1);
  } catch {
    // cancel
  }
};

const handleDeleteSource = async (source: PluginSource) => {
  if (source.id === OFFICIAL_PLUGIN_SOURCE_ID) {
    ElMessage.warning(t("plugins.cannotDeleteOfficialSource"));
    return;
  }
  try {
    await ElMessageBox.confirm(
      t("plugins.confirmDeleteStoreSourceWithName", { name: pluginSourceDisplayName(source) }),
      t("plugins.deleteStoreSourceTitle"),
      { type: "warning" }
    );

    // 调用后端删除
    await invoke("delete_plugin_source", { id: source.id });

    // 从前端列表移除
    const idx = sources.value.findIndex(s => s.id === source.id);
    if (idx !== -1) {
      sources.value.splice(idx, 1);
    }

    // 清理前端缓存
    delete storePluginsBySource.value[source.id];
    delete storeLoadedBySource.value[source.id];

    // 如果当前 tab 是被删的源，切换到已安装源
    if (activeStoreSourceId.value === source.id) {
      activeTab.value = "installed";
    }

    ElMessage.success(t("plugins.sourceDeleted"));
  } catch (e) {
    if (e !== 'cancel') {
      console.error("删除商店源失败:", e);
      ElMessage.error(t("plugins.deleteSourceFailed"));
    }
  }
};


/**
 * 加载商店插件列表
 * @param sourceId 商店源 ID
 * @param options.showMessage 是否显示提示消息
 * @param options.forceRefresh 是否强制从远程刷新（忽略本地缓存）
 *   - true: 用户手动刷新时使用，强制从远程获取最新数据
 *   - false: 首次加载或自动加载时使用，优先使用本地缓存
 */
const loadStorePlugins = async (
  sourceId: string,
  options: { showMessage?: boolean; forceRefresh?: boolean } = {}
) => {
  const { showMessage = true, forceRefresh = false } = options;

  loadingBySource.value = { ...loadingBySource.value, [sourceId]: true };
  // 延迟 300ms 显示骨架屏，避免快速加载时闪屏
  if (skeletonTimersBySource.value[sourceId]) {
    clearTimeout(skeletonTimersBySource.value[sourceId]);
  }
  skeletonTimersBySource.value[sourceId] = setTimeout(() => {
    if (loadingBySource.value[sourceId]) {
      showSkeletonBySource.value = { ...showSkeletonBySource.value, [sourceId]: true };
    }
  }, 300);
  try {
    const plugins = await invoke<StorePluginResolved[]>("get_store_plugins", {
      sourceId,
      forceRefresh,
    });
    storePluginsBySource.value = {
      ...storePluginsBySource.value,
      [sourceId]: applyInstalledVersions(plugins || []),
    };
    storeLoadedBySource.value = {
      ...storeLoadedBySource.value,
      [sourceId]: true,
    };
    loadingBySource.value = { ...loadingBySource.value, [sourceId]: false };

    if (showMessage) {
      ElMessage.success(forceRefresh ? t("plugins.storeListRefreshed") : t("plugins.storeListLoaded"));
    }

    // 新格式：iconUrl 可能为空，尝试通过 KGPG v2 Range 预取 icon（不阻塞 UI）
    void prefetchRemoteIconsForSource(sourceId);
  } catch (error) {
    console.error("加载商店失败:", error);
    // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
    let errorMessage = t("plugins.loadStoreFailed");
    if (typeof error === 'string') {
      errorMessage = error;
    } else if (error instanceof Error) {
      errorMessage = error.message || error.toString();
    } else if (error && typeof error === 'object' && 'message' in error) {
      errorMessage = String((error as any).message);
    }
    ElMessage.error(errorMessage);
    loadingBySource.value = { ...loadingBySource.value, [sourceId]: false };
  } finally {
    // 确保骨架屏状态被清理（列表内容可能已提前展示，但骨架屏不能残留）
    loadingBySource.value = { ...loadingBySource.value, [sourceId]: false };
    showSkeletonBySource.value = { ...showSkeletonBySource.value, [sourceId]: false };
    if (skeletonTimersBySource.value[sourceId]) {
      clearTimeout(skeletonTimersBySource.value[sourceId]);
      delete skeletonTimersBySource.value[sourceId];
    }
  }
};

/** 用于比对商店列表是否变化（仅 id + version，排序后拼接） */
const storePluginListSignature = (plugins: StorePluginResolved[]) =>
  [...plugins]
    .map((p) => `${p.id}\x1f${p.version}`)
    .sort()
    .join("\n");

/**
 * 静默后台：若 index 缓存超过 `STORE_INDEX_REVALIDATE_MAX_AGE_SECS` 则拉取；不碰 loading 状态。
 * 若返回列表与当前展示不一致则更新 UI 并提示；失败完全静默。
 */
const revalidateStorePluginsInBackground = (sourceId: string) => {
  if (storeRevalidateInflight.has(sourceId)) return;
  storeRevalidateInflight.add(sourceId);
  void (async () => {
    try {
      const prev = storePluginsBySource.value[sourceId];
      const prevSig = storePluginListSignature(prev ?? []);
      const plugins = await invoke<StorePluginResolved[]>("get_store_plugins", {
        sourceId,
        forceRefresh: false,
        revalidateIfStaleAfterSecs: STORE_INDEX_REVALIDATE_MAX_AGE_SECS,
      });
      if (!plugins?.length) return;
      const next = applyInstalledVersions(plugins);
      const nextSig = storePluginListSignature(next);
      if (prevSig === nextSig) return;
      storePluginsBySource.value = { ...storePluginsBySource.value, [sourceId]: next };
      if (prev && prev.length > 0) {
        ElMessage.success(t("plugins.storeListAutoUpdated"));
      }
      void prefetchRemoteIconsForSource(sourceId);
    } catch {
      /* 静默 */
    } finally {
      storeRevalidateInflight.delete(sourceId);
    }
  })();
};

const selectPluginFile = async () => {
  try {
    const filePath = await open({
      filters: [
        {
          name: "Kabegame 插件",
          extensions: ["kgpg"],
        },
      ],
    });

    if (filePath && typeof filePath === "string") {
      selectedFilePath.value = filePath;
    }
  } catch (error) {
    console.error("选择文件失败:", error);
    ElMessage.error(t("plugins.selectFileFailed"));
  }
};

/** Android：直接打开文件选择器，选择后执行导入（不显示导入弹窗）。
 *  使用 picker 插件的 pickKgpgFile 将 content:// URI 复制到应用私有目录，返回可读路径 */
const triggerImportDirect = async () => {
  try {
    const filePath = await pickKgpgFile();
    if (!filePath) return;

    selectedFilePath.value = filePath;
    await handleImport();
  } catch (error) {
    console.error("选择文件失败:", error);
    ElMessage.error(t("plugins.selectFileFailed"));
  }
};

const handleImport = async () => {
  if (!selectedFilePath.value) return;

  try {
    const filePath = selectedFilePath.value;
    const fileExt = filePath.split('.').pop()?.toLowerCase();

    if (fileExt === "kgpg") {
      const parsed = await invoke<Plugin>("preview_import_plugin", { zipPath: filePath });

      const existing = pluginStore.plugins.find(p => p.id === parsed.id);
      const alreadyExists = !!existing;
      const existingVersion = existing?.version;

      if (alreadyExists && existingVersion && existingVersion === parsed.version) {
        ElMessage.info(`插件已存在（v${parsed.version}），无需重复导入`);
        return;
      }

      const displayName = pluginName(parsed);
      const msg = alreadyExists
        ? `检测到同 ID 插件，版本将从 <b>v${existingVersion || "?"}</b> 变更为 <b>v${parsed.version}</b>，是否继续导入？`
        : `将导入插件：<b>${escapeHtml(displayName)}</b>（v${parsed.version}，${formatBytes(parsed.sizeBytes)}），是否继续？`;

      await ElMessageBox.confirm(msg, t("plugins.confirmImport"), {
        type: "warning",
        dangerouslyUseHTMLString: true,
        confirmButtonText: t("plugins.importButton"),
        cancelButtonText: t("common.cancel"),
      });

      await invoke("import_plugin_from_zip", { zipPath: filePath });
    } else {
      ElMessage.error(t("plugins.invalidFormatSelectKgpg"));
      return;
    }

    ElMessage.success(t("plugins.importSuccess"));
    showImportDialog.value = false;
    selectedFilePath.value = null;
    // plugin-added / plugin-updated event auto-updates the store
    // 若当前在某个商店源 tab，导入后顺手刷新当前源列表（否则只刷新已安装即可）
    // 只需更新 installedVersion，使用缓存即可
    if (activeStoreSourceId.value) {
      await loadStorePlugins(activeStoreSourceId.value, { showMessage: false, forceRefresh: false });
    }
  } catch (error) {
    console.error("导入源失败:", error);
    ElMessage.error(
      error instanceof Error ? error.message : t("plugins.importFailed")
    );
  }
};

const handleStoreInstall = async (plugin: StorePluginResolved, forceReinstall = false) => {
  try {
    // 之所以先下载，是为了避免实际版本不一致
    const willUpdate = isUpdateAvailable(plugin.installedVersion, plugin.version);
    const isReinstall = forceReinstall && plugin.installedVersion === plugin.version;
    const title = isReinstall ? t("plugins.confirmReinstall") : willUpdate ? t("plugins.confirmUpdate") : t("plugins.confirmInstall");
    const confirmButtonText = isReinstall ? t("plugins.reinstall") : willUpdate ? t("plugins.update") : t("plugins.install");
    const displayName = pluginName(plugin);
    const msg = isReinstall
      ? `将重新安装 <b>${escapeHtml(displayName)}</b>（v${escapeHtml(plugin.version)}，${formatBytes(
        plugin.sizeBytes
      )}），是否继续？`
      : willUpdate
        ? `将从 <b>v${escapeHtml(plugin.installedVersion || "?")}</b> 更新为 <b>v${escapeHtml(
          plugin.version
        )}</b>（${formatBytes(plugin.sizeBytes)}），是否继续？`
        : `将安装 <b>${escapeHtml(displayName)}</b>（v${escapeHtml(plugin.version)}，${formatBytes(
          plugin.sizeBytes
        )}），是否继续？`;

    await ElMessageBox.confirm(msg, title, {
      type: "warning",
      dangerouslyUseHTMLString: true,
      confirmButtonText,
      cancelButtonText: t("common.cancel"),
    });

    setInstalling(plugin.id, true);
    installProgressByKey.value = {
      ...installProgressByKey.value,
      [storePluginProgressKey(plugin)]: 0,
    };
    const installed = await invoke<Plugin>("install_from_store", {
      sourceId: plugin.sourceId,
      pluginId: plugin.id,
    });

    ElMessage.success(isReinstall ? t("plugins.reinstallSuccess") : willUpdate ? t("plugins.updateSuccess") : t("plugins.installSuccess"));
    // plugin-added / plugin-updated event auto-updates the store

    // 只更新本地 UI 状态：不触发整页/整 tab 列表刷新
    markStorePluginInstalled(plugin.id, installed.version);
    if (plugin.sourceId && installed.version && plugin.version !== installed.version) {
      const list = storePluginsBySource.value[plugin.sourceId] || [];
      storePluginsBySource.value = {
        ...storePluginsBySource.value,
        [plugin.sourceId]: list.map((p) => (p.id === plugin.id ? { ...p, version: installed.version } : p)),
      };
    }
  } catch (error) {
    if (error !== "cancel") {
      console.error("商店安装失败:", error);
      ElMessage.error(error instanceof Error ? error.message : "安装/更新失败");
    }
  } finally {
    setInstalling(plugin.id, false);
    const pk = storePluginProgressKey(plugin);
    if (installProgressByKey.value[pk] !== undefined) {
      const next = { ...installProgressByKey.value };
      delete next[pk];
      installProgressByKey.value = next;
    }
  }
};

const viewPluginDetails = (plugin: PluginListItem) => {
  // 跳转到插件详情页面，对 ID 进行 URL 编码以支持中文字符
  // 商店/官方源条目：通过 mode=remote&sourceId 进入远程详情路径
  const path = `/plugin-detail/${encodeURIComponent(plugin.id)}`;
  if ("downloadUrl" in plugin && plugin.downloadUrl) {
    const store = plugin as StorePluginResolved;
    // 已安装且与商店版本一致：走本地已安装详情与文档，不拉远程包
    if (store.installedVersion && store.installedVersion === store.version) {
      router.push(path);
      return;
    }
    router.push({
      path,
      query: {
        mode: "remote",
        sourceId: store.sourceId ?? undefined,
      },
    });
    return;
  }
  router.push(path);
};

const handleDelete = async (plugin: Plugin) => {
  try {
    await ElMessageBox.confirm(t("plugins.confirmUninstall", { name: pluginName(plugin) }), t("plugins.confirmDelete"), {
      type: "warning",
    });
    await pluginStore.deletePlugin(plugin.id);
    ElMessage.success(t("plugins.pluginDeleted"));
  } catch (error) {
    // 用户取消
  }
};

// 统一的刷新处理，根据当前 tab 执行不同逻辑
const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    if (activeTab.value === "installed") {
      // 已安装源 tab：刷新已安装源
      // 已安装源使用 "installed" 作为key
      const sourceKey = "installed";
      loadingBySource.value = { ...loadingBySource.value, [sourceKey]: true };
      if (skeletonTimersBySource.value[sourceKey]) {
        clearTimeout(skeletonTimersBySource.value[sourceKey]);
      }
      skeletonTimersBySource.value[sourceKey] = setTimeout(() => {
        if (loadingBySource.value[sourceKey]) {
          showSkeletonBySource.value = { ...showSkeletonBySource.value, [sourceKey]: true };
        }
      }, 300);
      try {
        // 触发后端全量刷新缓存（避免 get_plugins 只返回内存缓存导致”刷新无效”）
        await pluginStore.refreshPlugins();
        await refreshPluginIcons();
        ElMessage.success(t("plugins.installedRefreshSuccess"));
      } catch (error) {
        console.error("刷新已安装源失败:", error);
        // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
        let errorMessage = t("plugins.installedRefreshFailed");
        if (typeof error === 'string') {
          errorMessage = error;
        } else if (error instanceof Error) {
          errorMessage = error.message || error.toString();
        } else if (error && typeof error === 'object' && 'message' in error) {
          errorMessage = String((error as any).message);
        }
        ElMessage.error(errorMessage);
        throw error; // 重新抛出，让外层 catch 处理
      } finally {
        loadingBySource.value = { ...loadingBySource.value, [sourceKey]: false };
        showSkeletonBySource.value = { ...showSkeletonBySource.value, [sourceKey]: false };
        if (skeletonTimersBySource.value[sourceKey]) {
          clearTimeout(skeletonTimersBySource.value[sourceKey]);
          delete skeletonTimersBySource.value[sourceKey];
        }
      }
    } else if (isStoreTab(activeTab.value)) {
      // 商店 tab：只刷新当前源
      const sourceId = activeStoreSourceId.value;
      if (!sourceId) return;

      // 刷新源列表（本地），若当前源不见了则切回已安装源
      const sourcesResult = await loadSources();
      if (!sourcesResult.success && sourcesResult.error) {
        ElMessage.error(sourcesResult.error);
      }
      const sourceIds = new Set(sources.value.map((s) => s.id));
      if (!sourceIds.has(sourceId)) {
        ElMessage.warning(t("plugins.storeSourceGoneSwitchToInstalled"));
        activeTab.value = "installed";
        return;
      }

      // 用户点击刷新按钮：强制从远程刷新（忽略本地缓存）
      await loadStorePlugins(sourceId, { showMessage: true, forceRefresh: true });
      await refreshPluginIcons();
    }
  } catch (error) {
    console.error("刷新失败:", error);
    // 如果内层已经处理过错误（已安装源），这里不再重复显示
    // 否则显示通用错误消息
    if (isStoreTab(activeTab.value)) {
      // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
      let errorMessage = t("plugins.refreshFailed");
      if (typeof error === 'string') {
        errorMessage = error;
      } else if (error instanceof Error) {
        errorMessage = error.message || error.toString();
      } else if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String((error as any).message);
      }
      ElMessage.error(errorMessage);
    }
  } finally {
    isRefreshing.value = false;
  }
};

onMounted(async () => {
  try {
    // 首次进入：已安装列表由用户在「已安装」Tab 手动刷新拉取；此处只加载商店源配置
    // 加载商店源列表（本地配置），用于渲染动态 tab
    await loadSources();
    await refreshPluginIcons();

    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (isTauri()) {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenStoreDownloadProgress = await listen<StoreDownloadProgressPayload>(
          "plugin-store-download-progress",
          (event) => {
            const { sourceId, pluginId, percent, error } = event.payload;
            const k = `${sourceId}::${pluginId}`;
            if (error) {
              const next = { ...installProgressByKey.value };
              delete next[k];
              installProgressByKey.value = next;
              return;
            }
            installProgressByKey.value = { ...installProgressByKey.value, [k]: percent };
          }
        );
        unlistenPluginSourcesChanged = await listen<{ sourceId?: string; name?: string }>(
          "plugin-sources-changed",
          () => {
            void loadSources();
          }
        );
      }
    } catch {
      /* 无事件环境 */
    }
  } finally {
    // 无论成功失败，都清理骨架屏定时器与显示状态
    loadingBySource.value = {};
    showSkeletonBySource.value = {};
    for (const timer of Object.values(skeletonTimersBySource.value)) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    skeletonTimersBySource.value = {};
  }
});

// 首次切到“某个商店源 tab”时，才拉取该源的商店列表（懒加载）
watch(activeTab, async (tab) => {
  if (!isStoreTab(tab)) return;
  const sourceId = tab.slice("store:".length);
  if (!sourceId) return;

  // 兜底：若源列表尚未加载，先加载一次（本地）
  if (!sourcesLoadedOnce.value) {
    await loadSources();
  }

  // 如果该源不存在，直接回到已安装源
  const sourceIds = new Set(sources.value.map((s) => s.id));
  if (!sourceIds.has(sourceId)) {
    activeTab.value = "installed";
    return;
  }

  // 首次进入该源：优先本地缓存；之后每次切回该 tab 也会触发后台按时间静默重拉（见 revalidateStorePluginsInBackground）
  if (!storeLoadedBySource.value[sourceId]) {
    await loadStorePlugins(sourceId, { showMessage: false, forceRefresh: false });
    await refreshPluginIcons();
  }
  revalidateStorePluginsInBackground(sourceId);
});

onUnmounted(() => {
  unlistenStoreDownloadProgress?.();
  unlistenPluginSourcesChanged?.();
});
</script>

<style lang="scss">
.plugin-browser-container {
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

  &::-webkit-scrollbar {
    display: none;
    /* Chrome, Safari, Opera */
  }
}

.plugin-browser-content {
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

  .filter-bar {
    display: flex;
    align-items: center;
    margin-bottom: 20px;
    gap: 10px;
  }

  .plugin-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
  }

  /* 安卓：2 列正方形；上/中/下固定比例，仅名称可省略，标签区可滚动（隐藏滚动条） */
  .plugin-grid-android {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;

    .plugin-card {
      height: auto;
      aspect-ratio: 1;
      min-height: 0;
      overflow: hidden;
      --el-card-padding: 10px;

      .el-card__body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 5px 6px;
        box-sizing: border-box;
        gap: 0;
        overflow: hidden;
      }

      /* 图标区与标题区分开：图标占卡片内容区高度 40%，标题单独一行、字号 15px */
      .plugin-android-icon {
        flex: 0 0 40%;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;

        .plugin-icon,
        .plugin-icon-placeholder {
          width: clamp(40px, 52%, 56px);
          height: clamp(40px, 52%, 56px);
          border-radius: 8px;
        }

        .plugin-icon-placeholder {
          font-size: 22px;
        }
      }

      .plugin-android-title {
        flex: 0 0 auto;
        width: 100%;
        min-width: 0;
        text-align: center;
        padding: 2px 4px 0;
        box-sizing: border-box;

        h3 {
          margin: 0 !important;
          font-size: 15px;
          font-weight: 600;
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          width: 100%;
          max-width: 100%;
        }
      }

      /* 单行标签：横向自动循环（双列无缝），不可手动滑动 */
      .plugin-info {
        flex: 0 0 auto;
        width: 100%;
        margin-bottom: 0 !important;
        margin-top: 1px;
        padding: 0;

        .el-tag {
          flex-shrink: 0;
          margin: 0;
          height: 13px;
          padding: 0 3px;
          font-size: 8px;
          line-height: 11px;
          border-radius: 3px;
          box-sizing: border-box;
          white-space: nowrap;
        }

        .el-tag .el-tag__content {
          line-height: 11px;
        }
      }

      .plugin-info--marquee {
        overflow: hidden;
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
      }

      .plugin-info-track {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        width: max-content;
        will-change: transform;
        animation: plugin-info-marquee-android 16s linear infinite;

        @media (prefers-reduced-motion: reduce) {
          animation: none;
        }
      }

      .plugin-info-group {
        display: flex;
        flex-flow: row nowrap;
        align-items: center;
        gap: 3px;
        padding-right: 14px;
        flex-shrink: 0;
      }

      @keyframes plugin-info-marquee-android {
        0% {
          transform: translateX(0);
        }

        100% {
          transform: translateX(-50%);
        }
      }

      .plugin-footer {
        flex: 0 0 auto;
        flex-shrink: 0;
        flex-direction: column;
        gap: 3px;
        margin-top: auto;
        padding-top: 3px;
        border-top: 1px solid var(--anime-border, rgba(128, 128, 128, 0.2));

        .el-button {
          width: 100%;
          margin: 0;
          padding: 4px 6px;
          font-size: 11px;
        }
      }

      .plugin-store-install-btn {
        min-width: 0;

        &--progress {
          padding: 3px 8px;
        }

        &__fill-wrap {
          min-height: 18px;
        }

        &__label {
          font-size: 10px;
          line-height: 18px;
        }
      }
    }
  }
}

/* 列表淡入动画 */
.fade-in-list-enter-active {
  transition: transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.26s ease-out, filter 0.26s ease-out;
}

.fade-in-list-leave-active {
  transition: transform 0.22s ease-in, opacity 0.22s ease-in, filter 0.22s ease-in;
  pointer-events: none;
}

.fade-in-list-enter-from {
  opacity: 0;
  transform: translateY(14px) scale(0.96);
  filter: blur(2px);
}

.fade-in-list-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.92);
  filter: blur(2px);
}

.fade-in-list-move {
  transition: transform 0.4s ease;
}

.plugin-card {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 2px solid var(--anime-border);
  cursor: pointer;

  &:hover {
    box-shadow: var(--anime-shadow-hover);
    border-color: var(--anime-primary-light);
  }

  .plugin-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
  }

  .plugin-icon {
    width: 48px;
    height: 48px;
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--anime-bg-secondary);

    .el-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .el-image__inner {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  .plugin-icon-placeholder {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(255, 107, 157, 0.2) 0%, rgba(167, 139, 250, 0.2) 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--anime-primary);
    font-size: 24px;

    &.plugin-icon-loading {
      background: var(--anime-bg-secondary);
      color: var(--anime-text-regular);
    }

    .spin {
      animation: icon-spin 1s linear infinite;
    }
  }

  .plugin-title {
    flex: 1;
    min-width: 0;
    user-select: text;
    cursor: inherit;

    h3 {
      margin: 0 0 4px 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--anime-text-primary);
      user-select: text;
      cursor: inherit;
    }
  }

  .plugin-desp {
    margin: 0;
    font-size: 12px;
    color: var(--anime-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    user-select: text;
    cursor: text;
  }

  .plugin-actions {
    flex-shrink: 0;
  }

  .plugin-info {
    margin-bottom: 12px;
  }

  .plugin-footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    align-items: center;
  }

  .plugin-store-install-btn {
    min-width: 132px;

    &--progress {
      position: relative;
      overflow: hidden;
      padding: 5px 14px;
    }

    &__fill-wrap {
      position: relative;
      display: block;
      width: 100%;
      min-width: 104px;
      min-height: 22px;
      border-radius: 4px;
      overflow: hidden;
      /* 未装填区域：略压暗，装填层从左盖上 */
      background: rgba(0, 0, 0, 0.14);
    }

    /* 从左向右装填（“水”） */
    &__fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 0;
      border-radius: 0 3px 3px 0;
      pointer-events: none;
      transition: width 0.22s ease-out;
      z-index: 0;
      background: linear-gradient(90deg,
          rgba(255, 255, 255, 0.52) 0%,
          rgba(255, 255, 255, 0.22) 100%);
    }

    &__label {
      position: relative;
      z-index: 1;
      display: block;
      font-size: 12px;
      line-height: 22px;
      text-align: center;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    }

    &.el-button--warning {
      .plugin-store-install-btn__fill {
        background: linear-gradient(90deg,
            rgba(255, 255, 255, 0.5) 0%,
            rgba(255, 255, 255, 0.2) 100%);
      }
    }

    /* 默认/浅色按钮：用主题色半透明作为装填 */
    &.el-button--default {
      .plugin-store-install-btn__fill-wrap {
        background: rgba(0, 0, 0, 0.06);
      }

      .plugin-store-install-btn__fill {
        background: linear-gradient(90deg,
            var(--el-color-primary-light-5) 0%,
            var(--el-color-primary-light-7) 100%);
      }

      .plugin-store-install-btn__label {
        color: var(--el-text-color-primary);
        text-shadow: none;
      }
    }

    &--installed-only {
      cursor: default;
      pointer-events: none;
    }
  }

  /* Tab 关闭按钮样式 */
  .tab-close-icon {
    margin-left: 8px;
    font-size: 14px;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.2s;

    &:hover {
      opacity: 1;
      color: #f56c6c;
    }
  }

  /* 禁用插件卡片上标签和按钮的初始展开动画 */
  .el-tag {
    animation: none !important;
    transition: none !important;
  }
}

.loading-skeleton {
  padding: 20px;
}

.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.skeleton-grid-android {
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;

  .skeleton-card {
    height: auto;
    aspect-ratio: 1;
    padding: 10px;
    overflow: hidden;
    display: flex;
    align-items: flex-start;
    box-sizing: border-box;
  }
}

.skeleton-card {
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  padding: 20px;
  background: var(--anime-bg-card);
  box-shadow: var(--anime-shadow);
}

.empty {
  padding: 40px;
  text-align: center;
}

/* 表格淡入动画 */
.fade-in-table {
  animation: fadeInTable 0.4s ease-in;
}

@keyframes fadeInTable {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes icon-spin {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

.import-instructions {
  text-align: center;
  padding: 20px;
}

.import-instructions p {
  margin: 10px 0;
  color: var(--el-text-color-secondary);
}

.selected-file {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}
</style>
