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
                <el-descriptions-item :label="t('plugins.detailPluginIdLabel')">
                    <div class="plugin-id-container">
                        <span class="plugin-id-text">{{ pluginId }}</span>
                        <template v-if="showCopyId">
                            <slot name="copy-id-button" :plugin-id="pluginId">
                                <el-button circle size="small" :title="t('plugins.detailCopyId')" @click="$emit('copy-id', pluginId)">
                                    {{ t('plugins.detailCopyAction') }}
                                </el-button>
                            </slot>
                        </template>
                    </div>
                </el-descriptions-item>

                <el-descriptions-item :label="t('plugins.detailNameLabel')">
                    {{ name }}
                </el-descriptions-item>

                <el-descriptions-item v-if="version" :label="t('plugins.detailVersionLabel')">
                    {{ version }}
                </el-descriptions-item>

                <el-descriptions-item :label="t('plugins.detailDescriptionLabel')">
                    {{ description || t('plugins.noDescription') }}
                </el-descriptions-item>

                <el-descriptions-item :label="t('plugins.detailStatusLabel')">
                    <el-tag v-if="installed" type="success">{{ t('plugins.installed') }}</el-tag>
                    <el-tag v-else type="info">{{ t('plugins.notInstalled') }}</el-tag>
                </el-descriptions-item>

                <el-descriptions-item v-if="baseUrl" :label="t('plugins.detailCrawlUrlLabel')">
                    <span class="source-url-link" role="button" @click="handleOpenBaseUrl(baseUrl)">
                        {{ baseUrl }}
                    </span>
                </el-descriptions-item>

                <slot name="extra-items" />
            </el-descriptions>

            <div class="actions">
                <slot name="actions">
                    <el-button v-if="showPrimaryAction && !installed" type="primary"
                        :class="{ 'plugin-detail-install-btn--progress': primaryActionProgressPercent != null }"
                        :loading="primaryActionLoading && primaryActionProgressPercent == null"
                        :disabled="primaryActionLoading || primaryActionDisabled" @click="$emit('primary-action')">
                        <span v-if="primaryActionProgressPercent != null" class="plugin-detail-install-btn__fill-wrap">
                            <span class="plugin-detail-install-btn__fill"
                                :style="{ width: `${Math.min(100, Math.max(0, primaryActionProgressPercent))}%` }" />
                            <span class="plugin-detail-install-btn__label">{{ primaryActionText || t('plugins.install')
                            }}</span>
                        </span>
                        <span v-else>{{ primaryActionText || t('plugins.install') }}</span>
                    </el-button>
                </slot>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElMessage } from "element-plus";

const { t } = useI18n();

const handleOpenBaseUrl = async (url: string) => {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("打开链接失败:", error);
    ElMessage.error(t("common.openUrlFailed"));
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
    /** 商店下载进度 0–100，有值时主按钮显示流式进度条 */
    primaryActionProgressPercent?: number | null;
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

    .plugin-detail-install-btn--progress {
        position: relative;
        overflow: hidden;
        padding: 5px 14px;
        min-width: 132px;
    }

    .plugin-detail-install-btn__fill-wrap {
        position: relative;
        display: block;
        width: 100%;
        min-width: 104px;
        min-height: 22px;
        border-radius: 4px;
        overflow: hidden;
        background: rgba(0, 0, 0, 0.14);
    }

    .plugin-detail-install-btn__fill {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 0;
        border-radius: 0 3px 3px 0;
        pointer-events: none;
        transition: width 0.22s ease-out;
        z-index: 0;
        background: linear-gradient(90deg,
                rgba(255, 255, 255, 0.52) 0%,
                rgba(255, 255, 255, 0.22) 100%);
    }

    .plugin-detail-install-btn__label {
        position: relative;
        z-index: 1;
        display: block;
        font-size: 12px;
        line-height: 22px;
        text-align: center;
        white-space: nowrap;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    }
}
</style>
