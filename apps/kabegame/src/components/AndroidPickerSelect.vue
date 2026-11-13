<template>
  <slot name="trigger" :open="onTriggerClick">
    <button
      type="button"
      class="android-picker-select kb-control h-8 cursor-pointer justify-between gap-2 px-2.5 text-left [font:inherit]"
      :data-disabled="disabled || undefined"
      :aria-disabled="disabled || undefined"
      @click="onTriggerClick"
    >
      <span
        class="android-picker-select__value min-w-0 flex-1 truncate"
        :class="displayLabel ? '' : 'text-kb-fg-subtle'"
      >
        {{ displayLabel || resolvedPlaceholder }}
      </span>
      <ChevronDown class="android-picker-select__arrow size-4 shrink-0 text-kb-fg-subtle" />
    </button>
  </slot>

  <!-- 有 option 插槽：居中对话框，可渲染图标 / 描述 / 标签 / 警告 -->
  <Dialog
    v-if="useOptionSlot"
    v-model:open="isOpen"
    :title="resolvedTitle"
    :description="subtitle"
    :width="720"
    body-class="!px-2.5 !pt-1 !pb-3"
  >
    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] content-start gap-x-2 gap-y-0.5">
      <!-- 推荐来源 -->
      <div
        v-if="primaryGroupLabel && restrictedOptions.length"
        class="col-span-full px-2 pb-1.5 pt-1 text-[11.5px] font-600 tracking-wide text-kb-fg-subtle"
      >
        {{ primaryGroupLabel }}
      </div>
      <button
        v-for="opt in primaryOptions"
        :key="String(opt.value)"
        type="button"
        class="relative flex cursor-pointer items-center gap-3 rounded-kb-lg border-0 p-3 text-left text-kb-fg [font:inherit] transition-colors duration-100"
        :class="
          opt.value === modelValue
            ? 'bg-[color-mix(in_srgb,var(--kb-accent)_9%,transparent)]'
            : 'bg-transparent hover:bg-kb-hover'
        "
        :aria-pressed="opt.value === modelValue"
        @click="onSelectOption(opt)"
      >
        <div class="min-w-0 flex-1">
          <slot name="option" :option="opt" />
        </div>
        <span
          v-if="opt.value === modelValue"
          class="grid size-5 shrink-0 place-items-center rounded-full bg-kb-accent text-white"
        >
          <Check class="size-3" :stroke-width="3" />
        </span>
      </button>

      <!-- 受限来源（Webview 插件），移动端不可选 -->
      <template v-if="restrictedOptions.length">
        <div
          v-if="restrictedGroupLabel"
          class="col-span-full flex items-center gap-1.5 px-2 pb-1.5 pt-3 text-[11.5px] font-600 tracking-wide text-kb-fg-subtle"
        >
          {{ restrictedGroupLabel }}
          <span v-if="restrictedGroupNote" class="font-400 tracking-normal text-kb-warning">
            · {{ restrictedGroupNote }}
          </span>
        </div>
        <div
          v-for="opt in restrictedOptions"
          :key="String(opt.value)"
          class="flex cursor-not-allowed items-center gap-3 rounded-kb-lg p-3 opacity-55"
          aria-disabled="true"
        >
          <div class="min-w-0 flex-1">
            <slot name="option" :option="opt" />
          </div>
        </div>
      </template>
    </div>
  </Dialog>

  <!-- 无 option 插槽：底部滚轮 -->
  <PickerSheet
    v-else
    v-model:open="isOpen"
    v-model="pickerSelectedValues"
    :title="resolvedTitle"
    :columns="pickerColumns"
    @confirm="onPickerConfirm"
  />
</template>

<script setup lang="ts">
import { computed, ref, useSlots, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, ChevronDown } from "@lucide/vue";
import Dialog from "@/components/ui/Dialog.vue";
import PickerSheet from "@/components/ui/PickerSheet.vue";
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
  },
);

const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));
const resolvedPlaceholder = computed(() => props.placeholder ?? t("common.selectPlaceholder"));

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const slots = useSlots();
const useOptionSlot = computed(() => !!slots.option);

const isOpen = ref(false);

/** 「清除」行的私有值：不能用 ""，那是插件 options 可声明的合法取值 */
const CLEAR_VALUE = "\u0000kb-picker-clear";

/** 当前值是否对应一个可选中的项（"" 只有被某个选项声明时才算选中） */
function hasValue(v: string | null | undefined): v is string {
  if (v === null || v === undefined) return false;
  return v !== "" || props.options.some((o) => o.value === "");
}

const displayLabel = computed(() => {
  const v = props.modelValue;
  if (!hasValue(v)) return "";
  const opt = props.options.find((o) => o.value === v);
  return opt ? opt.label : v;
});

const optionsWithClear = computed(() => {
  if (props.clearable) {
    return [{ label: t("common.selectNone"), value: CLEAR_VALUE }, ...props.options];
  }
  return props.options;
});

// 居中弹窗模式下按 warning 分区：可选项 vs 受限项（Webview 插件）。
const primaryOptions = computed(() => optionsWithClear.value.filter((o) => !o.warning));
const restrictedOptions = computed(() => optionsWithClear.value.filter((o) => o.warning));

const pickerColumns = computed(() => optionsWithClear.value.map((o) => ({ text: o.label, value: o.value })));

const pickerSelectedValues = ref<string[]>([]);

watch(isOpen, (v) => {
  if (v) {
    const val = props.modelValue;
    const selected = hasValue(val) ? val : props.clearable ? CLEAR_VALUE : (optionsWithClear.value[0]?.value ?? "");
    pickerSelectedValues.value = [selected];
  }
});

watch(
  () => [props.modelValue, optionsWithClear.value] as const,
  () => {
    if (isOpen.value) {
      const v = props.modelValue;
      const val = hasValue(v) ? v : props.clearable ? CLEAR_VALUE : (optionsWithClear.value[0]?.value ?? "");
      pickerSelectedValues.value = [val];
    }
  },
);

function onTriggerClick() {
  if (props.disabled) return;
  isOpen.value = true;
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
  const raw = selectedValues[0];
  const value = raw === CLEAR_VALUE || raw === null || raw === undefined ? null : String(raw);
  emit("update:modelValue", value);
}

function onSelectOption(opt: AndroidPickerSelectOption) {
  // 受限项（Webview 插件）在移动端不可选，点击无反馈
  if (opt.warning) return;
  isOpen.value = false;
  const value = opt.value === CLEAR_VALUE || opt.value === null || opt.value === undefined ? null : opt.value;
  emit("update:modelValue", value);
}
</script>
