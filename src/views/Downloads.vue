<template>
  <TabLayout title="正在下载" max-width="1200px">
    <template #actions>
      <div class="header-actions">
        <el-button circle size="small" @click="handleRefresh" :loading="isRefreshing">
          <el-icon>
            <Refresh />
          </el-icon>
        </el-button>
        <el-button
          type="danger"
          plain
          size="small"
          :disabled="queueSize === 0"
          @click="handleClearQueue"
        >
          终止队列
        </el-button>
        <div class="header-stats">
          <el-tag type="info">队列中: {{ queueSize }}</el-tag>
          <el-tag type="warning">下载中: {{ activeDownloads.length }}</el-tag>
        </div>
      </div>
    </template>

    <el-card v-if="activeDownloads.length === 0 && queueSize === 0" class="empty-card">
      <el-empty description="暂无下载任务" :image-size="100" />
    </el-card>

    <div v-else>
      <!-- 正在下载的图片 -->
      <el-card v-if="activeDownloads.length > 0" class="downloads-card">
        <template #header>
          <span>正在下载 ({{ activeDownloads.length }})</span>
        </template>
        <el-table :data="activeDownloads" style="width: 100%" empty-text="暂无正在下载的图片">
          <el-table-column prop="url" label="图片 URL" show-overflow-tooltip min-width="300">
            <template #default="{ row }">
              <a :href="row.url" target="_blank" class="url-link">{{ row.url }}</a>
            </template>
          </el-table-column>
          <el-table-column prop="plugin_id" label="插件" width="150">
            <template #default="{ row }">
              <el-tag size="small">{{ row.plugin_id }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="开始时间" width="180">
            <template #default="{ row }">
              {{ formatTime(row.start_time) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default>
              <el-tag type="warning" size="small">
                <el-icon><Loading /></el-icon>
                下载中
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 队列中的任务 -->
      <el-card v-if="queueSize > 0" class="downloads-card" style="margin-top: 20px">
        <template #header>
          <span>等待队列 ({{ queueSize }})</span>
        </template>
        <div class="queue-info">
          <el-alert
            :title="`还有 ${queueSize} 个任务在队列中等待下载`"
            type="info"
            :closable="false"
            show-icon
          />
        </div>
      </el-card>
    </div>
  </TabLayout>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { Loading, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import TabLayout from "@/layouts/TabLayout.vue";

interface ActiveDownloadInfo {
  url: string;
  plugin_id: string;
  start_time: number;
}

const activeDownloads = ref<ActiveDownloadInfo[]>([]);
const queueSize = ref(0);
const isRefreshing = ref(false);
let refreshInterval: number | null = null;

const loadDownloads = async () => {
  try {
    const [downloads, size] = await Promise.all([
      invoke<ActiveDownloadInfo[]>("get_active_downloads"),
      invoke<number>("get_download_queue_size"),
    ]);
    activeDownloads.value = downloads;
    queueSize.value = size;
  } catch (error) {
    console.error("加载下载列表失败:", error);
  }
};

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

onMounted(() => {
  loadDownloads();
  // 每 1 秒刷新一次
  refreshInterval = window.setInterval(loadDownloads, 1000);
});

const handleRefresh = async () => {
  isRefreshing.value = true;
  try {
    await loadDownloads();
    ElMessage.success("刷新成功");
  } catch (error) {
    console.error("刷新失败:", error);
    ElMessage.error("刷新失败");
  } finally {
    isRefreshing.value = false;
  }
};

const handleClearQueue = async () => {
  if (queueSize.value === 0) return;
  try {
    await ElMessageBox.confirm(
      `确定要清空等待队列吗？将移除队列中 ${queueSize.value} 个待下载任务（不影响正在下载）。`,
      "终止队列",
      { type: "warning" }
    );
    const removed = await invoke<number>("clear_download_queue");
    ElMessage.success(`已清空队列（移除 ${removed} 个任务）`);
    await loadDownloads();
  } catch (error) {
    if (error !== "cancel") {
      console.error("清空队列失败:", error);
      ElMessage.error("清空队列失败");
    }
  }
};

onUnmounted(() => {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
  }
});
</script>

<style scoped lang="scss">
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-stats {
  display: flex;
  gap: 12px;
}

.downloads-card {
  background: var(--anime-bg-card);
  border-radius: 16px;
  box-shadow: var(--anime-shadow);
  transition: none !important;

  &:hover {
    transform: none !important;
    box-shadow: var(--anime-shadow) !important;
  }
}

.empty-card {
  background: var(--anime-bg-card);
  border-radius: 16px;
  box-shadow: var(--anime-shadow);
  margin-top: 40px;
}

.url-link {
  color: var(--anime-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.queue-info {
  padding: 10px 0;
}

:deep(.el-table) {
  background: transparent;

  th {
    background: var(--anime-bg-card);
    color: var(--anime-text-primary);
  }

  td {
    background: var(--anime-bg-card);
    color: var(--anime-text-primary);
  }

  tr:hover > td {
    background: rgba(255, 107, 157, 0.05);
  }
}
</style>

