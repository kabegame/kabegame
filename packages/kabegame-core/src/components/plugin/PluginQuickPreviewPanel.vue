<template>
  <div class="qp-panel" :class="{ 'qp-panel--no-footer': !showFooter }">
    <div class="qp-header">
      <div class="qp-icon">
        <img v-if="iconSrc" :src="iconSrc" alt="" />
        <el-icon v-else><Grid /></el-icon>
      </div>
      <div class="qp-header-text">
        <div class="qp-name-row">
          <span class="qp-name">{{ pluginName(plugin) }}</span>
          <span v-if="updateAvailableVersion" class="qp-update-dot" />
        </div>
        <div class="qp-meta">{{ metaLine }}</div>
      </div>
    </div>

    <p class="qp-desc">{{ pluginDescription(plugin) || t("plugins.noDescription") }}</p>

    <PluginLabelTags v-if="plugin.labels?.length" class="qp-tags" :labels="plugin.labels" size="small" />

    <PluginQuickPreviewCarousel
      class="qp-carousel-slot"
      :images="images"
      :loading="carouselLoading"
      :empty-reason="emptyReason"
      :reset-token="plugin.id"
    />

    <div v-if="showFooter" class="qp-footer">
      <span v-if="updateAvailableVersion" class="qp-footer-update">
        {{ t("plugins.quickPreview.canUpdateTo", { version: updateAvailableVersion }) }}
      </span>
      <span v-if="showDetailHint" class="qp-footer-hint">
        {{ t("plugins.quickPreview.viewDetails") }}
        <el-icon><ArrowRight /></el-icon>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElIcon } from "@kabegame/element-plus";
import { ArrowRight, Grid } from "@kabegame/element-plus-icons";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import PluginLabelTags from "./PluginLabelTags.vue";
import PluginQuickPreviewCarousel, {
  type PluginQuickPreviewImage,
} from "./PluginQuickPreviewCarousel.vue";
import type { PluginManifestText } from "../../stores/plugins";
import type { PluginLabel } from "../../stores/pluginLabels";

/** 已安装 Plugin 与商店 StorePluginResolved 的最小公共形状（结构化类型，两侧均满足） */
export interface QuickPreviewPluginLike {
  id: string;
  name: PluginManifestText;
  description: PluginManifestText;
  version: string;
  baseUrl?: string | null;
  labels?: PluginLabel[];
}

const props = withDefaults(
  defineProps<{
    plugin: QuickPreviewPluginLike;
    iconSrc?: string | null;
    images: PluginQuickPreviewImage[];
    carouselLoading?: boolean;
    emptyReason?: "no-assets" | "not-installed" | null;
    /** 已知的可更新版本号；未知或已是最新则为 null，面板只显示"点击查看详情" */
    updateAvailableVersion?: string | null;
    /** 面板点击后不会跳转详情时（如插件选择器里的预览）关掉这行提示 */
    showDetailHint?: boolean;
  }>(),
  { showDetailHint: true },
);

/** 页脚两项都没有就整条去掉，改由面板自身补底部内边距 */
const showFooter = computed(() => props.showDetailHint || !!props.updateAvailableVersion);

const { t } = useI18n();
const { pluginName, pluginDescription } = usePluginManifestI18n();

/** 从 baseUrl 提取展示用域名；商店条目通常没有 baseUrl，直接省略这一段 */
const siteHost = computed(() => {
  const raw = props.plugin.baseUrl;
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
});

const metaLine = computed(() => {
  const host = siteHost.value;
  return host ? `v${props.plugin.version} · ${host}` : `v${props.plugin.version}`;
});
</script>

<style scoped lang="scss">
.qp-panel {
  width: 320px;
  border-radius: 18px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.06);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.qp-panel--no-footer {
  padding-bottom: 16px;
}

.qp-header {
  padding: 16px 16px 12px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.qp-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--el-fill-color-light);
  flex: none;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  color: var(--el-text-color-placeholder);
}

.qp-icon img {
  width: 30px;
  height: 30px;
  object-fit: contain;
}

.qp-header-text {
  flex: 1;
  min-width: 0;
}

.qp-name-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.qp-name {
  font: 600 14.5px/1.35 var(--kb-font-sans, sans-serif);
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.qp-update-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-danger);
}

.qp-meta {
  margin-top: 3px;
  font: 400 11.5px/1.3 ui-monospace, Menlo, monospace;
  color: var(--el-text-color-secondary);
}

.qp-desc {
  padding: 0 16px 12px;
  font: 400 12.5px/1.6 var(--kb-font-sans, sans-serif);
  color: var(--el-text-color-regular);
  text-wrap: pretty;
}

.qp-tags {
  padding: 0 16px 12px;
}

.qp-carousel-slot {
  margin: 0 16px;
}

.qp-footer {
  margin-top: 14px;
  padding: 11px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
  display: flex;
  align-items: center;
  gap: 8px;
  font: 400 12px/1 var(--kb-font-sans, sans-serif);
  color: var(--el-text-color-secondary);
}

.qp-footer-update {
  color: var(--el-color-danger);
}

.qp-footer-hint {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
</style>
