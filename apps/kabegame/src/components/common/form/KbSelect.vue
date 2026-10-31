<template>
  <!-- 选项少时用分段器：一眼看全部选项，省一次点击展开 -->
  <KbSegmentedControl
    v-if="segmented && !isCompact && normalizedOptions.length > 0 && normalizedOptions.length <= 4"
    :model-value="valueForSelect ?? SEGMENT_NONE"
    :options="normalizedOptions"
    @update:model-value="$emit('update:modelValue', $event)"
  />
  <el-select
    v-else
    :model-value="valueForSelect"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :empty-values="[undefined, null]"
    :filterable="normalizedOptions.length >= 9"
    :focus-on-open="!IS_ANDROID"
    style="width: 100%"
    :title="selectedLabel || placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <!-- 插件 options 声明的 variable "" 是合法取值（如「全部」）；empty-values 去掉 ""，否则会被当成未选显示占位 -->
    <!-- 下拉宽度已统一为输入框宽度，长文案会被 ellipsis 截断；补原生 title 让鼠标能看全 -->
    <el-option
      v-for="opt in normalizedOptions"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
      :title="opt.label"
    />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "../../../stores/ui";
import { IS_ANDROID } from "../../../env";
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

defineEmits<{
  "update:modelValue": [value: string | undefined];
}>();

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

/** 触发器里显示的选项文案（窄栅格里会被截断，靠 title 看全） */
const selectedLabel = computed(
  () => normalizedOptions.value.find((o) => o.value === valueForSelect.value)?.label ?? "",
);
</script>
