<template>
    <div class="setting-row">
        <div class="setting-meta">
            <div class="label">
                {{ label }}
                <el-tooltip v-if="description" :content="description" placement="top">
                    <el-icon class="help-icon">
                        <QuestionFilled />
                    </el-icon>
                </el-tooltip>
            </div>
        </div>
        <div class="setting-control">
            <slot />
        </div>
    </div>
</template>

<script setup lang="ts">
import { QuestionFilled } from "@element-plus/icons-vue";

defineProps<{
    label: string;
    description?: string;
}>();
</script>

<style scoped lang="scss">
.setting-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 0;
}

.setting-meta {
    // flex-shrink: 1;
    // min-width: 180px;
}

.label {
    font-weight: 600;
    color: var(--anime-text-primary);
    line-height: 1.3;
    display: flex;
    align-items: center;
    gap: 6px;
}

.help-icon {
    color: var(--anime-text-muted);
    font-size: 14px;
    cursor: help;
    flex-shrink: 0;
}

.setting-control {
    // flex-shrink: 0;
    // min-width: 260px;
    display: flex;
    justify-content: flex-end;
}

@media (max-width: 720px) {
    .setting-row {
        flex-direction: column;
    }

    .setting-meta {
        min-width: 0;
    }

    .setting-control {
        width: 100%;
        min-width: 0;
        justify-content: flex-start;
    }
}
</style>
