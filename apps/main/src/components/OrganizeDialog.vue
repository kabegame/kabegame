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
                    <el-checkbox v-model="options.removeUnrecognized" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.removeUnrecognized') }}</div>
                        <div class="option-desc">{{ $t('gallery.removeUnrecognizedDesc') }}</div>
                        <div class="option-slow-hint">{{ $t('gallery.removeUnrecognizedSlowHint') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.regenThumbnails" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.regenThumbnails') }}</div>
                        <div class="option-desc">{{ $t('gallery.regenThumbnailsDesc') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.deleteSourceFiles" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.deleteSourceFiles') }}</div>
                        <div class="option-desc">{{ $t('gallery.deleteSourceFilesDesc') }}</div>
                    </div>
                </div>
                <div v-if="options.deleteSourceFiles" class="option-sub-block">
                    <div class="option-item">
                        <el-checkbox v-model="options.safeDelete" />
                        <div class="option-content">
                            <div class="option-title">{{ $t('gallery.safeDelete') }}</div>
                            <div class="option-desc">{{ $t('gallery.safeDeleteDesc') }}</div>
                            <div class="option-slow-hint">{{ $t('gallery.safeDeleteSlowHint') }}</div>
                        </div>
                    </div>
                </div>
            </div>
            <div v-if="showRangeSlider" class="organize-range">
                <div class="option-title">{{ $t('gallery.organizeRange') }}</div>
                <div class="option-desc organize-range-desc">{{ $t('gallery.organizeRangeDesc', { total: totalCount }) }}</div>
                <el-slider
                    v-model="rangeValue"
                    range
                    :min="0"
                    :max="totalCount"
                    :step="1000"
                    @change="onRangeChange"
                />
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
                    <el-checkbox v-model="options.removeUnrecognized" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.removeUnrecognized') }}</div>
                        <div class="option-desc">{{ $t('gallery.removeUnrecognizedDescDesktop') }}</div>
                        <div class="option-slow-hint">{{ $t('gallery.removeUnrecognizedSlowHint') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.regenThumbnails" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.regenThumbnails') }}</div>
                        <div class="option-desc">{{ $t('gallery.regenThumbnailsDesc') }}</div>
                    </div>
                </div>
                <div class="option-item">
                    <el-checkbox v-model="options.deleteSourceFiles" />
                    <div class="option-content">
                        <div class="option-title">{{ $t('gallery.deleteSourceFiles') }}</div>
                        <div class="option-desc">{{ $t('gallery.deleteSourceFilesDescDesktop') }}</div>
                    </div>
                </div>
                <div v-if="options.deleteSourceFiles" class="option-sub-block">
                    <div class="option-item">
                        <el-checkbox v-model="options.safeDelete" />
                        <div class="option-content">
                            <div class="option-title">{{ $t('gallery.safeDelete') }}</div>
                            <div class="option-desc">{{ $t('gallery.safeDeleteDesc') }}</div>
                            <div class="option-slow-hint">{{ $t('gallery.safeDeleteSlowHint') }}</div>
                        </div>
                    </div>
                </div>
            </div>
            <div v-if="showRangeSlider" class="organize-range">
                <div class="option-title">{{ $t('gallery.organizeRange') }}</div>
                <div class="option-desc organize-range-desc">{{ $t('gallery.organizeRangeDesc', { total: totalCount }) }}</div>
                <el-slider
                    v-model="rangeValue"
                    range
                    :min="0"
                    :max="totalCount"
                    :step="1000"
                    @change="onRangeChange"
                />
            </div>
        </div>
        <template #footer>
            <el-button @click="visible = false">{{ $t('common.cancel') }}</el-button>
            <el-button type="primary" @click="handleConfirm" :loading="loading">{{ $t('gallery.startOrganize') }}</el-button>
        </template>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import { IS_ANDROID } from "@kabegame/core/env";

interface Props {
    modelValue: boolean;
    loading?: boolean;
}

interface OrganizeOptions {
    dedupe: boolean;
    removeMissing: boolean;
    removeUnrecognized: boolean;
    regenThumbnails: boolean;
    deleteSourceFiles: boolean;
    safeDelete: boolean;
    rangeStart: number | null;
    rangeEnd: number | null;
}

const props = withDefaults(defineProps<Props>(), {
    loading: false,
});

const emit = defineEmits<{
    "update:modelValue": [value: boolean];
    confirm: [options: OrganizeOptions];
}>();

const visible = ref(false);
const totalCount = ref(0);
const rangeValue = ref<[number, number]>([0, 0]);

const options = reactive({
    dedupe: true, // 默认开启去重
    removeMissing: true, // 默认开启清除失效
    removeUnrecognized: false,
    regenThumbnails: true, // 默认开启补充缩略图
    deleteSourceFiles: false,
    safeDelete: true,
});

const showRangeSlider = computed(() => totalCount.value > 4000);

function clampRangePair(val: [number, number]): [number, number] {
    const max = totalCount.value;
    if (max <= 0) {
        return [0, 0];
    }
    let [a, b] = val;
    a = Math.max(0, Math.min(a, max));
    b = Math.max(0, Math.min(b, max));
    if (b < a) {
        [a, b] = [b, a];
    }
    const minSpan = Math.min(1000, max);
    if (b - a < minSpan) {
        b = Math.min(a + minSpan, max);
        if (b - a < minSpan) {
            a = Math.max(0, b - minSpan);
        }
    }
    return [a, b];
}

function onRangeChange(val: number | [number, number]) {
    if (!Array.isArray(val)) return;
    rangeValue.value = clampRangePair(val);
}

// 同步 visible 与 modelValue
watch(
    () => props.modelValue,
    async (newVal) => {
        visible.value = newVal;
        if (newVal) {
            try {
                const n = await invoke<number>("get_organize_total_count");
                totalCount.value = n;
                rangeValue.value = clampRangePair([0, n]);
            } catch {
                totalCount.value = 0;
                rangeValue.value = [0, 0];
            }
        }
    }
);

watch(visible, (newVal) => {
    emit("update:modelValue", newVal);
});

const handleConfirm = () => {
    const payload: OrganizeOptions = {
        dedupe: options.dedupe,
        removeMissing: options.removeMissing,
        removeUnrecognized: options.removeUnrecognized,
        regenThumbnails: options.regenThumbnails,
        deleteSourceFiles: options.deleteSourceFiles,
        safeDelete: options.safeDelete,
        rangeStart: null,
        rangeEnd: null,
    };
    if (showRangeSlider.value) {
        const [a, b] = clampRangePair(rangeValue.value);
        const full = a === 0 && b === totalCount.value;
        if (!full) {
            payload.rangeStart = a;
            payload.rangeEnd = b;
        }
    }
    emit("confirm", payload);
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
    .organize-range {
        padding: 12px 0 8px;
        border-top: 1px solid var(--el-border-color-lighter);

        .organize-range-desc {
            margin-bottom: 12px;
        }
    }

    .organize-options {
        .option-sub-block {
            padding-left: 28px;
            margin-top: -8px;
            margin-bottom: 8px;
        }

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

                .option-slow-hint {
                    font-size: 13px;
                    color: var(--el-text-color-secondary);
                    line-height: 1.4;
                    margin-top: 6px;
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
