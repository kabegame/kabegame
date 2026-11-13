<template>
  <div class="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
    <div
      v-if="$slots.icon"
      class="mb-1 grid size-12 place-items-center rounded-kb-lg bg-kb-fill text-kb-fg-muted [&_svg]:size-6"
    >
      <slot name="icon" />
    </div>
    <slot name="image" />
    <div v-if="title" class="text-[14px] font-600 text-kb-fg">{{ title }}</div>
    <div v-if="description || $slots.default" class="max-w-[380px] text-[12.5px] leading-[1.6] text-kb-fg-muted">
      <slot>{{ description }}</slot>
    </div>
    <div v-if="$slots.actions" class="mt-3 flex items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 空状态：图标（#icon，放进浅灰方块）或插画（#image）+ 标题 + 说明 + 操作（#actions）。
 * 说明有多行时用默认插槽。
 */
defineProps<{ title?: string; description?: string }>();
</script>
