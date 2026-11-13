<template>
  <div
    :class="['kb-control', SIZES[size], $attrs.class]"
    :style="$attrs.style as StyleValue"
    :data-disabled="disabled || undefined"
    :data-invalid="field.invalid.value || undefined"
    @mousedown="focusFromFrame"
  >
    <span v-if="$slots.prefix" class="flex shrink-0 items-center pl-2.5 text-kb-fg-subtle [&_svg]:size-4">
      <slot name="prefix" />
    </span>
    <input
      ref="inputRef"
      v-model="model"
      v-bind="inputAttrs"
      :id="field.id.value"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :aria-invalid="field.invalid.value || undefined"
      :aria-describedby="field.describedBy.value"
      :class="[
        'h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 py-0 text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle',
        inputClass,
      ]"
    />
    <button
      v-if="clearable && model && !disabled && !readonly"
      type="button"
      tabindex="-1"
      class="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted"
      :aria-label="t('common.clear')"
      @click="clear"
    >
      <X class="size-3.5" />
    </button>
    <span v-if="$slots.suffix" class="flex shrink-0 items-center pr-2.5 text-kb-fg-subtle [&_svg]:size-4">
      <slot name="suffix" />
    </span>
  </div>
</template>

<script setup lang="ts">
/**
 * 单行输入框（v-model 字符串）。#prefix / #suffix 放图标或单位；clearable 显示清空按钮。
 * class / style 落在外框上，其余属性与事件（@keydown.enter、maxlength、autocomplete……）落在 input 上。
 */
import { computed, ref, useAttrs, type StyleValue } from "vue";
import { X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useFieldControl } from "./field";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    clearable?: boolean;
    invalid?: boolean;
    id?: string;
    size?: "sm" | "md";
    /** 加在内层 input 上的类（如数字居中 `text-center tabular-nums`） */
    inputClass?: string;
  }>(),
  { type: "text", size: "md" },
);

const emit = defineEmits<{ clear: [] }>();
const model = defineModel<string>({ default: "" });
const { t } = useI18n();
const attrs = useAttrs();
const field = useFieldControl(props);
const inputRef = ref<HTMLInputElement | null>(null);

const SIZES = { sm: "h-7 text-[12.5px]", md: "h-8" } as const;

const inputAttrs = computed(() => {
  const { class: _c, style: _s, ...rest } = attrs;
  return rest;
});

// 点外框空白处（前后缀）也聚焦输入框
function focusFromFrame(e: MouseEvent) {
  if (e.target !== inputRef.value && !(e.target as Element).closest("button")) {
    e.preventDefault();
    inputRef.value?.focus();
  }
}

function clear() {
  model.value = "";
  emit("clear");
  inputRef.value?.focus();
}

defineExpose({ focus: () => inputRef.value?.focus(), select: () => inputRef.value?.select() });
</script>
