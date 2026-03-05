<template>
    <div class="android-picker-number" :class="{ 'is-disabled': disabled }" @click="onTriggerClick">
        <span class="android-picker-number__value" :class="{ 'is-placeholder': numberValue === undefined }">
            {{ numberValue !== undefined ? numberValue : (placeholder ?? "请选择") }}
        </span>
        <el-icon class="android-picker-number__arrow">
            <ArrowDown />
        </el-icon>
    </div>

    <Teleport to="body">
        <van-popup v-model:show="showPicker" position="bottom" round>
            <van-picker
                v-model="pickerSelectedValues"
                :title="title"
                :columns="pickerColumns"
                @confirm="onPickerConfirm"
                @cancel="showPicker = false"
            />
        </van-popup>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowDown } from "@element-plus/icons-vue";
import { useModalBack } from "../composables/useModalBack";

const props = withDefaults(
    defineProps<{
        modelValue: number | undefined;
        min?: number;
        max?: number;
        step?: number;
        title?: string;
        placeholder?: string;
        disabled?: boolean;
    }>(),
    { min: 0, max: 100, step: 1, title: "请选择", placeholder: "请选择", disabled: false }
);

const emit = defineEmits<{
    "update:modelValue": [value: number | undefined];
}>();

const showPicker = ref(false);
useModalBack(showPicker);

const numberValue = computed(() => {
    const v = props.modelValue;
    if (typeof v !== "number" || Number.isNaN(v)) return undefined;
    return v;
});

const pickerColumns = computed(() => {
    const min = typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0;
    const max = typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100;
    const step = typeof props.step === "number" && props.step > 0 ? props.step : 1;
    const options: { text: string; value: number }[] = [];
    for (let n = min; n <= max; n += step) {
        options.push({ text: String(n), value: n });
    }
    return options;
});

const pickerSelectedValues = ref<number[]>([]);

watch(showPicker, (open) => {
    if (open) {
        const v = props.modelValue;
        const num = typeof v === "number" && !Number.isNaN(v) ? v : props.min ?? 0;
        const clamped = Math.max(props.min ?? 0, Math.min(props.max ?? 100, num));
        const step = props.step ?? 1;
        const aligned = Math.round((clamped - (props.min ?? 0)) / step) * step + (props.min ?? 0);
        const final = Math.max(props.min ?? 0, Math.min(props.max ?? 100, aligned));
        pickerSelectedValues.value = [final];
    }
});

watch(
    () => [props.modelValue, props.min, props.max, props.step] as const,
    () => {
        if (showPicker.value) {
            const v = props.modelValue;
            const num = typeof v === "number" && !Number.isNaN(v) ? v : props.min ?? 0;
            const clamped = Math.max(props.min ?? 0, Math.min(props.max ?? 100, num));
            const step = props.step ?? 1;
            const aligned = Math.round((clamped - (props.min ?? 0)) / step) * step + (props.min ?? 0);
            const final = Math.max(props.min ?? 0, Math.min(props.max ?? 100, aligned));
            pickerSelectedValues.value = [final];
        }
    }
);

function onTriggerClick() {
    if (props.disabled) return;
    showPicker.value = true;
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
    showPicker.value = false;
    const raw = selectedValues[0];
    if (raw === undefined || raw === null) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    emit("update:modelValue", value);
}
</script>

<style scoped lang="scss">
.android-picker-number {
    display: flex;
    align-items: center;
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

.android-picker-number__value {
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

.android-picker-number__arrow {
    flex-shrink: 0;
    margin-left: 8px;
    font-size: 14px;
    color: var(--anime-text-secondary);
}
</style>
