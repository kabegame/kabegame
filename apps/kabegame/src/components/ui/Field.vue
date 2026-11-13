<template>
  <div
    class="flex gap-x-4 gap-y-1.5"
    :class="orientation === 'horizontal' ? 'flex-row items-start' : 'flex-col'"
    :data-invalid="invalid || undefined"
  >
    <div
      v-if="label || $slots.label"
      class="flex flex-col gap-0.5"
      :class="
        orientation === 'horizontal' ? 'min-h-8 w-[var(--kb-field-label-width,160px)] shrink-0 justify-center' : ''
      "
    >
      <Label :for="id" class="text-[13px] font-500 leading-5 text-kb-fg">
        <slot name="label">{{ label }}</slot>
        <span v-if="required" class="ml-0.5 text-kb-danger" aria-hidden="true">*</span>
      </Label>
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <slot :id="id" :invalid="invalid" />
      <p v-if="error" :id="messageId" class="m-0 text-[12px] leading-[1.5] text-kb-danger">{{ error }}</p>
      <p
        v-else-if="description || $slots.description"
        :id="messageId"
        class="m-0 text-[12px] leading-[1.55] text-kb-fg-muted"
      >
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 表单项：标签 + 控件（默认插槽）+ 说明或错误（取代 el-form-item 的布局）。
 * 控件自动拿到 id 与出错状态（field.ts）；自定义控件可用插槽参数 { id, invalid }。
 * horizontal：标签在左（宽度 --kb-field-label-width，默认 160px），设置页这类长表单用。
 * 校验不在这里：调用方自己算 error 传进来。
 */
import { computed, provide } from "vue";
import { Label, useId } from "reka-ui";
import { FIELD_KEY } from "./field";

const props = withDefaults(
  defineProps<{
    label?: string;
    description?: string;
    /** 错误文字；非空即出错（控件描红、说明换成错误） */
    error?: string;
    required?: boolean;
    orientation?: "vertical" | "horizontal";
    id?: string;
  }>(),
  { orientation: "vertical" },
);

const generatedId = useId(undefined, "kb-field");
const id = computed(() => props.id ?? generatedId);
const messageId = computed(() => `${id.value}-message`);
const invalid = computed(() => !!props.error);
const hasMessage = computed(() => !!props.error || !!props.description);

provide(FIELD_KEY, {
  get id() {
    return id.value;
  },
  invalid,
  describedBy: computed(() => (hasMessage.value ? messageId.value : undefined)),
});
</script>
