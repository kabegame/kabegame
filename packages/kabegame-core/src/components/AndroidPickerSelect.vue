<template>
    <div class="android-picker-select" :class="{ 'is-disabled': disabled }" @click="onTriggerClick">
        <span class="android-picker-select__value" :class="{ 'is-placeholder': !displayLabel }">
            {{ displayLabel || resolvedPlaceholder }}
        </span>
        <el-icon class="android-picker-select__arrow">
            <ArrowDown />
        </el-icon>
    </div>

    <Teleport to="body">
        <!-- 有 option 插槽：屏幕居中磨玻璃弹窗（方案 1c）。可渲染图标 / 描述 / 标签 / 警告 -->
        <Transition v-if="useOptionSlot" name="apk-modal">
            <div
                v-if="isOpen"
                class="apk-modal-mask"
                :style="{ zIndex }"
                @click.self="close()"
            >
                <div class="apk-modal-card">
                    <header class="apk-modal-header">
                        <div class="apk-modal-title">{{ resolvedTitle }}</div>
                        <div v-if="subtitle" class="apk-modal-subtitle">{{ subtitle }}</div>
                    </header>
                    <div class="apk-modal-list">
                        <!-- 推荐来源 -->
                        <div v-if="primaryGroupLabel && restrictedOptions.length" class="apk-section-title">
                            {{ primaryGroupLabel }}
                        </div>
                        <div
                            v-for="opt in primaryOptions"
                            :key="String(opt.value)"
                            class="apk-row"
                            :class="{ 'is-selected': opt.value === modelValue }"
                            @click="onSelectOption(opt)"
                        >
                            <div v-if="opt.value === modelValue" class="apk-row__sel" />
                            <div class="apk-row__body">
                                <slot name="option" :option="opt" />
                            </div>
                            <div v-if="opt.value === modelValue" class="apk-row__check">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M5 13l4 4L19 7" />
                                </svg>
                            </div>
                        </div>

                        <!-- 受限来源（Webview 插件），移动端不可选 -->
                        <template v-if="restrictedOptions.length">
                            <div v-if="restrictedGroupLabel" class="apk-section-title apk-section-title--restricted">
                                {{ restrictedGroupLabel }}
                                <span v-if="restrictedGroupNote" class="apk-section-note">· {{ restrictedGroupNote }}</span>
                            </div>
                            <div
                                v-for="opt in restrictedOptions"
                                :key="String(opt.value)"
                                class="apk-row apk-row--disabled"
                            >
                                <div class="apk-row__body">
                                    <slot name="option" :option="opt" />
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </Transition>

        <!-- 无 option 插槽：底部抽屉（保持现状） -->
        <van-popup
            v-else
            :show="isOpen"
            position="bottom"
            round
            :z-index="zIndex"
            @update:show="v => { if (!v) close() }"
        >
            <van-picker
                v-model="pickerSelectedValues"
                :title="resolvedTitle"
                :columns="pickerColumns"
                :confirm-button-text="t('common.confirm')"
                :cancel-button-text="t('common.cancel')"
                @confirm="onPickerConfirm"
                @cancel="close()"
            />
        </van-popup>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, useSlots, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown } from "@kabegame/element-plus-icons";
import { useModal } from "../composables/useModal";
import type { PluginLabel } from "../stores/pluginLabels";

export interface AndroidPickerSelectOption {
    label: string;
    value: string;
    /** 可选：供 option 插槽使用，如展示插件 id 相关状态 */
    pluginId?: string;
    /** 可选：供 option 插槽使用，如展示关联数量 */
    count?: number;
    /**
     * 可选：标记该项为受限来源（如 Webview 插件在移动端不可运行）。
     * 置为 true 时归入「受限」分区，居中弹窗模式下不可点选。
     */
    warning?: boolean;
    /** 可选：列表左侧图标 URL（如插件图标），由业务传入 */
    iconSrc?: string;
    /** 可选：供 option 插槽展示的一句话描述 */
    desc?: string;
    /** 可选：供 option 插槽展示的插件标签 */
    labels?: PluginLabel[];
}

const props = withDefaults(
    defineProps<{
        modelValue: string | null;
        options: AndroidPickerSelectOption[];
        title?: string;
        placeholder?: string;
        clearable?: boolean;
        disabled?: boolean;
        /** 居中弹窗模式（有 option 插槽时）：标题下的副标题 */
        subtitle?: string;
        /** 居中弹窗模式：主分区（可选项）标题；不传则不显示分区标题 */
        primaryGroupLabel?: string;
        /** 居中弹窗模式：受限分区（warning 项）标题；不传则受限项不单列分区标题 */
        restrictedGroupLabel?: string;
        /** 居中弹窗模式：受限分区标题后的小字说明（如「移动端暂不支持」） */
        restrictedGroupNote?: string;
    }>(),
    {
        title: undefined,
        placeholder: undefined,
        clearable: false,
        disabled: false,
        subtitle: undefined,
        primaryGroupLabel: undefined,
        restrictedGroupLabel: undefined,
        restrictedGroupNote: undefined,
    }
);

const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));
const resolvedPlaceholder = computed(() => props.placeholder ?? t("common.selectPlaceholder"));

const emit = defineEmits<{
    "update:modelValue": [value: string | null];
}>();

const slots = useSlots();
const useOptionSlot = computed(() => !!slots.option);

const { isOpen, zIndex, open, close } = useModal();

const displayLabel = computed(() => {
    const v = props.modelValue;
    if (v === null || v === undefined || v === "") return "";
    const opt = props.options.find((o) => o.value === v);
    return opt ? opt.label : v;
});

const optionsWithClear = computed(() => {
    if (props.clearable) {
        return [{ label: t("common.selectNone"), value: "" }, ...props.options];
    }
    return props.options;
});

// 居中弹窗模式下按 warning 分区：可选项 vs 受限项（Webview 插件）。
const primaryOptions = computed(() => optionsWithClear.value.filter((o) => !o.warning));
const restrictedOptions = computed(() => optionsWithClear.value.filter((o) => o.warning));

const pickerColumns = computed(() =>
    optionsWithClear.value.map((o) => ({ text: o.label, value: o.value }))
);

const pickerSelectedValues = ref<string[]>([]);

watch(isOpen, (v) => {
    if (v) {
        const val = props.modelValue;
        const selected =
            val !== null && val !== undefined && val !== "" ? val : (props.clearable ? "" : optionsWithClear.value[0]?.value ?? "");
        pickerSelectedValues.value = [selected];
    }
});

watch(
    () => [props.modelValue, optionsWithClear.value] as const,
    () => {
        if (isOpen.value) {
            const v = props.modelValue;
            const val =
                v !== null && v !== undefined && v !== "" ? v : (props.clearable ? "" : optionsWithClear.value[0]?.value ?? "");
            pickerSelectedValues.value = [val];
        }
    }
);

function onTriggerClick() {
    if (props.disabled) return;
    open();
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
    close();
    const raw = selectedValues[0];
    const value = raw === "" || raw === null || raw === undefined ? null : String(raw);
    emit("update:modelValue", value);
}

function onSelectOption(opt: AndroidPickerSelectOption) {
    // 受限项（Webview 插件）在移动端不可选，点击无反馈
    if (opt.warning) return;
    close();
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

/* ============ 居中磨玻璃弹窗（方案 1c，仅 option 插槽场景） ============ */
.apk-modal-mask {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 16px;
    background: rgba(46, 16, 54, 0.28);
}

.apk-modal-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: 82%;
    border: 1px solid rgba(255, 255, 255, 0.75);
    border-radius: 28px;
    background: rgba(255, 255, 255, 0.68);
    box-shadow: 0 26px 64px rgba(74, 21, 75, 0.3);
    overflow: hidden;
    backdrop-filter: blur(26px) saturate(1.6);
    -webkit-backdrop-filter: blur(26px) saturate(1.6);
    animation: apk-pop-in 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.15) both;
}

.apk-modal-header {
    padding: 18px 20px 14px;
}

.apk-modal-title {
    font-size: 18px;
    font-weight: 700;
    color: var(--anime-text-primary);
}

.apk-modal-subtitle {
    margin-top: 3px;
    font-size: 11.5px;
    color: var(--anime-text-muted);
}

.apk-modal-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 12px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
        display: none;
    }
}

.apk-section-title {
    padding: 4px 8px 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #b58fb8;

    &--restricted {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 12px 8px 8px;
    }
}

.apk-section-note {
    font-weight: 500;
    letter-spacing: 0;
    color: #c8a76b;
}

.apk-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 13px;
    margin-bottom: 2px;
    padding: 12px;
    border-radius: 18px;
    cursor: pointer;

    &:not(.apk-row--disabled):hover {
        background: rgba(255, 255, 255, 0.55);
    }

    &--disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }
}

/* 选中态叠加层：粉紫渐变 + 左侧强调条 */
.apk-row__sel {
    position: absolute;
    inset: 0;
    border-radius: 18px;
    pointer-events: none;
    background: linear-gradient(90deg, rgba(255, 107, 157, 0.16), rgba(167, 139, 250, 0.08));
    box-shadow: inset 3px 0 0 var(--anime-primary);
}

.apk-row__body {
    position: relative;
    flex: 1;
    min-width: 0;
}

.apk-row__check {
    position: relative;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--anime-primary), var(--anime-secondary));
    box-shadow: 0 3px 8px rgba(255, 107, 157, 0.45);
}

@keyframes apk-pop-in {
    from {
        opacity: 0;
        transform: scale(0.9);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

/* 遮罩淡入淡出（卡片自身走 apk-pop-in 缩放） */
.apk-modal-enter-active,
.apk-modal-leave-active {
    transition: opacity 0.2s ease;
}

.apk-modal-enter-from,
.apk-modal-leave-to {
    opacity: 0;
}
</style>
