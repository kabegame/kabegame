<template>
    <div class="android-picker-duration" :class="{ 'is-disabled': disabled }" @click="onTriggerClick">
        <span class="android-picker-duration__value" :class="{ 'is-placeholder': displayValue === undefined }">
            {{ displayValue !== undefined ? displayValue : resolvedPlaceholder }}
        </span>
        <el-icon class="android-picker-duration__arrow">
            <ArrowDown />
        </el-icon>
    </div>

    <Teleport to="body">
        <van-popup v-model:show="showPicker" position="bottom" round>
            <van-picker
                v-model="pickerSelectedValues"
                :title="resolvedTitle"
                :columns="pickerColumns"
                :confirm-button-text="t('common.confirm')"
                :cancel-button-text="t('common.cancel')"
                @confirm="onPickerConfirm"
                @cancel="showPicker = false"
            />
        </van-popup>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown } from "@element-plus/icons-vue";
import { useModalBack } from "../composables/useModalBack";

const MIN_MS = 100;
const MAX_MS = 10000;
const MS_STEP = 100;

const props = withDefaults(
    defineProps<{
        modelValue: number | undefined;
        title?: string;
        placeholder?: string;
        disabled?: boolean;
    }>(),
    { title: undefined, placeholder: undefined, disabled: false }
);

const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));
const resolvedPlaceholder = computed(() => props.placeholder ?? t("common.selectPlaceholder"));

const emit = defineEmits<{
    "update:modelValue": [value: number | undefined];
}>();

const showPicker = ref(false);
useModalBack(showPicker);

function msToSecAndMs(totalMs: number): [number, number] {
    const clamped = Math.max(MIN_MS, Math.min(MAX_MS, totalMs));
    const sec = Math.floor(clamped / 1000);
    const ms = Math.round((clamped % 1000) / MS_STEP) * MS_STEP;
    return [sec, ms];
}

function secAndMsToMs(sec: number, ms: number): number {
    const total = sec * 1000 + ms;
    return Math.max(MIN_MS, Math.min(MAX_MS, total));
}

const displayValue = computed(() => {
    const v = props.modelValue;
    if (typeof v !== "number" || Number.isNaN(v)) return undefined;
    const clamped = Math.max(MIN_MS, Math.min(MAX_MS, v));
    if (clamped >= 1000) {
        const sec = Math.floor(clamped / 1000);
        const ms = clamped % 1000;
        return ms > 0
            ? t("common.durationFormatSecMs", { sec, ms })
            : t("common.durationFormatSec", { sec });
    }
    return t("common.durationFormatMs", { ms: clamped });
});

const pickerColumns = computed(() => {
    const secCol: { text: string; value: number }[] = [];
    for (let s = 0; s <= 10; s++) {
        secCol.push({ text: t("common.pickerColumnSeconds", { n: s }), value: s });
    }
    const msCol: { text: string; value: number }[] = [];
    for (let m = 0; m <= 900; m += MS_STEP) {
        msCol.push({ text: t("common.pickerColumnMilliseconds", { n: m }), value: m });
    }
    return [secCol, msCol];
});

const pickerSelectedValues = ref<[number, number]>([0, 500]);

watch(showPicker, (open) => {
    if (open) {
        const v = props.modelValue;
        const num = typeof v === "number" && !Number.isNaN(v) ? v : 500;
        const [sec, ms] = msToSecAndMs(num);
        pickerSelectedValues.value = [sec, ms];
    }
});

watch(
    () => props.modelValue,
    () => {
        if (showPicker.value) {
            const v = props.modelValue;
            const num = typeof v === "number" && !Number.isNaN(v) ? v : 500;
            const [sec, ms] = msToSecAndMs(num);
            pickerSelectedValues.value = [sec, ms];
        }
    }
);

function onTriggerClick() {
    if (props.disabled) return;
    showPicker.value = true;
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
    showPicker.value = false;
    const secRaw = selectedValues[0];
    const msRaw = selectedValues[1];
    if (secRaw === undefined || secRaw === null || msRaw === undefined || msRaw === null) return;
    const sec = Number(secRaw);
    const ms = Number(msRaw);
    if (!Number.isFinite(sec) || !Number.isFinite(ms)) return;
    const totalMs = secAndMsToMs(sec, ms);
    emit("update:modelValue", totalMs);
}
</script>

<style scoped lang="scss">
.android-picker-duration {
    display: flex;
    align-items: center;
    width: 100%;
    justify-content: space-between;
    min-height: 32px;
    padding: 6px 12px;
    border: 1px solid var(--el-border-color);
    border-radius: var(--el-border-radius-base);
    background: var(--el-fill-color-blank);
    cursor: pointer;
    user-select: none;

    &.is-disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }
}

.android-picker-duration__value {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    color: var(--anime-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &.is-placeholder {
        color: var(--anime-text-muted);
    }
}

.android-picker-duration__arrow {
    flex-shrink: 0;
    margin-left: 8px;
    font-size: 14px;
    color: var(--anime-text-secondary);
}
</style>
