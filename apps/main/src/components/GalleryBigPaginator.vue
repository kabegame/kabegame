<template>
    <div v-if="showPaginator" class="gallery-big-paginator" :class="{ 'is-sticky': isSticky, 'is-android': isCompact }">
        <div class="paginator-content">
            <button class="nav-button prev" :disabled="currentBigPage === 1" @click="handlePrevPage">
                <el-icon>
                    <ArrowLeft />
                </el-icon>
                <span v-if="!isCompact">{{ $t('gallery.prevPage') }}</span>
            </button>

            <div class="paginator-info">
                <!-- 桌面：输入框 + 斜杠 + 总页数 -->
                <template v-if="!isCompact">
                    <div class="page-number">
                        <div class="part part-current">
                            <el-input-number ref="pageInputRef" v-model="inputPage" :min="1" :max="totalBigPages" :precision="0"
                                size="small" class="page-input-inline" @change="handleJumpToPage" />
                        </div>
                        <div class="paginator-diagonal" aria-hidden="true" />
                        <div class="part part-total">
                            <span class="total">{{ totalBigPages }}</span>
                        </div>
                    </div>
                </template>
                <!-- Android：点击打开 Vant Picker，按总页数位数多列选择 -->
                <div v-else class="page-number page-number-android" @click="showPagePicker = true">
                    <div class="part part-current">
                        <span class="current-page">{{ currentBigPage }}</span>
                    </div>
                    <div class="paginator-diagonal" aria-hidden="true" />
                    <div class="part part-total">
                        <span class="total">{{ totalBigPages }}</span>
                    </div>
                </div>
            </div>

            <button class="nav-button next" :disabled="currentBigPage === totalBigPages" @click="handleNextPage">
                <span v-if="!isCompact">{{ $t('gallery.nextPage') }}</span>
                <el-icon>
                    <ArrowRight />
                </el-icon>
            </button>
        </div>

        <!-- Android：页码选择器（Vant Picker）；Teleport 到 body 避免受父级 sticky 影响，从页面最底部弹出 -->
        <Teleport v-if="isCompact" to="body">
            <van-popup v-model:show="showPagePicker" position="bottom" round>
                <van-picker
                    v-model="pickerSelectedValues"
                    :title="$t('gallery.jumpToPage')"
                    :columns="pickerColumns"
                    :confirm-button-text="t('common.confirm')"
                    :cancel-button-text="t('common.cancel')"
                    @confirm="onPickerConfirm"
                    @cancel="showPagePicker = false"
                />
            </van-popup>
        </Teleport>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowLeft, ArrowRight } from "@element-plus/icons-vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
    totalCount: number;
    currentPage: number;
    bigPageSize?: number;
    isSticky?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    currentPage: 1,
    bigPageSize: 10000,
    isSticky: false,
});

const emit = defineEmits<{
    jumpToPage: [page: number];
}>();

const { t } = useI18n();

const BIG_PAGE_SIZE = computed(() => props.bigPageSize);
const { isCompact } = storeToRefs(useUiStore());

// 总共有多少大页
const totalBigPages = computed(() => {
    return Math.max(1, Math.ceil(props.totalCount / BIG_PAGE_SIZE.value));
});

// 当前在第几大页（从1开始）
const currentBigPage = computed(() => {
    return Math.max(1, props.currentPage || 1);
});

// 是否显示分页器（总数超过一页才显示）
const showPaginator = computed(() => {
    return props.totalCount > BIG_PAGE_SIZE.value;
});

const pageInputRef = ref<any>(null);
// 跳转输入框的值（桌面）
const inputPage = ref(currentBigPage.value);

// 监听当前页变化，同步输入框
watch(
    () => currentBigPage.value,
    (newPage) => {
        if (inputPage.value !== newPage) {
            inputPage.value = newPage;
        }
    }
);

// --- Android：Vant Picker 按总页数每 10 倍一列 ---
const showPagePicker = ref(false);

useModalBack(showPagePicker);

/** 总页数的位数，即 Picker 列数（1–9→1 列，10–99→2 列，100–999→3 列…） */
const pickerDigitCount = computed(() => {
    const total = totalBigPages.value;
    return total < 10 ? 1 : Math.floor(Math.log10(total)) + 1;
});

/** Picker 级联选项类型（保证选中值在 1～totalBigPages） */
interface PickerCascadeOption {
    text: string;
    value: number;
    children?: PickerCascadeOption[];
}

/** 构建级联列：最小 1、最大 total，避免出现 0 或超过总页数 */
function buildCascadeColumns(total: number, n: number): PickerCascadeOption[] | PickerCascadeOption[][] {
    if (n === 1) {
        return Array.from({ length: total }, (_, i) => ({
            text: String(i + 1),
            value: i + 1,
        }));
    }
    const maxFirst = Math.min(9, Math.floor(total / Math.pow(10, n - 1)));
    const options: PickerCascadeOption[] = [];
    for (let d0 = 0; d0 <= maxFirst; d0++) {
        const base = d0 * Math.pow(10, n - 1);
        const restMax = total - base;
        const restMin = d0 === 0 ? 1 : 0;
        const childScale = Math.pow(10, n - 2);
        const children = buildCascadeLevel(restMin, Math.min(restMax, Math.pow(10, n - 1) - 1), n - 1, childScale);
        options.push({ text: String(d0), value: d0, children });
    }
    return options;
}

function buildCascadeLevel(
    minRest: number,
    maxRest: number,
    depth: number,
    scale: number
): PickerCascadeOption[] {
    if (depth <= 0 || scale < 1) return [];
    if (depth === 1) {
        const low = Math.max(0, minRest);
        const high = Math.min(9, maxRest);
        return Array.from({ length: high - low + 1 }, (_, i) => {
            const v = low + i;
            return { text: String(v), value: v };
        });
    }
    const nextScale = scale / 10;
    const low = Math.max(0, Math.floor(minRest / scale));
    const high = Math.min(9, Math.floor(maxRest / scale));
    const options: PickerCascadeOption[] = [];
    for (let d = low; d <= high; d++) {
        const subMin = Math.max(0, minRest - d * scale);
        const subMax = Math.min(scale - 1, maxRest - d * scale);
        const children = buildCascadeLevel(subMin, subMax, depth - 1, nextScale);
        if (children.length > 0) {
            options.push({ text: String(d), value: d, children });
        }
    }
    return options;
}

/** Picker 各列选项：单列为 [ [{text,value},...] ]，多列为级联数组（保证 1～totalBigPages） */
const pickerColumns = computed(() => {
    const total = totalBigPages.value;
    const n = pickerDigitCount.value;
    const result = buildCascadeColumns(total, n);
    if (n === 1) {
        return [result as PickerCascadeOption[]];
    }
    return result as PickerCascadeOption[];
});

/** 将页码拆成各位数字数组（用于 Picker v-model） */
function pageToDigitValues(page: number, digitCount: number): number[] {
    const total = totalBigPages.value;
    if (digitCount === 1) {
        return [Math.max(1, Math.min(page, total))];
    }
    const arr: number[] = [];
    let p = Math.max(1, Math.min(page, total));
    for (let i = 0; i < digitCount; i++) {
        arr.unshift(p % 10);
        p = Math.floor(p / 10);
    }
    return arr;
}

/** 将各列选中的 value 组合成页码 */
function digitValuesToPage(values: (string | number)[]): number {
    let page = 0;
    for (let i = 0; i < values.length; i++) {
        page = page * 10 + Number(values[i]);
    }
    return page;
}

/** Picker 当前选中值（与 currentBigPage 同步，打开时写入） */
const pickerSelectedValues = ref<number[]>([]);

watch(showPagePicker, (open) => {
    if (open) {
        pickerSelectedValues.value = pageToDigitValues(currentBigPage.value, pickerDigitCount.value);
    }
});

watch([currentBigPage, pickerDigitCount], () => {
    if (showPagePicker.value) {
        pickerSelectedValues.value = pageToDigitValues(currentBigPage.value, pickerDigitCount.value);
    }
});

const onPickerConfirm = ({ selectedValues }: { selectedValues: (string | number)[] }) => {
    showPagePicker.value = false;
    let page = digitValuesToPage(selectedValues);
    page = Math.max(1, Math.min(totalBigPages.value, page));
    if (page !== currentBigPage.value) {
        emit("jumpToPage", page);
    }
};

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

// 跳转到指定页（桌面输入框）
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
    align-items: center;
    font-weight: 600;
    line-height: 1.2;
    min-width: 80px;
    border: 1px solid var(--anime-border);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.6);

    .part {
        flex: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        min-width: 0;
        padding: 4px 8px;
    }

    .part-total .total {
        font-size: 14px;
        color: var(--anime-text-secondary);
        font-weight: 600;
    }
}

.paginator-diagonal {
    flex-shrink: 0;
    width: 20px;
    height: 28px;
    position: relative;
    background: transparent;

    &::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 1px;
        height: 36px;
        background: var(--anime-border);
        transform: translate(-50%, -50%) rotate(-45deg);
        opacity: 0.7;
    }
}

.page-input-inline {
    min-width: 2.5em;
    width: auto;

    :deep(.el-input__wrapper) {
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 0;
        transition: all 0.3s ease;

        &:hover {
            background: rgba(255, 107, 157, 0.05);
            border: none;
            box-shadow: none;
        }

        &.is-focus {
            background: rgba(255, 255, 255, 0.95);
            border: none;
            box-shadow:
                inset 0 0 0 1px var(--anime-primary),
                0 0 0 2px rgba(255, 107, 157, 0.2);
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

// 响应式设计（非 Android 小屏时：数字在上方一行，按钮在下方）
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

// Android：上一页/下一页箭头与分页数字同一行，不换行；页码可点开 Picker
.gallery-big-paginator.is-android {
    .paginator-content {
        flex-wrap: nowrap;
        justify-content: space-between;
        gap: 8px;
    }

    .paginator-info {
        order: 0;
        width: auto;
        flex: 1;
        min-width: 0;
        padding: 0 4px;
    }

    .nav-button {
        flex: none;
        min-width: 0;
        padding: 6px 10px;
    }

    .page-number-android {
        cursor: pointer;
        user-select: none;

        .part-current .current-page {
            font-weight: 700;
            font-size: 18px;
            color: var(--anime-primary);
        }
    }
}
</style>
