<template>
    <div class="android-picker-select" :class="{ 'is-disabled': disabled }" @click="onTriggerClick">
        <span class="android-picker-select__value" :class="{ 'is-placeholder': !displayLabel }">
            {{ displayLabel || placeholder || "请选择" }}
        </span>
        <el-icon class="android-picker-select__arrow">
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

export interface AndroidPickerSelectOption {
    label: string;
    value: string;
}

const props = withDefaults(
    defineProps<{
        modelValue: string | null;
        options: AndroidPickerSelectOption[];
        title?: string;
        placeholder?: string;
        clearable?: boolean;
        disabled?: boolean;
    }>(),
    { title: "请选择", placeholder: "请选择", clearable: false, disabled: false }
);

const emit = defineEmits<{
    "update:modelValue": [value: string | null];
}>();

const showPicker = ref(false);
useModalBack(showPicker);

const displayLabel = computed(() => {
    const v = props.modelValue;
    if (v === null || v === undefined || v === "") return "";
    const opt = props.options.find((o) => o.value === v);
    return opt ? opt.label : v;
});

const optionsWithClear = computed(() => {
    if (props.clearable) {
        return [{ label: "不选择", value: "" }, ...props.options];
    }
    return props.options;
});

const pickerColumns = computed(() =>
    optionsWithClear.value.map((o) => ({ text: o.label, value: o.value }))
);

const pickerSelectedValues = ref<string[]>([]);

watch(showPicker, (open) => {
    if (open) {
        const v = props.modelValue;
        const val =
            v !== null && v !== undefined && v !== "" ? v : (props.clearable ? "" : optionsWithClear.value[0]?.value ?? "");
        pickerSelectedValues.value = [val];
    }
});

watch(
    () => [props.modelValue, optionsWithClear.value] as const,
    () => {
        if (showPicker.value) {
            const v = props.modelValue;
            const val =
                v !== null && v !== undefined && v !== "" ? v : (props.clearable ? "" : optionsWithClear.value[0]?.value ?? "");
            pickerSelectedValues.value = [val];
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
    const value = raw === "" || raw === null || raw === undefined ? null : String(raw);
    emit("update:modelValue", value);
}
</script>

<style scoped lang="scss">
.android-picker-select {
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

.android-picker-select__value {
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

.android-picker-select__arrow {
    flex-shrink: 0;
    margin-left: 8px;
    font-size: 14px;
    color: var(--anime-text-secondary);
}
</style>
