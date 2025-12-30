<template>
  <el-dialog v-model="visible" title="图片详情" width="600px">
    <div v-if="image" class="image-detail-content">
      <div class="detail-item">
        <span class="detail-label">源：</span>
        <span class="detail-value">{{ getPluginName(image.pluginId) }}</span>
      </div>
      <div v-if="!isFileUrl(image.url)" class="detail-item">
        <span class="detail-label">URL：</span>
        <span class="detail-value clickable-link" @click="handleOpenUrl(image.url)">{{ image.url }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">本地路径：</span>
        <span class="detail-value clickable-link" @click="handleOpenPath(image.localPath)">{{ image.localPath }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">收藏时间：</span>
        <span class="detail-value">{{ formatDate(image.crawledAt) }}</span>
      </div>
      <div v-if="image.metadata && Object.keys(image.metadata).length > 0" class="detail-item">
        <span class="detail-label">元数据：</span>
        <div class="detail-metadata">
          <div v-for="(value, key) in image.metadata" :key="key" class="metadata-item">
            <span class="metadata-key">{{ key }}：</span>
            <span class="metadata-value">{{ value }}</span>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { usePluginStore } from "@/stores/plugins";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ElMessage } from "element-plus";
import type { ImageInfo } from "@/stores/crawler";

interface Props {
  modelValue: boolean;
  image: ImageInfo | null;
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const pluginStore = usePluginStore();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});

const plugins = computed(() => pluginStore.plugins);

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

const formatDate = (timestamp: number) => {
  // Rust 返回的是秒级时间戳，需要转换为毫秒
  const milliseconds = timestamp * 1000;
  return new Date(milliseconds).toLocaleString("zh-CN");
};

// 检查 URL 是否以 file:// 开头
const isFileUrl = (url: string) => {
  return url && url.toLowerCase().startsWith('file://');
};

// 打开 URL
const handleOpenUrl = async (url: string) => {
  if (!url) return;
  try {
    await open(url);
  } catch (error) {
    console.error("打开 URL 失败:", error);
    ElMessage.error("打开 URL 失败");
  }
};

// 打开本地路径
const handleOpenPath = async (path: string) => {
  if (!path) return;
  try {
    await invoke("open_file_path", { filePath: path });
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error("打开文件失败");
  }
};
</script>

<style scoped lang="scss">
.image-detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;

  .detail-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .detail-label {
    font-weight: 500;
    color: var(--anime-text-secondary);
    min-width: 80px;
    flex-shrink: 0;
  }

  .detail-value {
    color: var(--anime-text-primary);
    word-break: break-all;
    flex: 1;

    &.clickable-link {
      color: var(--anime-primary);
      cursor: pointer;
      text-decoration: underline;
      transition: color 0.3s ease;

      &:hover {
        color: var(--anime-primary-dark);
      }
    }
  }

  .detail-metadata {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
  }

  .metadata-item {
    display: flex;
    gap: 8px;
    padding: 8px;
    background: var(--anime-bg-card);
    border-radius: 4px;
  }

  .metadata-key {
    font-weight: 500;
    color: var(--anime-text-secondary);
    min-width: 100px;
    flex-shrink: 0;
  }

  .metadata-value {
    color: var(--anime-text-primary);
    word-break: break-all;
    flex: 1;
  }
}
</style>
