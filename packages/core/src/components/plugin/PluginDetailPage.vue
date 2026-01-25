<template>
  <TabLayout :title="title" :subtitle="subtitle" :show-back="showBack" @back="$emit('back')">
    <template #icon>
      <div v-if="plugin?.icon" class="plugin-icon-wrap">
        <el-image :src="plugin.icon" fit="contain" class="plugin-icon-image" />
      </div>
      <div v-else class="plugin-icon-placeholder">
        <el-icon>
          <Grid />
        </el-icon>
      </div>
    </template>

    <template #actions>
      <div v-if="plugin && !plugin.isBuiltIn" class="header-actions">
        <el-tooltip content="卸载" placement="bottom" v-if="showUninstall && installed">
          <el-button :icon="Delete" circle type="danger" @click="$emit('uninstall')" />
        </el-tooltip>
      </div>
    </template>

    <div v-if="showSkeleton" class="loading">
      <el-skeleton :rows="5" animated />
    </div>

    <div v-else-if="!loading && !plugin" class="empty">
      <el-empty :description="emptyDescription" />
    </div>

    <div v-else class="plugin-detail-content">
      <!-- 基本信息 -->
      <div class="plugin-info-section">
        <PluginDetail v-if="plugin" :show-header="false" :plugin-id="plugin.id" :name="plugin.name"
          :description="plugin.desp" :base-url="plugin.baseUrl" :installed="installed" :show-copy-id="true"
          :show-primary-action="true" :primary-action-loading="installing" :primary-action-disabled="installing"
          :primary-action-text="installing ? installingText : installText" @primary-action="$emit('install')"
          @copy-id="$emit('copy-id', $event)">
          <template #copy-id-button="{ pluginId }">
            <el-button :icon="DocumentCopy" circle size="small" title="复制插件ID" @click="$emit('copy-id', pluginId)" />
          </template>
          <template v-if="$slots['detail-extra-items']" #extra-items>
            <slot name="detail-extra-items" />
          </template>
          <template v-if="$slots['detail-actions']" #actions>
            <slot name="detail-actions" />
          </template>
        </PluginDetail>
      </div>

      <!-- 文档 -->
      <div class="plugin-doc-section">
        <PluginDocRenderer v-if="plugin?.doc" :markdown="plugin.doc" :load-image-bytes="loadDocImageBytes"
          :empty-description="docEmptyDescription" />
        <el-empty v-else :description="docEmptyDescription" :image-size="100" />
      </div>
    </div>
  </TabLayout>
</template>

<script setup lang="ts">
import { Delete, DocumentCopy, Grid } from "@element-plus/icons-vue";
import TabLayout from "../../layouts/TabLayout.vue";
import PluginDetail from "./PluginDetail.vue";
import PluginDocRenderer from "./PluginDocRenderer.vue";

type PluginVm = {
  id: string;
  name: string;
  desp: string;
  icon?: string;
  doc?: string;
  baseUrl?: string;
  isBuiltIn?: boolean;
};

type LoadImageBytes = (imagePath: string) => Promise<Uint8Array | number[]>;


withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    showBack?: boolean;

    loading: boolean;
    showSkeleton: boolean;
    plugin: PluginVm | null;

    installed: boolean;
    installing: boolean;
    showUninstall?: boolean;

    installText?: string;
    installingText?: string;
    emptyDescription?: string;
    docEmptyDescription?: string;

    loadDocImageBytes?: LoadImageBytes;
  }>(),
  {
    showBack: false,
    showUninstall: true,
    installText: "安装",
    installingText: "安装中...",
    emptyDescription: "源不存在",
    docEmptyDescription: "该源暂无文档",
  }
);

defineEmits<{
  (e: "back"): void;
  (e: "install"): void;
  (e: "uninstall"): void;
  (e: "copy-id", pluginId: string): void;
}>();
</script>

<style scoped lang="scss">
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-icon-wrap,
.plugin-icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.plugin-icon-image {
  width: 100%;
  height: 100%;
}

.plugin-icon-placeholder {
  background: linear-gradient(135deg,
      rgba(255, 107, 157, 0.2) 0%,
      rgba(167, 139, 250, 0.2) 100%);
  color: var(--anime-primary);
  font-size: 32px;
}

.plugin-detail-content {
  background: var(--anime-bg-card);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--anime-shadow);

  .loading {
    padding: 40px;
  }

  .empty {
    padding: 40px;
    text-align: center;
  }

  .plugin-info-section {
    margin-bottom: 32px;
  }

  .plugin-doc-section {
    border-top: 1px solid var(--anime-border);
    padding-top: 20px;
  }
}
</style>
