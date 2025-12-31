<template>
  <div class="plugin-browser-container">
    <!-- 顶部工具栏 -->
    <PageHeader title="源管理">
      <el-button v-if="!isLocalMode" @click="handleRefresh" :loading="isRefreshing">
        <el-icon>
          <Refresh />
        </el-icon>
        刷新
      </el-button>
      <el-button type="primary" @click="showImportDialog = true">
        <el-icon>
          <Upload />
        </el-icon>
        导入源
      </el-button>
      <el-button @click="openQuickSettings" circle>
        <el-icon>
          <Setting />
        </el-icon>
      </el-button>
    </PageHeader>

    <!-- Tab 切换 -->
    <StyledTabs v-model="activeTab" :before-leave="beforeLeaveTab">
      <el-tab-pane label="已安装源" name="installed">
        <!-- 已安装插件配置表格 -->
        <div v-if="showSkeletonBySource['installed'] && activeTab === 'installed'" class="loading-skeleton">
          <el-skeleton :rows="8" animated />
        </div>
        <div v-else-if="installedPlugins.length === 0" class="empty">
          <el-empty description="暂无已安装源" />
        </div>

        <!-- 已安装：布局与商店一致 -->
        <div v-else>
          <transition-group name="fade-in-list" tag="div" class="plugin-grid">
            <el-card v-for="plugin in installedPlugins" :key="plugin.id" class="plugin-card" shadow="hover"
              @click="viewPluginDetails(plugin)">
              <div class="plugin-header">
                <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                  <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
                </div>
                <div v-else class="plugin-icon-placeholder">
                  <el-icon>
                    <Grid />
                  </el-icon>
                </div>
                <div class="plugin-title">
                  <h3>{{ plugin.name }}</h3>
                  <p class="plugin-desp">{{ plugin.description || "无描述" }}</p>
                </div>
              </div>

              <div class="plugin-info">
                <el-tag type="success" size="small">已安装</el-tag>
              </div>

              <div class="plugin-footer">
                <el-switch v-model="plugin.enabled" @change="handleTogglePlugin(plugin)" @click.stop />
                <el-button type="danger" size="small" v-if="!(isLocalMode && plugin.builtIn)"
                  @click.stop="handleDelete(plugin)">
                  卸载
                </el-button>
              </div>
            </el-card>
          </transition-group>
        </div>
      </el-tab-pane>
      <!-- 商店源：按"源名称"动态生成 tab；每个 tab 只显示该源的数据 -->
      <el-tab-pane v-for="s in storeSourcesToRender" :key="s.id" :label="s.name" :name="storeTabName(s.id)">
        <!-- 搜索（暂不实现：先保留 UI） -->
        <!-- <div class="filter-bar">
          <el-input v-model="searchQuery" placeholder="搜索（开发中）" clearable disabled style="width: 300px;">
            <template #prefix>
              <el-icon>
                <Search />
              </el-icon>
            </template>
</el-input>
</div> -->

        <!-- 插件列表（300ms 延迟显示骨架屏，避免快速刷新时闪屏） -->
        <div v-if="showSkeletonBySource[s.id]" class="loading-skeleton">
          <div class="skeleton-grid">
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
          <el-empty :description="`该商店源暂无插件：${s.name}`" />
        </div>

        <transition-group v-else name="fade-in-list" tag="div" class="plugin-grid">
          <el-card v-for="plugin in getStorePlugins(s.id)" :key="plugin.id" class="plugin-card" shadow="hover"
            @click="viewPluginDetails(plugin)">
            <div class="plugin-header">
              <div v-if="getPluginIconSrc(plugin)" class="plugin-icon">
                <el-image :src="getPluginIconSrc(plugin) || ''" fit="contain" />
              </div>
              <div v-else class="plugin-icon-placeholder">
                <el-icon>
                  <Grid />
                </el-icon>
              </div>
              <div class="plugin-title">
                <h3>{{ plugin.name }}</h3>
                <p class="plugin-desp">{{ plugin.description || "无描述" }}</p>
              </div>
            </div>

            <div class="plugin-info">
              <el-tag type="info" size="small">v{{ plugin.version }}</el-tag>
              <el-tag v-if="plugin.installedVersion" type="success" size="small">已安装：v{{ plugin.installedVersion
              }}</el-tag>
              <el-tag v-else type="warning" size="small">未安装</el-tag>
              <el-tag v-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="danger"
                size="small">可更新</el-tag>
              <el-tag type="info" size="small">{{ formatBytes(plugin.sizeBytes) }}</el-tag>
            </div>

            <div class="plugin-footer">
              <el-button v-if="!plugin.installedVersion" type="primary" size="small" :loading="isInstalling(plugin.id)"
                :disabled="isInstalling(plugin.id)" @click.stop="handleStoreInstall(plugin)">
                {{ isInstalling(plugin.id) ? "安装中..." : "安装" }}
              </el-button>
              <el-button v-else-if="isUpdateAvailable(plugin.installedVersion, plugin.version)" type="warning"
                size="small" :loading="isInstalling(plugin.id)" :disabled="isInstalling(plugin.id)"
                @click.stop="handleStoreInstall(plugin)">
                {{ isInstalling(plugin.id) ? "更新中..." : "更新" }}
              </el-button>
              <el-button v-else size="small" disabled>
                已安装
              </el-button>
            </div>
          </el-card>
        </transition-group>
      </el-tab-pane>

      <!-- 添加源 tab -->
      <el-tab-pane v-if="!isLocalMode" name="add-source">
        <template #label>
          <el-icon style="margin-right: 4px;">
            <Plus />
          </el-icon>
          添加源
        </template>
        <div class="add-source-content">
          <el-empty description="点击上方“添加源”标签页可添加新的商店源" />
        </div>
      </el-tab-pane>
    </StyledTabs>

    <!-- 商店源管理 -->
    <el-dialog v-if="!isLocalMode" v-model="showSourcesDialog" title="商店源" width="720px">
      <div class="sources-hint">
        商店源是一个可访问的 <code>index.json</code> 地址（推荐指向 GitHub Releases 资产直链）。
      </div>
      <el-table :data="sources" style="width: 100%" empty-text="暂无商店源">
        <el-table-column prop="name" label="名称" width="180">
          <template #default="{ row }">
            <span>{{ row.name }}</span>
            <el-tag v-if="row.builtIn" type="info" size="small" style="margin-left: 8px;">官方</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="indexUrl" label="index.json 地址" show-overflow-tooltip />
        <el-table-column label="操作" width="140">
          <template #default="{ row, $index }">
            <el-button size="small" @click="editSource($index)" :disabled="row.builtIn">编辑</el-button>
            <el-button size="small" type="danger" @click="removeSource($index)" :disabled="row.builtIn">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="showSourcesDialog = false">关闭</el-button>
        <el-button @click="addSource">新增源</el-button>
        <el-button type="primary" @click="saveSources">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑源 -->
    <el-dialog v-if="!isLocalMode" v-model="showEditSourceDialog" :title="editingSourceIndex === null ? '新增源' : '编辑源'"
      width="620px">
      <el-form label-width="110px">
        <el-form-item label="名称">
          <el-input v-model="editSourceForm.name" placeholder="例如：官方源" />
        </el-form-item>
        <el-form-item label="index.json">
          <el-input v-model="editSourceForm.indexUrl" placeholder="https://.../index.json" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditSourceDialog = false">取消</el-button>
        <el-button type="primary" :loading="isValidatingSource" :disabled="isValidatingSource"
          @click="confirmEditSource">
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- 导入源对话框 -->
    <el-dialog v-model="showImportDialog" title="导入源" width="500px">
      <div class="import-instructions">
        <p>请选择要导入的源文件（.kgpg 格式）</p>
        <el-button type="primary" @click="selectPluginFile">
          <el-icon>
            <Upload />
          </el-icon>
          选择文件
        </el-button>
        <p v-if="selectedFilePath" class="selected-file">
          已选择: {{ selectedFilePath }}
        </p>
      </div>
      <template #footer>
        <el-button @click="showImportDialog = false">取消</el-button>
        <el-button type="primary" @click="handleImport" :disabled="!selectedFilePath">
          导入
        </el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Refresh,
  Upload,
  Grid,
  Plus,
  Setting,
} from "@element-plus/icons-vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import { useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import PageHeader from "@/components/common/PageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import { isUpdateAvailable } from "@/utils/version";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";

type BuildMode = "normal" | "local";

interface PluginSource {
  id: string;
  name: string;
  indexUrl: string;
  enabled: boolean;
  builtIn?: boolean; // 是否为内置官方源（不可删除）
}

interface StorePluginResolved {
  id: string;
  name: string;
  version: string;
  description: string;
  downloadUrl: string;
  iconUrl?: string | null;
  sha256?: string | null;
  sizeBytes: number;
  sourceId: string;
  sourceName: string;
  installedVersion?: string | null;
}

interface ImportPreview {
  id: string;
  name: string;
  version: string;
  sizeBytes: number;
  alreadyExists: boolean;
  existingVersion?: string | null;
  changeLogDiff?: string | null;
}

interface StoreInstallPreview {
  tmpPath: string;
  preview: ImportPreview;
}

const pluginStore = usePluginStore();
const router = useRouter();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("pluginbrowser");

const buildMode = ref<BuildMode>(
  import.meta.env.VITE_KABEGAME_MODE === "local" ? "local" : "normal"
);
const isLocalMode = computed(() => buildMode.value === "local");

const loadingBySource = ref<Record<string, boolean>>({}); // 按源区分的loading状态
const showSkeletonBySource = ref<Record<string, boolean>>({}); // 按源区分的骨架屏状态
const skeletonTimersBySource = ref<Record<string, ReturnType<typeof setTimeout>>>({}); // 按源区分的骨架屏定时器
const activeTab = ref<string>("installed");
const showImportDialog = ref(false);
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

// 商店插件：按商店源分组缓存（每个 tab 独立显示/刷新）
const storePluginsBySource = ref<Record<string, StorePluginResolved[]>>({});
const storeLoadedBySource = ref<Record<string, boolean>>({});

const sources = ref<PluginSource[]>([]);
const storeSourcesToRender = computed(() => (isLocalMode.value ? [] : sources.value));
const sourcesLoadedOnce = ref(false); // 是否已加载过商店源（仅用于避免重复拉取）
const showSourcesDialog = ref(false);
const showEditSourceDialog = ref(false);
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

// 插件图标（key: pluginId, value: data URL）
const pluginIcons = ref<Record<string, string>>({});

const getPluginIconSrc = (p: { id: string; iconUrl?: string | null }) => {
  // 已安装：优先本地 icon.png（data URL）
  const local = pluginIcons.value[p.id];
  if (local) return local;
  // 商店/官方源：用 index.json 里的 iconUrl（通常是 https://.../<id>.icon.png）
  if (p.iconUrl) return p.iconUrl;
  return null;
};

const loadPluginIcon = async (pluginId: string) => {
  if (!pluginId) return;
  if (pluginIcons.value[pluginId]) return;
  try {
    const iconData = await invoke<number[] | null>("get_plugin_icon", {
      pluginId,
    });
    if (!iconData || iconData.length === 0) {
      return;
    }
    const bytes = new Uint8Array(iconData);
    const binaryString = Array.from(bytes)
      .map((byte) => String.fromCharCode(byte))
      .join("");
    const base64 = btoa(binaryString);
    pluginIcons.value = {
      ...pluginIcons.value,
      [pluginId]: `data:image/png;base64,${base64}`,
    };
  } catch (e) {
    // 图标缺失不算错误：保持占位符即可
  }
};

const refreshPluginIcons = async () => {
  const ids = new Set<string>();
  // 已安装源：一定尝试加载本地 icon
  installedPlugins.value.forEach((p) => ids.add(p.id));
  // 商店列表：仅对“已安装”的条目尝试加载本地 icon（未安装通常没有本地文件可读）
  for (const arr of Object.values(storePluginsBySource.value)) {
    for (const p of arr) {
      if (p.installedVersion) ids.add(p.id);
    }
  }
  await Promise.all([...ids].map((id) => loadPluginIcon(id)));
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

  // 官方源不允许编辑
  if (s.builtIn) {
    ElMessage.warning("官方源不能编辑");
    return;
  }

  editingSourceIndex.value = idx;
  editSourceForm.id = s.id;
  editSourceForm.name = s.name;
  editSourceForm.indexUrl = s.indexUrl;
  showEditSourceDialog.value = true;
};

const confirmEditSource = async () => {
  if (!editSourceForm.name.trim() || !editSourceForm.indexUrl.trim()) {
    ElMessage.warning("请填写名称和 index.json 地址");
    return;
  }

  // 先验证源可用性（index.json 可获取且可解析）
  // 若验证失败，弹窗询问用户是否仍然添加
  const indexUrl = editSourceForm.indexUrl.trim();
  isValidatingSource.value = true;
  try {
    await invoke("validate_plugin_source", { indexUrl });
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
        `验证该源失败：\n\n${msg}\n\n仍然要添加这个源吗？`,
        "源验证失败",
        {
          type: "warning",
          confirmButtonText: "仍然添加",
          cancelButtonText: "返回修改",
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

  const payload: PluginSource = {
    id: editSourceForm.id,
    name: editSourceForm.name.trim(),
    indexUrl,
    enabled: true,
    builtIn: false,
  };
  if (editingSourceIndex.value === null) {
    sources.value.push(payload);
  } else {
    sources.value.splice(editingSourceIndex.value, 1, payload);
  }

  // 确认添加/编辑即持久化（避免用户以为已添加但重启后丢失）
  try {
    await invoke("save_plugin_sources", { sources: sources.value });
    await loadSources();
    ElMessage.success(editingSourceIndex.value === null ? "源已添加" : "源已更新");
    showEditSourceDialog.value = false;
  } catch (e) {
    console.error("保存商店源失败:", e);
    ElMessage.error("保存商店源失败");
  }
};

const removeSource = async (idx: number) => {
  const source = sources.value[idx];
  if (!source) return;

  // 官方源不允许删除
  if (source.builtIn) {
    ElMessage.warning("官方源不能删除");
    return;
  }

  try {
    await ElMessageBox.confirm("确定要删除这个商店源吗？", "删除商店源", { type: "warning" });
    sources.value.splice(idx, 1);
  } catch {
    // cancel
  }
};

const saveSources = async () => {
  try {
    await invoke("save_plugin_sources", { sources: sources.value });
    ElMessage.success("商店源已保存");
    showSourcesDialog.value = false;
    // 保存后刷新源列表（本地配置）
    await loadSources();

    // 清理已移除源的缓存
    const sourceIds = new Set(sources.value.map((s) => s.id));
    const nextPlugins: Record<string, StorePluginResolved[]> = {};
    const nextLoaded: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(storePluginsBySource.value)) {
      if (sourceIds.has(k)) {
        nextPlugins[k] = v;
        nextLoaded[k] = !!storeLoadedBySource.value[k];
      }
    }
    storePluginsBySource.value = nextPlugins;
    storeLoadedBySource.value = nextLoaded;

    // 若当前停留在某个商店源 tab，但该源不见了，则切换到已安装源
    if (activeStoreSourceId.value && !sourceIds.has(activeStoreSourceId.value)) {
      activeTab.value = "installed";
      return;
    }

    // 若当前就是某个商店源 tab：保存后刷新当前源（不刷新其他源）
    if (activeStoreSourceId.value) {
      await loadStorePlugins(activeStoreSourceId.value, false);
      await refreshPluginIcons();
    }
  } catch (e) {
    console.error("保存商店源失败:", e);
    ElMessage.error("保存商店源失败");
  }
};

const loadStorePlugins = async (sourceId: string, showMessage: boolean = true) => {
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
    const plugins = await invoke<StorePluginResolved[]>("get_store_plugins", { sourceId });
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
      ElMessage.success("商店列表已刷新");
    }
  } catch (error) {
    console.error("加载商店失败:", error);
    // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
    let errorMessage = "加载商店失败（请检查商店源配置）";
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
    ElMessage.error("选择文件失败");
  }
};

const handleImport = async () => {
  if (!selectedFilePath.value) return;

  try {
    const filePath = selectedFilePath.value;
    const fileExt = filePath.split('.').pop()?.toLowerCase();

    if (fileExt === "kgpg") {
      const preview = await invoke<ImportPreview>("preview_import_plugin", { zipPath: filePath });
      if (preview.alreadyExists && preview.existingVersion && preview.existingVersion === preview.version) {
        ElMessage.info(`插件已存在（v${preview.version}），无需重复导入`);
        return;
      }

      const changeLogHtml = preview.changeLogDiff
        ? `<details style="margin-top:10px;"><summary>查看变更</summary><pre style="white-space:pre-wrap;margin-top:8px;">${escapeHtml(
          preview.changeLogDiff
        )}</pre></details>`
        : "";

      const msg = preview.alreadyExists
        ? `检测到同 ID 插件，版本将从 <b>v${preview.existingVersion || "?"}</b> 变更为 <b>v${preview.version}</b>，是否继续导入？${changeLogHtml}`
        : `将导入插件：<b>${escapeHtml(preview.name)}</b>（v${preview.version}，${formatBytes(preview.sizeBytes)}），是否继续？${changeLogHtml}`;

      await ElMessageBox.confirm(msg, "确认导入", {
        type: "warning",
        dangerouslyUseHTMLString: true,
        confirmButtonText: "导入",
        cancelButtonText: "取消",
      });

      await invoke("import_plugin_from_zip", { zipPath: filePath });
    } else {
      ElMessage.error("不支持的文件格式，请选择 .kgpg 文件");
      return;
    }

    ElMessage.success("源导入成功");
    showImportDialog.value = false;
    selectedFilePath.value = null;
    await pluginStore.loadPlugins();
    // 若当前在某个商店源 tab，导入后顺手刷新当前源列表（否则只刷新已安装即可）
    if (activeStoreSourceId.value) {
      await loadStorePlugins(activeStoreSourceId.value, false);
    }
  } catch (error) {
    console.error("导入源失败:", error);
    ElMessage.error(
      error instanceof Error ? error.message : "导入源失败"
    );
  }
};

const handleStoreInstall = async (plugin: StorePluginResolved) => {
  try {
    // 先弹确认（不要先下载/预览，否则确认会延迟）
    const willUpdate = isUpdateAvailable(plugin.installedVersion, plugin.version);
    const title = willUpdate ? "确认更新" : "确认安装";
    const confirmButtonText = willUpdate ? "更新" : "安装";
    const msg = willUpdate
      ? `将从 <b>v${escapeHtml(plugin.installedVersion || "?")}</b> 更新为 <b>v${escapeHtml(
        plugin.version
      )}</b>（${formatBytes(plugin.sizeBytes)}），是否继续？`
      : `将安装 <b>${escapeHtml(plugin.name)}</b>（v${escapeHtml(plugin.version)}，${formatBytes(
        plugin.sizeBytes
      )}），是否继续？`;

    await ElMessageBox.confirm(msg, title, {
      type: "warning",
      dangerouslyUseHTMLString: true,
      confirmButtonText,
      cancelButtonText: "取消",
    });

    // 确认后再开始下载/安装
    setInstalling(plugin.id, true);
    const res = await invoke<StoreInstallPreview>("preview_store_install", {
      downloadUrl: plugin.downloadUrl,
      sha256: plugin.sha256 ?? null,
      sizeBytes: plugin.sizeBytes || null,
    });

    await invoke("import_plugin_from_zip", { zipPath: res.tmpPath });

    ElMessage.success(willUpdate ? "更新成功" : "安装成功");
    await pluginStore.loadPlugins();

    // 只更新本地 UI 状态：不触发整页/整 tab 列表刷新
    markStorePluginInstalled(plugin.id, res.preview.version);
    await loadPluginIcon(plugin.id);
  } catch (error) {
    if (error !== "cancel") {
      console.error("商店安装失败:", error);
      ElMessage.error(error instanceof Error ? error.message : "安装/更新失败");
    }
  } finally {
    setInstalling(plugin.id, false);
  }
};

const viewPluginDetails = (plugin: { id: string } & Partial<StorePluginResolved>) => {
  // 跳转到插件详情页面，对 ID 进行 URL 编码以支持中文字符
  // 商店/官方源条目：通过 query 携带 downloadUrl 等信息，详情页才能走“远程下载到内存解析”的路径
  const path = `/plugin-detail/${encodeURIComponent(plugin.id)}`;
  if (plugin.downloadUrl) {
    router.push({
      path,
      query: {
        downloadUrl: plugin.downloadUrl,
        sha256: plugin.sha256 ?? undefined,
        sizeBytes: plugin.sizeBytes != null ? String(plugin.sizeBytes) : undefined,
        iconUrl: plugin.iconUrl ?? undefined,
      },
    });
    return;
  }
  router.push(path);
};

const handleDelete = async (plugin: Plugin) => {
  if (plugin.builtIn) {
    ElMessage.warning("该插件为内置核心插件，禁止卸载");
    return;
  }
  try {
    await ElMessageBox.confirm(`确定要删除插件 "${plugin.name}" 吗？`, "确认删除", {
      type: "warning",
    });
    await pluginStore.deletePlugin(plugin.id);
    ElMessage.success("插件已删除");
  } catch (error) {
    // 用户取消
  }
};

const handleTogglePlugin = async (plugin: Plugin) => {
  try {
    await pluginStore.updatePlugin(plugin.id, { enabled: plugin.enabled });
  } catch (error) {
    ElMessage.error("更新失败");
    plugin.enabled = !plugin.enabled; // 回滚
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
        await pluginStore.loadPlugins();
        await refreshPluginIcons();
        ElMessage.success("已安装源已刷新");
      } catch (error) {
        console.error("刷新已安装源失败:", error);
        // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
        let errorMessage = "刷新已安装源失败";
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
        ElMessage.warning("当前商店源已不存在，已切回已安装源");
        activeTab.value = "installed";
        return;
      }

      await loadStorePlugins(sourceId, false);
      await refreshPluginIcons();
      ElMessage.success("商店源已刷新");
    }
  } catch (error) {
    console.error("刷新失败:", error);
    // 如果内层已经处理过错误（已安装源），这里不再重复显示
    // 否则显示通用错误消息
    if (isStoreTab(activeTab.value)) {
      // 提取错误消息 - Tauri invoke 可能返回字符串或 Error 对象
      let errorMessage = "刷新失败";
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
    // 运行时从后端获取 build mode（后端为编译期注入，作为最终可信来源）
    try {
      const mode = await invoke<string>("get_build_mode");
      buildMode.value = mode === "local" ? "local" : "normal";
    } catch {
      // ignore: fallback to import.meta.env
    }

    // 首次进入：默认 tab=已安装源，不需要拉取商店列表；仅加载本地已安装源即可
    await pluginStore.loadPlugins();
    // normal 模式才加载商店源列表（本地配置），用于渲染动态 tab
    if (!isLocalMode.value) {
      await loadSources();
    } else {
      sources.value = [];
    }
    await refreshPluginIcons();
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
  if (isLocalMode.value) return;
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

  // 每个源只在首次进入时加载一次；之后除非用户手动刷新/保存源，不自动重复拉取
  if (storeLoadedBySource.value[sourceId]) {
    return;
  }
  await loadStorePlugins(sourceId, false);
  await refreshPluginIcons();
});
</script>

<style scoped lang="scss">
.plugin-browser-container {
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

    :deep(.el-image) {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    :deep(.el-image__inner) {
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

  /* 禁用插件卡片上标签和按钮的初始展开动画 */
  :deep(.el-tag) {
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
