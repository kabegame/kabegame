<template>
  <div class="plugin-browser-container" v-pull-to-refresh="pullToRefreshOpts">
    <div class="plugin-browser-content">
      <PluginBrowserPageHeader @refresh="handleRefresh" @import-source="handleImportSource"
        @manage-sources="openManageSources" />

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

      <!-- Tab 切换：分段式胶囊组，右侧搜索框与其同排 -->
      <div class="plugin-tabs-row">
        <KbTab v-model="activeTab" :items="tabItems" :close-title="$t('plugins.delete')"
          @close="handleDeleteSourceById" @select="handleTabSelect" />

        <div class="plugin-search">
          <el-input v-model="searchKeyword" :placeholder="$t('plugins.quickPreview.searchPlaceholder')" clearable>
            <template #prefix>
              <el-icon>
                <Search />
              </el-icon>
            </template>
          </el-input>
        </div>
      </div>

      <div class="plugin-tab-panes">
        <div v-show="activeTab === 'installed'">
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

          <div v-else-if="filteredInstalledPlugins.length === 0" class="empty">
            <el-empty :description="$t('plugins.quickPreview.noSearchResult')" :image-size="100" />
          </div>

          <!-- 已安装：布局与商店一致 -->
          <div v-else>
            <transition-group name="fade-in-list" tag="div" class="plugin-grid"
              :class="{ 'plugin-grid-android': uiStore.isCompact }">
              <PluginGridCard v-for="plugin in filteredInstalledPlugins" :key="plugin.id"
                :card-class="appBackgroundCardClass" :name="pluginName(plugin)" :version="plugin.version"
                :icon-src="getPluginIconSrc(plugin)" :icon-loading="isIconLoading(plugin)"
                :update-available="hasKnownUpdateFor(plugin.id, plugin.version)"
                @click="openDetailDialog(plugin)" v-on="quickPreview.cardListeners(plugin)" />
            </transition-group>
          </div>
        </div>

        <!-- 商店源：按"源名称"动态生成 tab；每个 tab 只显示该源的数据 -->
        <div v-for="s in storeSourcesToRender" :key="s.id" v-show="activeTab === storeTabName(s.id)">
          <!-- 插件列表（300ms 延迟显示骨架屏，避免快速刷新时闪屏） -->
          <div v-if="showSkeletonBySource[s.id]" class="loading-skeleton">
            <div v-if="uiStore.isCompact" class="skeleton-grid skeleton-grid-android">
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

          <div v-else-if="filteredStorePlugins(s.id).length === 0" class="empty">
            <el-empty :description="$t('plugins.quickPreview.noSearchResult')" :image-size="100" />
          </div>

          <transition-group v-else name="fade-in-list" tag="div" class="plugin-grid"
            :class="{ 'plugin-grid-android': uiStore.isCompact }">
            <PluginGridCard v-for="plugin in filteredStorePlugins(s.id)" :key="plugin.id"
              :card-class="appBackgroundCardClass" :name="pluginName(plugin)" :version="plugin.version"
              :icon-src="getPluginIconSrc(plugin)" :icon-loading="isIconLoading(plugin)"
              :update-available="isUpdateAvailable(plugin.installedVersion, plugin.version)"
              @click="openDetailDialog(plugin)" v-on="quickPreview.cardListeners(plugin)" />
          </transition-group>
        </div>
      </div>
    </div>

    <!-- 商店源管理 -->
    <el-dialog v-if="!IS_LIGHT_MODE" :model-value="sourcesDialog.isOpen.value" :z-index="sourcesDialog.zIndex.value" :title="$t('plugins.sourcesDialogTitle')"
      width="720px" @update:model-value="sourcesDialog.close">
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
        <el-button @click="sourcesDialog.close()">{{ $t('common.close') }}</el-button>
        <el-button @click="addSource">{{ $t('plugins.newSource') }}</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑源 -->
    <el-dialog v-if="!IS_LIGHT_MODE" :model-value="editSourceDialog.isOpen.value" :z-index="editSourceDialog.zIndex.value"
      :title="editingSourceIndex === null ? $t('plugins.newSource') : $t('plugins.editSource')" width="620px" @update:model-value="editSourceDialog.close">
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
        <el-button @click="editSourceDialog.close()">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="isValidatingSource" :disabled="isValidatingSource"
          @click="confirmEditSource">
          {{ $t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 导入源对话框 -->
    <el-dialog :model-value="importDialog.isOpen.value" :z-index="importDialog.zIndex.value" :title="$t('plugins.importDialogTitle')" width="500px" @update:model-value="importDialog.close">
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
        <el-button @click="importDialog.close()">{{ $t('common.cancel') }}</el-button>
        <el-button type="primary" @click="handleImport" :disabled="!selectedFilePath">
          {{ $t('plugins.importButton') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 桌面 hover 悬浮快捷预览：贴卡片弹出，跟随卡片翻转/贴边定位 -->
    <Teleport to="body">
      <div v-if="quickPreview.visible.value && !quickPreview.compact.value"
        :ref="(el) => (quickPreview.panelRef.value = (el as HTMLElement | null))" :style="quickPreview.panelStyle.value"
        v-on="quickPreview.panelListeners" @click="handleQuickPreviewOpenDetail">
        <PluginQuickPreviewPanel v-if="quickPreviewPlugin" :plugin="quickPreviewPlugin" :icon-src="quickPreviewIconSrc"
          :images="quickPreviewImages" :empty-reason="quickPreviewEmptyReason"
          :update-available-version="quickPreviewUpdateVersion" />
      </div>
    </Teleport>

    <!-- 紧凑端长按：同一张面板以底部抽屉形态展现 -->
    <el-drawer v-if="quickPreview.compact.value" :model-value="quickPreview.visible.value" direction="btt" size="auto"
      :with-header="false" append-to-body class="quick-preview-drawer"
      @update:model-value="(v) => (v ? null : quickPreview.close())" @click="handleQuickPreviewOpenDetail">
      <PluginQuickPreviewPanel v-if="quickPreviewPlugin" :plugin="quickPreviewPlugin" :icon-src="quickPreviewIconSrc"
        :images="quickPreviewImages" :empty-reason="quickPreviewEmptyReason"
        :update-available-version="quickPreviewUpdateVersion" class="quick-preview-drawer-panel" />
    </el-drawer>

    <!-- 插件/源详情：弹窗形式，不再走独立路由 -->
    <PluginDetailDialog v-model:visible="detailDialogVisible" :target="detailDialogTarget" />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import {
  Refresh,
  Upload,
  Plus,
  Search,
  Setting,
  QuestionFilled,
} from "@element-plus/icons-vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import type { PluginManifestText } from "@kabegame/core/stores/plugins";
import type { PluginLabel } from "@kabegame/core/stores/pluginLabels";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke, listen } from "@/api/rpc";
import { open } from "@tauri-apps/plugin-dialog";
import { pickKgpgFile } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import PluginBrowserPageHeader from "@/components/header/PluginBrowserPageHeader.vue";
import KbTab, { type KbTabItem } from "@/components/common/KbTab.vue";
import PluginGridCard from "@/components/plugin/PluginGridCard.vue";
import PluginDetailDialog, {
  type PluginDetailDialogTarget,
} from "@/components/plugin/PluginDetailDialog.vue";
import PluginQuickPreviewPanel, {
  type QuickPreviewPluginLike,
} from "@kabegame/core/components/plugin/PluginQuickPreviewPanel.vue";
import type { PluginQuickPreviewImage } from "@kabegame/core/components/plugin/PluginQuickPreviewCarousel.vue";
import { usePluginQuickPreview } from "@kabegame/core/composables/usePluginQuickPreview";
import { guessDocAssetMime, humanizeDocAssetLabel } from "@kabegame/core/utils/docAssetKey";
import { isUpdateAvailable } from "@/utils/version";
import { IS_LIGHT_MODE, IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { useModal } from "@kabegame/core/composables/useModal";
import { storePluginCacheDb } from "@kabegame/core/cache/storePluginCache";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { trackEvent } from "@kabegame/core/track/umami";

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
  labels?: PluginLabel[];
  minAppIncompatible?: boolean;
}

/** 与 Rust `StorePluginDownloadProgressEvent`（camelCase）一致 */
/** 已安装插件或商店插件，用于列表卡片、详情跳转等统一入参 */
type PluginListItem = Plugin | StorePluginResolved;


const pluginStore = usePluginStore();
const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();

const uiStore = useUiStore();
const settingsStore = useSettingsStore();
const appBackgroundCardClass = computed(() =>
  settingsStore.values.appBackgroundEnabled
    ? "!bg-transparent [--el-card-bg-color:transparent]"
    : ""
);

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function trackPluginBrowserEvent(name: string, data: Record<string, unknown> = {}) {
  if (!IS_WEB) return;
  trackEvent(name, {
    url: currentUrl(),
    tab: activeTab.value,
    ...data,
  });
}

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
  if (uiStore.isCompact) {
    triggerImportDirect();
  } else {
    importDialog.open();
  }
};

const openManageSources = () => {
  sourcesDialog.open();
};


const loadingBySource = ref<Record<string, boolean>>({}); // 按源区分的loading状态
const showSkeletonBySource = ref<Record<string, boolean>>({}); // 按源区分的骨架屏状态
const skeletonTimersBySource = ref<Record<string, ReturnType<typeof setTimeout>>>({}); // 按源区分的骨架屏定时器
const activeTab = ref<string>("installed");
const importDialog = useModal();
const selectedFilePath = ref<string | null>(null);
const isRefreshing = ref(false);

let unlistenPluginSourcesChanged: (() => void) | undefined;

// 商店插件：按商店源分组缓存（每个 tab 独立显示/刷新）
const storePluginsBySource = ref<Record<string, StorePluginResolved[]>>({});
const storeLoadedBySource = ref<Record<string, boolean>>({});

const sources = ref<PluginSource[]>([]);
const storeSourcesToRender = computed(() => sources.value);
const sourcesLoadedOnce = ref(false); // 是否已加载过商店源（仅用于避免重复拉取）
const sourcesDialog = useModal();
const editSourceDialog = useModal();
const isValidatingSource = ref(false);
const editingSourceIndex = ref<number | null>(null);
const editSourceForm = reactive<{ id: string; name: string; indexUrl: string }>({
  id: "",
  name: "",
  indexUrl: "",
});

const installedPlugins = computed(() => pluginStore.visiblePlugins);

const storeTabName = (sourceId: string) => `store:${sourceId}`;
const isStoreTab = (tabName: string) => tabName.startsWith("store:");

/** 「添加源」伪 tab：点击只开弹窗，不作为可选中的内容页 */
const ADD_SOURCE_TAB = "add-source";

const tabItems = computed<KbTabItem[]>(() => [
  {
    name: "installed",
    label: t("plugins.installedTab"),
    count: installedPlugins.value.length,
  },
  ...storeSourcesToRender.value.map((s) => ({
    name: storeTabName(s.id),
    label: pluginSourceDisplayName(s),
    // 未加载过的源不显示计数（0 会被误读成「这个源是空的」）
    count: storeLoadedBySource.value[s.id] ? getStorePlugins(s.id).length : null,
    closable: s.id !== OFFICIAL_PLUGIN_SOURCE_ID,
  })),
  {
    name: ADD_SOURCE_TAB,
    label: t("plugins.addSourceTab"),
    icon: Plus,
    iconOnly: true,
    action: true,
  },
]);
const activeStoreSourceId = computed(() => {
  if (!isStoreTab(activeTab.value)) return null;
  return activeTab.value.slice("store:".length);
});

const getStorePlugins = (sourceId: string) => storePluginsBySource.value[sourceId] || [];

// ---- 搜索：只过滤网格展示，不影响 tab 计数与 installedVersion 合并等既有逻辑 ----
const searchKeyword = ref("");

const matchesSearch = (p: PluginListItem): boolean => {
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return true;
  const haystack = [p.id, pluginName(p), "baseUrl" in p ? p.baseUrl : null]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(kw);
};

const filteredInstalledPlugins = computed(() => installedPlugins.value.filter(matchesSearch));
const filteredStorePlugins = (sourceId: string) => getStorePlugins(sourceId).filter(matchesSearch);

const sourceAnalyticsItem = (sourceId: string) => {
  const source = sources.value.find((s) => s.id === sourceId);
  return {
    sourceId,
    sourceName: source ? pluginSourceDisplayName(source) : sourceId,
  };
};

const pluginAnalyticsItem = (plugin: PluginListItem) => {
  const isStore = "sourceId" in plugin && typeof plugin.sourceId === "string";
  return {
    pluginId: plugin.id,
    pluginName: pluginName(plugin),
    version: plugin.version,
    source: isStore ? "store" : "installed",
    ...(isStore
      ? {
        sourceId: (plugin as StorePluginResolved).sourceId,
        sourceName: (plugin as StorePluginResolved).sourceName,
        installedVersion: (plugin as StorePluginResolved).installedVersion ?? null,
      }
      : {}),
  };
};

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
    // 商店插件 id 与已安装插件一致时，直接复用已安装图标
    if (installedPlugins.value.some((x) => x.id === p.id)) {
      return pluginStore.pluginIconSrc(p.id) || null;
    }
    const key = getIconKey(p);
    return pluginIcons.value[key] || null;
  }

  // 已安装：图标已在 Plugin.iconPngBase64 中，直接从 store 读取
  return pluginStore.pluginIconSrc(p.id) || null;
};

// ---- hover 快捷预览（走马灯示例图仅取已安装插件的 docResources，内存直读零成本；
//      商店未安装条目若拉取示例图需要 get_plugin_detail 现下整包 .kgpg，
//      hover 这种高频轻量交互不适合触发这种下载，故只做 best-effort：
//      版本与已安装一致时复用本地已装包，否则提示"安装后可查看"）----
const quickPreview = usePluginQuickPreview<PluginListItem>();

/** 已安装 tab 里"已知有更新"仅在对应商店列表恰好已加载时才能判断，不主动为此发请求 */
const hasKnownUpdateFor = (pluginId: string, installedVersion: string): boolean => {
  for (const arr of Object.values(storePluginsBySource.value)) {
    const match = (arr || []).find((p) => p.id === pluginId);
    if (match && isUpdateAvailable(installedVersion, match.version)) return true;
  }
  return false;
};

/** 预览目标对应的"已安装 Plugin"：本身就是已安装插件，或商店条目版本与本地一致（同一份内容，复用零成本） */
const quickPreviewInstalledMatch = computed<Plugin | null>(() => {
  const item = quickPreview.activeItem.value;
  if (!item) return null;
  if (!("sourceId" in item)) return item as Plugin;
  const store = item as StorePluginResolved;
  if (store.installedVersion && store.installedVersion === store.version) {
    return installedPlugins.value.find((p) => p.id === store.id) ?? null;
  }
  return null;
});

const quickPreviewPlugin = computed<QuickPreviewPluginLike | null>(() => quickPreview.activeItem.value);
const quickPreviewIconSrc = computed(() => {
  const item = quickPreview.activeItem.value;
  return item ? getPluginIconSrc(item) : null;
});

const quickPreviewImages = computed<PluginQuickPreviewImage[]>(() => {
  const resources = quickPreviewInstalledMatch.value?.docResources;
  if (!resources) return [];
  return Object.keys(resources)
    .sort()
    .map((key) => ({
      key,
      src: `data:${guessDocAssetMime(key)};base64,${resources[key]}`,
      label: humanizeDocAssetLabel(key),
    }));
});

const quickPreviewEmptyReason = computed<"no-assets" | "not-installed" | null>(() => {
  if (quickPreviewImages.value.length > 0) return null;
  return quickPreviewInstalledMatch.value ? "no-assets" : "not-installed";
});

const quickPreviewUpdateVersion = computed<string | null>(() => {
  const item = quickPreview.activeItem.value;
  if (!item) return null;
  if ("sourceId" in item) {
    const store = item as StorePluginResolved;
    return isUpdateAvailable(store.installedVersion, store.version) ? store.version : null;
  }
  for (const arr of Object.values(storePluginsBySource.value)) {
    const match = (arr || []).find((p) => p.id === item.id);
    if (match && isUpdateAvailable(item.version, match.version)) return match.version;
  }
  return null;
});

const handleQuickPreviewOpenDetail = () => {
  const item = quickPreview.activeItem.value;
  if (!item) return;
  quickPreview.close();
  openDetailDialog(item);
};

// 商店列表：当 index.json 不再提供 iconUrl 时，从 .kgpg 固定头部通过 Range 读取 icon（后端返回 PNG bytes）
const loadRemotePluginIcon = async (plugin: {
  id: string;
  sourceId: string;
  downloadUrl?: string | null;
  version?: string;
}) => {
  if (!plugin?.id || !plugin.sourceId || !plugin.downloadUrl) return;
  // 有同 id 的已安装插件 → 图标由 getPluginIconSrc 从已安装数据取，无需远程拉取
  if (installedPlugins.value.some((p) => p.id === plugin.id)) return;
  const key = storeIconKey(plugin.sourceId, plugin.id);
  if (pluginIcons.value[key]) return;
  if (pluginIconLoading.value[key]) return;
  // web 模式：先查 Dexie icon 缓存（版本匹配）
  if (IS_WEB && plugin.version) {
    const cached = await storePluginCacheDb.icons.get(key);
    if (cached && cached.version === plugin.version) {
      pluginIcons.value = { ...pluginIcons.value, [key]: `data:image/png;base64,${cached.iconBase64}` };
      return;
    }
  }
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
    if (IS_WEB && plugin.version) {
      void storePluginCacheDb.icons.put({ key, version: plugin.version, iconBase64: base64, cachedAt: Date.now() });
    }
  } catch {
    // 远程 icon 拉取失败：保持占位符即可
  } finally {
    setPluginIconLoading(key, false);
  }
};

const prefetchRemoteIconsForSource = async (sourceId: string) => {
  const arr = getStorePlugins(sourceId) || [];
  const installedIds = new Set(installedPlugins.value.map((p) => p.id));
  // 控制规模：只预取前 24 个缺失 iconUrl 的条目，避免刷新时并发过多；已安装同 id 者跳过
  const targets = arr
    .filter((p) => {
      if (installedIds.has(p.id)) return false;
      const pv = typeof p.packageVersion === 'number' ? p.packageVersion : 1;
      return pv >= 2 && !p.iconUrl && !!p.downloadUrl;
    })
    .slice(0, 24);
  // 有限并发：最多同时拉 10 个，避免请求风暴但也不会”一个接一个”太慢
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
        version: cur.version,
      });
    }
  });
  await Promise.all(workers);
};

const restoreIconsFromCache = async (sourceId: string) => {
  if (!IS_WEB) return;
  const arr = getStorePlugins(sourceId);
  if (!arr.length) return;
  const installedIds = new Set(installedPlugins.value.map((p) => p.id));
  const updates: Record<string, string> = {};
  await Promise.all(
    arr
      .filter((p) => !p.iconUrl && !installedIds.has(p.id))
      .map(async (p) => {
        const key = storeIconKey(sourceId, p.id);
        if (pluginIcons.value[key]) return;
        const cached = await storePluginCacheDb.icons.get(key);
        if (cached && cached.version === p.version) {
          updates[key] = `data:image/png;base64,${cached.iconBase64}`;
        }
      }),
  );
  if (Object.keys(updates).length) {
    pluginIcons.value = { ...pluginIcons.value, ...updates };
  }
};

const refreshPluginIcons = async () => {
  // 已安装插件的图标已内嵌在 Plugin.iconPngBase64 中，无需单独加载
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
  editSourceDialog.open();
};

/** 「添加源」是 action 项：KbTab 不会把它设为选中，只回调这里开弹窗 */
const handleTabSelect = (name: string) => {
  if (name === ADD_SOURCE_TAB) addSource();
};

const handleDeleteSourceById = (name: string) => {
  const sourceId = name.slice("store:".length);
  const source = sources.value.find((s) => s.id === sourceId);
  if (source) void handleDeleteSource(source);
};

const editSource = (idx: number) => {
  const s = sources.value[idx];
  if (!s) return;

  editingSourceIndex.value = idx;
  editSourceForm.id = s.id;
  editSourceForm.name = pluginSourceDisplayName(s);
  editSourceForm.indexUrl = s.indexUrl;
  editSourceDialog.open();
};

const confirmEditSource = async () => {
  if (await guardDesktopOnly("addPluginSource")) return;
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
    editSourceDialog.close();
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

    // 新格式：先从 Dexie 还原图标缓存，再按需发起远程拉取（均不阻塞 UI）
    void restoreIconsFromCache(sourceId);
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
      void restoreIconsFromCache(sourceId);
      void prefetchRemoteIconsForSource(sourceId);
    } catch {
      /* 静默 */
    } finally {
      storeRevalidateInflight.delete(sourceId);
    }
  })();
};

const selectPluginFile = async () => {
  if (await guardDesktopOnly("picker")) return;
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
  if (await guardDesktopOnly("picker")) return;
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
    importDialog.close();
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

/** 详情弹窗当前定位到的插件（null = 未打开）。安装/更新/卸载均在弹窗内完成，网格不再放操作按钮。 */
const detailDialogVisible = ref(false);
const detailDialogTarget = ref<PluginDetailDialogTarget | null>(null);

const openDetailDialog = (plugin: PluginListItem) => {
  trackPluginBrowserEvent("plugin_browser_plugin_open", pluginAnalyticsItem(plugin));
  if ("downloadUrl" in plugin && plugin.downloadUrl) {
    const store = plugin as StorePluginResolved;
    // 已安装且与商店版本一致：走本地已安装详情与文档，不拉远程包
    if (store.installedVersion && store.installedVersion === store.version) {
      detailDialogTarget.value = { pluginId: store.id, mode: "local" };
    } else {
      detailDialogTarget.value = {
        pluginId: store.id,
        mode: "remote",
        sourceId: store.sourceId,
        version: store.version,
      };
    }
  } else {
    detailDialogTarget.value = { pluginId: plugin.id, mode: "local" };
  }
  detailDialogVisible.value = true;
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
        // 下载进度事件现由 PluginDetailDialog.vue 自行订阅（安装/更新都在弹窗内完成）
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
watch(activeTab, async (tab, prevTab) => {
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

  if (prevTab && prevTab !== tab) {
    trackPluginBrowserEvent("plugin_browser_source_switch", sourceAnalyticsItem(sourceId));
  }

  // 首次进入该源：优先本地缓存；之后每次切回该 tab 也会触发后台按时间静默重拉（见 revalidateStorePluginsInBackground）
  if (!storeLoadedBySource.value[sourceId]) {
    await loadStorePlugins(sourceId, { showMessage: false, forceRefresh: false });
    await refreshPluginIcons();
  }
  trackPluginBrowserEvent("plugin_browser_store_plugins_view", {
    ...sourceAnalyticsItem(sourceId),
    count: getStorePlugins(sourceId).length,
    loaded: !!storeLoadedBySource.value[sourceId],
  });
  revalidateStorePluginsInBackground(sourceId);
});

onUnmounted(() => {
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

  /* 卡片本身（图标+名称+版本）的样式在 PluginGridCard.vue 里；这里只管网格布局 */
  .plugin-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
    gap: 12px;
  }

  /* 紧凑端：2 列 */
  .plugin-grid-android {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
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

/* 卡片自身样式（图标/名称/版本/更新角标）在 PluginGridCard.vue 的 scoped style 里 */

/* 胶囊 tab 组（KbTab，样式自带）与搜索框同排 */
.plugin-tabs-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 20px;
  margin-bottom: 18px;
}

.plugin-search {
  margin-left: auto;
  width: 230px;
  flex: none;

  .el-input__wrapper {
    border-radius: 10px;
  }
}

/* 窄屏没有横向余量：搜索框换到 tab 组下方独占一行 */
@media (max-width: 900px) {
  .plugin-tabs-row {
    flex-wrap: wrap;
  }

  .plugin-search {
    margin-left: 0;
    width: 100%;
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

/* 紧凑端长按快捷预览：底部抽屉，面板铺满宽度、贴底圆角 */
.quick-preview-drawer .el-drawer__body {
  padding: 0;
  display: flex;
  justify-content: center;
}

.quick-preview-drawer-panel {
  width: 100% !important;
  max-width: 420px;
  border-radius: 18px 18px 0 0 !important;
  box-shadow: none !important;
  border: none !important;
}
</style>
