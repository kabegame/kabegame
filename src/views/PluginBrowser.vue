<template>
  <div class="plugin-browser-container">
    <!-- 顶部工具栏 -->
    <div class="plugin-toolbar">
      <span class="toolbar-title">🔌 收集源管理</span>
      <div class="header-actions">
        <el-button @click="loadPluginsFromDirectory">
          <el-icon>
            <Refresh />
          </el-icon>
          刷新收集源目录
        </el-button>
        <el-button @click="showAddDialog = true">
          <el-icon>
            <Plus />
          </el-icon>
          添加收集源
        </el-button>
        <el-button type="primary" @click="showImportDialog = true">
          <el-icon>
            <Upload />
          </el-icon>
          导入收集源
        </el-button>
      </div>
    </div>

    <!-- Tab 切换 -->
    <el-tabs v-model="activeTab" class="plugin-tabs">
      <el-tab-pane label="插件浏览" name="browser">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 12px;">
          <el-button circle size="small" @click="handleRefreshBrowser" :loading="isRefreshingBrowser">
            <el-icon>
              <Refresh />
            </el-icon>
          </el-button>
        </div>
        <!-- 原有的插件浏览内容 -->
        <!-- 搜索和筛选 -->
        <div class="filter-bar">
          <el-input v-model="searchQuery" placeholder="搜索收集源..." clearable style="width: 300px; margin-right: 10px">
            <template #prefix>
              <el-icon>
                <Search />
              </el-icon>
            </template>
          </el-input>
          <el-button-group>
            <el-button :type="filterType === 'all' ? 'primary' : ''" @click="filterType = 'all'">
              全部
            </el-button>
            <el-button :type="filterType === 'installed' ? 'primary' : ''" @click="filterType = 'installed'">
              已安装
            </el-button>
            <el-button :type="filterType === 'favorite' ? 'primary' : ''" @click="filterType = 'favorite'">
              已收藏
            </el-button>
          </el-button-group>
        </div>

        <!-- 插件列表 -->
        <div v-if="loading" class="loading-skeleton">
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

        <div v-else-if="filteredPlugins.length === 0" class="empty">
          <el-empty description="暂无收集源" />
        </div>

        <transition-group v-else name="fade-in-list" tag="div" class="plugin-grid">
          <el-card v-for="plugin in filteredPlugins" :key="plugin.id" class="plugin-card" shadow="hover"
            @click="viewPluginDetails(plugin)">
            <div class="plugin-header">
              <div class="plugin-icon" v-if="plugin.icon && plugin.icon.startsWith('data:')">
                <el-image :src="plugin.icon" fit="cover" />
              </div>
              <div class="plugin-icon-placeholder" v-else>
                <el-icon>
                  <Grid />
                </el-icon>
              </div>
              <div class="plugin-title" @click.stop>
                <h3>{{ plugin.name }}</h3>
                <p class="plugin-desp">{{ plugin.desp || "无描述" }}</p>
              </div>
              <div class="plugin-actions">
                <el-button :icon="plugin.favorite ? StarFilled : Star" circle :type="plugin.favorite ? 'warning' : ''"
                  @click.stop="toggleFavorite(plugin)" title="收藏" />
              </div>
            </div>

            <div class="plugin-info">
              <el-tag v-if="isInstalled(plugin.id)" type="success" size="small">
                已安装
              </el-tag>
              <el-tag v-else type="info" size="small">未安装</el-tag>
            </div>

            <div class="plugin-footer">
              <el-button v-if="!isInstalled(plugin.id)" type="primary" size="small" @click.stop="installPlugin(plugin)">
                安装
              </el-button>
              <el-button v-else type="danger" size="small" @click.stop="uninstallPlugin(plugin.id)">
                卸载
              </el-button>
            </div>
          </el-card>
        </transition-group>
      </el-tab-pane>

      <el-tab-pane label="已安装收集源" name="installed">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 12px;">
          <el-button circle size="small" @click="handleRefreshInstalled" :loading="isRefreshingInstalled">
            <el-icon>
              <Refresh />
            </el-icon>
          </el-button>
        </div>
        <!-- 已安装插件配置表格 -->
        <div v-if="loading && activeTab === 'installed'" class="loading-skeleton">
          <el-skeleton :rows="8" animated />
        </div>
        <el-table v-else :data="installedPlugins" style="width: 100%" empty-text="暂无已安装收集源" class="fade-in-table">
          <el-table-column prop="name" label="名称" width="150" />
          <el-table-column prop="description" label="描述" show-overflow-tooltip />
          <el-table-column prop="baseUrl" label="基础URL" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-switch v-model="row.enabled" @change="handleTogglePlugin(row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200">
            <template #default="{ row }">
              <el-button size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="handleDelete(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 添加/编辑插件对话框 -->
    <el-dialog v-model="showAddDialog" :title="editingPlugin ? '编辑插件' : '添加插件'" width="600px">
      <el-form :model="pluginForm" label-width="100px" ref="formRef">
        <el-form-item label="名称" required>
          <el-input v-model="pluginForm.name" placeholder="收集源名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="pluginForm.description" type="textarea" :rows="2" placeholder="收集源描述" />
        </el-form-item>
        <el-form-item label="基础URL" required>
          <el-input v-model="pluginForm.baseUrl" placeholder="https://example.com" />
        </el-form-item>
        <el-form-item label="图片选择器" required>
          <el-input v-model="pluginForm.selector.imageSelector" placeholder="img" />
        </el-form-item>
        <el-form-item label="下一页选择器">
          <el-input v-model="pluginForm.selector.nextPageSelector" placeholder="a.next" />
        </el-form-item>
        <el-form-item label="标题选择器">
          <el-input v-model="pluginForm.selector.titleSelector" placeholder="h1.title" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="pluginForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>

    <!-- 导入收集源对话框 -->
    <el-dialog v-model="showImportDialog" title="导入收集源" width="500px">
      <div class="import-instructions">
        <p>请选择要导入的收集源文件（.kgpg 格式）</p>
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
import { ref, computed, onMounted, reactive } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Refresh,
  Upload,
  Search,
  Grid,
  Star,
  StarFilled,
  Plus,
} from "@element-plus/icons-vue";
import { usePluginStore, type Plugin } from "@/stores/plugins";
import { useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface BrowserPlugin {
  id: string;
  name: string;
  desp: string;
  icon?: string;
  favorite?: boolean;
  filePath?: string;
  doc?: string;
}

const pluginStore = usePluginStore();
const router = useRouter();

const loading = ref(true); // 初始为 true，显示骨架屏
const activeTab = ref<"browser" | "installed">("browser");
const searchQuery = ref("");
const filterType = ref<"all" | "installed" | "favorite">("all");
const showImportDialog = ref(false);
const showAddDialog = ref(false);
const selectedFilePath = ref<string | null>(null);
const editingPlugin = ref<Plugin | null>(null);
const isRefreshingBrowser = ref(false);
const isRefreshingInstalled = ref(false);
// const formRef = ref(); // 暂时未使用

const pluginForm = reactive({
  name: "",
  description: "",
  baseUrl: "",
  enabled: true,
  selector: {
    imageSelector: "",
    nextPageSelector: "",
    titleSelector: "",
  },
});

const browserPlugins = ref<BrowserPlugin[]>([]);

const installedPlugins = computed(() => pluginStore.plugins);

const filteredPlugins = computed(() => {
  let plugins = browserPlugins.value;

  // 搜索过滤
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    plugins = plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        (p.desp && p.desp.toLowerCase().includes(query))
    );
  }

  // 类型过滤
  if (filterType.value === "installed") {
    plugins = plugins.filter((p) => isInstalled(p.id));
  } else if (filterType.value === "favorite") {
    plugins = plugins.filter((p) => p.favorite);
  }

  return plugins;
});

const isInstalled = (pluginId: string) => {
  // 匹配插件 ID 或名称（因为插件可能通过不同方式安装，ID 可能略有不同）
  return pluginStore.plugins.some((p) => {
    // 精确匹配 ID
    if (p.id === pluginId) return true;
    // 如果 ID 格式是 "文件名-插件名"，也尝试匹配
    const browserPlugin = browserPlugins.value.find((bp) => bp.id === pluginId);
    if (browserPlugin) {
      // 通过名称匹配
      return p.name === browserPlugin.name;
    }
    return false;
  });
};

const loadPluginsFromDirectory = async (showMessage: boolean = true) => {
  loading.value = true;
  try {
    const plugins = await invoke<BrowserPlugin[]>("get_browser_plugins");
    
    // 先显示插件列表，不阻塞图标加载
    // 如果 plugin.icon 是文件路径（不是 data URL），先清空，避免直接使用 file:// URL
    const processedPlugins = plugins.map(p => ({
      ...p,
      icon: p.icon && p.icon.startsWith('data:') ? p.icon : undefined
    }));
    browserPlugins.value = processedPlugins;
    loading.value = false;
    
    // 异步加载图标，不阻塞主流程
    // 为有图标的插件加载图标数据
    // plugin.icon 如果存在，表示图标文件存在（值为插件文件路径）
    // 我们需要调用 get_plugin_icon 来获取图标数据
    for (const plugin of plugins) {
      if (plugin.icon && !plugin.icon.startsWith('data:')) {
        try {
          const iconData = await invoke<number[] | null>("get_plugin_icon", {
            pluginId: plugin.id,
          });
          if (iconData && iconData.length > 0) {
            // 将数组转换为 Uint8Array，然后转换为 base64 data URL
            const bytes = new Uint8Array(iconData);
            // 使用更安全的方式处理大文件
            const binaryString = Array.from(bytes)
              .map((byte) => String.fromCharCode(byte))
              .join("");
            const base64 = btoa(binaryString);
            // 更新对应插件的图标
            const targetPlugin = browserPlugins.value.find(p => p.id === plugin.id);
            if (targetPlugin) {
              targetPlugin.icon = `data:image/x-icon;base64,${base64}`;
            }
          } else {
            const targetPlugin = browserPlugins.value.find(p => p.id === plugin.id);
            if (targetPlugin) {
              targetPlugin.icon = undefined;
            }
          }
        } catch (error) {
          console.error(`加载插件 ${plugin.id} 图标失败:`, error);
          const targetPlugin = browserPlugins.value.find(p => p.id === plugin.id);
          if (targetPlugin) {
            targetPlugin.icon = undefined;
          }
        }
      }
    }
    
    if (showMessage) {
      ElMessage.success("插件列表已刷新");
    }
  } catch (error) {
    console.error("加载插件失败:", error);
    ElMessage.error("加载插件失败");
    loading.value = false;
  }
};

const selectPluginFile = async () => {
  try {
    const filePath = await open({
      filters: [
        {
          name: "Kabegami 插件",
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
      // ZIP 格式的插件
      await invoke("import_plugin_from_zip", {
        zipPath: filePath,
      });
    } else {
      ElMessage.error("不支持的文件格式，请选择 .kgpg 文件");
      return;
    }

    ElMessage.success("收集源导入成功");
    showImportDialog.value = false;
    selectedFilePath.value = null;
    await loadPluginsFromDirectory();
    await pluginStore.loadPlugins();
  } catch (error) {
    console.error("导入收集源失败:", error);
    ElMessage.error(
      error instanceof Error ? error.message : "导入收集源失败"
    );
  }
};

const installPlugin = async (plugin: BrowserPlugin) => {
  try {
    await invoke("install_browser_plugin", { pluginId: plugin.id });
    ElMessage.success("插件安装成功");
    await pluginStore.loadPlugins();
    await loadPluginsFromDirectory();
  } catch (error) {
    console.error("安装插件失败:", error);
    ElMessage.error("安装插件失败");
  }
};

const uninstallPlugin = async (pluginId: string) => {
  try {
    await ElMessageBox.confirm("确定要卸载这个插件吗？", "确认卸载", {
      type: "warning",
    });
    await pluginStore.deletePlugin(pluginId);
    ElMessage.success("插件已卸载");
    await loadPluginsFromDirectory();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error("卸载插件失败");
    }
  }
};

const toggleFavorite = async (plugin: BrowserPlugin) => {
  try {
    plugin.favorite = !plugin.favorite;
    await invoke("toggle_plugin_favorite", {
      pluginId: plugin.id,
      favorite: plugin.favorite,
    });
    ElMessage.success(plugin.favorite ? "已收藏" : "已取消收藏");
  } catch (error) {
    console.error("更新收藏状态失败:", error);
    plugin.favorite = !plugin.favorite; // 回滚
  }
};

const viewPluginDetails = (plugin: BrowserPlugin) => {
  // 跳转到插件详情页面，对 ID 进行 URL 编码以支持中文字符
  router.push(`/plugin-detail/${encodeURIComponent(plugin.id)}`);
};

const handleSave = async () => {
  if (!pluginForm.name || !pluginForm.baseUrl || !pluginForm.selector.imageSelector) {
    ElMessage.warning("请填写必填项");
    return;
  }

  try {
    if (editingPlugin.value) {
      await pluginStore.updatePlugin(editingPlugin.value.id, pluginForm);
      ElMessage.success("收集源已更新");
    } else {
      await pluginStore.addPlugin({
        ...pluginForm,
        config: {},
      });
      ElMessage.success("收集源已添加");
    }
    showAddDialog.value = false;
    resetForm();
  } catch (error) {
    ElMessage.error("保存失败");
  }
};

const handleEdit = (plugin: Plugin) => {
  editingPlugin.value = plugin;
  pluginForm.name = plugin.name;
  pluginForm.description = plugin.description;
  pluginForm.baseUrl = plugin.baseUrl;
  pluginForm.enabled = plugin.enabled;
  pluginForm.selector = {
    imageSelector: plugin.selector?.imageSelector || "",
    nextPageSelector: plugin.selector?.nextPageSelector || "",
    titleSelector: plugin.selector?.titleSelector || "",
  };
  showAddDialog.value = true;
};

const handleDelete = async (plugin: Plugin) => {
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

const resetForm = () => {
  editingPlugin.value = null;
  pluginForm.name = "";
  pluginForm.description = "";
  pluginForm.baseUrl = "";
  pluginForm.enabled = true;
  pluginForm.selector = {
    imageSelector: "",
    nextPageSelector: "",
    titleSelector: "",
  };
};

const handleRefreshBrowser = async () => {
  isRefreshingBrowser.value = true;
  try {
    await loadPluginsFromDirectory(false);
    await pluginStore.loadPlugins();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshingBrowser.value = false;
  }
};

const handleRefreshInstalled = async () => {
  isRefreshingInstalled.value = true;
  try {
    await pluginStore.loadPlugins();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshingInstalled.value = false;
  }
};

onMounted(async () => {
  await loadPluginsFromDirectory(false);
  await pluginStore.loadPlugins();
});
</script>

<style scoped lang="scss">
.plugin-browser-container {
  width: 100%;
  height: 100%;
  padding: 20px;
  overflow-y: auto;

.plugin-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 12px 16px;
  background: var(--anime-bg-card);
  border-radius: 12px;
  box-shadow: var(--anime-shadow);

.toolbar-title {
  font-size: 20px;
  font-weight: 600;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.header-actions {
  display: flex;
  gap: 10px;
    }
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
  transition: all 0.4s ease-out;
}

.fade-in-list-leave-active {
  transition: all 0.3s ease-in;
}

.fade-in-list-enter-from {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

.fade-in-list-leave-to {
  opacity: 0;
  transform: scale(0.9);
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
  cursor: text;

    h3 {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--anime-text-primary);
  user-select: text;
  cursor: text;
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
}

/* 禁用插件卡片上标签和按钮的初始展开动画 */
  :deep(.el-tag) {
  animation: none !important;
  transition: none !important;
}

  :deep(.el-button) {
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


.plugin-tabs {
  margin-top: 20px;

  :deep(.el-tabs__header) {
  margin-bottom: 20px;
}

  :deep(.el-tabs__item) {
  color: var(--anime-text-muted);
  font-weight: 500;
  transition: all 0.3s ease;

    &:hover {
  color: var(--anime-primary);
}

    &.is-active {
  color: var(--anime-primary);
  font-weight: 600;
    }
}

  :deep(.el-tabs__active-bar) {
  background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  height: 3px;
  border-radius: 2px;
  }
}
</style>
