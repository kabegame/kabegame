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
            <!-- 有 option 插槽时用自定义列表，可渲染叹号等 -->
            <template v-if="useOptionSlot">
                <div class="android-picker-select__header">
                    <span class="android-picker-select__title">{{ title }}</span>
                    <van-button type="default" size="small" @click="showPicker = false">取消</van-button>
                </div>
                <div class="android-picker-select__list">
                    <div
                        v-for="opt in optionsWithClear"
                        :key="String(opt.value)"
                        class="android-picker-select__list-item"
                        :class="{ 'is-selected': opt.value === modelValue }"
                        @click="onSelectOption(opt)"
                    >
                        <slot name="option" :option="opt" />
                    </div>
                </div>
            </template>
            <van-picker
                v-else
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
import { computed, ref, useSlots, watch } from "vue";
import { ArrowDown } from "@element-plus/icons-vue";
import { useModalBack } from "../composables/useModalBack";

export interface AndroidPickerSelectOption {
    label: string;
    value: string;
    /** 可选：供 option 插槽使用，如标记为 JS 插件在安卓不支持 */
    warning?: boolean;
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

const slots = useSlots();
const useOptionSlot = computed(() => !!slots.option);

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

function onSelectOption(opt: AndroidPickerSelectOption) {
    showPicker.value = false;
    const value = opt.value === "" || opt.value === null || opt.value === undefined ? null : opt.value;
    emit("update:modelValue", value);
}
</script>

<style scoped lang="scss">
.android-picker-select {
    display: flex;
    width: 100%;
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

.android-picker-select__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--el-border-color-lighter);
}

.android-picker-select__title {
    font-size: 16px;
    font-weight: 600;
    color: var(--anime-text-primary);
}

.android-picker-select__list {
    max-height: 60vh;
    overflow-y: auto;
    padding: 8px 0;
}

.android-picker-select__list-item {
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: 10px 16px;
    cursor: pointer;
    color: var(--anime-text-primary);

    &.is-selected {
        color: var(--el-color-primary);
    }
}
</style>
