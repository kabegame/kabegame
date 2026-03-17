<template>
    <div class="plugin-detail">
        <div v-if="showHeader" class="header">
            <div class="icon">
                <el-image v-if="iconUrl" :src="iconUrl" fit="contain" class="icon-image" />
                <div v-else class="icon-placeholder">KG</div>
            </div>

            <div class="header-main">
                <div class="name">{{ name }}</div>
                <div class="id">{{ pluginId }}</div>
            </div>

            <div class="header-actions">
                <slot name="header-actions" />
            </div>
        </div>

        <div class="body">
            <el-descriptions :column="1" border>
                <el-descriptions-item label="插件ID">
                    <div class="plugin-id-container">
                        <span class="plugin-id-text">{{ pluginId }}</span>
                        <template v-if="showCopyId">
                            <slot name="copy-id-button" :plugin-id="pluginId">
                                <el-button circle size="small" title="复制插件ID" @click="$emit('copy-id', pluginId)">
                                    复制
                                </el-button>
                            </slot>
                        </template>
                    </div>
                </el-descriptions-item>

                <el-descriptions-item label="名称">
                    {{ name }}
                </el-descriptions-item>

                <el-descriptions-item v-if="version" label="版本">
                    {{ version }}
                </el-descriptions-item>

                <el-descriptions-item label="描述">
                    {{ description || "无描述" }}
                </el-descriptions-item>

                <el-descriptions-item :label="t('plugins.detailStatusLabel')">
                    <el-tag v-if="installed" type="success">{{ t('plugins.installed') }}</el-tag>
                    <el-tag v-else type="info">{{ t('plugins.notInstalled') }}</el-tag>
                </el-descriptions-item>

                <el-descriptions-item v-if="baseUrl" label="爬取地址">
                    <span class="source-url-link" role="button" @click="handleOpenBaseUrl(baseUrl)">
                        {{ baseUrl }}
                    </span>
                </el-descriptions-item>

                <slot name="extra-items" />
            </el-descriptions>

            <div class="actions">
                <slot name="actions">
                    <el-button v-if="showPrimaryAction && !installed" type="primary" :loading="primaryActionLoading"
                        :disabled="primaryActionLoading || primaryActionDisabled" @click="$emit('primary-action')">
                        {{ primaryActionText || "安装" }}
                    </el-button>
                </slot>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { inject } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElMessage } from "element-plus";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
const t = inject<TranslateFn>("i18n-t") ?? ((k: string) => k);

const handleOpenBaseUrl = async (url: string) => {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("打开链接失败:", error);
    ElMessage.error("打开链接失败");
  }
};

defineProps<{
    pluginId: string;
    name: string;
    description?: string | null;
    version?: string | null;
    baseUrl?: string | null;
    iconUrl?: string | null;
    installed: boolean;
    showHeader?: boolean;
    showCopyId?: boolean;
    showPrimaryAction?: boolean;
    primaryActionText?: string;
    primaryActionLoading?: boolean;
    primaryActionDisabled?: boolean;
}>();

defineEmits<{
    (e: "primary-action"): void;
    (e: "copy-id", pluginId: string): void;
}>();
</script>

<style scoped>
.plugin-detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.header {
    display: flex;
    align-items: center;
    gap: 12px;
}

.icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
}

.icon-image {
    width: 44px;
    height: 44px;
}

.icon-placeholder {
    font-weight: 800;
    opacity: 0.85;
    font-size: 14px;
}

.header-main {
    min-width: 0;
    flex: 1;
}

.name {
    font-weight: 800;
    font-size: 14px;
    line-height: 1.2;
}

.id {
    margin-top: 2px;
    font-size: 12px;
    opacity: 0.7;
    word-break: break-all;
}

.header-actions {
    flex: none;
}

.body {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.plugin-id-container {
    display: flex;
    align-items: center;
    gap: 8px;
}

.plugin-id-text {
    word-break: break-all;
}

.source-url-link {
    color: inherit;
    text-decoration: underline;
    word-break: break-all;
    cursor: pointer;
}

.actions {
    display: flex;
    align-items: center;
    gap: 10px;
}
</style>
