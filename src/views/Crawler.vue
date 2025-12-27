<template>
  <div class="crawler-container">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>🕷️ 爬虫管理</span>
          <el-button type="primary" @click="showAddDialog = true" :disabled="isCrawling">
            <el-icon><Plus /></el-icon>
            添加任务
          </el-button>
        </div>
      </template>

      <!-- 插件选择 -->
      <el-form :model="form" label-width="100px" class="crawl-form">
        <el-form-item label="选择插件">
          <el-select v-model="form.pluginId" placeholder="请选择插件" style="width: 100%">
            <el-option
              v-for="plugin in enabledPlugins"
              :key="plugin.id"
              :label="plugin.name"
              :value="plugin.id"
            >
              <div class="plugin-option">
                <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]" class="plugin-option-icon" />
                <el-icon v-else class="plugin-option-icon-placeholder">
                  <Grid />
                </el-icon>
                <span>{{ plugin.name }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="目标URL">
          <el-input v-model="form.url" placeholder="请输入要爬取的网址" />
        </el-form-item>
        <el-form-item label="输出目录">
          <el-input 
            v-model="form.outputDir" 
            placeholder="留空使用默认目录，或输入自定义路径"
            clearable
          >
            <template #append>
              <el-button @click="selectOutputDir">
                <el-icon><FolderOpened /></el-icon>
                选择
              </el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleStartCrawl" :loading="isCrawling" :disabled="!form.pluginId || !form.url">
            开始爬取
          </el-button>
        </el-form-item>
      </el-form>

      <!-- 任务列表 -->
      <el-divider />
      <h3>任务列表</h3>
      <el-table :data="tasks" style="width: 100%" empty-text="暂无任务">
        <el-table-column prop="pluginId" label="插件" width="120" />
        <el-table-column prop="url" label="URL" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)">{{ getStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进度" width="200">
          <template #default="{ row }">
            <el-progress :percentage="Math.round(row.progress)" />
            <span class="progress-text">{{ row.downloadedImages }} / {{ row.totalImages }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="startTime" label="开始时间" width="180">
          <template #default="{ row }">
            {{ row.startTime ? new Date(row.startTime * 1000).toLocaleString() : "-" }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'failed'"
              type="danger"
              size="small"
              @click="handleRetry(row)"
            >
              重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { ElMessage } from "element-plus";
import { Plus, FolderOpened, Grid } from "@element-plus/icons-vue";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();

const form = ref({
  pluginId: "",
  url: "",
  outputDir: "",
});

const showAddDialog = ref(false);
const tasks = computed(() => crawlerStore.tasks);
const isCrawling = computed(() => crawlerStore.isCrawling);
const enabledPlugins = computed(() => pluginStore.plugins.filter((p) => p.enabled));
const plugins = computed(() => pluginStore.plugins);

// 插件图标映射，存储每个插件的图标 URL
const pluginIcons = ref<Record<string, string>>({});

const getStatusType = (status: string) => {
  const map: Record<string, string> = {
    pending: "info",
    running: "warning",
    completed: "success",
    failed: "danger",
  };
  return map[status] || "info";
};

const getStatusText = (status: string) => {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "完成",
    failed: "失败",
  };
  return map[status] || status;
};

const selectOutputDir = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
    });
    
    if (selected && typeof selected === "string") {
      form.value.outputDir = selected;
    }
  } catch (error) {
    console.error("选择目录失败:", error);
  }
};

const handleStartCrawl = async () => {
  if (!form.value.pluginId || !form.value.url) {
    ElMessage.warning("请选择插件并输入URL");
    return;
  }

  try {
    await crawlerStore.addTask(
      form.value.pluginId, 
      form.value.url,
      form.value.outputDir || undefined
    );
    ElMessage.success("任务已添加");
    form.value.url = "";
    form.value.outputDir = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "添加任务失败");
  }
};

const handleRetry = async (task: any) => {
  try {
    await crawlerStore.addTask(task.pluginId, task.url);
    ElMessage.success("任务已重新添加");
  } catch (error) {
    ElMessage.error("重试失败");
  }
};

// 加载插件图标
const loadPluginIcons = async () => {
  for (const plugin of plugins.value) {
    if (pluginIcons.value[plugin.id]) {
      continue; // 已经加载过
    }
    try {
      const iconData = await invoke<number[] | null>("get_plugin_icon", {
        pluginId: plugin.id,
      });
      if (iconData && iconData.length > 0) {
        // 将数组转换为 Uint8Array，然后转换为 base64 data URL
        const bytes = new Uint8Array(iconData);
        const binaryString = Array.from(bytes)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        const base64 = btoa(binaryString);
        pluginIcons.value[plugin.id] = `data:image/x-icon;base64,${base64}`;
      }
    } catch (error) {
      // 图标加载失败，忽略（插件可能没有图标）
      console.debug(`插件 ${plugin.id} 没有图标或加载失败`);
    }
  }
};

// 监听插件列表变化，加载新插件的图标
watch(plugins, () => {
  loadPluginIcons();
}, { deep: true });

onMounted(async () => {
  await pluginStore.loadPlugins();
  await loadPluginIcons(); // 加载插件图标
});
</script>

<style scoped lang="scss">
.crawler-container {
  max-width: 1200px;
  margin: 0 auto;

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    span {
      font-size: 20px;
      font-weight: 600;
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
  }

  .crawl-form {
    margin-bottom: 20px;

    :deep(.el-form-item__label) {
      color: var(--anime-text-primary);
      font-weight: 500;
    }
  }

  .progress-text {
    font-size: 12px;
    color: var(--anime-text-secondary);
    margin-top: 5px;
    display: block;
    font-weight: 500;
  }

  h3 {
    color: var(--anime-text-primary);
    font-weight: 600;
    margin-bottom: 16px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .plugin-option-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .plugin-option-icon-placeholder {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    color: var(--anime-text-secondary);
  }
}
</style>

