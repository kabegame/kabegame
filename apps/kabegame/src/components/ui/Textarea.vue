<template>
  <div
    :class="['kb-control items-stretch', $attrs.class]"
    :style="$attrs.style as StyleValue"
    :data-disabled="disabled || undefined"
    :data-invalid="field.invalid.value || undefined"
  >
    <textarea
      ref="textareaRef"
      v-model="model"
      v-bind="textareaAttrs"
      :id="field.id.value"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :aria-invalid="field.invalid.value || undefined"
      :aria-describedby="field.describedBy.value"
      :class="autosize ? '[field-sizing:content]' : ''"
      :style="
        autosize
          ? { minHeight: `calc(${rows}lh + 12px)`, maxHeight: maxRows ? `calc(${maxRows}lh + 12px)` : undefined }
          : undefined
      "
      class="box-border w-full resize-y border-0 bg-transparent px-2.5 py-1.5 leading-[1.55] text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 多行输入框（v-model 字符串）。autosize：高度随内容在 rows ~ maxRows 行之间变化（CSS field-sizing）。
 * class / style 落在外框上，其余属性落在 textarea 上。
 */
import { computed, ref, useAttrs, type StyleValue } from "vue";
import { useFieldControl } from "./field";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    rows?: number;
    maxRows?: number;
    autosize?: boolean;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    id?: string;
  }>(),
  { rows: 3 },
);

const model = defineModel<string>({ default: "" });
const attrs = useAttrs();
const field = useFieldControl(props);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const textareaAttrs = computed(() => {
  const { class: _c, style: _s, ...rest } = attrs;
  return rest;
});

defineExpose({ focus: () => textareaRef.value?.focus() });
</script>
