<template>
  <div class="downloads-container">
    <div class="downloads-header">
      <h2>正在下载</h2>
      <div class="header-stats">
        <el-tag type="info">队列中: {{ queueSize }}</el-tag>
        <el-tag type="warning">下载中: {{ activeDownloads.length }}</el-tag>
      </div>
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { Loading } from "@element-plus/icons-vue";

interface ActiveDownloadInfo {
  url: string;
  plugin_id: string;
  start_time: number;
}

const activeDownloads = ref<ActiveDownloadInfo[]>([]);
const queueSize = ref(0);
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

onUnmounted(() => {
  if (refreshInterval !== null) {
    clearInterval(refreshInterval);
  }
});
</script>

<style scoped lang="scss">
.downloads-container {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;

  .downloads-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;

    h2 {
      color: var(--anime-text-primary);
      font-weight: 600;
      font-size: 24px;
      margin: 0;
    }
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
}
</style>

