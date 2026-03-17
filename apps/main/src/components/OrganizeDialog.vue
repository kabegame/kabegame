<template>
    <!-- Android：自研全宽抽屉，不显示右上角关闭按钮，关闭靠遮罩/返回 -->
    <AndroidDrawer v-if="IS_ANDROID" v-model="visible" show-close-button class="organize-dialog">
        <template #header>
            <div class="organize-drawer-header">
                <h3>{{ $t('gallery.organizeGallery') }}</h3>
            </div>
        </template>
        <div class="organize-form">
            <div class="organize-options">
                <div class="option-item">
                    <el-checkbox v-model="options.dedupe" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.dedupe') }}</div>
                        <div class="option-desc">{{ $t('gallery.dedupeDesc') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.removeMissing" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.removeMissing') }}</div>
                        <div class="option-desc">{{ $t('gallery.removeMissingDesc') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.regenThumbnails" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.regenThumbnails') }}</div>
                        <div class="option-desc">{{ $t('gallery.regenThumbnailsDesc') }}</div>
                    </div>
                </div>
            </div>
            <div class="organize-dialog-footer">
                <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
                <el-button type="primary" @click="handleConfirm" :loading="loading">{{ $t('gallery.startOrganize') }}</el-button>
            </div>
        </div>
    </AndroidDrawer>

    <!-- 桌面端：标准对话框 -->
    <el-dialog v-else v-model="visible" :title="$t('gallery.organizeGallery')" width="480px" destroy-on-close>
        <div class="organize-form">
            <div class="organize-options">
                <div class="option-item">
                    <el-checkbox v-model="options.dedupe" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.dedupe') }}</div>
                        <div class="option-desc">{{ $t('gallery.dedupeDescDesktop') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.removeMissing" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.removeMissing') }}</div>
                        <div class="option-desc">{{ $t('gallery.removeMissingDescDesktop') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.regenThumbnails" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.regenThumbnails') }}</div>
                        <div class="option-desc">{{ $t('gallery.regenThumbnailsDesc') }}</div>
                    </div>
                </div>
            </div>
        </div>
        <template #footer>
            <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
            <el-button type="primary" @click="handleConfirm" :loading="loading">{{ $t('gallery.startOrganize') }}</el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from "vue";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import { IS_ANDROID } from "@kabegame/core/env";

interface Props {
    modelValue: boolean;
    loading?: boolean;
}

interface OrganizeOptions {
    dedupe: boolean;
    removeMissing: boolean;
    regenThumbnails: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    loading: false,
});

const emit = defineEmits<{
    "update:modelValue": [value: boolean];
    confirm: [options: OrganizeOptions];
}>();

const visible = ref(false);
const options = reactive<OrganizeOptions>({
    dedupe: true, // 默认开启去重
    removeMissing: true, // 默认开启清除失效
    regenThumbnails: true, // 默认开启补充缩略图
});

// 同步 visible 与 modelValue
watch(
    () => props.modelValue,
    (newVal) => {
        visible.value = newVal;
    }
);

watch(visible, (newVal) => {
    emit("update:modelValue", newVal);
});

const handleConfirm = () => {
    emit("confirm", { ...options });
};
</script>

<style scoped lang="scss">
.organize-dialog {
    --el-drawer-padding-primary: 20px;
}

.organize-drawer-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--el-border-color-light);
    margin: -20px -20px 20px -20px;

    h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--el-text-color-primary);
    }
}

.organize-form {
    .organize-options {
        .option-item {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 16px 0;
            border-bottom: 1px solid var(--el-border-color-lighter);

            &:last-child {
                border-bottom: none;
            }

            .option-content {
                flex: 1;

                .option-title {
                    font-weight: 500;
                    color: var(--el-text-color-primary);
                    margin-bottom: 4px;
                }

                .option-desc {
                    font-size: 14px;
                    color: var(--el-text-color-regular);
                    line-height: 1.4;
                }
            }
        }
    }

    .organize-dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        padding-top: 20px;
        border-top: 1px solid var(--el-border-color-lighter);
        margin-top: 20px;
    }
}
</style>