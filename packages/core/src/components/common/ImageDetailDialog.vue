<template>
  <el-dialog v-model="visible" :title="t('gallery.imageDetailTitle')" width="600px">
    <div v-if="image" class="image-detail-content">
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailSource') }}</span>
        <span class="detail-value">{{ getPluginName(image.pluginId) }}</span>
      </div>
      <div v-if="image.url && !isFileUrl(image.url)" class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailUrl') }}</span>
        <span class="detail-value clickable-link" @click="handleOpenUrl(image.url)">{{ image.url }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailLocalPath') }}</span>
        <span class="detail-value clickable-link" @click="handleOpenPath(image.localPath)">{{ image.localPath }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailCrawledAt') }}</span>
        <span class="detail-value">{{ formatDate(image.crawledAt) }}</span>
      </div>
      <div v-if="image.metadata && Object.keys(image.metadata).length > 0" class="detail-item">
        <span class="detail-label">{{ t('gallery.imageDetailMetadata') }}</span>
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
import { computed, inject } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElMessage } from "element-plus";
import { IS_ANDROID } from "../../env";
import { openImage } from "tauri-plugin-picker-api";
import { useModalBack } from "../../composables/useModalBack";
import type { PluginManifestText } from "../../stores/plugins";

type TranslateFn = (key: string) => string;
const t = inject<TranslateFn>("i18n-t") ?? ((k: string) => k);
const localeRef = inject<{ value: string }>("i18n-locale");
const resolveManifestText = inject<
  (value: PluginManifestText | null | undefined) => string
>("resolveManifestText");

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

type ImageLike = {
  url?: string;
  localPath?: string;
  pluginId?: string;
  crawledAt?: number;
  metadata?: Record<string, string>;
};

interface Props {
  modelValue: boolean;
  image: ImageLike | null;
  plugins?: Array<{ id: string; name?: string }>;
}

interface Emits {
  (e: "update:modelValue", value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit("update:modelValue", value),
});

useModalBack(visible);

const getPluginName = (pluginId?: string) => {
  if (!pluginId) return "unknown";
  const plugin = (props.plugins || []).find((p) => p.id === pluginId);
  if (!plugin) return pluginId;
  const raw = plugin.name;
  if (!raw || typeof raw !== "object") return (raw as string) || pluginId;
  return resolveManifestText ? resolveManifestText(raw) : (raw["default"] ?? pluginId) || pluginId;
};

const formatDate = (timestamp?: number) => {
  // 后端 crawledAt 实际为“下载/导入时间”，单位可能是秒或毫秒（历史数据混用）
  // - 0/无效：按需求显示“银河系末日”
  if (!Number.isFinite(timestamp) || (timestamp as number) <= 0) return t("gallery.imageDetailInvalidDate");
  const ts = timestamp as number;
  const ms = ts > 1e11 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("gallery.imageDetailInvalidDate");
  const loc = localeRef?.value ?? "zh";
  return d.toLocaleString(toLocaleTag(loc));
};

const isFileUrl = (url?: string) => {
  return url && url.toLowerCase().startsWith("file://");
};

const handleOpenUrl = async (url?: string) => {
  if (!url) return;
  try {
    await openUrl(url);
  } catch (error) {
    console.error("打开 URL 失败:", error);
    ElMessage.error(t("common.openUrlFailed"));
  }
};

const handleOpenPath = async (path?: string) => {
  if (!path) return;
  try {
    if (IS_ANDROID) {
      const uri = path.startsWith("content://")
        ? path
        : path.startsWith("/")
          ? `file://${path}`
          : `file:///${path}`;
      await openImage(uri);
    } else {
      await invoke("open_file_path", { filePath: path });
    }
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error(t("common.openFileFailed"));
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

