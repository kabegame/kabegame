<template>
  <KbBoolean
    v-if="item.kind === 'bool'"
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <KbNumber
    v-else-if="item.kind === 'slider'"
    type="float"
    :model-value="modelValue"
    :min="item.min ?? undefined"
    :max="item.max ?? undefined"
    :step="sliderStep"
    @update:model-value="emit('update:modelValue', $event)"
  />
  <KbSelect
    v-else-if="item.kind === 'combo'"
    :model-value="selectedIndex"
    :options="options"
    :segmented="segmented"
    @update:model-value="selectOption"
  />
  <KbColor
    v-else-if="item.kind === 'color'"
    :model-value="wpeColorToHex(modelValue)"
    @update:model-value="emit('update:modelValue', hexToWpeColor($event))"
  />
  <KbPath
    v-else-if="item.kind === 'file'"
    type="file"
    :model-value="modelValue"
    :file-extensions="item.extensions"
    allow-unset
    @update:model-value="emit('update:modelValue', $event)"
  />
  <KbPath
    v-else-if="item.kind === 'directory'"
    type="folder"
    :model-value="modelValue"
    allow-unset
    @update:model-value="emit('update:modelValue', $event)"
  />
  <KbText v-else :model-value="modelValue" allow-unset @update:model-value="emit('update:modelValue', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import KbBoolean from "@/components/common/form/KbBoolean.vue";
import KbNumber from "@/components/common/form/KbNumber.vue";
import KbSelect from "@/components/common/form/KbSelect.vue";
import KbColor from "@/components/common/form/KbColor.vue";
import KbPath from "@/components/common/form/KbPath.vue";
import KbText from "@/components/common/form/KbText.vue";
import type { WpeWebPropertyItem } from "@/composables/useWpeWebProperties";
import { hexToWpeColor, wpeColorToHex, wpeLabelText } from "@/utils/wpeProperties";

const props = defineProps<{ item: WpeWebPropertyItem; modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();
const sliderStep = computed(
  () => props.item.step ?? (Number.isInteger(props.item.min) && Number.isInteger(props.item.max) ? 1 : undefined),
);
const options = computed(() =>
  props.item.options.map((option, index) => ({ name: wpeLabelText(option.label), variable: String(index) })),
);
/** 侧栏窄：选项不超过 3 个且文案都短才用分段器，否则下拉（分段器放不下会横向截断） */
const segmented = computed(() => options.value.length <= 3 && options.value.every((option) => option.name.length <= 8));
const selectedIndex = computed(() => {
  const index = props.item.options.findIndex((option) => option.value === props.modelValue);
  return index >= 0 ? String(index) : undefined;
});
function selectOption(index: string | undefined) {
  if (index === undefined) return;
  const option = props.item.options[Number(index)];
  if (option) emit("update:modelValue", option.value);
}
</script>
