<template>
  <!-- 选项少时用分段器：一眼看全部选项，省一次点击展开 -->
  <KbSegmentedControl
    v-if="segmented && !isCompact && normalizedOptions.length > 0 && normalizedOptions.length <= 4"
    :model-value="valueForSelect ?? SEGMENT_NONE"
    :options="normalizedOptions"
    @update:model-value="$emit('update:modelValue', $event)"
  />
  <!-- 选项多时可搜索 -->
  <Combobox
    v-else-if="normalizedOptions.length >= 9"
    :model-value="encodedValue"
    :options="encodedOptions"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :title="selectedLabel || placeholder"
    @update:model-value="onPick"
  />
  <Select
    v-else
    :model-value="encodedValue"
    :options="encodedOptions"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :title="selectedLabel || placeholder"
    @update:model-value="onPick"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "../../../stores/ui";
import Combobox from "@/components/ui/Combobox.vue";
import Select from "@/components/ui/Select.vue";
import KbSegmentedControl from "./KbSegmentedControl.vue";

const isCompact = computed(() => useUiStore().isCompact);

/** 分段器「未选」占位：不能用 ""，那是插件可声明的合法选项值 */
const SEGMENT_NONE = "\u0000kb-segment-none";

type VarOption = string | { name: string | Record<string, string>; variable: string };

function optionLabel(o: VarOption): string {
  if (typeof o === "string") return o;
  if (typeof o.name === "string") return o.name;
  if (o.name && typeof o.name === "object") return (o.name as Record<string, string>).default ?? "";
  return "";
}

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    placeholder?: string;
    allowUnset?: boolean;
    /** 选项少时是否用分段器；放进窄容器、选项文案又长时传 false，始终用下拉 */
    segmented?: boolean;
  }>(),
  { allowUnset: false, segmented: true },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | undefined];
}>();

/**
 * 插件 options 声明的 variable "" 是合法取值（如「全部」），但 Reka 的选项值不能是空串（空串表示未选）：
 * 进出下拉时把 "" 换成这个占位。
 */
const EMPTY_OPTION = "\u0000kb-empty-option";
const encode = (v: string) => (v === "" ? EMPTY_OPTION : v);
const decode = (v: string) => (v === EMPTY_OPTION ? "" : v);

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return (
    opts
      .map((o) => {
        if (typeof o === "string") return { label: o, value: o };
        return { label: optionLabel(o), value: o.variable };
      })
      // 保留 variable 为 "" 的选项：它是插件声明的合法值，空值语义由 null / undefined 表达
      .filter((o) => typeof o.value === "string")
  );
});

const valueForSelect = computed<string | undefined>(() => {
  return typeof props.modelValue === "string" ? props.modelValue : undefined;
});

const encodedValue = computed(() => (valueForSelect.value === undefined ? undefined : encode(valueForSelect.value)));
const encodedOptions = computed(() => normalizedOptions.value.map((o) => ({ label: o.label, value: encode(o.value) })));

function onPick(v: string | undefined) {
  emit("update:modelValue", v === undefined ? undefined : decode(v));
}

/** 触发器里显示的选项文案（窄栅格里会被截断，靠 title 看全） */
const selectedLabel = computed(
  () => normalizedOptions.value.find((o) => o.value === valueForSelect.value)?.label ?? "",
);
</script>
