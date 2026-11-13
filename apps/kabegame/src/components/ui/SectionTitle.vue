<template>
  <div class="flex items-center gap-3 pt-1" role="separator" :aria-label="ariaLabel">
    <span class="shrink-0 text-[12px] font-600 uppercase tracking-[0.02em] text-kb-fg-subtle"><slot /></span>
    <span class="h-px flex-1 bg-kb-line" aria-hidden="true" />
  </div>
</template>

<script setup lang="ts">
/** 长表单里的分节标题：小号灰字 + 一条细线（取代 el-divider 的 content-position="left"）。 */
defineProps<{ ariaLabel?: string }>();
</script>
