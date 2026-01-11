<template>
    <div v-if="showPaginator" class="gallery-big-paginator" :class="{ 'is-sticky': isSticky }">
        <div class="paginator-content">
            <button class="nav-button prev" :disabled="currentBigPage === 1" @click="handlePrevPage">
                <el-icon>
                    <ArrowLeft />
                </el-icon>
                <span>上一页</span>
            </button>

            <div class="paginator-info">
                <div class="page-number">
                    <el-input-number ref="pageInputRef" v-model="inputPage" :min="1" :max="totalBigPages" :precision="0"
                        size="small" class="page-input-inline" @change="handleJumpToPage" />
                    <span class="separator">/</span>
                    <span class="total">{{ totalBigPages }}</span>
                </div>
            </div>

            <button class="nav-button next" :disabled="currentBigPage === totalBigPages" @click="handleNextPage">
                <span>下一页</span>
                <el-icon>
                    <ArrowRight />
                </el-icon>
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, ArrowRight } from "@element-plus/icons-vue";

interface Props {
    totalCount: number;
    currentOffset: number;
    bigPageSize?: number;
    isSticky?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    bigPageSize: 10000,
    isSticky: false,
});

const emit = defineEmits<{
    jumpToPage: [page: number];
}>();

const BIG_PAGE_SIZE = computed(() => props.bigPageSize);

// 总共有多少大页
const totalBigPages = computed(() => {
    return Math.max(1, Math.ceil(props.totalCount / BIG_PAGE_SIZE.value));
});

// 当前在第几大页（从1开始）
const currentBigPage = computed(() => {
    return Math.floor(props.currentOffset / BIG_PAGE_SIZE.value) + 1;
});


// 是否显示分页器（总数超过一页才显示）
const showPaginator = computed(() => {
    return props.totalCount > BIG_PAGE_SIZE.value;
});

const pageInputRef = ref<any>(null);
// 跳转输入框的值
const inputPage = ref(currentBigPage.value);

// 监听当前页变化，同步输入框
watch(
    () => currentBigPage.value,
    (newPage) => {
        // 只有当输入框值不等于新页数时才更新，避免用户输入时被重置
        if (inputPage.value !== newPage) {
            inputPage.value = newPage;
        }
    }
);

// 上一页
const handlePrevPage = () => {
    if (currentBigPage.value > 1) {
        emit("jumpToPage", currentBigPage.value - 1);
    }
};

// 下一页
const handleNextPage = () => {
    if (currentBigPage.value < totalBigPages.value) {
        emit("jumpToPage", currentBigPage.value + 1);
    }
};

// 跳转到指定页
const handleJumpToPage = (page: number | null | undefined) => {
    if (page === null || page === undefined) return;
    const targetPage = Math.max(1, Math.min(totalBigPages.value, page));
    if (targetPage !== currentBigPage.value) {
        emit("jumpToPage", targetPage);
    }
};
</script>

<style scoped lang="scss">
.gallery-big-paginator {
    padding: 8px 12px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 243, 248, 0.95) 100%);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--anime-border);
    z-index: 99;
    transition: all 0.3s ease;

    &.is-sticky {
        position: sticky;
        // PageHeader 高度 64px + margin-bottom 20px = 84px，但由于在 before-grid 内，实际需要粘在 header 下方
        top: 64px;
        box-shadow: 0 2px 8px rgba(255, 107, 157, 0.12);
    }
}

.paginator-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    max-width: 1200px;
    margin: 0 auto;
}

.nav-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--anime-text-primary);
    background: rgba(255, 255, 255, 0.8);
    border: 1.5px solid var(--anime-border);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    white-space: nowrap;

    &:hover:not(:disabled) {
        background: linear-gradient(135deg, rgba(255, 107, 157, 0.1) 0%, rgba(167, 139, 250, 0.1) 100%);
        border-color: var(--anime-primary-light);
        color: var(--anime-primary);
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(255, 107, 157, 0.2);
    }

    &:active:not(:disabled) {
        transform: translateY(0);
        box-shadow: 0 1px 4px rgba(255, 107, 157, 0.15);
    }

    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        background: rgba(255, 255, 255, 0.5);
    }

    .el-icon {
        font-size: 14px;
        transition: transform 0.3s ease;
    }

    &:hover:not(:disabled) .el-icon {
        transform: scale(1.1);
    }

    &.prev:hover:not(:disabled) .el-icon {
        transform: translateX(-2px) scale(1.1);
    }

    &.next:hover:not(:disabled) .el-icon {
        transform: translateX(2px) scale(1.1);
    }
}

.paginator-info {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-width: 120px;
    padding: 0 8px;
}

.page-number {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-weight: 600;
    line-height: 1.2;

    .separator {
        font-size: 14px;
        color: var(--anime-text-muted);
        font-weight: 500;
        opacity: 0.6;
    }

    .total {
        font-size: 14px;
        color: var(--anime-text-secondary);
        font-weight: 600;
    }
}

.page-input-inline {
    width: 70px;

    :deep(.el-input__wrapper) {
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 0;
        transition: all 0.3s ease;

        &:hover {
            background: rgba(255, 107, 157, 0.05);
            border: 1px solid transparent;
        }

        &.is-focus {
            background: rgba(255, 255, 255, 0.95);
            border: 2px solid var(--anime-primary);
            box-shadow: 0 0 0 2px rgba(255, 107, 157, 0.2);
        }
    }

    :deep(.el-input__inner) {
        text-align: center;
        font-weight: 700;
        font-size: 18px;
        color: var(--anime-primary);
        padding: 2px 6px;
        height: auto;
        background: transparent;
        border: none;
    }

    :deep(.el-input-number__increase),
    :deep(.el-input-number__decrease) {
        display: none;
    }
}

// 响应式设计
@media (max-width: 768px) {
    .paginator-content {
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
    }

    .paginator-info {
        order: -1;
        width: 100%;
        flex: none;
        min-width: auto;
        padding: 4px 0;
    }

    .nav-button {
        flex: 1;
        min-width: 100px;
    }
}
</style>
