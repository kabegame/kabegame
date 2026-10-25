<template>
  <DragFileZone
    class="plugin-browser-container"
    v-pull-to-refresh="pullToRefreshOpts"
    :plan="planDrop"
    :on-drop="onDropFiles"
  >
    <div class="plugin-browser-content">
      <PluginBrowserPageHeader
        @refresh="handleRefresh"
        @import-source="handleImportSource"
        @manage-sources="openManageSources"
      />

      <div v-if="sourcesLoaded && sources.length === 0" class="plugin-sources-empty-hint">
        <el-alert type="info" :closable="false" show-icon>
          <template #title>
            {{ $t("plugins.noStoreSourcesHint") }}
          </template>
          <el-button type="primary" size="small" style="margin-top: 8px" @click="goToOfficialGitHubStoreTab">
            {{ $t("plugins.goToOfficialGitHubStore") }}
          </el-button>
        </el-alert>
      </div>

      <!-- Tab 切换：分段式胶囊组，右侧搜索框与其同排 -->
      <div class="plugin-tabs-row">
        <KbTab
          v-model="activeTab"
          :items="tabItems"
          :close-title="$t('plugins.delete')"
          @close="handleDeleteSourceById"
          @select="handleTabSelect"
        />

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
                {{ $t("plugins.goToOfficialGitHubStore") }}
              </el-button>
            </el-empty>
          </div>

          <div v-else-if="filteredInstalledPlugins.length === 0" class="empty">
            <el-empty :description="$t('plugins.quickPreview.noSearchResult')" :image-size="100" />
          </div>

          <!-- 已安装：布局与商店一致 -->
          <div v-else>
            <transition-group
              name="fade-in-list"
              tag="div"
              class="plugin-grid"
              :class="{ 'plugin-grid-android': uiStore.isCompact }"
            >
              <HoverRevealPanel
                v-for="plugin in filteredInstalledPlugins"
                :key="plugin.id"
                trigger="contextmenu"
                @panel-click="openDetailDialog(plugin)"
              >
                <PluginGridCard
                  :card-class="appBackgroundCardClass"
                  :name="pluginName(plugin)"
                  :version="plugin.version"
                  :icon-src="getPluginIconSrc(plugin)"
                  :icon-loading="isIconLoading(plugin)"
                  @click="openDetailDialog(plugin)"
                />
                <template #panel>
                  <PluginQuickPreviewPanel v-bind="quickPreviewProps(plugin)" />
                </template>
              </HoverRevealPanel>
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
                      style="
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        width: 100%;
                        height: 100%;
                        min-height: 0;
                        gap: 0;
                        box-sizing: border-box;
                      "
                    >
                      <div
                        style="
                          flex: 0 0 40%;
                          min-height: 0;
                          width: 100%;
                          display: flex;
                          align-items: center;
                          justify-content: center;
                        "
                      >
                        <el-skeleton-item
                          variant="image"
                          style="width: 48px; height: 48px; border-radius: 8px; flex-shrink: 0"
                        />
                      </div>
                      <el-skeleton-item
                        variant="h3"
                        style="width: 92%; height: 15px; margin: 2px 0 0; flex-shrink: 0"
                      />
                      <div
                        style="
                          flex: 0 0 auto;
                          width: 100%;
                          height: 14px;
                          display: flex;
                          flex-flow: row nowrap;
                          gap: 3px;
                          align-items: center;
                          overflow: hidden;
                        "
                      >
                        <el-skeleton-item variant="text" style="width: 28%; height: 12px; margin: 0; flex-shrink: 0" />
                        <el-skeleton-item variant="text" style="width: 32%; height: 12px; margin: 0; flex-shrink: 0" />
                        <el-skeleton-item variant="text" style="width: 24%; height: 12px; margin: 0; flex-shrink: 0" />
                      </div>
                      <div style="flex: 1 1 auto; min-height: 0; width: 100%" />
                      <el-skeleton-item variant="button" style="width: 100%; height: 26px; margin: 0; flex-shrink: 0" />
                    </div>
                  </template>
                </el-skeleton>
              </div>
            </div>
            <div v-else class="skeleton-grid">
              <div v-for="i in 12" :key="i" class="skeleton-card">
                <el-skeleton :rows="0" animated>
                  <template #template>
                    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
                      <el-skeleton-item variant="image" style="width: 48px; height: 48px; border-radius: 8px" />
                      <div style="flex: 1">
                        <el-skeleton-item variant="h3" style="width: 60%; margin-bottom: 8px" />
                        <el-skeleton-item variant="text" style="width: 80%" />
                      </div>
                    </div>
                    <el-skeleton-item variant="text" style="width: 40%; margin-bottom: 12px" />
                    <el-skeleton-item variant="button" style="width: 100%" />
                  </template>
                </el-skeleton>
              </div>
            </div>
          </div>

          <!-- 尚未拉取过该源：保持空白，等加载态/骨架屏接管，避免先闪「源为空」 -->
          <div v-else-if="!settledBySource[s.id]" />

          <div v-else-if="getStorePlugins(s.id).length === 0" class="empty">
            <el-empty :description="$t('plugins.noPluginsInSource', { name: pluginSourceDisplayName(s) })" />
          </div>

          <div v-else-if="filteredStorePlugins(s.id).length === 0" class="empty">
            <el-empty :description="$t('plugins.quickPreview.noSearchResult')" :image-size="100" />
          </div>

          <transition-group
            v-else
            name="fade-in-list"
            tag="div"
            class="plugin-grid"
            :class="{ 'plugin-grid-android': uiStore.isCompact }"
          >
            <HoverRevealPanel
              v-for="plugin in filteredStorePlugins(s.id)"
              :key="plugin.id"
              trigger="contextmenu"
              @panel-click="openDetailDialog(plugin)"
            >
              <PluginGridCard
                :card-class="appBackgroundCardClass"
                :name="pluginName(plugin)"
                :version="plugin.version"
                :icon-src="getPluginIconSrc(plugin)"
                :icon-loading="isIconLoading(plugin)"
                :update-available="isStoreUpdateAvailable(plugin)"
                @click="openDetailDialog(plugin)"
              />
              <template #panel>
                <PluginQuickPreviewPanel v-bind="quickPreviewProps(plugin)" />
              </template>
            </HoverRevealPanel>
          </transition-group>
        </div>
      </div>
    </div>

    <!-- 商店源管理 -->
    <el-dialog
      v-if="!IS_LIGHT_MODE"
      :model-value="sourcesDialog.isOpen.value"
      :z-index="sourcesDialog.zIndex.value"
      :title="$t('plugins.sourcesDialogTitle')"
      width="720px"
      @update:model-value="sourcesDialog.close"
    >
      <div class="sources-hint">
        {{ $t("plugins.sourcesIntro") }}
      </div>
      <el-table :data="sources" style="width: 100%" :empty-text="$t('plugins.noSources')">
        <!-- @vue-generic {PluginSource} -->
        <el-table-column :label="$t('plugins.name')" width="180">
          <template #default="{ row }">
            {{ pluginSourceDisplayName(row) }}
          </template>
        </el-table-column>
        <el-table-column prop="indexUrl" :label="$t('plugins.indexUrl')" show-overflow-tooltip />
        <!-- @vue-generic {PluginSource} -->
        <el-table-column :label="$t('plugins.action')" width="140">
          <template #default="{ row, $index }">
            <el-button size="small" @click="editSource($index)">{{ $t("plugins.edit") }}</el-button>
            <el-button
              v-if="row.id !== OFFICIAL_PLUGIN_SOURCE_ID"
              size="small"
              type="danger"
              @click="removeSource($index)"
            >
              {{ $t("plugins.delete") }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="sourcesDialog.close()">{{ $t("common.close") }}</el-button>
        <el-button @click="addSource">{{ $t("plugins.newSource") }}</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑源 -->
    <el-dialog
      v-if="!IS_LIGHT_MODE"
      :model-value="editSourceDialog.isOpen.value"
      :z-index="editSourceDialog.zIndex.value"
      :title="editingSourceIndex === null ? $t('plugins.newSource') : $t('plugins.editSource')"
      width="620px"
      @update:model-value="editSourceDialog.close"
    >
      <el-form label-width="110px">
        <el-form-item label="ID">
          <el-input v-model="editSourceForm.id" :placeholder="$t('plugins.idPlaceholder')" />
        </el-form-item>
        <el-form-item :label="$t('plugins.name')">
          <el-input v-model="editSourceForm.name" :placeholder="$t('plugins.namePlaceholder')" />
        </el-form-item>
        <el-form-item label="index.json">
          <el-input
            v-model="editSourceForm.indexUrl"
            placeholder="https://.../index.json"
            :disabled="editSourceForm.id === OFFICIAL_PLUGIN_SOURCE_ID"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editSourceDialog.close()">{{ $t("common.cancel") }}</el-button>
        <el-button
          type="primary"
          :loading="isValidatingSource"
          :disabled="isValidatingSource"
          @click="confirmEditSource"
        >
          {{ $t("common.confirm") }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 导入源对话框 -->
    <el-dialog
      :model-value="importDialog.isOpen.value"
      :z-index="importDialog.zIndex.value"
      :title="$t('plugins.importDialogTitle')"
      width="500px"
      @update:model-value="importDialog.close"
    >
      <div class="import-instructions">
        <p>{{ $t("plugins.selectFileHint") }}</p>
        <el-button type="primary" @click="selectPluginFile">
          <el-icon>
            <Upload />
          </el-icon>
          {{ $t("plugins.selectFile") }}
        </el-button>
        <p v-if="selectedFilePath" class="selected-file">{{ $t("plugins.selected") }} {{ selectedFilePath }}</p>
      </div>
      <template #footer>
        <el-button @click="importDialog.close()">{{ $t("common.cancel") }}</el-button>
        <el-button type="primary" @click="handleImport" :disabled="!selectedFilePath">
          {{ $t("plugins.importButton") }}
        </el-button>
      </template>
    </el-dialog>
  </DragFileZone>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { ElMessageBox } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { Refresh, Upload, Plus, Search, Setting, QuestionFilled } from "@kabegame/element-plus-icons";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import {
  usePluginMarketStore,
  isStoreUpdateAvailable,
  storeIconKey,
  OFFICIAL_PLUGIN_SOURCE_ID,
  OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME,
  type PluginSource,
  type StorePluginResolved,
} from "@/stores/pluginMarket";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { open } from "@tauri-apps/plugin-dialog";
import { pickKgpgFile } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import PluginBrowserPageHeader from "@/components/header/PluginBrowserPageHeader.vue";
import { KbTab, type KbTabItem } from "@kabegame/element-plus";
import PluginGridCard from "@/components/plugin/PluginGridCard.vue";
import PluginQuickPreviewPanel, { type QuickPreviewPluginLike } from "@/components/plugin/PluginQuickPreviewPanel.vue";
import HoverRevealPanel from "@/components/common/HoverRevealPanel.vue";
import { bannerPreviewImages } from "@/utils/assetPath";
import { IS_LIGHT_MODE, IS_ANDROID, IS_WEB } from "@/env";
import { useModal } from "@/composables/useModal";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";
import { trackEvent } from "@/track/umami";
import type { DragFileItem, DragFilePlan } from "@/utils/dragFileZones";
import DragFileZone from "@/components/common/DragFileZone.vue";

/** 已安装插件或商店插件，用于列表卡片、详情跳转等统一入参 */
type PluginListItem = Plugin | StorePluginResolved;

const pluginStore = usePluginStore();
const market = usePluginMarketStore();
const { sources, sourcesLoaded, loadingBySource, loadedBySource, settledBySource } = storeToRefs(market);
const { t } = useI18n();
const { pluginName } = usePluginManifestI18n();

const uiStore = useUiStore();
const settingsStore = useSettingsStore();
const appBackgroundCardClass = computed(() =>
  settingsStore.values.appBackgroundEnabled ? "!bg-transparent [--el-card-bg-color:transparent]" : "",
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

const pluginSourceDisplayName = (s: PluginSource) => {
  if (s.id === OFFICIAL_PLUGIN_SOURCE_ID && s.name === OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME) {
    return t("plugins.officialGithubReleaseSourceName");
  }
  return s.name;
};

const pullToRefreshOpts = computed(() =>
  IS_ANDROID ? { onRefresh: handleRefresh, refreshing: isRefreshing.value } : undefined,
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

const route = useRoute();
const router = useRouter();
const importDialog = useModal();
const selectedFilePath = ref<string | null>(null);
const isRefreshing = ref(false);
/** 「已安装」tab 手动刷新中（商店源的加载态由 market store 持有） */
const installedRefreshing = ref(false);

/** 当前 tab 走 URL query（`?tab=store:<sourceId>`），从详情页返回时随 history 恢复 */
const { settingValue: tabSetting, set: setTabSetting } = useSettingKeyState("pluginBrowserTab");
/** settings 层只做哑同步：离开本页后 query 会被别的页面解码，这里只在本页激活时读写 */
const isOnPage = () => route.name === "PluginBrowser";
const activeTab = computed<string>({
  get: () => tabSetting.value || "installed",
  set: (tab) => {
    if (!isOnPage()) return;
    void setTabSetting(tab);
  },
});

// 骨架屏：加载超过 300ms 才显示，避免快速加载时闪屏
const showSkeletonBySource = ref<Record<string, boolean>>({});
const skeletonTimersBySource: Record<string, ReturnType<typeof setTimeout>> = {};
watch(
  (): Record<string, boolean> => ({ ...loadingBySource.value, installed: installedRefreshing.value }),
  (loadingMap) => {
    // 加载结束时 store 会删掉 key 而不是置 false：待触发的定时器也要纳入，否则会漏清并在之后把骨架屏永久打开
    const keys = new Set([
      ...Object.keys(loadingMap),
      ...Object.keys(showSkeletonBySource.value),
      ...Object.keys(skeletonTimersBySource),
    ]);
    for (const key of keys) {
      if (loadingMap[key]) {
        if (skeletonTimersBySource[key] || showSkeletonBySource.value[key]) continue;
        skeletonTimersBySource[key] = setTimeout(() => {
          delete skeletonTimersBySource[key];
          showSkeletonBySource.value = { ...showSkeletonBySource.value, [key]: true };
        }, 300);
      } else {
        clearTimeout(skeletonTimersBySource[key]);
        delete skeletonTimersBySource[key];
        if (showSkeletonBySource.value[key]) {
          const next = { ...showSkeletonBySource.value };
          delete next[key];
          showSkeletonBySource.value = next;
        }
      }
    }
  },
  { immediate: true },
);

const storeSourcesToRender = computed(() => sources.value);
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
    count: loadedBySource.value[s.id] ? getStorePlugins(s.id).length : null,
    // 可更新数挂在商店源 tab 上：只有商店详情能执行更新，已安装 tab 不提示
    badge: getStorePlugins(s.id).filter(isStoreUpdateAvailable).length,
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

const getStorePlugins = (sourceId: string) => market.storePlugins(sourceId);

// ---- 搜索：只过滤网格展示，不影响 tab 计数与 installedVersion 合并等既有逻辑 ----
const searchKeyword = ref("");

const matchesSearch = (p: PluginListItem): boolean => {
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return true;
  const haystack = [p.id, pluginName(p), "baseUrl" in p ? p.baseUrl : null].filter(Boolean).join(" ").toLowerCase();
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

// 插件图标：
// - 本地已安装：key = local:<pluginId>，直接读 Plugin.iconPngBase64
// - 商店源：key = store:<sourceId>:<pluginId>，由 market store 远程拉取并缓存
//
// 关键：商店 tab 绝不能”命中”本地 icon，即使 id 一样；因此必须用不同 key 做隔离。
const getIconKey = (p: PluginListItem) => {
  // StorePluginResolved 一定有 sourceId；本地 Plugin 没有该字段
  const sid = "sourceId" in p && typeof p.sourceId === "string" ? p.sourceId : null;
  return sid ? storeIconKey(sid, p.id) : `local:${p.id}`;
};
const isIconLoading = (p: PluginListItem) => !!market.pluginIconLoading[getIconKey(p)];

const getPluginIconSrc = (p: PluginListItem) => {
  const isStore = "sourceId" in p && typeof p.sourceId === "string";
  if (isStore) {
    const store = p as StorePluginResolved;
    if (store.iconUrl) return store.iconUrl;
    // 商店插件 id 与已安装插件一致时，直接复用已安装图标
    if (installedPlugins.value.some((x) => x.id === p.id)) {
      return pluginStore.pluginIconSrc(p.id) || null;
    }
    return market.pluginIcons[getIconKey(p)] || null;
  }

  // 已安装：图标已在 Plugin.iconPngBase64 中，直接从 store 读取
  return pluginStore.pluginIconSrc(p.id) || null;
};

// ---- 右键快捷预览（走马灯示例图仅取已安装插件的 assets，内存直读零成本；
//      商店未安装条目若拉取示例图需要 get_plugin_detail 现下整包 .kgpg，
//      预览这种轻量交互不适合触发这种下载，故只做 best-effort：
//      版本与已安装一致时复用本地已装包，否则不展示 banner 区）----

/** 预览目标对应的"已安装 Plugin"：本身就是已安装插件，或商店条目版本与本地一致（同一份内容，复用零成本） */
const quickPreviewInstalledMatch = (item: PluginListItem): Plugin | null => {
  if (!("sourceId" in item)) return item as Plugin;
  const store = item as StorePluginResolved;
  if (store.installedVersion && store.installedVersion === store.version) {
    return installedPlugins.value.find((p) => p.id === store.id) ?? null;
  }
  return null;
};

/** 只有商店条目提示新版本：已安装条目点开的是本地详情，那里不能更新 */
const quickPreviewUpdateVersion = (item: PluginListItem): string | null => {
  if (!("sourceId" in item)) return null;
  const store = item as StorePluginResolved;
  return isStoreUpdateAvailable(store) ? store.version : null;
};

/** 面板 props 现算不缓存：面板只在真正弹出的那一张卡片上渲染，算一次的成本可以忽略 */
const quickPreviewProps = (item: PluginListItem) => {
  const installed = quickPreviewInstalledMatch(item);
  return {
    plugin: item as QuickPreviewPluginLike,
    iconSrc: getPluginIconSrc(item),
    images: bannerPreviewImages(installed),
    updateAvailableVersion: quickPreviewUpdateVersion(item),
  };
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/** Tauri invoke 可能返回字符串或 Error 对象 */
const errorMessageOf = (e: unknown, fallback: string): string => {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || e.toString();
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return fallback;
};

const formatBytes = (bytes: number) => {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 100) / 100} MB`;
};

const goToOfficialGitHubStoreTab = async () => {
  const r = await market.loadSources();
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
    const skipValidate = editSourceForm.id === OFFICIAL_PLUGIN_SOURCE_ID && editingSourceIndex.value !== null;
    if (!skipValidate) {
      await invoke("validate_plugin_source", { indexUrl });
    }
  } catch (e) {
    const msg = errorMessageOf(e, "源验证失败");

    try {
      await ElMessageBox.confirm(
        t("plugins.sourceValidateFailedStillAdd", { msg }),
        t("plugins.sourceValidateFailed"),
        {
          type: "warning",
          confirmButtonText: t("plugins.stillAdd"),
          cancelButtonText: t("plugins.backToEdit"),
          distinguishCancelAndClose: true,
        },
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
      (editingSourceIndex.value !== null && sources.value[editingSourceIndex.value]?.id === OFFICIAL_PLUGIN_SOURCE_ID);
    if (isOfficial) {
      const localizedDefault = t("plugins.officialGithubReleaseSourceName");
      if (name === localizedDefault || name === OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME) {
        name = OFFICIAL_PLUGIN_SOURCE_DEFAULT_DB_NAME;
      }
    }

    if (editingSourceIndex.value === null) {
      // 添加新源
      await invoke<PluginSource>("add_plugin_source", { id, name, indexUrl });
    } else {
      // 编辑现有源
      const originalId = sources.value[editingSourceIndex.value].id;
      await invoke("update_plugin_source", { id: originalId, name, indexUrl });
    }

    // 自身写操作直接刷新源列表（不依赖 plugin-sources-changed 回刷）
    await market.loadSources();
    ElMessage.success(editingSourceIndex.value === null ? t("plugins.sourceAdded") : t("plugins.sourceUpdated"));
    editSourceDialog.close();
  } catch (e) {
    console.error("保存商店源失败:", e);
    ElMessage.error(errorMessageOf(e, t("plugins.saveSourceFailed")));
  }
};

/** 源管理弹窗里的删除：与 tab 关闭按钮走同一条真正删除后端记录的路径 */
const removeSource = (idx: number) => {
  const source = sources.value[idx];
  if (source) void handleDeleteSource(source);
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
      { type: "warning" },
    );

    // 调用后端删除；源列表刷新时 store 会清掉该源的缓存，当前 tab 由 watch(sources) 切回「已安装」
    await invoke("delete_plugin_source", { id: source.id });
    await market.loadSources();

    ElMessage.success(t("plugins.sourceDeleted"));
  } catch (e) {
    if (e !== "cancel") {
      console.error("删除商店源失败:", e);
      ElMessage.error(t("plugins.deleteSourceFailed"));
    }
  }
};

/** 拉取某个源的商店列表并提示结果；数据与加载态都由 market store 持有 */
const loadStoreList = async (sourceId: string, options: { showMessage?: boolean; forceRefresh?: boolean } = {}) => {
  const { showMessage = false, forceRefresh = false } = options;
  try {
    if (forceRefresh) await market.loadStorePlugins(sourceId, { forceRefresh: true });
    else await market.ensureStorePlugins(sourceId);
    if (showMessage) {
      ElMessage.success(forceRefresh ? t("plugins.storeListRefreshed") : t("plugins.storeListLoaded"));
    }
  } catch (error) {
    console.error("加载商店失败:", error);
    ElMessage.error(errorMessageOf(error, t("plugins.loadStoreFailed")));
  }
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
    const fileExt = filePath.split(".").pop()?.toLowerCase();

    if (fileExt === "kgpg") {
      const parsed = await invoke<Plugin>("preview_import_plugin", { zipPath: filePath });

      const existing = pluginStore.plugins.find((p) => p.id === parsed.id);
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
    // plugin-added / plugin-changed 事件更新已安装列表；商店卡片的 installedVersion 由 market store 现算
  } catch (error) {
    console.error("导入源失败:", error);
    ElMessage.error(error instanceof Error ? error.message : t("plugins.importFailed"));
  }
};

// ---------- 区域级文件拖入（只收 .kgpg 插件包）----------
const planDrop = (items: DragFileItem[]): DragFilePlan | null => {
  const plugins = items.filter((i) => i.isKgpg);
  if (plugins.length === 0) return null;
  return {
    label: t("import.dropZone.plugins", { count: plugins.length }),
    media: [],
    folders: [],
    plugins,
  };
};

const onDropFiles = async (plan: DragFilePlan) => {
  let successCount = 0;
  for (const plugin of plan.plugins) {
    try {
      await invoke("import_plugin_from_zip", { zipPath: plugin.path });
      successCount++;
    } catch (error) {
      console.error("[PluginBrowser] 导入插件失败:", plugin.path, error);
      ElMessage.error(t("import.importPluginFailed"));
    }
  }
  if (successCount > 0) {
    ElMessage.success(t("import.importedPluginsCount", { count: successCount }));
    // plugin-added / plugin-changed 事件会自动更新已安装列表；商店卡片的 installedVersion 由 market store 现算
    await pluginStore.refreshPlugins();
  }
};

const openDetailDialog = (plugin: PluginListItem) => {
  trackPluginBrowserEvent("plugin_browser_plugin_open", pluginAnalyticsItem(plugin));
  // 详情信息量大，走独立页面 /plugins/:pluginId（远程条目把定位信息放 query）
  if ("downloadUrl" in plugin && plugin.downloadUrl) {
    const store = plugin as StorePluginResolved;
    // 已安装且与商店版本一致：走本地已安装详情与文档，不拉远程包
    if (store.installedVersion && store.installedVersion === store.version) {
      void router.push({ name: "PluginDetail", params: { pluginId: store.id } });
    } else {
      void router.push({
        name: "PluginDetail",
        params: { pluginId: store.id },
        query: { mode: "remote", source: store.sourceId, version: store.version },
      });
    }
  } else {
    void router.push({ name: "PluginDetail", params: { pluginId: plugin.id } });
  }
};

// 统一的刷新处理，根据当前 tab 执行不同逻辑
const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    if (activeTab.value === "installed") {
      installedRefreshing.value = true;
      try {
        // 触发后端全量刷新缓存（避免 get_plugins 只返回内存缓存导致”刷新无效”）
        await pluginStore.refreshPlugins();
        ElMessage.success(t("plugins.installedRefreshSuccess"));
      } catch (error) {
        console.error("刷新已安装源失败:", error);
        ElMessage.error(errorMessageOf(error, t("plugins.installedRefreshFailed")));
      } finally {
        installedRefreshing.value = false;
      }
    } else if (isStoreTab(activeTab.value)) {
      // 商店 tab：只刷新当前源
      const sourceId = activeStoreSourceId.value;
      if (!sourceId) return;

      // 刷新源列表（本地），若当前源不见了则切回已安装源
      const sourcesResult = await market.loadSources();
      if (!sourcesResult.success && sourcesResult.error) {
        ElMessage.error(sourcesResult.error);
      }
      if (!sources.value.some((s) => s.id === sourceId)) {
        ElMessage.warning(t("plugins.storeSourceGoneSwitchToInstalled"));
        activeTab.value = "installed";
        return;
      }

      // 用户点击刷新按钮：强制从远程刷新（忽略本地缓存）
      await loadStoreList(sourceId, { showMessage: true, forceRefresh: true });
    }
  } finally {
    isRefreshing.value = false;
  }
};

onMounted(() => {
  // 已安装列表由 pluginStore 维护；这里只确保商店源配置已加载（已加载过则直接复用 store）
  void market.ensureSources();
});

// 商店 tab 懒加载：首次进入某个源才拉列表（store 里已有则直接复用），之后每次进入都做一次后台按时间静默重拉。
// immediate：从详情页返回 / 直接打开带 ?tab= 的链接时，挂载即按 URL 恢复。
watch(
  activeTab,
  async (tab, prevTab) => {
    if (!isOnPage() || !isStoreTab(tab)) return;
    const sourceId = tab.slice("store:".length);
    if (!sourceId) return;

    await market.ensureSources();
    if (activeTab.value !== tab) return;

    // 如果该源不存在，直接回到已安装源
    if (!sources.value.some((s) => s.id === sourceId)) {
      activeTab.value = "installed";
      return;
    }

    if (prevTab && prevTab !== tab) {
      trackPluginBrowserEvent("plugin_browser_source_switch", sourceAnalyticsItem(sourceId));
    }

    await loadStoreList(sourceId);
    trackPluginBrowserEvent("plugin_browser_store_plugins_view", {
      ...sourceAnalyticsItem(sourceId),
      count: getStorePlugins(sourceId).length,
      loaded: !!loadedBySource.value[sourceId],
    });
    void market.revalidateInBackground(sourceId).then((changed) => {
      if (changed) ElMessage.success(t("plugins.storeListAutoUpdated"));
    });
  },
  { immediate: true },
);

// 当前商店 tab 的源消失（本页删除，或 plugin-sources-changed 事件刷新）时回到「已安装」
watch(sources, (list) => {
  const sourceId = activeStoreSourceId.value;
  if (sourceId && sourcesLoaded.value && !list.some((s) => s.id === sourceId)) {
    activeTab.value = "installed";
  }
});

onUnmounted(() => {
  for (const timer of Object.values(skeletonTimersBySource)) clearTimeout(timer);
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
}

/* 列表淡入动画 */
.fade-in-list-enter-active {
  transition:
    transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.26s ease-out,
    filter 0.26s ease-out;
}

.fade-in-list-leave-active {
  transition:
    transform 0.22s ease-in,
    opacity 0.22s ease-in,
    filter 0.22s ease-in;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
