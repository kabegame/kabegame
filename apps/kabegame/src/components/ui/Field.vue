<template>
  <div
    ref="rootRef"
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
      <div class="flex min-w-0 items-center gap-2">
        <Label :for="id" class="min-w-0 text-[13px] font-500 leading-5 text-kb-fg">
          <slot name="label">{{ label }}</slot>
          <span v-if="required" class="ml-0.5 text-kb-danger" aria-hidden="true">*</span>
        </Label>
        <!-- 标签行右侧的附加操作（全选、计数……）；不放进 <label>，免得点它时聚焦控件 -->
        <slot name="label-end" />
      </div>
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <slot :id="id" :invalid="invalid" />
      <p v-if="shownError" :id="messageId" class="m-0 text-[12px] leading-[1.5] text-kb-danger">{{ shownError }}</p>
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
 * 表单项：标签 + 控件（默认插槽）+ 说明或错误（取代 el-form-item 的布局与校验）。
 * 控件自动拿到 id 与出错状态（field.ts）；自定义控件可用插槽参数 { id, invalid }。
 * horizontal：标签在左（宽度 --kb-field-label-width，默认 160px），设置页这类长表单用。
 *
 * 错误两种给法：
 * - `error`：调用方自己算好的文字，非空即显示；
 * - `validator`：返回错误文字的函数，放在 useForm() 的表单里时随表单 validate() 一起检查；
 *   值改过一次之后实时显示（见 form.ts）。两者都给时 `error` 优先。
 */
import { computed, onBeforeUnmount, provide, ref, watch } from "vue";
import { Label, useId } from "reka-ui";
import { FIELD_KEY } from "./field";
import { useFormContext } from "./form";

const props = withDefaults(
  defineProps<{
    label?: string;
    description?: string;
    /** 错误文字；非空即出错（控件描红、说明换成错误） */
    error?: string;
    /** 返回错误文字的校验函数（通过时返回 undefined / 空串） */
    validator?: () => string | undefined | null | false;
    required?: boolean;
    orientation?: "vertical" | "horizontal";
    id?: string;
  }>(),
  { orientation: "vertical" },
);

const generatedId = useId(undefined, "kb-field");
const id = computed(() => props.id ?? generatedId);
const messageId = computed(() => `${id.value}-message`);
const rootRef = ref<HTMLElement | null>(null);

const form = useFormContext();
const validatorError = computed(() => props.validator?.() || undefined);
/** 校验结果变过一次（用户改过值）之后才实时显示 */
const touched = ref(false);
watch(validatorError, () => (touched.value = true));

const shownError = computed(
  () => props.error || ((touched.value || form?.submitted.value) && validatorError.value) || undefined,
);
const invalid = computed(() => !!shownError.value);
const hasMessage = computed(() => !!shownError.value || !!props.description);

if (form) {
  const unregister = form.register({
    error: () => validatorError.value,
    el: () => rootRef.value,
    reset: () => (touched.value = false),
  });
  onBeforeUnmount(unregister);
}

provide(FIELD_KEY, {
  get id() {
    return id.value;
  },
  invalid,
  describedBy: computed(() => (hasMessage.value ? messageId.value : undefined)),
});
</script>
